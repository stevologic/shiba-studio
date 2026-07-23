/**
 * Live Meetings (Beta) engine — spoken, agent-led project reviews.
 *
 * A meeting is a turn-based conversation between the creator (director) and
 * one agent (senior engineer). The agent leads: it presents delivered work
 * grounded in a server-built project brief and puts visuals on the stage
 * (real code excerpts, diagrams, markdown notes, live screenshots). Ending a
 * meeting produces minutes — summary, direction, decisions, todos — and the
 * todos become Board cards only after explicit confirmation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDb } from './db';
import { emitAppEvent } from './app-events';
import { audit } from './audit-log';
import { grokChat } from './grok-client';
import { grokChatStream } from './grok-chat-stream';
import { loadAgents, loadConfig } from './persistence';
import { buildProjectChatContext, getProject } from './projects';
import { createBoardTask, listBoardTasks } from './board';
import { buildAgentChatSystem } from './chat-skill';
import { normalizeAgent, type Agent, type AppConfig } from './types';
import { resolveProjectWorkspace } from './project-types';
import { parseModelRef } from './model-providers';
import { readIdeTextFile } from './ide-workspace';
import {
  LIVE_MEETING_MAX_TODOS,
  LIVE_MEETING_MAX_TURNS,
  type LiveMeetingMinutes,
  type LiveMeetingRecord,
  type LiveMeetingStatus,
  type LiveMeetingStreamEvent,
  type LiveMeetingTodo,
  type LiveMeetingTurn,
  type MeetingDiagramVisual,
  type MeetingVisual,
} from './live-meeting-types';

const execFileAsync = promisify(execFile);

const MAX_TURN_HISTORY = 24;
const MAX_CODE_LINES = 80;
const MAX_SAY_CHARS = 4_000;
const MAX_MARKDOWN_CHARS = 6_000;
const SKIP_TREE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.cache', '.venv', 'venv', '__pycache__', 'vendor', 'target',
]);

interface LiveMeetingRow {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  projectId: string | null;
  projectName: string;
  focus: string;
  status: string;
  pendingTurn: number;
  turns: string;
  minutes: string | null;
  brief: string;
  workspacePath: string;
  error: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  deletedAt: string | null;
}

const initializedHandles = new WeakSet<object>();

/** Guarded extension schema — deployable without bumping the main DB version. */
export function ensureLiveMeetingSchema(): void {
  const db = getDb();
  if (initializedHandles.has(db as object)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agentId TEXT NOT NULL,
      agentName TEXT NOT NULL,
      projectId TEXT,
      projectName TEXT NOT NULL DEFAULT '',
      focus TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      pendingTurn INTEGER NOT NULL DEFAULT 0,
      turns TEXT NOT NULL DEFAULT '[]',
      minutes TEXT,
      brief TEXT NOT NULL DEFAULT '',
      workspacePath TEXT NOT NULL DEFAULT '',
      error TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      endedAt TEXT,
      deletedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_live_meetings_updated ON live_meetings(deletedAt, updatedAt DESC);
  `);
  initializedHandles.add(db as object);
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanText(value: unknown, max: number, required = false): string {
  const text = String(value ?? '').trim().slice(0, max);
  if (required && !text) throw new Error('Required meeting field is empty');
  return text;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function assertLiveMeetingId(id: string): string {
  const value = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error('Invalid meeting id');
  return value;
}

function rowToRecord(row: LiveMeetingRow): LiveMeetingRecord {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agentId,
    agentName: row.agentName,
    projectId: row.projectId,
    projectName: row.projectName,
    focus: row.focus,
    status: row.status as LiveMeetingStatus,
    turns: parseJson<LiveMeetingTurn[]>(row.turns, []),
    minutes: parseJson<LiveMeetingMinutes | null>(row.minutes, null),
    ...(row.error ? { error: row.error } : {}),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.endedAt ? { endedAt: row.endedAt } : {}),
  };
}

function meetingRow(id: string): LiveMeetingRow | undefined {
  ensureLiveMeetingSchema();
  return getDb().prepare('SELECT * FROM live_meetings WHERE id = ? AND deletedAt IS NULL')
    .get(assertLiveMeetingId(id)) as unknown as LiveMeetingRow | undefined;
}

export function getLiveMeeting(id: string): LiveMeetingRecord | null {
  const row = meetingRow(id);
  return row ? rowToRecord(row) : null;
}

export function listLiveMeetings(limit = 100): LiveMeetingRecord[] {
  ensureLiveMeetingSchema();
  const rows = getDb().prepare('SELECT * FROM live_meetings WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, Number(limit) || 100))) as unknown as LiveMeetingRow[];
  return rows.map(rowToRecord);
}

/**
 * Soft-delete a meeting and scrub its payload.
 *
 * Board cards created from minutes are intentionally kept (they are separate
 * Board ownership). Transcript turns (including any screenshot data URLs),
 * minutes, and the project brief are wiped so delete frees storage and matches
 * the lobby confirmation copy.
 */
export function deleteLiveMeeting(id: string): void {
  const row = meetingRow(id);
  if (!row) throw new Error('Meeting not found');
  if (row.status === 'summarizing') throw new Error('Wait for the minutes to finish before deleting this meeting');
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE live_meetings SET
      deletedAt = ?,
      pendingTurn = 0,
      turns = '[]',
      minutes = NULL,
      brief = '',
      error = NULL,
      version = version + 1,
      updatedAt = ?
    WHERE id = ? AND version = ? AND deletedAt IS NULL AND status != 'summarizing'
  `).run(now, now, row.id, row.version);
  if (Number(result.changes) !== 1) throw new Error('Meeting changed concurrently; reload and retry');
  audit('run', 'live meeting deleted', row.title, { meetingId: row.id });
  emitAppEvent('meetings');
}

