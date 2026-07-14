import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDb } from './db';
import {
  createTaskInOpenTransaction,
  getTask,
  getTaskDetails,
  publishTaskChanges,
  recordTaskEvidence,
  transitionTask,
  transitionTaskInOpenTransaction,
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

export interface HarnessGrantLifecycleRepairReport {
  grantsExpired: number;
  grantsTerminalized: number;
  tasksCancelled: number;
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

const ACTIVE_HARNESS_TASK_STATUSES = new Set([
  'queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked',
]);

function settleHarnessChildInOpenTransaction(childTaskId: string, message: string): boolean {
  const child = getTask(childTaskId);
  if (!child || !ACTIVE_HARNESS_TASK_STATUSES.has(child.status)) return false;
  transitionTaskInOpenTransaction({
    taskId: child.id,
    status: 'cancelled',
    expectedVersion: child.version,
    error: message,
    metadata: { harnessLifecycleReconciled: true },
  });
  return true;
}

function repairHarnessGrantLifecycleAt(
  at: Date,
  onlyGrantId?: string,
): HarnessGrantLifecycleRepairReport {
  ensureSchema();
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid harness lifecycle timestamp');
  const now = at.toISOString();
  const db = getDb();
  const idPredicate = onlyGrantId ? 'AND grantRow.id = ?' : '';
  const candidate = db.prepare(`
    SELECT 1 FROM harness_grants grantRow
    LEFT JOIN tasks child ON child.id = grantRow.childTaskId
    WHERE (
      (grantRow.status IN ('issued', 'active') AND grantRow.expiresAt <= ?)
      OR (
        grantRow.status IN ('revoked', 'expired')
        AND child.status IN ('queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked')
      )
      OR (
        grantRow.status IN ('issued', 'active')
        AND child.status IN ('succeeded', 'failed', 'cancelled', 'lost')
      )
    ) ${idPredicate}
    LIMIT 1
  `).get(now, ...(onlyGrantId ? [onlyGrantId] : []));
  if (!candidate) return { grantsExpired: 0, grantsTerminalized: 0, tasksCancelled: 0 };

  const report: HarnessGrantLifecycleRepairReport = {
    grantsExpired: 0,
    grantsTerminalized: 0,
    tasksCancelled: 0,
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    report.grantsExpired = Number(db.prepare(`
      UPDATE harness_grants SET status = 'expired'
      WHERE status IN ('issued', 'active') AND expiresAt <= ?
        ${onlyGrantId ? 'AND id = ?' : ''}
    `).run(now, ...(onlyGrantId ? [onlyGrantId] : [])).changes) || 0;
    report.grantsTerminalized = Number(db.prepare(`
      UPDATE harness_grants SET
        status = CASE (SELECT child.status FROM tasks child WHERE child.id = harness_grants.childTaskId)
          WHEN 'succeeded' THEN 'completed'
          WHEN 'failed' THEN 'failed'
          ELSE 'revoked'
        END,
        revokedAt = CASE WHEN (
          SELECT child.status FROM tasks child WHERE child.id = harness_grants.childTaskId
        ) IN ('cancelled', 'lost') THEN COALESCE(revokedAt, ?) ELSE revokedAt END
      WHERE status IN ('issued', 'active')
        AND EXISTS (
          SELECT 1 FROM tasks child
          WHERE child.id = harness_grants.childTaskId
            AND child.status IN ('succeeded', 'failed', 'cancelled', 'lost')
        ) ${onlyGrantId ? 'AND id = ?' : ''}
    `).run(now, ...(onlyGrantId ? [onlyGrantId] : [])).changes) || 0;
    const rows = db.prepare(`
      SELECT id, childTaskId, status FROM harness_grants
      WHERE status IN ('revoked', 'expired') ${onlyGrantId ? 'AND id = ?' : ''}
      ORDER BY createdAt, id
    `).all(...(onlyGrantId ? [onlyGrantId] : [])) as Array<{
      id: string;
      childTaskId: string;
      status: 'revoked' | 'expired';
    }>;
    for (const row of rows) {
      const message = row.status === 'revoked'
        ? 'External harness grant revoked.'
        : 'External harness capability grant expired.';
      if (settleHarnessChildInOpenTransaction(row.childTaskId, message)) report.tasksCancelled += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
  if (report.tasksCancelled) {
    try { publishTaskChanges(true); } catch (error) {
      console.error('[harness-grants] could not publish lifecycle task changes', error);
    }
  }
  return report;
}

/** Repair expired/revoked grant projections even when no client reads them. */
export function repairHarnessGrantLifecycleProjections(
  at = new Date(),
): HarnessGrantLifecycleRepairReport {
  return repairHarnessGrantLifecycleAt(at);
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
  const db = getDb();
  let grant: HarnessGrant;
  db.exec('BEGIN IMMEDIATE');
  try {
    createTaskInOpenTransaction({
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
    db.prepare(`
      INSERT INTO harness_grants (
        id, taskId, childTaskId, provider, workspaceRootId, workspacePath,
        allowedTools, tokenHash, status, expiresAt, createdAt, usedAt, revokedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, NULL, NULL)
    `).run(
      id, parent.id, childTaskId, input.provider, root.id, root.path,
      JSON.stringify(allowedTools), hashToken(token), expiresAt, now.toISOString(),
    );
    grant = rowToGrant(db.prepare('SELECT * FROM harness_grants WHERE id = ?').get(id) as GrantRow);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
  try { publishTaskChanges(); } catch (error) {
    console.error('[harness-grants] could not publish created harness task', error);
  }
  return { grant, token };
}

export function listHarnessGrants(taskId?: string): HarnessGrant[] {
  ensureSchema();
  repairHarnessGrantLifecycleProjections();
  const rows = (taskId
    ? getDb().prepare('SELECT * FROM harness_grants WHERE taskId = ? ORDER BY createdAt DESC').all(taskId)
    : getDb().prepare('SELECT * FROM harness_grants ORDER BY createdAt DESC LIMIT 200').all()) as GrantRow[];
  return rows.map(rowToGrant);
}

export function authenticateHarnessGrant(id: string, token: string): HarnessGrant {
  let row = getRow(id);
  if (!row) throw new Error('Harness grant not found');
  repairHarnessGrantLifecycleAt(new Date(), row.id);
  row = getRow(id);
  if (!row) throw new Error('Harness grant not found');
  validateToken(row, token);
  if (row.status === 'revoked' || row.status === 'expired') throw new Error(`Harness grant is ${row.status}`);
  return rowToGrant(row);
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
  const db = getDb();
  let activeGrant: HarnessGrant;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare("UPDATE harness_grants SET status = 'active', usedAt = ? WHERE id = ? AND status = 'issued'")
      .run(now, id);
    if (Number(result.changes) !== 1) throw new Error('Harness grant changed before it could start');
    const child = getTask(grant.childTaskId);
    if (!child) throw new Error('Harness child task not found');
    transitionTaskInOpenTransaction({
      taskId: child.id,
      status: 'running',
      expectedVersion: child.version,
      currentStep: `Launching ${grant.provider} harness`,
    });
    activeGrant = rowToGrant(db.prepare('SELECT * FROM harness_grants WHERE id = ?').get(id) as GrantRow);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
  try { publishTaskChanges(); } catch (error) {
    console.error('[harness-grants] could not publish started harness task', error);
  }
  void (async () => {
    try {
      const prompt = boundedPrompt(activeGrant, instruction);
      // Never launch a host CLI with direct workspace access: prompt-level
      // tool names cannot enforce path, account, or secret isolation. Every
      // provider (including Grok) attaches explicitly and receives only this
      // bounded context plus the one-time callback grant. A compatible harness
      // must broker its own actions through the declared capability classes.
      recordTaskEvidence({
        taskId: activeGrant.childTaskId,
        kind: 'assertion',
        status: 'informational',
        label: 'Scoped harness attachment prepared',
        summary: `Prepared ${activeGrant.provider} attachment with ${activeGrant.allowedTools.length} action-level permission(s); no host process or ambient secret was exposed.`,
        scope: activeGrant.workspaceRootId,
        metadata: { grantId: activeGrant.id, provider: activeGrant.provider, contextDigest: createHash('sha256').update(prompt).digest('hex') },
      });
      const waiting = getTask(activeGrant.childTaskId)!;
      transitionTask({ taskId: waiting.id, status: 'waiting_for_input', expectedVersion: waiting.version, currentStep: 'Waiting for isolated external harness callback' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let taskChanged = false;
      db.exec('BEGIN IMMEDIATE');
      try {
        const task = getTask(activeGrant.childTaskId);
        if (task && !['succeeded', 'failed', 'cancelled', 'lost'].includes(task.status)) {
          transitionTaskInOpenTransaction({ taskId: task.id, status: 'failed', error: message });
          taskChanged = true;
        }
        db.prepare("UPDATE harness_grants SET status = 'failed' WHERE id = ? AND status = 'active'").run(activeGrant.id);
        db.exec('COMMIT');
      } catch (settlementError) {
        try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
        console.error(`[harness-grants] could not settle failed harness ${activeGrant.id}`, settlementError);
      }
      if (taskChanged) {
        try { publishTaskChanges(true); } catch (publishError) {
          console.error('[harness-grants] could not publish failed harness task', publishError);
        }
      }
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
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const currentChild = getTask(grant.childTaskId);
      if (!currentChild) throw new Error('Harness child task not found');
      transitionTaskInOpenTransaction({
        taskId: currentChild.id,
        status: input.status,
        expectedVersion: currentChild.version,
        result: input.status === 'succeeded' ? input.summary.slice(0, 20_000) : null,
        error: input.status === 'failed' ? input.summary.slice(0, 10_000) : null,
      });
      const result = db.prepare("UPDATE harness_grants SET status = ? WHERE id = ? AND status = 'active'")
        .run(input.status === 'succeeded' ? 'completed' : 'failed', grant.id);
      if (Number(result.changes) !== 1) throw new Error('Harness grant changed before its callback completed');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
      throw error;
    }
    try { publishTaskChanges(true); } catch (error) {
      console.error('[harness-grants] could not publish terminal harness task', error);
    }
  }
  return rowToGrant(getRow(grant.id)!);
}

export function revokeHarnessGrant(id: string): HarnessGrant {
  ensureSchema();
  const now = new Date().toISOString();
  const db = getDb();
  let taskChanged = false;
  let grant: HarnessGrant;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM harness_grants WHERE id = ?').get(id) as GrantRow | undefined;
    if (!row) throw new Error('Harness grant not found');
    const result = db.prepare(`
      UPDATE harness_grants SET status = 'revoked', revokedAt = ?
      WHERE id = ? AND status IN ('issued', 'active')
    `).run(now, id);
    if (Number(result.changes) !== 1) throw new Error(`Harness grant cannot be revoked from status ${row.status}`);
    taskChanged = settleHarnessChildInOpenTransaction(row.childTaskId, 'External harness grant revoked.');
    grant = rowToGrant(db.prepare('SELECT * FROM harness_grants WHERE id = ?').get(id) as GrantRow);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
  if (taskChanged) {
    try { publishTaskChanges(true); } catch (error) {
      console.error('[harness-grants] could not publish revoked task state', error);
    }
  }
  return grant;
}
