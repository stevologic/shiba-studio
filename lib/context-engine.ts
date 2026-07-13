import { createHash } from 'node:crypto';
import { getDb } from './db';
import type { ChatSession } from './chat-session-types';
import type {
  ContextCompactionRecord,
  ContextMatchWindow,
  ContextModelMessage,
  ContextScopeInspection,
  ContextScopeType,
  ContextSearchResult,
  ContextSourceCitation,
  ContextSourceRecord,
  ContextSourceType,
  ContextWindowMeter,
  PreparedSessionContext,
} from './context-types';
import type { Project, ProjectChatMessage } from './project-types';
import type { AgentRun } from './types';

const CONTEXT_ALGORITHM = 'extractive-v1';
const MAX_SOURCE_CHARS = 20_000;
const DEFAULT_RECENT_MESSAGES = 36;
const DEFAULT_REPLAY_TOKENS = 14_000;
const DEFAULT_BATCH_SIZE = 16;
const SEARCH_CANDIDATE_LIMIT = 2_500;

interface SourceRow {
  id: string;
  scopeType: string;
  scopeId: string;
  projectId: string | null;
  runId: string | null;
  sourceType: string;
  sourceKey: string;
  role: string | null;
  content: string;
  contentHash: string;
  ordinal: number;
  tokenEstimate: number;
  pinned: number;
  active: number;
  metadata: string;
  createdAt: string;
  updatedAt: string;
}

interface CompactionRow {
  id: string;
  scopeType: string;
  scopeId: string;
  fromOrdinal: number;
  toOrdinal: number;
  sourceIds: string;
  sourceDigest: string;
  summary: string;
  tokenEstimate: number;
  algorithm: string;
  createdAt: string;
  updatedAt: string;
}