/* ── Project brief ── */

async function workspaceTree(root: string): Promise<string> {
  const lines: string[] = [];
  const maxLines = 200;
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 4 || lines.length >= maxLines) return;
    let entries;
    try {
      entries = await fs.readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= maxLines) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isDirectory()) {
        if (SKIP_TREE_DIRS.has(entry.name)) continue;
        lines.push(`${prefix}${entry.name}/`);
        await walk(path.join(dir, entry.name), `${prefix}  `, depth + 1);
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }
  }
  await walk(root, '', 1);
  if (!lines.length) return '(workspace is empty or unreadable)';
  return lines.join('\n') + (lines.length >= maxLines ? '\n… (tree truncated)' : '');
}

async function recentCommits(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--oneline', '--no-decorate', '-15'],
      { cwd: root, timeout: 10_000, windowsHide: true },
    );
    return stdout.trim() || '(no commits yet)';
  } catch {
    return '(not a git repository)';
  }
}

async function boardSnapshot(projectId: string | null): Promise<string> {
  try {
    const tasks = (await listBoardTasks()).filter((task) => !projectId || task.projectId === projectId);
    if (!tasks.length) return projectId ? '(no Board cards for this project yet)' : '(the Board is empty)';
    const counts = new Map<string, number>();
    for (const task of tasks) counts.set(task.status, (counts.get(task.status) || 0) + 1);
    const open = tasks.filter((task) => ['backlog', 'todo', 'in_progress', 'review'].includes(task.status)).slice(0, 25);
    const done = tasks.filter((task) => task.status === 'done').slice(-10);
    return [
      [...counts.entries()].map(([status, count]) => `${status}: ${count}`).join(', '),
      ...open.map((task) => `- [${task.status}] ${task.key} ${task.title}`),
      ...(done.length ? ['Recently done:', ...done.map((task) => `- ${task.key} ${task.title}`)] : []),
    ].join('\n');
  } catch {
    return '(Board unavailable)';
  }
}

async function resolveMeetingWorkspace(projectId: string | null, agent: Agent, config: AppConfig): Promise<string> {
  if (projectId) {
    const project = await getProject(projectId);
    if (project) {
      const resolved = resolveProjectWorkspace(project, config.defaultWorkspace);
      if (resolved?.trim()) return resolved.trim();
    }
  }
  return agent.workspace?.path?.trim() || config.defaultWorkspace?.trim() || '';
}

async function buildMeetingBrief(input: {
  projectId: string | null;
  agent: Agent;
  config: AppConfig;
  workspacePath: string;
  focus: string;
}): Promise<string> {
  const sections: string[] = [];
  if (input.projectId) {
    const project = await getProject(input.projectId);
    if (project) {
      sections.push('=== Project context ===\n' + await buildProjectChatContext(project, input.config.defaultWorkspace));
    }
  }
  if (!sections.length) sections.push('=== Project context ===\n(no Studio project attached — review the workspace itself)');
  sections.push('=== Board snapshot ===\n' + await boardSnapshot(input.projectId));
  if (input.workspacePath) {
    sections.push(`=== Workspace file tree (${input.workspacePath}, partial) ===\n` + await workspaceTree(input.workspacePath));
    sections.push('=== Recent commits ===\n' + await recentCommits(input.workspacePath));
  } else {
    sections.push('=== Workspace ===\n(no workspace configured — code visuals are unavailable)');
  }
  if (input.focus) sections.push(`=== Meeting focus from the director ===\n${input.focus}`);
  return sections.join('\n\n');
}

/* ── Turn engine ── */

const MEETING_ROLE = [
  'You are in a live Meetings (Beta) session: a spoken project review between you — the senior engineer who has been building this project — and the creator, who directs it.',
  'You LEAD the meeting. Present what has been implemented, walk through the work like a delivery review, and propose direction — but always yield to what the director wants to discuss.',
  'Speaking style: natural spoken language that will be read aloud, 2 to 5 short sentences per turn. No markdown, bullet lists, code, URLs, or emoji inside the spoken text. Be concrete: name real files, features, commits, and Board cards from the project material below.',
  'Everything you have put on the stage stays in this conversation, with its content included for recent visuals. When the director says "explain it", "walk me through this", or similar, they mean what is on the stage — use that included content directly instead of asking what they mean.',
  'Never invent files, code, commits, or decisions. If you are unsure something exists, say so and offer to check together.',
].join('\n');

