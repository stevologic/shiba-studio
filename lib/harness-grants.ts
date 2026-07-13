import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDb } from './db';
import {
  createTask,
  getTask,
  getTaskDetails,
  recordTaskEvidence,
  requestTaskAttention,
  transitionTask,
} from './task-ledger';

export type HarnessProvider = 'grok' | 'codex' | 'claude' | 'hermes';

export interface HarnessGrant {
  id: string;
  taskId: string;
  childTaskId: string;
  provider: HarnessProvider;
  workspaceRootId: string;
  workspacePath: string;
  allowedTools: string[];
  status: 'issued' | 'active' | 'completed' | 'failed' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
  revokedAt?: string;
}

interface GrantRow extends Omit<HarnessGrant, 'allowedTools' | 'usedAt' | 'revokedAt'> {
  allowedTools: string;
  tokenHash: string;
  usedAt: string | null;
  revokedAt: string | null;
}

const VALID_PROVIDERS = new Set<HarnessProvider>(['grok', 'codex', 'claude', 'hermes']);

function ensureSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS harness_grants (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      childTaskId TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      workspaceRootId TEXT NOT NULL,
      workspacePath TEXT NOT NULL,
      allowedTools TEXT NOT NULL DEFAULT '[]',
      tokenHash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      usedAt TEXT,
      revokedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_harness_grants_task ON harness_grants(taskId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_harness_grants_expiry ON harness_grants(status, expiresAt);
  `);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function rowToGrant(row: GrantRow): HarnessGrant {
  let allowedTools: string[] = [];
  try {
    const value = JSON.parse(row.allowedTools);
    if (Array.isArray(value)) allowedTools = value.map(String);
  } catch { /* empty */ }
  return {
    id: row.id,
    taskId: row.taskId,
    childTaskId: row.childTaskId,
    provider: row.provider,
    workspaceRootId: row.workspaceRootId,
    workspacePath: row.workspacePath,
    allowedTools,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    ...(row.usedAt ? { usedAt: row.usedAt } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

function getRow(id: string): GrantRow | null {
  ensureSchema();
  return (getDb().prepare('SELECT * FROM harness_grants WHERE id = ?').get(id) as GrantRow | undefined) || null;
}

function expireIfNeeded(row: GrantRow): GrantRow {
  if ((row.status === 'issued' || row.status === 'active') && Date.parse(row.expiresAt) <= Date.now()) {
    getDb().prepare("UPDATE harness_grants SET status = 'expired' WHERE id = ? AND status IN ('issued', 'active')").run(row.id);
    const child = getTask(row.childTaskId);
    if (child && !['succeeded', 'failed', 'cancelled', 'lost'].includes(child.status)) {
      transitionTask({ taskId: child.id, status: 'cancelled', error: 'External harness capability grant expired.' });
    }
    return getRow(row.id)!;
  }
  return row;
}

function validateToken(row: GrantRow, token: string): void {
  const supplied = Buffer.from(hashToken(token));
  const expected = Buffer.from(row.tokenHash);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid harness capability token');
}

export function createHarnessGrant(input: {
  taskId: string;
  provider: HarnessProvider;
  workspaceRootId: string;
  allowedTools: string[];
  ttlSeconds?: number;
}): { grant: HarnessGrant; token: string } {
  ensureSchema();
  if (!VALID_PROVIDERS.has(input.provider)) throw new Error('Unsupported harness provider');
  const parent = getTask(input.taskId);
  if (!parent) throw new Error('Parent task not found');
  const root = parent.workspaceRoots.find((candidate) => candidate.id === input.workspaceRootId);
  if (!root || root.permission !== 'write') throw new Error('Harness requires one explicitly selected writable workspace root');
  const allowedTools = [...new Set((input.allowedTools || []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 30);
  if (!allowedTools.length) throw new Error('At least one action-level tool permission is required');
  for (const tool of allowedTools) {
    if (!/^[a-z][a-z0-9_.:-]{0,79}$/i.test(tool)) throw new Error(`Invalid harness tool permission: ${tool}`);
  }
  const ttlSeconds = Math.max(60, Math.min(60 * 60, Math.floor(Number(input.ttlSeconds) || 15 * 60)));
  const id = randomUUID();
  const childTaskId = `harness-${randomUUID()}`;
  const token = `shg_${randomBytes(32).toString('base64url')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();
  createTask({
    id: childTaskId,
    kind: 'external',
    parentId: parent.id,
    title: `${input.provider} harness: ${parent.title}`.slice(0, 500),
    description: parent.description,
    status: 'queued',
    originType: 'manual',
    originId: id,
    workspaceRoots: [{ ...root }],
    maxRetries: 0,
    metadata: { harnessGrantId: id, provider: input.provider, allowedTools },
  });
  getDb().prepare(`
    INSERT INTO harness_grants (
      id, taskId, childTaskId, provider, workspaceRootId, workspacePath,
      allowedTools, tokenHash, status, expiresAt, createdAt, usedAt, revokedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, NULL, NULL)
  `).run(
    id, parent.id, childTaskId, input.provider, root.id, root.path,
    JSON.stringify(allowedTools), hashToken(token), expiresAt, now.toISOString(),
  );
  return { grant: rowToGrant(getRow(id)!), token };
}

export function listHarnessGrants(taskId?: string): HarnessGrant[] {
  ensureSchema();
  const rows = (taskId
    ? getDb().prepare('SELECT * FROM harness_grants WHERE taskId = ? ORDER BY createdAt DESC').all(taskId)
    : getDb().prepare('SELECT * FROM harness_grants ORDER BY createdAt DESC LIMIT 200').all()) as GrantRow[];
  return rows.map(expireIfNeeded).map(rowToGrant);
}

export function authenticateHarnessGrant(id: string, token: string): HarnessGrant {
  const row = getRow(id);
  if (!row) throw new Error('Harness grant not found');
  const current = expireIfNeeded(row);
  validateToken(current, token);
  if (current.status === 'revoked' || current.status === 'expired') throw new Error(`Harness grant is ${current.status}`);
  return rowToGrant(current);
}

function boundedPrompt(grant: HarnessGrant, requested: string): string {
  const parent = getTaskDetails(grant.taskId);
  if (!parent) throw new Error('Parent task not found');
  const contract = parent.contract
    ? `\nCompletion contract:\n${JSON.stringify({
        outcome: parent.contract.outcome,
        constraints: parent.contract.constraints,
        requiredArtifacts: parent.contract.requiredArtifacts,
        requirements: parent.contract.requirements,
      }, null, 2)}`
    : '';
  return [
    'You are a scoped external coding worker attached to a Shiba Studio task.',
    `Task: ${parent.title}`,
    parent.description,
    contract,
    `Workspace: ${grant.workspacePath}`,
    `Allowed action classes: ${grant.allowedTools.join(', ')}`,
    'Do not read outside the selected workspace. Do not use ambient MCP servers or environment secrets.',
    'Return a concrete summary of files changed and verification commands run.',
    requested.trim().slice(0, 20_000),
  ].filter(Boolean).join('\n\n').slice(0, 40_000);
}

export async function startHarnessGrant(id: string, token: string, instruction = ''): Promise<HarnessGrant> {
  const grant = authenticateHarnessGrant(id, token);
  if (grant.status !== 'issued') throw new Error(`Harness grant cannot start from status ${grant.status}`);
  const now = new Date().toISOString();
  getDb().prepare("UPDATE harness_grants SET status = 'active', usedAt = ? WHERE id = ? AND status = 'issued'").run(now, id);
  const child = getTask(grant.childTaskId)!;
  transitionTask({ taskId: child.id, status: 'running', expectedVersion: child.version, currentStep: `Launching ${grant.provider} harness` });
  void (async () => {
    try {
      const prompt = boundedPrompt(grant, instruction);
      // Never launch a host CLI with direct workspace access: prompt-level
      // tool names cannot enforce path, account, or secret isolation. Every
      // provider (including Grok) attaches explicitly and receives only this
      // bounded context plus the one-time callback grant. A compatible harness
      // must broker its own actions through the declared capability classes.
      requestTaskAttention({
        taskId: grant.childTaskId,
        kind: 'question',
        severity: 'info',
        title: `${grant.provider} harness is ready to attach`,
        body: 'Start the external harness in its own isolated environment with the one-time capability token, then post typed evidence to the callback endpoint before expiry. Shiba will not launch a host CLI with ambient HOME, MCP, or credential access.',
        dedupeKey: `harness-manual-attach:${grant.id}`,
        action: {
          grantId: grant.id,
          expiresAt: grant.expiresAt,
          allowedTools: grant.allowedTools,
          contextDigest: createHash('sha256').update(prompt).digest('hex'),
        },
      });
      recordTaskEvidence({
        taskId: grant.childTaskId,
        kind: 'assertion',
        status: 'informational',
        label: 'Scoped harness attachment prepared',
        summary: `Prepared ${grant.provider} attachment with ${grant.allowedTools.length} action-level permission(s); no host process or ambient secret was exposed.`,
        scope: grant.workspaceRootId,
        metadata: { grantId: grant.id, provider: grant.provider, contextDigest: createHash('sha256').update(prompt).digest('hex') },
      });
      const waiting = getTask(grant.childTaskId)!;
      transitionTask({ taskId: waiting.id, status: 'waiting_for_input', expectedVersion: waiting.version, currentStep: 'Waiting for isolated external harness callback' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const task = getTask(grant.childTaskId);
      if (task && !['succeeded', 'failed', 'cancelled', 'lost'].includes(task.status)) {
        transitionTask({ taskId: task.id, status: 'failed', error: message });
      }
      getDb().prepare("UPDATE harness_grants SET status = 'failed' WHERE id = ? AND status = 'active'").run(grant.id);
    }
  })();
  return rowToGrant(getRow(id)!);
}

export function postHarnessCallback(input: {
  id: string;
  token: string;
  status: 'running' | 'succeeded' | 'failed';
  summary: string;
  evidence?: Array<{ kind: 'command' | 'test' | 'build' | 'diff' | 'artifact'; status: 'passed' | 'failed' | 'informational'; label: string; summary: string; uri?: string; command?: string; exitCode?: number }>;
}): HarnessGrant {
  const grant = authenticateHarnessGrant(input.id, input.token);
  if (grant.status !== 'active') throw new Error(`Harness callback rejected from status ${grant.status}`);
  for (const evidence of (input.evidence || []).slice(0, 100)) {
    recordTaskEvidence({
      taskId: grant.childTaskId,
      ...evidence,
      scope: grant.workspaceRootId,
      metadata: { grantId: grant.id, provider: grant.provider, externalCallback: true },
    });
  }
  const child = getTask(grant.childTaskId)!;
  if (input.status === 'running') {
    if (child.status === 'waiting_for_input') {
      transitionTask({ taskId: child.id, status: 'running', expectedVersion: child.version, currentStep: input.summary.slice(0, 1_000) });
    }
  } else {
    transitionTask({
      taskId: child.id,
      status: input.status,
      expectedVersion: child.version,
      result: input.status === 'succeeded' ? input.summary.slice(0, 20_000) : null,
      error: input.status === 'failed' ? input.summary.slice(0, 10_000) : null,
    });
    getDb().prepare('UPDATE harness_grants SET status = ? WHERE id = ?')
      .run(input.status === 'succeeded' ? 'completed' : 'failed', grant.id);
  }
  return rowToGrant(getRow(grant.id)!);
}

export function revokeHarnessGrant(id: string): HarnessGrant {
  const row = getRow(id);
  if (!row) throw new Error('Harness grant not found');
  const now = new Date().toISOString();
  getDb().prepare("UPDATE harness_grants SET status = 'revoked', revokedAt = ? WHERE id = ? AND status IN ('issued', 'active')")
    .run(now, id);
  const child = getTask(row.childTaskId);
  if (child && !['succeeded', 'failed', 'cancelled', 'lost'].includes(child.status)) {
    transitionTask({ taskId: child.id, status: 'cancelled', error: 'External harness grant revoked.' });
  }
  return rowToGrant(getRow(id)!);
}