interface UpsertSourceInput {
  id: string;
  scopeType: ContextScopeType;
  scopeId: string;
  projectId?: string | null;
  runId?: string | null;
  sourceType: ContextSourceType;
  sourceKey: string;
  role?: string | null;
  content: string;
  ordinal: number;
  pinned?: boolean;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clip(value: unknown, max = MAX_SOURCE_CHARS): string {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  return text.length <= max ? text : `${text.slice(0, max)}\n…[source truncated]`;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function estimateContextTokens(value: string): number {
  if (!value) return 0;
  // Conservative, deterministic approximation that works across providers.
  return Math.ceil(value.length / 3.5);
}

function safeIdPart(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 180);
  return cleaned || digest(value).slice(0, 20);
}

function sourceId(scopeType: ContextScopeType, scopeId: string, sourceType: ContextSourceType, key: string): string {
  return `ctx:${scopeType}:${safeIdPart(scopeId)}:${sourceType}:${safeIdPart(key)}`;
}

export function ensureContextSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS context_sources (
      id TEXT PRIMARY KEY,
      scopeType TEXT NOT NULL,
      scopeId TEXT NOT NULL,
      projectId TEXT,
      runId TEXT,
      sourceType TEXT NOT NULL,
      sourceKey TEXT NOT NULL,
      role TEXT,
      content TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      tokenEstimate INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      metadata TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(scopeType, scopeId, sourceType, sourceKey)
    );
    CREATE INDEX IF NOT EXISTS idx_context_sources_scope
      ON context_sources(scopeType, scopeId, active, ordinal);
    CREATE INDEX IF NOT EXISTS idx_context_sources_project
      ON context_sources(projectId, active, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_context_sources_run
      ON context_sources(runId, active, ordinal);
    CREATE INDEX IF NOT EXISTS idx_context_sources_pinned
      ON context_sources(scopeType, scopeId, pinned, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS context_compactions (
      id TEXT PRIMARY KEY,
      scopeType TEXT NOT NULL,
      scopeId TEXT NOT NULL,
      fromOrdinal INTEGER NOT NULL,
      toOrdinal INTEGER NOT NULL,
      sourceIds TEXT NOT NULL,
      sourceDigest TEXT NOT NULL,
      summary TEXT NOT NULL,
      tokenEstimate INTEGER NOT NULL,
      algorithm TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(scopeType, scopeId, fromOrdinal, toOrdinal, algorithm)
    );
    CREATE INDEX IF NOT EXISTS idx_context_compactions_scope
      ON context_compactions(scopeType, scopeId, fromOrdinal);

    CREATE TABLE IF NOT EXISTS context_scope_state (
      scopeType TEXT NOT NULL,
      scopeId TEXT NOT NULL,
      indexedAt TEXT,
      compactedAt TEXT,
      sourceCount INTEGER NOT NULL DEFAULT 0,
      summaryCount INTEGER NOT NULL DEFAULT 0,
      indexVersion TEXT NOT NULL,
      PRIMARY KEY(scopeType, scopeId)
    );
  `);
}

function upsertSource(input: UpsertSourceInput): void {
  const now = new Date().toISOString();
  const content = clip(input.content);
  const contentHash = digest(content);
  getDb().prepare(`
    INSERT INTO context_sources
      (id, scopeType, scopeId, projectId, runId, sourceType, sourceKey, role,
       content, contentHash, ordinal, tokenEstimate, pinned, active, metadata, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(scopeType, scopeId, sourceType, sourceKey) DO UPDATE SET
      projectId = COALESCE(excluded.projectId, context_sources.projectId),
      runId = COALESCE(excluded.runId, context_sources.runId),
      role = excluded.role,
      content = excluded.content,
      contentHash = excluded.contentHash,
      ordinal = excluded.ordinal,
      tokenEstimate = excluded.tokenEstimate,
      active = 1,
      metadata = excluded.metadata,
      createdAt = CASE
        WHEN excluded.createdAt < context_sources.createdAt THEN excluded.createdAt
        ELSE context_sources.createdAt
      END,
      updatedAt = excluded.updatedAt
  `).run(
    input.id,
    input.scopeType,
    input.scopeId,
    input.projectId ?? null,
    input.runId ?? null,
    input.sourceType,
    input.sourceKey,
    input.role ?? null,
    content,
    contentHash,
    input.ordinal,
    estimateContextTokens(content),
    input.pinned ? 1 : 0,
    JSON.stringify(input.metadata || {}),
    input.createdAt || now,
    now,
  );
}

function markMissingInactive(
  scopeType: ContextScopeType,
  scopeId: string,
  sourceTypes: ContextSourceType[],
  sourceKeys: string[],
): void {
  if (!sourceTypes.length) return;
  const typeMarks = sourceTypes.map(() => '?').join(',');
  if (!sourceKeys.length) {
    getDb().prepare(`
      UPDATE context_sources SET active = 0, updatedAt = ?
      WHERE scopeType = ? AND scopeId = ? AND sourceType IN (${typeMarks})
    `).run(new Date().toISOString(), scopeType, scopeId, ...sourceTypes);
    return;
  }
  const keyMarks = sourceKeys.map(() => '?').join(',');
  getDb().prepare(`
    UPDATE context_sources SET active = 0, updatedAt = ?
    WHERE scopeType = ? AND scopeId = ? AND sourceType IN (${typeMarks})
      AND sourceKey NOT IN (${keyMarks})
  `).run(new Date().toISOString(), scopeType, scopeId, ...sourceTypes, ...sourceKeys);
}

function updateScopeState(scopeType: ContextScopeType, scopeId: string, compacted = false): void {
  const now = new Date().toISOString();
  const sourceCount = Number((getDb().prepare(`
    SELECT COUNT(*) AS count FROM context_sources
    WHERE scopeType = ? AND scopeId = ? AND active = 1
  `).get(scopeType, scopeId) as { count: number }).count);
  const summaryCount = Number((getDb().prepare(`
    SELECT COUNT(*) AS count FROM context_compactions
    WHERE scopeType = ? AND scopeId = ?
  `).get(scopeType, scopeId) as { count: number }).count);
  getDb().prepare(`
    INSERT INTO context_scope_state
      (scopeType, scopeId, indexedAt, compactedAt, sourceCount, summaryCount, indexVersion)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scopeType, scopeId) DO UPDATE SET
      indexedAt = excluded.indexedAt,
      compactedAt = CASE WHEN ? THEN excluded.compactedAt ELSE context_scope_state.compactedAt END,
      sourceCount = excluded.sourceCount,
      summaryCount = excluded.summaryCount,
      indexVersion = excluded.indexVersion
  `).run(scopeType, scopeId, now, compacted ? now : null, sourceCount, summaryCount, CONTEXT_ALGORITHM, compacted ? 1 : 0);
}

function messageKey(message: Pick<ProjectChatMessage, 'id' | 'content'>, ordinal: number): string {
  return message.id?.trim() || `ordinal-${ordinal}-${digest(message.content || '').slice(0, 12)}`;
}

export function indexSessionContext(session: ChatSession): void {
  indexSessionMessages(session.id, session.messages || [], session.projectId || undefined);
}

export function indexSessionMessages(
  sessionId: string,
  messages: Array<ContextModelMessage | ProjectChatMessage>,
  projectId?: string,
): void {
  const id = sessionId.trim();
  if (!id) throw new Error('sessionId is required');
  ensureContextSchema();
  const keys: string[] = [];
  messages.forEach((message, ordinal) => {
    if (!message || !['user', 'assistant', 'system'].includes(message.role)) return;
    const key = messageKey({ id: message.id || '', content: message.content || '' }, ordinal);
    keys.push(key);
    upsertSource({
      id: sourceId('session', id, 'message', key),
      scopeType: 'session',
      scopeId: id,
      projectId: projectId || null,
      sourceType: 'message',
      sourceKey: key,
      role: message.role,
      content: message.content || '',
      ordinal,
      createdAt: message.createdAt,
      metadata: {
        hasAttachments: !!message.attachments?.length,
        attachmentCount: message.attachments?.length || 0,
      },
    });
  });
  markMissingInactive('session', id, ['message'], keys);
  updateScopeState('session', id);
}

export function indexProjectContext(project: Project): void {
  ensureContextSchema();
  const projectId = project.id.trim();
  if (!projectId) throw new Error('project id is required');
  const keys: string[] = ['project'];
  upsertSource({
    id: sourceId('project', projectId, 'project', 'project'),
    scopeType: 'project',
    scopeId: projectId,
    projectId,
    sourceType: 'project',
    sourceKey: 'project',
    content: [
      `Project: ${project.name}`,
      project.description ? `Description: ${project.description}` : '',
      project.instructions ? `Instructions: ${project.instructions}` : '',
      project.workspacePath ? `Workspace: ${project.workspacePath}` : '',
    ].filter(Boolean).join('\n'),
    ordinal: 0,
    createdAt: project.createdAt,
    metadata: { name: project.name },
  });
  project.files.forEach((file, index) => {
    const key = `file:${file.id}`;
    keys.push(key);
    upsertSource({
      id: sourceId('project', projectId, 'project_file', file.id),
      scopeType: 'project',
      scopeId: projectId,
      projectId,
      sourceType: 'project_file',
      sourceKey: key,
      content: `${file.name}\nMIME: ${file.mimeType || 'unknown'}\nSize: ${file.size} bytes\nChecksum: ${file.checksum}`,
      ordinal: 10_000 + index,
      createdAt: file.uploadedAt,
      metadata: { fileId: file.id, storedName: file.storedName, checksum: file.checksum },
    });
  });
  project.messages.forEach((message, index) => {
    const key = `message:${messageKey(message, index)}`;
    keys.push(key);
    upsertSource({
      id: sourceId('project', projectId, 'message', key),
      scopeType: 'project',
      scopeId: projectId,
      projectId,
      sourceType: 'message',
      sourceKey: key,
      role: message.role,
      content: message.content,
      ordinal: 20_000 + index,
      createdAt: message.createdAt,
      metadata: { messageId: message.id },
    });
  });
  markMissingInactive('project', projectId, ['project', 'project_file', 'message'], keys);
  updateScopeState('project', projectId);
}

export function indexRunContext(run: AgentRun): void {
  ensureContextSchema();
  const id = run.id.trim();
  if (!id) throw new Error('run id is required');
  const keys = ['prompt'];
  upsertSource({
    id: sourceId('run', id, 'run_prompt', 'prompt'),
    scopeType: 'run',
    scopeId: id,
    projectId: run.projectId || null,
    runId: id,
    sourceType: 'run_prompt',
    sourceKey: 'prompt',
    role: 'user',
    content: run.prompt,
    ordinal: 0,
    createdAt: run.startedAt,
    metadata: { agentId: run.agentId, agentName: run.agentName, model: run.model },
  });
  if (run.finalOutput) {
    keys.push('output');
    upsertSource({
      id: sourceId('run', id, 'run_output', 'output'),
      scopeType: 'run',
      scopeId: id,
      projectId: run.projectId || null,
      runId: id,
      sourceType: 'run_output',
      sourceKey: 'output',
      role: 'assistant',
      content: run.finalOutput,
      ordinal: 100_000,
      createdAt: run.completedAt || run.startedAt,
      metadata: { status: run.status },
    });
  }
  const trace = (run.trace || []).slice(-80);
  trace.forEach((step, index) => {
    const key = `trace:${step.id || index}`;
    keys.push(key);
    upsertSource({
      id: sourceId('run', id, 'run_trace', key),
      scopeType: 'run',
      scopeId: id,
      projectId: run.projectId || null,
      runId: id,
      sourceType: 'run_trace',
      sourceKey: key,
      role: 'tool',
      content: step.content || '',
      ordinal: 1_000 + index,
      createdAt: step.ts,
      metadata: { type: step.type, tool: step.tool?.name },
    });
  });
  markMissingInactive('run', id, ['run_prompt', 'run_output', 'run_trace'], keys);
  updateScopeState('run', id);
}

function rowToCitation(row: SourceRow): ContextSourceCitation {
  return {
    sourceId: row.id,
    scopeType: row.scopeType as ContextScopeType,
    scopeId: row.scopeId,
    sourceType: row.sourceType as ContextSourceType,
    sourceKey: row.sourceKey,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.role ? { role: row.role } : {}),
    createdAt: row.createdAt,
  };
}

function rowToSource(row: SourceRow): ContextSourceRecord {
  return {
    ...rowToCitation(row),
    content: row.content,
    contentHash: row.contentHash,
    ordinal: Number(row.ordinal),
    tokenEstimate: Number(row.tokenEstimate),
    pinned: !!row.pinned,
    metadata: parseJson(row.metadata, {}),
    updatedAt: row.updatedAt,
  };
}

function rowToCompaction(row: CompactionRow): ContextCompactionRecord {
  return {
    id: row.id,
    scopeType: row.scopeType as ContextScopeType,
    scopeId: row.scopeId,
    fromOrdinal: Number(row.fromOrdinal),
    toOrdinal: Number(row.toOrdinal),
    sourceIds: parseJson<string[]>(row.sourceIds, []),
    sourceDigest: row.sourceDigest,
    summary: row.summary,
    tokenEstimate: Number(row.tokenEstimate),
    algorithm: row.algorithm,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function scoreSentence(sentence: string): number {
  let score = Math.min(sentence.length, 240) / 240;
  if (/\b(must|never|required|constraint|non-negotiable|do not|don't|always)\b/i.test(sentence)) score += 9;
  if (/\b(unresolved|pending|blocked|question|waiting|approval|approve|deny)\b/i.test(sentence) || sentence.includes('?')) score += 8;
  if (/\b(plan|next step|todo|in progress|remaining|decision|decided)\b/i.test(sentence)) score += 7;
  if (/\b(contract|acceptance|success criteria|verify|test|evidence|artifact)\b/i.test(sentence)) score += 7;
  return score;
}

function sourceExcerpt(source: ContextSourceRecord): string {
  const sentences = source.content
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\s*[\r\n]+\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!sentences.length) return '(empty message)';
  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, score: scoreSentence(sentence) + (index === 0 ? 2 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
  return clip(ranked.join(' '), 520);
}

function buildDeterministicSummary(sources: ContextSourceRecord[]): string {
  const header = `Compacted ${sources.length} context sources. Citations are stable source IDs; retrieve a source before relying on omitted detail.`;
  const lines = sources.map((source) => {
    const role = source.role ? `${source.role}: ` : '';
    return `- [source:${source.sourceId}] ${role}${sourceExcerpt(source)}`;
  });
  return clip([header, ...lines].join('\n'), 10_000);
}

function boundedCompactionContext(
  compactions: ContextCompactionRecord[],
  maxTokens = 8_000,
): { text: string; tokenEstimate: number; sourceIds: string[] } {
  const maxChars = Math.floor(maxTokens * 3.5);
  const candidates = compactions.flatMap((compaction, compactionIndex) =>
    compaction.summary.split('\n').slice(1).map((line, lineIndex) => ({
      line,
      lineIndex,
      compactionIndex,
      score: scoreSentence(line),
      sourceId: line.match(/^\s*- \[source:([^\]]+)\]/)?.[1] || '',
    })).filter((item) => item.sourceId),
  );
  const selected: typeof candidates = [];
  let usedChars = 0;
  for (const item of [...candidates].sort((a, b) =>
    b.score - a.score || a.compactionIndex - b.compactionIndex || a.lineIndex - b.lineIndex)) {
    const cost = item.line.length + 1;
    if (selected.length > 0 && usedChars + cost > maxChars) continue;
    selected.push(item);
    usedChars += cost;
    if (usedChars >= maxChars) break;
  }
  selected.sort((a, b) => a.compactionIndex - b.compactionIndex || a.lineIndex - b.lineIndex);
  const text = selected.map((item) => item.line).join('\n');
  return {
    text,
    tokenEstimate: estimateContextTokens(text),
    sourceIds: selected.map((item) => item.sourceId),
  };
}

export function compactContextScope(
  scopeType: ContextScopeType,
  scopeId: string,
  options: { keepRecent?: number; batchSize?: number } = {},
): ContextCompactionRecord[] {
  ensureContextSchema();
  const keepRecent = boundedInt(options.keepRecent, DEFAULT_RECENT_MESSAGES, 8, 100);
  const batchSize = boundedInt(options.batchSize, DEFAULT_BATCH_SIZE, 4, 40);
  const sources = (getDb().prepare(`
    SELECT * FROM context_sources
    WHERE scopeType = ? AND scopeId = ? AND active = 1 AND sourceType = 'message'
    ORDER BY ordinal ASC
  `).all(scopeType, scopeId) as unknown as SourceRow[]).map(rowToSource);
  const compactable = sources.slice(0, Math.max(0, sources.length - keepRecent));
  const desiredKeys = new Set<string>();
  const now = new Date().toISOString();
  for (let start = 0; start < compactable.length; start += batchSize) {
    const batch = compactable.slice(start, start + batchSize);
    if (!batch.length) continue;
    const fromOrdinal = batch[0].ordinal;
    const toOrdinal = batch[batch.length - 1].ordinal;
    const key = `${fromOrdinal}:${toOrdinal}`;
    desiredKeys.add(key);
    const sourceDigest = digest(batch.map((source) => `${source.sourceId}:${source.contentHash}`).join('|'));
    const id = `cmp:${scopeType}:${safeIdPart(scopeId)}:${fromOrdinal}-${toOrdinal}:${sourceDigest.slice(0, 12)}`;
    const summary = buildDeterministicSummary(batch);
    getDb().prepare(`
      INSERT INTO context_compactions
        (id, scopeType, scopeId, fromOrdinal, toOrdinal, sourceIds, sourceDigest,
         summary, tokenEstimate, algorithm, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scopeType, scopeId, fromOrdinal, toOrdinal, algorithm) DO UPDATE SET
        id = excluded.id,
        sourceIds = excluded.sourceIds,
        sourceDigest = excluded.sourceDigest,
        summary = excluded.summary,
        tokenEstimate = excluded.tokenEstimate,
        updatedAt = excluded.updatedAt
    `).run(
      id,
      scopeType,
      scopeId,
      fromOrdinal,
      toOrdinal,
      JSON.stringify(batch.map((source) => source.sourceId)),
      sourceDigest,
      summary,
      estimateContextTokens(summary),
      CONTEXT_ALGORITHM,
      now,
      now,
    );
  }
  const existing = getDb().prepare(`
    SELECT fromOrdinal, toOrdinal FROM context_compactions
    WHERE scopeType = ? AND scopeId = ? AND algorithm = ?
  `).all(scopeType, scopeId, CONTEXT_ALGORITHM) as Array<{ fromOrdinal: number; toOrdinal: number }>;
  const remove = getDb().prepare(`
    DELETE FROM context_compactions
    WHERE scopeType = ? AND scopeId = ? AND algorithm = ? AND fromOrdinal = ? AND toOrdinal = ?
  `);
  for (const row of existing) {
    if (!desiredKeys.has(`${row.fromOrdinal}:${row.toOrdinal}`)) {
      remove.run(scopeType, scopeId, CONTEXT_ALGORITHM, row.fromOrdinal, row.toOrdinal);
    }
  }
  updateScopeState(scopeType, scopeId, true);
  return listCompactions(scopeType, scopeId);
}

function listCompactions(scopeType: ContextScopeType, scopeId: string): ContextCompactionRecord[] {
  return (getDb().prepare(`
    SELECT * FROM context_compactions
    WHERE scopeType = ? AND scopeId = ?
    ORDER BY fromOrdinal ASC
  `).all(scopeType, scopeId) as unknown as CompactionRow[]).map(rowToCompaction);
}

export function setContextSourcePinned(
  sourceIdValue: string,
  pinned: boolean,
  expectedScope?: { scopeType: ContextScopeType; scopeId: string },
): ContextSourceRecord {
  ensureContextSchema();
  const existing = getDb().prepare(`
    SELECT * FROM context_sources WHERE id = ? AND active = 1
  `).get(sourceIdValue) as unknown as SourceRow | undefined;
  if (!existing) throw new Error('Context source not found');
  if (expectedScope && (existing.scopeType !== expectedScope.scopeType || existing.scopeId !== expectedScope.scopeId)) {
    throw new Error('Source does not belong to this context scope');
  }
  const result = getDb().prepare(`
    UPDATE context_sources SET pinned = ?, updatedAt = ? WHERE id = ? AND active = 1
  `).run(pinned ? 1 : 0, new Date().toISOString(), sourceIdValue);
  if (!result.changes) throw new Error('Context source not found');
  const row = getDb().prepare('SELECT * FROM context_sources WHERE id = ?').get(sourceIdValue) as unknown as SourceRow;
  return rowToSource(row);
}

export function deleteContextScope(scopeType: ContextScopeType, scopeId: string): void {
  ensureContextSchema();
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM context_compactions WHERE scopeType = ? AND scopeId = ?').run(scopeType, scopeId);
    db.prepare('DELETE FROM context_sources WHERE scopeType = ? AND scopeId = ?').run(scopeType, scopeId);
    db.prepare('DELETE FROM context_scope_state WHERE scopeType = ? AND scopeId = ?').run(scopeType, scopeId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

function boundedMessages(
  messages: ContextModelMessage[],
  maxTokens: number,
  maxMessages: number,
): { messages: ContextModelMessage[]; tokens: number; attachmentTokens: number } {
  const selected: ContextModelMessage[] = [];
  let tokens = 0;
  let attachmentTokens = 0;
  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages; index--) {
    const message = messages[index];
    const messageTokens = estimateContextTokens(message.content || '')
      + estimateContextTokens(message.thinking || '');
    const attachments = (message.attachments || []).reduce(
      (sum, attachment) => sum + estimateContextTokens(attachment.textContent || '') + (attachment.dataUrl ? 256 : 0),
      0,
    );
    if (selected.length > 0 && tokens + messageTokens + attachments > maxTokens) break;
    selected.unshift(message);
    tokens += messageTokens + attachments;
    attachmentTokens += attachments;
  }
  return { messages: selected, tokens, attachmentTokens };
}

export function prepareSessionContext(input: {
  sessionId?: string | null;
  projectId?: string | null;
  messages: ContextModelMessage[];
  model?: string;
  maxReplayTokens?: number;
  maxRecentMessages?: number;
}): PreparedSessionContext {
  const maxReplayTokens = boundedInt(input.maxReplayTokens, DEFAULT_REPLAY_TOKENS, 2_000, 50_000);
  const maxRecentMessages = boundedInt(input.maxRecentMessages, DEFAULT_RECENT_MESSAGES, 8, 100);
  const sessionId = input.sessionId?.trim() || '';
  let compactions: ContextCompactionRecord[] = [];
  let pinned: ContextSourceRecord[] = [];
  if (sessionId) {
    indexSessionMessages(sessionId, input.messages, input.projectId || undefined);
    compactions = compactContextScope('session', sessionId, { keepRecent: maxRecentMessages });
    pinned = (getDb().prepare(`
      SELECT * FROM context_sources
      WHERE scopeType = 'session' AND scopeId = ? AND active = 1 AND pinned = 1
      ORDER BY ordinal ASC
    `).all(sessionId) as unknown as SourceRow[]).map(rowToSource);
  }
  const replay = boundedMessages(input.messages, maxReplayTokens, maxRecentMessages);
  const boundedSummary = boundedCompactionContext(compactions);
  const summaryTokens = boundedSummary.tokenEstimate;
  const maxPinnedTokens = Math.min(4_096, Math.max(512, Math.floor(maxReplayTokens / 4)));
  const boundedPinned: ContextSourceRecord[] = [];
  const pinnedOverflow: ContextSourceRecord[] = [];
  let pinnedTokens = 0;
  for (const source of pinned) {
    const remaining = maxPinnedTokens - pinnedTokens;
    if (remaining <= 0) {
      pinnedOverflow.push(source);
      continue;
    }
    if (source.tokenEstimate <= remaining) {
      boundedPinned.push(source);
      pinnedTokens += source.tokenEstimate;
      continue;
    }
    const content = source.content.slice(0, remaining * 4).trimEnd();
    if (content) {
      boundedPinned.push({ ...source, content: `${content}\n[truncated to pinned-context budget]`, tokenEstimate: remaining });
      pinnedTokens += remaining;
    }
    pinnedOverflow.push(source);
  }
  const sourceTokens = sessionId
    ? Number((getDb().prepare(`
        SELECT COALESCE(SUM(tokenEstimate), 0) AS tokens FROM context_sources
        WHERE scopeType = 'session' AND scopeId = ? AND active = 1
      `).get(sessionId) as { tokens: number }).tokens)
    : input.messages.reduce((sum, message) => sum + estimateContextTokens(message.content), 0);
  const compactedIds = new Set(compactions.flatMap((item) => item.sourceIds));
  const systemParts: string[] = [];
  if (compactions.length) {
    systemParts.push([
      '## Durable earlier-session context',
      `Session scope: ${sessionId}`,
      'The following deterministic compactions cover turns older than the bounded replay below.',
      'Each claim cites a durable source ID. Use session_search to retrieve exact wording before relying on omitted detail.',
      boundedSummary.text,
    ].join('\n'));
  }
  if (pinned.length) {
    systemParts.push([
      '## Pinned session context',
      ...boundedPinned.map((source) => `- [source:${source.sourceId}] ${source.content}`),
      ...(pinnedOverflow.length ? [
        `- ${pinnedOverflow.length} additional pinned source(s) are citation-only because the ${maxPinnedTokens}-token pin budget is full.`,
        ...pinnedOverflow.slice(0, 50).map((source) => `  - [source:${source.sourceId}] use session_search for exact content`),
      ] : []),
    ].join('\n'));
  }
  const meter: ContextWindowMeter = {
    ...(input.model ? { model: input.model } : {}),
    sourceTokens,
    summaryTokens,
    replayTokens: replay.tokens,
    pinnedTokens,
    pinnedOverflowCount: pinnedOverflow.length,
    maxPinnedTokens,
    attachmentTokens: replay.attachmentTokens,
    totalTokens: summaryTokens + replay.tokens + pinnedTokens,
    sourceCount: input.messages.length,
    summaryCount: compactions.length,
    replayCount: replay.messages.length,
    compactedSourceCount: compactedIds.size,
    maxReplayTokens,
    breakdown: {
      messageTokens: Math.max(0, replay.tokens - replay.attachmentTokens),
      toolResultTokens: 0,
      projectTokens: 0,
      runTokens: 0,
      otherTokens: summaryTokens + pinnedTokens,
    },
  };
  if (replay.messages.length < input.messages.length && !compactions.length) {
    systemParts.push(
      `Earlier turns were bounded for this request (${input.messages.length - replay.messages.length} omitted). `
      + 'No durable session ID was supplied, so ask the user rather than reconstructing them.',
    );
  }
  systemParts.push(
    `Context meter: replay ${meter.replayTokens}/${meter.maxReplayTokens} estimated tokens; `
    + `${meter.replayCount}/${meter.sourceCount} recent sources; ${meter.compactedSourceCount} compacted; `
    + `${meter.pinnedTokens}/${meter.maxPinnedTokens} pinned tokens; ${meter.pinnedOverflowCount || 0} citation-only pins.`,
  );
  const citations = [...pinned.map(rowToCitationFromRecord)];
  for (const id of boundedSummary.sourceIds) {
      const row = getDb().prepare('SELECT * FROM context_sources WHERE id = ?').get(id) as unknown as SourceRow | undefined;
      if (row) citations.push(rowToCitation(row));
  }
  return {
    systemContext: systemParts.join('\n\n'),
    replayMessages: replay.messages,
    meter,
    citations: uniqueCitations(citations),
  };
}

function rowToCitationFromRecord(source: ContextSourceRecord): ContextSourceCitation {
  return {
    sourceId: source.sourceId,
    scopeType: source.scopeType,
    scopeId: source.scopeId,
    sourceType: source.sourceType,
    sourceKey: source.sourceKey,
    ...(source.projectId ? { projectId: source.projectId } : {}),
    ...(source.runId ? { runId: source.runId } : {}),
    ...(source.role ? { role: source.role } : {}),
    createdAt: source.createdAt,
  };
}

function uniqueCitations(citations: ContextSourceCitation[]): ContextSourceCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (seen.has(citation.sourceId)) return false;
    seen.add(citation.sourceId);
    return true;
  });
}

function searchTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])].slice(0, 16);
}

function excerptAround(content: string, terms: string[], max = 900): string {
  const lower = content.toLocaleLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return clip(content, max);
  const start = Math.max(0, index - Math.floor(max * 0.35));
  const end = Math.min(content.length, start + max);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

function adjacentBookend(row: SourceRow, direction: 'before' | 'after'): { sourceId: string; role?: string; excerpt: string } | undefined {
  const op = direction === 'before' ? '<' : '>';
  const order = direction === 'before' ? 'DESC' : 'ASC';
  const adjacent = getDb().prepare(`
    SELECT * FROM context_sources
    WHERE scopeType = ? AND scopeId = ? AND active = 1 AND ordinal ${op} ?
    ORDER BY ordinal ${order} LIMIT 1
  `).get(row.scopeType, row.scopeId, row.ordinal) as unknown as SourceRow | undefined;
  if (!adjacent) return undefined;
  return {
    sourceId: adjacent.id,
    ...(adjacent.role ? { role: adjacent.role } : {}),
    excerpt: clip(adjacent.content.replace(/\s+/g, ' '), 220),
  };
}

export function searchContext(input: {
  query: string;
  scopeType?: ContextScopeType;
  scopeId?: string;
  projectId?: string;
  runId?: string;
  maxResults?: number;
  maxChars?: number;
}): ContextSearchResult {
  ensureContextSchema();
  const query = clip(input.query, 500);
  if (!query) throw new Error('query is required');
  const maxResults = boundedInt(input.maxResults, 8, 1, 20);
  const maxChars = boundedInt(input.maxChars, 8_000, 500, 30_000);
  const where = ['active = 1'];
  const params: Array<string | number> = [];
  if (input.scopeType) { where.push('scopeType = ?'); params.push(input.scopeType); }
  if (input.scopeId) { where.push('scopeId = ?'); params.push(input.scopeId); }
  if (input.projectId) { where.push('projectId = ?'); params.push(input.projectId); }
  if (input.runId) { where.push('runId = ?'); params.push(input.runId); }
  const rows = getDb().prepare(`
    SELECT * FROM context_sources
    WHERE ${where.join(' AND ')}
    ORDER BY pinned DESC, updatedAt DESC
    LIMIT ?
  `).all(...params, SEARCH_CANDIDATE_LIMIT) as unknown as SourceRow[];
  const terms = searchTerms(query);
  const exact = query.toLocaleLowerCase();
  const scored = rows.map((row) => {
    const lower = row.content.toLocaleLowerCase();
    const matchTerms = terms.filter((term) => lower.includes(term));
    const hasExactMatch = lower.includes(exact);
    let score = matchTerms.reduce((sum, term) => {
      const occurrences = lower.split(term).length - 1;
      return sum + Math.min(occurrences, 5) * 4;
    }, 0);
    if (hasExactMatch) score += 30;
    // Pinning and role only break ties among actual textual matches; unrelated
    // pinned constraints must never pollute bounded retrieval results.
    if (score > 0 && row.pinned) score += 12;
    if (score > 0 && row.role === 'user') score += 1;
    return { row, score, matchTerms };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.row.updatedAt.localeCompare(a.row.updatedAt));
  const matches: ContextMatchWindow[] = [];
  let returnedChars = 0;
  for (const item of scored) {
    if (matches.length >= maxResults || returnedChars >= maxChars) break;
    const remaining = maxChars - returnedChars;
    const content = excerptAround(item.row.content, item.matchTerms, Math.min(900, remaining));
    if (!content) continue;
    matches.push({
      citation: rowToCitation(item.row),
      content,
      score: item.score,
      matchTerms: item.matchTerms,
      before: adjacentBookend(item.row, 'before'),
      after: adjacentBookend(item.row, 'after'),
    });
    returnedChars += content.length;
  }
  return {
    query,
    matches,
    limits: {
      maxResults,
      maxChars,
      returnedChars,
      candidatesScanned: rows.length,
      truncated: scored.length > matches.length,
    },
  };
}

export function getContextSource(sourceIdValue: string): {
  source: ContextSourceRecord;
  before?: { sourceId: string; role?: string; excerpt: string };
  after?: { sourceId: string; role?: string; excerpt: string };
} {
  ensureContextSchema();
  const row = getDb().prepare(`
    SELECT * FROM context_sources WHERE id = ? AND active = 1
  `).get(sourceIdValue) as unknown as SourceRow | undefined;
  if (!row) throw new Error('Context source not found');
  return {
    source: rowToSource(row),
    before: adjacentBookend(row, 'before'),
    after: adjacentBookend(row, 'after'),
  };
}

export function inspectContextScope(
  scopeType: ContextScopeType,
  scopeId: string,
  options: { sourceLimit?: number; sourceOffset?: number } = {},
): ContextScopeInspection {
  ensureContextSchema();
  const sourceLimit = boundedInt(options.sourceLimit, 200, 1, 500);
  const sourceOffset = boundedInt(options.sourceOffset, 0, 0, 1_000_000);
  const totalSources = Number((getDb().prepare(`
    SELECT COUNT(*) AS count FROM context_sources
    WHERE scopeType = ? AND scopeId = ? AND active = 1
  `).get(scopeType, scopeId) as { count: number }).count);
  const totals = getDb().prepare(`
    SELECT
      COALESCE(SUM(tokenEstimate), 0) AS sourceTokens,
      COALESCE(SUM(CASE WHEN pinned = 1 THEN tokenEstimate ELSE 0 END), 0) AS pinnedTokens,
      COALESCE(SUM(CASE WHEN sourceType = 'message' THEN tokenEstimate ELSE 0 END), 0) AS messageTokens,
      COALESCE(SUM(CASE WHEN sourceType = 'run_trace' THEN tokenEstimate ELSE 0 END), 0) AS toolResultTokens,
      COALESCE(SUM(CASE WHEN sourceType IN ('project', 'project_file') THEN tokenEstimate ELSE 0 END), 0) AS projectTokens,
      COALESCE(SUM(CASE WHEN sourceType IN ('run_prompt', 'run_output') THEN tokenEstimate ELSE 0 END), 0) AS runTokens
    FROM context_sources
    WHERE scopeType = ? AND scopeId = ? AND active = 1
  `).get(scopeType, scopeId) as {
    sourceTokens: number;
    pinnedTokens: number;
    messageTokens: number;
    toolResultTokens: number;
    projectTokens: number;
    runTokens: number;
  };
  const sources = (getDb().prepare(`
    SELECT * FROM context_sources
    WHERE scopeType = ? AND scopeId = ? AND active = 1
    ORDER BY ordinal ASC
    LIMIT ? OFFSET ?
  `).all(scopeType, scopeId, sourceLimit, sourceOffset) as unknown as SourceRow[]).map(rowToSource);
  const compactions = listCompactions(scopeType, scopeId);
  const state = getDb().prepare(`
    SELECT indexedAt, compactedAt FROM context_scope_state WHERE scopeType = ? AND scopeId = ?
  `).get(scopeType, scopeId) as { indexedAt?: string; compactedAt?: string } | undefined;
  const compacted = new Set(compactions.flatMap((item) => item.sourceIds));
  const summaryTokens = compactions.reduce((sum, item) => sum + item.tokenEstimate, 0);
  const meter: ContextWindowMeter = {
    sourceTokens: Number(totals.sourceTokens),
    summaryTokens,
    replayTokens: 0,
    pinnedTokens: Number(totals.pinnedTokens),
    attachmentTokens: 0,
    totalTokens: Number(totals.sourceTokens) + summaryTokens,
    sourceCount: totalSources,
    summaryCount: compactions.length,
    replayCount: 0,
    compactedSourceCount: compacted.size,
    maxReplayTokens: DEFAULT_REPLAY_TOKENS,
    breakdown: {
      messageTokens: Number(totals.messageTokens),
      toolResultTokens: Number(totals.toolResultTokens),
      projectTokens: Number(totals.projectTokens),
      runTokens: Number(totals.runTokens),
      otherTokens: Math.max(0, Number(totals.sourceTokens)
        - Number(totals.messageTokens)
        - Number(totals.toolResultTokens)
        - Number(totals.projectTokens)
        - Number(totals.runTokens)),
    },
  };
  return {
    scopeType,
    scopeId,
    sources,
    compactions,
    meter,
    ...(state?.indexedAt ? { indexedAt: state.indexedAt } : {}),
    ...(state?.compactedAt ? { compactedAt: state.compactedAt } : {}),
    pagination: {
      sourceLimit,
      sourceOffset,
      totalSources,
      returnedSources: sources.length,
      truncated: sourceOffset + sources.length < totalSources,
    },
  };
}

function scopeNeedsIndex(scopeType: ContextScopeType, scopeId: string, entityUpdatedAt: string): boolean {
  ensureContextSchema();
  const state = getDb().prepare(`
    SELECT indexedAt FROM context_scope_state WHERE scopeType = ? AND scopeId = ?
  `).get(scopeType, scopeId) as { indexedAt?: string } | undefined;
  return !state?.indexedAt || state.indexedAt < entityUpdatedAt;
}

/** One-time/lazy bootstrap for data created before the context index existed. */
export async function backfillContextIndexes(options: { maxRuns?: number } = {}): Promise<{
  sessions: number;
  projects: number;
  runs: number;
}> {
  ensureContextSchema();
  let sessionCount = 0;
  let projectCount = 0;
  let runCount = 0;
  const { listChatSessions } = await import('./chat-sessions');
  for (const session of await listChatSessions({ includeArchived: true })) {
    if (!scopeNeedsIndex('session', session.id, session.updatedAt)) continue;
    indexSessionContext(session);
    sessionCount += 1;
  }
  const { listProjects } = await import('./projects');
  for (const project of await listProjects()) {
    if (!scopeNeedsIndex('project', project.id, project.updatedAt)) continue;
    indexProjectContext(project);
    projectCount += 1;
  }
  const maxRuns = boundedInt(options.maxRuns, 500, 1, 2_000);
  const rows = getDb().prepare(`
    SELECT r.* FROM runs r
    LEFT JOIN context_scope_state state
      ON state.scopeType = 'run' AND state.scopeId = r.id
    WHERE state.indexedAt IS NULL
       OR state.indexedAt < COALESCE(r.completedAt, r.startedAt)
    ORDER BY r.startedAt DESC
    LIMIT ?
  `).all(maxRuns) as Array<Record<string, unknown>>;
  for (const row of rows) {
    indexRunContext({
      id: String(row.id),
      taskId: row.taskId ? String(row.taskId) : undefined,
      attemptNo: row.attemptNo == null ? undefined : Number(row.attemptNo),
      agentId: String(row.agentId || ''),
      agentName: String(row.agentName || ''),
      model: String(row.model || ''),
      status: String(row.status || 'completed') as AgentRun['status'],
      prompt: String(row.prompt || ''),
      startedAt: String(row.startedAt || ''),
      completedAt: row.completedAt ? String(row.completedAt) : undefined,
      finalOutput: row.finalOutput ? String(row.finalOutput) : undefined,
      projectId: row.projectId ? String(row.projectId) : undefined,
      scheduleId: row.scheduleId ? String(row.scheduleId) : undefined,
      scheduleInstructions: row.scheduleInstructions ? String(row.scheduleInstructions) : undefined,
      workspaceSnapshot: row.workspaceSnapshot ? String(row.workspaceSnapshot) : undefined,
      trace: parseJson(String(row.trace || '[]'), []),
      sideEffects: parseJson(String(row.sideEffects || '[]'), []),
    });
    runCount += 1;
  }
  return { sessions: sessionCount, projects: projectCount, runs: runCount };
}

export function isContextScopeType(value: string): value is ContextScopeType {
  return value === 'session' || value === 'project' || value === 'run';
}