const VISUAL_CONTRACT = [
  'Respond with STRICT JSON only — one object, no code fences, no text outside it:',
  '{"say":"...","visual":<visual or null>,"suggestions":["...","..."]}',
  '"say" — your spoken turn.',
  '"visual" — at most one visual to put on the meeting stage, or null. Show something real every turn or two. One of:',
  '  {"kind":"code","title":"...","path":"relative/path/from/tree","startLine":N,"endLine":M} — the studio reads the REAL file and shows exactly those lines. Only reference paths from the workspace file tree. Keep ranges under 60 lines.',
  '  {"kind":"diagram","title":"...","nodes":[{"id":"a","label":"...","emphasis":true}],"edges":[{"from":"a","to":"b","label":"..."}]} — architecture or flow diagram, 3 to 10 nodes; set emphasis on the nodes you are discussing.',
  '  {"kind":"markdown","title":"...","body":"..."} — notes, status tables, comparisons, checklists. Structure the body with ## section headings (the stage renders each section as a side-by-side card), markdown tables for comparisons, and bullet checklists — never a wall of prose. Shiba-card fences (see the rich-card kinds above) render as live cards on the stage: prefer a stats, progress, checklist, timeline, or callout card whenever the data fits one. Keep sections short enough to read at a glance.',
  '  {"kind":"screenshot","title":"...","url":"http://..."} — live capture of a RUNNING app URL. Only use it when the director said the app is running or asked to see it, with a URL you know.',
  '"suggestions" — 2 to 4 short directions the director could take next, phrased as things they might say (for example "Show me the riskiest code path"). Steer toward review depth, strategy, and decisions.',
].join('\n');

interface TurnPayload { say?: unknown; visual?: unknown; suggestions?: unknown }

function parseModelJson<T>(content: string): T {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Meeting model reply did not contain JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

/**
 * Progressive spoken-text extractor for partial model JSON.
 * Models typically emit `"say"` first; as tokens arrive we surface as much of
 * that string as is safely decodable so the room can stream TTS mid-turn.
 */
export function extractPartialSay(raw: string, maxChars = MAX_SAY_CHARS): string {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '');
  const match = cleaned.match(/"say"\s*:\s*"/);
  if (!match || match.index == null) return '';
  let i = match.index + match[0].length;
  let out = '';
  while (i < cleaned.length && out.length < maxChars) {
    const ch = cleaned[i];
    if (ch === '\\') {
      if (i + 1 >= cleaned.length) break; // incomplete escape — wait for more tokens
      const next = cleaned[i + 1];
      if (next === 'n') { out += '\n'; i += 2; continue; }
      if (next === 't') { out += '\t'; i += 2; continue; }
      if (next === 'r') { out += '\r'; i += 2; continue; }
      if (next === '"' || next === '\\' || next === '/') { out += next; i += 2; continue; }
      if (next === 'u') {
        const hex = cleaned.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      break;
    }
    if (ch === '"') break;
    out += ch;
    i += 1;
  }
  return out.slice(0, maxChars);
}

interface PreparedTurn {
  row: LiveMeetingRow;
  agent: Agent;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

/** Claim the meeting and assemble the model prompt for one agent turn. */
async function prepareLiveMeetingTurn(
  id: string,
  creatorTextInput: string | null | undefined,
  options?: { stageTurnId?: string },
): Promise<PreparedTurn> {
  const creatorText = cleanText(creatorTextInput, MAX_SAY_CHARS) || null;
  // Claim first so concurrent turns fail fast; any failure after the claim
  // must release pendingTurn so the room is never stuck mid-turn.
  const row = claimTurn(id, creatorText);
  try {
    const agent = await requireAgent(row.agentId);
    const config = await loadConfig();
    const model = resolveMeetingModel(agent, config);
    const turns = parseJson<LiveMeetingTurn[]>(row.turns, []);
    const history = turns.slice(-MAX_TURN_HISTORY);

    // Everything displayed on the stage is carried into the conversation: the
    // most recent visuals — and whichever one the director is looking at right
    // now — keep their full content, so "explain this" has the real thing.
    const stageTurnId = cleanText(options?.stageTurnId, 160) || null;
    const fullVisualIds = new Set(
      history.filter((turn) => turn.visual).map((turn) => turn.id).slice(-FULL_VISUAL_CONTEXT_TURNS),
    );
    if (stageTurnId) fullVisualIds.add(stageTurnId);
    const stageTurn = stageTurnId
      ? turns.find((turn) => turn.id === stageTurnId && turn.visual) || null
      : null;

    const system = [
      buildAgentChatSystem(agent),
      MEETING_ROLE,
      row.brief,
      VISUAL_CONTRACT,
      ...(stageTurn?.visual
        ? [`The director's stage currently shows: "${stageTurn.visual.title}" (${stageTurn.visual.kind}). When they say "this" or "it" about something displayed, they mean that visual unless they say otherwise.`]
        : []),
    ].join('\n\n');
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: system },
    ];
    for (const turn of history) {
      if (turn.role === 'creator') {
        messages.push({ role: 'user', content: turn.text });
        continue;
      }
      const parts = [turnSummaryLine(row, turn)];
      if (turn.visual && fullVisualIds.has(turn.id)) parts.push(visualContextBlock(turn.visual));
      messages.push({ role: 'assistant', content: parts.join('\n') });
    }
    if (!creatorText) {
      messages.push({
        role: 'user',
        content: turns.length === 0
          ? '(The meeting starts.) Open it: greet the director briefly, then present the current state of the project like a senior engineer opening a delivery review — what was built recently, what is in flight, and what you want feedback on. Put an opening visual on the stage: an architecture diagram of the project or a markdown brief of recent work.'
          : '(The director is listening.) Continue leading the review with the next most useful part of the project.',
      });
    }
    return { row, agent, model, messages };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
    try { settleTurn(row.id, () => {}, message); } catch { /* meeting deleted mid-prep */ }
    emitAppEvent('meetings');
    throw error;
  }
}

/** Parse a completed model reply, resolve the visual, and settle the claim. */
async function settleAgentReply(row: LiveMeetingRow, content: string): Promise<LiveMeetingRecord> {
  let say: string;
  let visual: MeetingVisual | undefined;
  let suggestions: string[];
  try {
    const payload = parseModelJson<TurnPayload>(content);
    say = cleanText(payload.say, MAX_SAY_CHARS, true);
    visual = await resolveVisual(payload.visual, row.workspacePath);
    suggestions = normalizeSuggestions(payload.suggestions);
  } catch {
    // Tolerate an off-contract reply — keep the words, drop the stage update.
    say = cleanText(content, MAX_SAY_CHARS, true);
    visual = undefined;
    suggestions = [];
  }
  settleTurn(row.id, (all) => {
    all.push({
      id: randomUUID(),
      role: 'agent',
      text: say,
      at: nowIso(),
      ...(visual ? { visual } : {}),
      ...(suggestions.length ? { suggestions } : {}),
    });
  }, null);
  emitAppEvent('meetings');
  const record = getLiveMeeting(row.id);
  if (!record) throw new Error('Meeting was deleted during the turn');
  return record;
}

function languageForPath(filePath: string, fallback: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx', '.mjs': 'javascript',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.rb': 'ruby', '.java': 'java', '.cs': 'csharp',
    '.css': 'css', '.html': 'html', '.json': 'json', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml',
    '.sql': 'sql', '.sh': 'bash', '.ps1': 'powershell', '.toml': 'toml',
  };
  return map[ext] || cleanText(fallback, 30) || 'text';
}

/** Resolve the model's visual request into a stage-ready visual. Code is read
 *  from the real workspace file so excerpts can never be hallucinated. */
async function resolveVisual(raw: unknown, workspacePath: string): Promise<MeetingVisual | undefined> {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const kind = String(value.kind || '');
  const title = cleanText(value.title, 200) || 'Untitled visual';
  try {
    if (kind === 'code') {
      if (!workspacePath) return undefined;
      const relative = cleanText(value.path, 500, true).replace(/\\/g, '/');
      const file = await readIdeTextFile(workspacePath, relative);
      const lines = file.content.split(/\r?\n/);
      const start = Math.max(1, Math.min(Number(value.startLine) || 1, lines.length));
      const end = Math.max(start, Math.min(Number(value.endLine) || start + 39, lines.length, start + MAX_CODE_LINES - 1));
      const code = lines.slice(start - 1, end).join('\n').slice(0, 12_000);
      if (!code.trim()) return undefined;
      return { kind: 'code', title, path: relative, language: languageForPath(relative, String(value.language || '')), startLine: start, endLine: end, code };
    }
    if (kind === 'diagram') {
      const nodes = (Array.isArray(value.nodes) ? value.nodes : []).slice(0, 12).flatMap((node) => {
        const n = node as Record<string, unknown>;
        const id = cleanText(n.id, 60);
        const label = cleanText(n.label, 120);
        if (!id || !label) return [];
        return [{ id, label, ...(n.emphasis === true ? { emphasis: true } : {}) }];
      });
      if (nodes.length < 2) return undefined;
      const ids = new Set(nodes.map((node) => node.id));
      const edges = (Array.isArray(value.edges) ? value.edges : []).slice(0, 24).flatMap((edge) => {
        const e = edge as Record<string, unknown>;
        const from = cleanText(e.from, 60);
        const to = cleanText(e.to, 60);
        if (!ids.has(from) || !ids.has(to) || from === to) return [];
        const label = cleanText(e.label, 80);
        return [{ from, to, ...(label ? { label } : {}) }];
      });
      return { kind: 'diagram', title, nodes, edges } satisfies MeetingDiagramVisual;
    }
    if (kind === 'markdown') {
      const body = cleanText(value.body, MAX_MARKDOWN_CHARS);
      if (!body) return undefined;
      return { kind: 'markdown', title, body };
    }
    if (kind === 'screenshot') {
      const url = cleanText(value.url, 1_000);
      if (!/^https?:\/\//i.test(url)) return undefined;
      const runId = `live-meeting-${randomUUID().slice(0, 8)}`;
      const { browserNavigate, browserViewportShot, closeRunPage } = await import('./browser');
      try {
        const nav = await browserNavigate(url, runId);
        if (!nav.ok) return undefined;
        const shot = await browserViewportShot(runId);
        if (!shot.dataUrl) return undefined;
        return { kind: 'screenshot', title, url, src: shot.dataUrl };
      } finally {
        await closeRunPage(runId).catch(() => {});
      }
    }
  } catch (error) {
    // Expected when the model references a file that doesn't exist — the
    // visual is dropped rather than invented. One line, no stack.
    console.error(`[shiba-studio] live meeting ${kind} visual dropped: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
  return undefined;
}

function normalizeSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 4);
}

/** How many of the most recent visuals keep their FULL content in the model
 *  conversation. Older ones fall back to one-line summaries to bound tokens. */
const FULL_VISUAL_CONTEXT_TURNS = 3;

/** Full stage content for the model — what "it"/"this" refers to when the
 *  director asks about something being displayed. */
function visualContextBlock(visual: MeetingVisual): string {
  if (visual.kind === 'code') {
    return `[On stage — code "${visual.title}" (${visual.path} lines ${visual.startLine}-${visual.endLine})]\n\`\`\`${visual.language}\n${visual.code}\n\`\`\``;
  }
  if (visual.kind === 'diagram') {
    const nodes = visual.nodes.map((node) => `${node.id} = "${node.label}"${node.emphasis ? ' (emphasized)' : ''}`).join('; ');
    const edges = visual.edges.length
      ? visual.edges.map((edge) => `${edge.from} -> ${edge.to}${edge.label ? ` [${edge.label}]` : ''}`).join('; ')
      : '(none)';
    return `[On stage — diagram "${visual.title}"]\nNodes: ${nodes}\nEdges: ${edges}`;
  }
  if (visual.kind === 'markdown') {
    return `[On stage — notes "${visual.title}"]\n${visual.body}`;
  }
  return `[On stage — live screenshot "${visual.title}" captured from ${visual.url}. The pixels are not re-readable here; ask the director what they see when details matter.]`;
}

function turnSummaryLine(record: { agentName: string }, turn: LiveMeetingTurn): string {
  const who = turn.role === 'creator' ? 'Director' : record.agentName;
  const visual = turn.visual
    ? turn.visual.kind === 'code'
      ? ` [showed code: ${turn.visual.title} — ${turn.visual.path}:${turn.visual.startLine}-${turn.visual.endLine}]`
      : ` [showed ${turn.visual.kind}: ${turn.visual.title}]`
    : '';
  return `${who}: ${turn.text}${visual}`;
}

function resolveMeetingModel(agent: Agent, config: AppConfig): string {
  // Prefer the agent's own model when it is a cloud model; the meeting flow
  // needs the hosted chat API (CLI/local agents fall back to the app default).
  const agentRef = agent.model ? parseModelRef(agent.model) : null;
  if (agentRef?.provider === 'cloud') return agent.model;
  return config.defaultGrokModel || 'cloud:grok-4';
}

async function requireAgent(agentId: string): Promise<Agent> {
  const agents = (await loadAgents()).map(normalizeAgent);
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error('Meeting agent no longer exists');
  return agent;
}

/** Claim the meeting for one model turn (optionally appending the creator's
 *  words), atomically — a second concurrent turn call gets a clean error. */
function claimTurn(id: string, creatorText: string | null): LiveMeetingRow {
  ensureLiveMeetingSchema();
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM live_meetings WHERE id = ? AND deletedAt IS NULL')
      .get(assertLiveMeetingId(id)) as unknown as LiveMeetingRow | undefined;
    if (!row) throw new Error('Meeting not found');
    if (row.status !== 'active') throw new Error('This meeting has ended');
    if (row.pendingTurn) throw new Error('The agent is already responding; wait for the current turn');
    const turns = parseJson<LiveMeetingTurn[]>(row.turns, []);
    if (turns.length >= LIVE_MEETING_MAX_TURNS) throw new Error('This meeting is at its turn limit — end it to get the minutes');
    if (creatorText) {
      turns.push({ id: randomUUID(), role: 'creator', text: creatorText, at: nowIso() });
    }
    const result = db.prepare(`
      UPDATE live_meetings SET turns = ?, pendingTurn = 1, error = NULL, version = version + 1, updatedAt = ?
      WHERE id = ? AND version = ?
    `).run(JSON.stringify(turns), nowIso(), row.id, row.version);
    if (Number(result.changes) !== 1) throw new Error('Meeting changed concurrently; reload and retry');
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM live_meetings WHERE id = ?').get(row.id) as unknown as LiveMeetingRow;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

function settleTurn(id: string, apply: (turns: LiveMeetingTurn[]) => void, errorMessage: string | null): void {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM live_meetings WHERE id = ?')
      .get(id) as unknown as LiveMeetingRow | undefined;
    // Deleted mid-turn — nothing to settle; the reply is intentionally dropped.
    if (!row || row.deletedAt) { db.exec('ROLLBACK'); return; }
    const turns = parseJson<LiveMeetingTurn[]>(row.turns, []);
    apply(turns);
    const result = db.prepare(`
      UPDATE live_meetings SET turns = ?, pendingTurn = 0, error = ?, version = version + 1, updatedAt = ?
      WHERE id = ? AND version = ?
    `).run(JSON.stringify(turns), errorMessage, nowIso(), row.id, row.version);
    if (Number(result.changes) !== 1) throw new Error('Meeting changed concurrently while settling a turn');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

/**
 * Run one agent turn (non-streaming). `creatorText` is the director's
 * spoken/typed input; null means "the agent keeps leading" (opening turn or
 * continuation). Prefer `streamLiveMeetingTurn` for the live room UI.
 */
export async function runLiveMeetingTurn(
  id: string,
  creatorTextInput?: string | null,
  options?: { stageTurnId?: string },
): Promise<LiveMeetingRecord> {
  let claimedId: string | null = null;
  try {
    const prepared = await prepareLiveMeetingTurn(id, creatorTextInput, options);
    claimedId = prepared.row.id;
    const response = await grokChat({
      model: prepared.model,
      temperature: 0.4,
      max_tokens: 4_096,
      usageContext: { source: 'other', sourceId: 'live-meeting' },
      messages: prepared.messages,
    });
    const content = response.choices[0]?.message?.content || '';
    return await settleAgentReply(prepared.row, content);
  } catch (error) {
    if (claimedId) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
      try { settleTurn(claimedId, () => {}, message); } catch { /* meeting deleted mid-turn */ }
      emitAppEvent('meetings');
    }
    throw error;
  }
}

/**
 * Stream one agent turn over the same Grok streaming path multi-agent chat
 * uses (`grokChatStream` → SSE). Yields progressive `say` deltas as the
 * model emits JSON, then a final durable `meeting` record with visual +
 * suggestions once the turn settles.
 */
export async function* streamLiveMeetingTurn(
  id: string,
  creatorTextInput?: string | null,
  options?: { stageTurnId?: string; signal?: AbortSignal },
): AsyncGenerator<LiveMeetingStreamEvent> {
  let claimedId: string | null = null;
  try {
    const prepared = await prepareLiveMeetingTurn(id, creatorTextInput, options);
    claimedId = prepared.row.id;
    yield { type: 'status', phase: 'thinking' };

    let content = '';
    let emittedSay = '';
    let streamError: string | null = null;

    for await (const event of grokChatStream({
      model: prepared.model,
      temperature: 0.4,
      max_tokens: 4_096,
      signal: options?.signal,
      usageContext: { source: 'other', sourceId: 'live-meeting' },
      messages: prepared.messages,
    })) {
      if (options?.signal?.aborted) {
        throw new Error('Meeting turn cancelled');
      }
      if (event.type === 'error') {
        streamError = event.message || 'Meeting stream failed';
        break;
      }
      if (event.type === 'content' && event.delta) {
        content += event.delta;
        const partial = extractPartialSay(content);
        if (partial.length > emittedSay.length) {
          const delta = partial.slice(emittedSay.length);
          emittedSay = partial;
          yield { type: 'say', delta, text: emittedSay };
        }
      }
    }

    if (streamError) throw new Error(streamError);
    if (!content.trim() && !emittedSay.trim()) {
      throw new Error('Meeting model returned an empty reply');
    }

    yield { type: 'status', phase: 'settling' };
    const meeting = await settleAgentReply(prepared.row, content || JSON.stringify({ say: emittedSay }));
    claimedId = null; // settled successfully
    yield { type: 'meeting', meeting };
    yield { type: 'done' };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
    if (claimedId) {
      try { settleTurn(claimedId, () => {}, message); } catch { /* meeting deleted mid-turn */ }
      emitAppEvent('meetings');
    }
    yield { type: 'error', message };
  }
}

/* ── Lifecycle ── */

export async function createLiveMeeting(input: {
  title?: string;
  agentId: string;
  projectId?: string | null;
  focus?: string;
}): Promise<LiveMeetingRecord> {
  ensureLiveMeetingSchema();
  const agent = await requireAgent(cleanText(input.agentId, 160, true));
  const config = await loadConfig();
  const projectId = cleanText(input.projectId, 160) || null;
  let projectName = '';
  if (projectId) {
    const project = await getProject(projectId);
    if (!project) throw new Error('Meeting project not found');
    projectName = project.name;
  }
  const focus = cleanText(input.focus, 2_000);
  const workspacePath = await resolveMeetingWorkspace(projectId, agent, config);
  const brief = await buildMeetingBrief({ projectId, agent, config, workspacePath, focus });
  const id = randomUUID();
  const now = nowIso();
  const title = cleanText(input.title, 300)
    || `${projectName || agent.name} review — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  getDb().prepare(`
    INSERT INTO live_meetings (
      id, title, agentId, agentName, projectId, projectName, focus, status,
      pendingTurn, turns, minutes, brief, workspacePath, error, version,
      createdAt, updatedAt, endedAt, deletedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, '[]', NULL, ?, ?, NULL, 1, ?, ?, NULL, NULL)
  `).run(id, title, agent.id, agent.name, projectId, projectName, focus, brief, workspacePath, now, now);
  audit('run', 'live meeting started', title, { meetingId: id, agentId: agent.id, projectId });
  emitAppEvent('meetings');
  // Opening turn — the agent leads. A model failure leaves the meeting usable
  // (the room offers "ask the agent to continue" to retry).
  try {
    return await runLiveMeetingTurn(id, null);
  } catch {
    return getLiveMeeting(id)!;
  }
}

interface MinutesPayload {
  title?: unknown;
  summary?: unknown;
  direction?: unknown;
  decisions?: unknown[];
  todos?: Array<{ text?: unknown; detail?: unknown; priority?: unknown; owner?: unknown }>;
}

/** "<Project>: <what the meeting was about>" — the ended-meeting display title. */
function refinedMeetingTitle(row: LiveMeetingRow, modelTitle: string): string | null {
  const topic = modelTitle
    .replace(/^["'\s]+|["'.\s]+$/g, '')
    // The project name is prefixed below — strip it if the model added it anyway.
    .replace(row.projectName ? new RegExp(`^${row.projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:—-]\\s*`, 'i') : /^$/, '')
    .trim();
  if (!topic) return null;
  return cleanText(row.projectName ? `${row.projectName}: ${topic}` : topic, 300);
}

function normalizeMinutes(payload: MinutesPayload): LiveMeetingMinutes {
  const priorityOf = (value: unknown): LiveMeetingTodo['priority'] | undefined => {
    const p = String(value || '').toLowerCase();
    return p === 'low' || p === 'medium' || p === 'high' ? p : undefined;
  };
  return {
    summary: cleanText(payload.summary, 20_000),
    direction: cleanText(payload.direction, 10_000),
    decisions: (Array.isArray(payload.decisions) ? payload.decisions : [])
      .map((item) => cleanText(item, 2_000)).filter(Boolean).slice(0, 50),
    todos: (Array.isArray(payload.todos) ? payload.todos : []).slice(0, LIVE_MEETING_MAX_TODOS).flatMap((item, index) => {
      const text = cleanText(item?.text, 500);
      if (!text) return [];
      const detail = cleanText(item?.detail, 2_000);
      const priority = priorityOf(item?.priority);
      const owner = cleanText(item?.owner, 200);
      return [{
        id: `todo-${index + 1}`,
        text,
        ...(detail ? { detail } : {}),
        ...(priority ? { priority } : {}),
        ...(owner ? { owner } : {}),
      }];
    }),
  };
}

/** End the meeting: the agent writes the minutes (summary, direction,
 *  decisions, todo list). Todos stay local until explicitly sent to the Board. */
export async function endLiveMeeting(id: string): Promise<LiveMeetingRecord> {
  ensureLiveMeetingSchema();
  const db = getDb();
  const row = meetingRow(id);
  if (!row) throw new Error('Meeting not found');
  if (row.status === 'ended') return rowToRecord(row);
  if (row.status !== 'active') throw new Error('Meeting minutes are already being written');
  if (row.pendingTurn) throw new Error('Wait for the current turn to finish before ending the meeting');
  const claimed = db.prepare(`
    UPDATE live_meetings SET status = 'summarizing', error = NULL, version = version + 1, updatedAt = ?
    WHERE id = ? AND version = ? AND status = 'active' AND pendingTurn = 0 AND deletedAt IS NULL
  `).run(nowIso(), row.id, row.version);
  if (Number(claimed.changes) !== 1) throw new Error('Meeting changed concurrently; reload and retry');
  emitAppEvent('meetings');
  try {
    const config = await loadConfig();
    const agent = await requireAgent(row.agentId);
    const model = resolveMeetingModel(agent, config);
    const turns = parseJson<LiveMeetingTurn[]>(row.turns, []);
    const transcript = turns.map((turn) => turnSummaryLine(row, turn)).join('\n').slice(0, 120_000);
    // Roster lets the minutes attribute assignments to real agents, so
    // "the engineer will take this" becomes a card assignment on conversion.
    const roster = (await loadAgents()).map((candidate) => candidate.name).filter(Boolean).slice(0, 50);
    const response = await grokChat({
      model,
      temperature: 0.1,
      max_tokens: 4_096,
      usageContext: { source: 'other', sourceId: 'live-meeting' },
      messages: [
        {
          role: 'system',
          content: 'You write faithful meeting minutes for a project review between a director and an engineer. Never invent facts, decisions, or requests that are not in the transcript. Return JSON only.',
        },
        {
          role: 'user',
          content: `Write the minutes for this meeting. Return {"title":"4 to 8 words naming what this meeting actually covered — no project name, no dates","summary":"what was reviewed and discussed","direction":"the agreed direction for the project going forward","decisions":["explicit decisions made"],"todos":[{"text":"actionable item the director requested or both agreed on","detail":"context helpful to whoever picks it up","priority":"low|medium|high","owner":"who the transcript explicitly assigned this to — use the matching name from the agent roster, omit when nobody was named"}]}. Todos must come only from explicit requests or agreements in the transcript. Agent roster: ${roster.join(', ') || '(none)'}.\n\nMeeting: ${row.title}\n\n${transcript || '(no conversation happened)'}`,
        },
      ],
    });
    const payload = parseModelJson<MinutesPayload>(response.choices[0]?.message?.content || '');
    const minutes = normalizeMinutes(payload);
    // Ended meetings get a descriptive display title: "<Project>: <topic>".
    const refinedTitle = refinedMeetingTitle(row, cleanText(payload.title, 120));
    const now = nowIso();
    const finished = db.prepare(`
      UPDATE live_meetings SET status = 'ended', minutes = ?, title = COALESCE(?, title),
        error = NULL, version = version + 1, updatedAt = ?, endedAt = ?
      WHERE id = ? AND status = 'summarizing' AND deletedAt IS NULL
    `).run(JSON.stringify(minutes), refinedTitle, now, now, row.id);
    if (Number(finished.changes) !== 1) throw new Error('Meeting was changed while the minutes were being written');
    audit('run', 'live meeting ended', row.title, { meetingId: row.id, turns: turns.length, todos: minutes.todos.length });
    emitAppEvent('meetings');
    return getLiveMeeting(row.id)!;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
    db.prepare(`
      UPDATE live_meetings SET status = 'active', error = ?, version = version + 1, updatedAt = ?
      WHERE id = ? AND status = 'summarizing' AND deletedAt IS NULL
    `).run(message, nowIso(), row.id);
    emitAppEvent('meetings');
    throw error;
  }
}

/** Convert selected minute todos into Board cards. Requires the explicit
 *  confirmation flag; idempotent per todo via deterministic card ids. */
export async function convertLiveMeetingTodos(input: {
  meetingId: string;
  todoIds: string[];
  confirmed: boolean;
}): Promise<LiveMeetingRecord> {
  if (input.confirmed !== true) throw new Error('Explicit confirmation is required to create Board cards');
  const row = meetingRow(input.meetingId);
  if (!row) throw new Error('Meeting not found');
  if (row.status !== 'ended') throw new Error('End the meeting before sending todos to the Board');
  const minutes = parseJson<LiveMeetingMinutes | null>(row.minutes, null);
  if (!minutes) throw new Error('This meeting has no minutes');
  const wanted = new Set(input.todoIds.map(String));
  const selected = minutes.todos.filter((todo) => wanted.has(todo.id));
  if (!selected.length) throw new Error('Select at least one todo');
  const priorityMap: Record<string, number> = { high: 2, medium: 3, low: 4 };
  // Owners named in the meeting become real card assignments. Assignment uses
  // the Board's normal flow, so agent auto-accept opt-ins still govern starts.
  const agents = (await loadAgents()).map(normalizeAgent);
  const resolveOwner = (owner: string | undefined): Agent | undefined => {
    const name = owner?.trim().toLowerCase();
    if (!name) return undefined;
    return agents.find((candidate) => candidate.name.toLowerCase() === name)
      || agents.find((candidate) => candidate.name.toLowerCase().includes(name) || name.includes(candidate.name.toLowerCase()));
  };
  for (const todo of selected) {
    if (todo.boardTaskId) continue;
    const assignee = resolveOwner(todo.owner);
    const cardKey = createHash('sha256').update(`${row.id}\0${todo.id}`).digest('hex').slice(0, 32);
    const card = await createBoardTask({
      id: `live-meeting-board-${cardKey}`,
      title: todo.text,
      description: [
        todo.detail || '',
        todo.owner ? `Owner named in the meeting: ${todo.owner}${assignee ? '' : ' (no matching agent — left unassigned)'}` : '',
        `Requested in meeting “${row.title}” (${new Date(row.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}).`,
      ].filter(Boolean).join('\n\n'),
      status: 'todo',
      priority: todo.priority ? priorityMap[todo.priority] : 0,
      projectId: row.projectId || undefined,
      assigneeAgentId: assignee?.id,
      labels: ['meeting'],
      createdBy: `meeting ${row.title}`,
    });
    todo.boardTaskId = card.id;
    todo.boardTaskKey = card.key;
  }
  // Persist boardTaskIds with an optimistic-version retry: the conversion
  // itself is idempotent, so a concurrent bump only forces a re-read.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = meetingRow(row.id);
    if (!current) throw new Error('Meeting not found');
    const currentMinutes = parseJson<LiveMeetingMinutes | null>(current.minutes, null);
    if (!currentMinutes) throw new Error('This meeting has no minutes');
    for (const todo of currentMinutes.todos) {
      const converted = selected.find((item) => item.id === todo.id);
      if (converted?.boardTaskId) {
        todo.boardTaskId = converted.boardTaskId;
        todo.boardTaskKey = converted.boardTaskKey;
      }
    }
    const result = getDb().prepare(`
      UPDATE live_meetings SET minutes = ?, version = version + 1, updatedAt = ?
      WHERE id = ? AND version = ? AND deletedAt IS NULL
    `).run(JSON.stringify(currentMinutes), nowIso(), current.id, current.version);
    if (Number(result.changes) === 1) {
      audit('run', 'live meeting todos sent to board', row.title, { meetingId: row.id, count: selected.length });
      emitAppEvent('meetings');
      emitAppEvent('board');
      return getLiveMeeting(row.id)!;
    }
  }
  throw new Error('Meeting changed concurrently; reload and retry');
}
