// Universal durable task control plane. Runs, chat background work, routines,
// Board work, dynamic workers, artifacts, and external harnesses project into
// this one SQLite ledger instead of maintaining parallel lifecycle stores.

import { createHash, randomUUID } from 'node:crypto';
import type { AgentRun } from './types';
import { getDb } from './db';
import { emitAppEvent } from './app-events';
import type {
  AttentionItem,
  AttentionKind,
  CompletionContract,
  CompletionEvaluation,
  CompletionRequirement,
  CreateTaskInput,
  EvidenceKind,
  EvidenceStatus,
  RequirementEvaluation,
  TaskCommand,
  TaskCommandKind,
  TaskDetails,
  TaskEvidence,
  TaskKind,
  TaskListOptions,
  TaskOriginType,
  TaskOutboxItem,
  TaskPlanStep,
  TaskRecord,
  TaskStatus,
  TaskWorkspaceRoot,
} from './task-types';
import { TASK_STATUSES, TERMINAL_TASK_STATUSES } from './task-types';
import { getPendingApproval, resolveToolApproval } from './tool-approval';
import { isAutomationMaintenanceActive } from './automation-maintenance';

type SqlValue = string | number | null;

interface TaskRow {
  id: string;
  kind: string;
  status: string;
  title: string;
  description: string;
  parentId: string | null;
  originType: string;
  originId: string | null;
  agentId: string | null;
  projectId: string | null;
  runId: string | null;
  sessionId: string | null;
  workspaceRoots: string;
  plan: string;
  progress: number;
  currentStep: string | null;
  nextAction: string | null;
  retryCount: number;
  maxRetries: number;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
  error: string | null;
  contract: string | null;
  completion: string | null;
  checkpointId: string | null;
  metadata: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface EvidenceRow {
  id: string;
  taskId: string;
  requirementId: string | null;
  kind: string;
  status: string;
  label: string;
  summary: string;
  uri: string | null;
  command: string | null;
  exitCode: number | null;
  scope: string | null;
  recordedAt: string;
  metadata: string;
}

interface AttentionRow {
  id: string;
  taskId: string;
  kind: string;
  status: string;
  severity: string;
  title: string;
  body: string;
  action: string;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

interface CommandRow {
  id: string;
  taskId: string;
  kind: string;
  status: string;
  payload: string;
  idempotencyKey: string;
  expectedVersion: number;
  createdAt: string;
  appliedAt: string | null;
}

interface OutboxRow {
  id: string;
  taskId: string;
  kind: string;
  target: string;
  payload: string;
  status: string;
  attempts: number;
  availableAt: string;
  createdAt: string;
  deliveredAt: string | null;
  lastError: string | null;
  idempotencyKey: string;
}

interface RunControlRow {
  id: string;
  commandId: string;
  taskId: string;
  runId: string;
  kind: string;
  instruction: string | null;
  status: string;
  attempts: number;
  availableAt: string;
  consumerId: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
}

const VALID_KINDS = new Set<TaskKind>([
  'chat', 'work', 'code', 'routine', 'agent', 'board', 'integration', 'artifact', 'external',
]);

const VALID_ORIGINS = new Set<TaskOriginType>([
  'chat', 'run', 'schedule', 'board', 'integration', 'manual', 'api', 'system',
]);

const MAX_EVIDENCE_FUTURE_SKEW_MS = 5 * 60_000;

const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(['running', 'paused', 'blocked', 'succeeded', 'failed', 'cancelled', 'lost']),
  running: new Set(['paused', 'waiting_for_input', 'waiting_for_approval', 'blocked', 'succeeded', 'failed', 'cancelled', 'lost']),
  // A cooperative pause can race with the worker's final persistence after
  // its last model/tool step. Preserve that real terminal result instead of
  // leaving a completed run stuck in `paused`.
  paused: new Set(['queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled', 'lost']),
  waiting_for_input: new Set(['running', 'blocked', 'failed', 'cancelled', 'lost']),
  waiting_for_approval: new Set(['running', 'blocked', 'failed', 'cancelled', 'lost']),
  blocked: new Set(['queued', 'running', 'failed', 'cancelled', 'lost']),
  succeeded: new Set(),
  failed: new Set(['queued']),
  cancelled: new Set(),
  lost: new Set(['queued']),
};

function nowIso(): string {
  return new Date().toISOString();
}

function assertTaskId(id: string): string {
  const value = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value)) {
    throw new Error('Invalid task id');
  }
  return value;
}

function assertTaskKind(kind: TaskKind): TaskKind {
  if (!VALID_KINDS.has(kind)) throw new Error('Invalid task kind');
  return kind;
}

function assertOriginType(origin: TaskOriginType): TaskOriginType {
  if (!VALID_ORIGINS.has(origin)) throw new Error('Invalid task origin');
  return origin;
}

function assertTaskStatus(status: TaskStatus): TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) throw new Error('Invalid task status');
  return status;
}

function cleanText(value: unknown, max: number, required = false): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new Error('A non-empty value is required');
  return text.slice(0, max);
}

function parseObject<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function parseArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function normalizeWorkspaceRoots(input: TaskWorkspaceRoot[] | undefined): TaskWorkspaceRoot[] {
  if (!input) return [];
  if (!Array.isArray(input) || input.length > 20) throw new Error('workspaceRoots must contain at most 20 entries');
  const ids = new Set<string>();
  return input.map((root, index) => {
    const id = cleanText(root?.id || `root-${index + 1}`, 80, true);
    if (ids.has(id)) throw new Error(`Duplicate workspace root id: ${id}`);
    ids.add(id);
    const rootPath = cleanText(root?.path, 2_000, true);
    if (root?.permission !== 'read' && root?.permission !== 'write') {
      throw new Error(`Invalid workspace permission for ${id}`);
    }
    return {
      id,
      path: rootPath,
      permission: root.permission,
      ...(root.label ? { label: cleanText(root.label, 120) } : {}),
      ...(root.gitRef ? { gitRef: cleanText(root.gitRef, 300) } : {}),
    };
  });
}

function normalizePlan(input: TaskPlanStep[] | undefined): TaskPlanStep[] {
  if (!input) return [];
  if (!Array.isArray(input) || input.length > 200) throw new Error('plan must contain at most 200 steps');
  const ids = new Set<string>();
  return input.map((step, index) => {
    const id = cleanText(step?.id || `step-${index + 1}`, 100, true);
    if (ids.has(id)) throw new Error(`Duplicate plan step id: ${id}`);
    ids.add(id);
    const allowed = new Set(['pending', 'in_progress', 'completed', 'failed', 'skipped']);
    if (!allowed.has(step?.status)) throw new Error(`Invalid plan step status for ${id}`);
    return {
      id,
      title: cleanText(step?.title, 500, true),
      status: step.status,
      ...(step.ownerTaskId ? { ownerTaskId: assertTaskId(step.ownerTaskId) } : {}),
      ...(Array.isArray(step.evidenceIds)
        ? { evidenceIds: step.evidenceIds.slice(0, 100).map((value) => cleanText(value, 160, true)) }
        : {}),
    };
  });
}

function normalizeContract(
  contract: CreateTaskInput['contract'],
  existingCreatedAt?: string,
): CompletionContract | undefined {
  if (!contract) return undefined;
  const now = nowIso();
  const requirements = Array.isArray(contract.requirements) ? contract.requirements : [];
  if (requirements.length > 200) throw new Error('A completion contract may contain at most 200 requirements');
  const ids = new Set<string>();
  const normalized: CompletionRequirement[] = requirements.map((requirement, index) => {
    const id = cleanText(requirement?.id || `requirement-${index + 1}`, 120, true);
    if (ids.has(id)) throw new Error(`Duplicate completion requirement id: ${id}`);
    ids.add(id);
    const acceptedKinds = Array.isArray(requirement.acceptedKinds)
      ? [...new Set(requirement.acceptedKinds)].slice(0, 20)
      : undefined;
    return {
      id,
      label: cleanText(requirement?.label, 500, true),
      ...(requirement.description ? { description: cleanText(requirement.description, 2_000) } : {}),
      required: requirement.required !== false,
      ...(acceptedKinds?.length ? { acceptedKinds } : {}),
      ...(requirement.scope ? { scope: cleanText(requirement.scope, 500) } : {}),
      ...(Number.isFinite(requirement.maxAgeMinutes)
        ? { maxAgeMinutes: Math.max(1, Math.min(525_600, Number(requirement.maxAgeMinutes))) }
        : {}),
    };
  });
  return {
    outcome: cleanText(contract.outcome, 4_000, true),
    constraints: Array.isArray(contract.constraints)
      ? contract.constraints.slice(0, 100).map((value) => cleanText(value, 1_000, true))
      : [],
    requiredArtifacts: Array.isArray(contract.requiredArtifacts)
      ? contract.requiredArtifacts.slice(0, 100).map((value) => cleanText(value, 500, true))
      : [],
    requirements: normalized,
    createdAt: existingCreatedAt || ('createdAt' in contract ? contract.createdAt : now) || now,
    updatedAt: now,
  };
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    kind: row.kind as TaskKind,
    status: row.status as TaskStatus,
    title: row.title,
    description: row.description,
    ...(row.parentId ? { parentId: row.parentId } : {}),
    originType: row.originType as TaskOriginType,
    ...(row.originId ? { originId: row.originId } : {}),
    ...(row.agentId ? { agentId: row.agentId } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    workspaceRoots: parseArray<TaskWorkspaceRoot>(row.workspaceRoots),
    plan: parseArray<TaskPlanStep>(row.plan),
    progress: Math.max(0, Math.min(1, Number(row.progress) || 0)),
    ...(row.currentStep ? { currentStep: row.currentStep } : {}),
    ...(row.nextAction ? { nextAction: row.nextAction } : {}),
    retryCount: Number(row.retryCount) || 0,
    maxRetries: Number(row.maxRetries) || 0,
    ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.result != null ? { result: row.result } : {}),
    ...(row.error != null ? { error: row.error } : {}),
    ...(row.contract ? { contract: parseObject(row.contract, {} as CompletionContract) } : {}),
    ...(row.completion ? { completion: parseObject(row.completion, {} as CompletionEvaluation) } : {}),
    ...(row.checkpointId ? { checkpointId: row.checkpointId } : {}),
    metadata: parseObject(row.metadata, {}),
    version: Number(row.version) || 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToEvidence(row: EvidenceRow): TaskEvidence {
  return {
    id: row.id,
    taskId: row.taskId,
    ...(row.requirementId ? { requirementId: row.requirementId } : {}),
    kind: row.kind as EvidenceKind,
    status: row.status as EvidenceStatus,
    label: row.label,
    summary: row.summary,
    ...(row.uri ? { uri: row.uri } : {}),
    ...(row.command ? { command: row.command } : {}),
    ...(row.exitCode != null ? { exitCode: Number(row.exitCode) } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    recordedAt: row.recordedAt,
    metadata: parseObject(row.metadata, {}),
  };
}

function rowToAttention(row: AttentionRow): AttentionItem {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind as AttentionKind,
    status: row.status as AttentionItem['status'],
    severity: row.severity as AttentionItem['severity'],
    title: row.title,
    body: row.body,
    action: parseObject(row.action, {}),
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
  };
}

function rowToCommand(row: CommandRow): TaskCommand {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind as TaskCommandKind,
    status: row.status as TaskCommand['status'],
    payload: parseObject(row.payload, {}),
    idempotencyKey: row.idempotencyKey,
    expectedVersion: Number(row.expectedVersion) || 1,
    createdAt: row.createdAt,
    ...(row.appliedAt ? { appliedAt: row.appliedAt } : {}),
  };
}

function rowToOutbox(row: OutboxRow): TaskOutboxItem {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    target: row.target,
    payload: parseObject(row.payload, {}),
    status: row.status as TaskOutboxItem['status'],
    attempts: Number(row.attempts) || 0,
    availableAt: row.availableAt,
    createdAt: row.createdAt,
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    idempotencyKey: row.idempotencyKey,
  };
}

function emitTaskChanges(attention = false): void {
  emitAppEvent('tasks');
  if (attention) emitAppEvent('attention');
}

function insertEvent(taskId: string, type: string, data: Record<string, unknown> = {}): void {
  getDb().prepare('INSERT INTO task_events (taskId, type, ts, data) VALUES (?, ?, ?, ?)')
    .run(taskId, cleanText(type, 120, true), nowIso(), JSON.stringify(data));
}

/**
 * Publish a task projection change after a caller-owned ledger transaction.
 * Most callers should use createTask/transitionTask directly; this is for
 * compound mutations such as atomically creating a task team and its edges.
 */
export function publishTaskChanges(attention = false): void {
  emitTaskChanges(attention);
}

function createTaskInTransaction(input: CreateTaskInput): TaskRecord {
  const db = getDb();
  const id = assertTaskId(input.id || randomUUID());
  const kind = assertTaskKind(input.kind);
  const status = assertTaskStatus(input.status || 'queued');
  const originType = assertOriginType(input.originType || 'manual');
  const title = cleanText(input.title, 500, true);
  const description = cleanText(input.description, 20_000);
  const parentId = input.parentId ? assertTaskId(input.parentId) : null;
  if (parentId && !db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(parentId)) {
    throw new Error('Parent task not found');
  }
  const roots = normalizeWorkspaceRoots(input.workspaceRoots);
  const plan = normalizePlan(input.plan);
  const contract = normalizeContract(input.contract);
  const now = nowIso();
  const startedAt = status === 'running' ? now : null;
  const completedAt = TERMINAL_TASK_STATUSES.has(status) ? now : null;
  const progress = status === 'succeeded' ? 1 : 0;

  db.prepare(`
    INSERT INTO tasks (
      id, kind, status, title, description, parentId, originType, originId,
      agentId, projectId, runId, sessionId, workspaceRoots, plan, progress,
      currentStep, nextAction, retryCount, maxRetries, heartbeatAt, startedAt,
      completedAt, result, error, contract, completion, checkpointId, metadata,
      version, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, 1, ?, ?)
  `).run(
    id, kind, status, title, description, parentId, originType,
    input.originId ? cleanText(input.originId, 500) : null,
    input.agentId ? cleanText(input.agentId, 200) : null,
    input.projectId ? cleanText(input.projectId, 200) : null,
    input.runId ? cleanText(input.runId, 200) : null,
    input.sessionId ? cleanText(input.sessionId, 200) : null,
    JSON.stringify(roots), JSON.stringify(plan), progress,
    Math.max(0, Math.min(20, Number(input.maxRetries) || 0)),
    status === 'running' ? now : null, startedAt, completedAt,
    contract ? JSON.stringify(contract) : null,
    JSON.stringify(input.metadata || {}), now, now,
  );
  insertEvent(id, 'created', { kind, status, originType });
  return getTask(id)!;
}

/** Apply task creation inside a caller-owned SQLite transaction. */
export function createTaskInOpenTransaction(input: CreateTaskInput): TaskRecord {
  return createTaskInTransaction(input);
}

export function createTask(input: CreateTaskInput): TaskRecord {
  const db = getDb();
  let created: TaskRecord;
  db.exec('BEGIN IMMEDIATE');
  try {
    created = createTaskInTransaction(input);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  emitTaskChanges();
  return created;
}

export function getTask(id: string): TaskRecord | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(assertTaskId(id)) as unknown as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

/** Resolve the durable task projection for an exact run identity. */
export function getTaskByRunId(runId: string): TaskRecord | null {
  const value = cleanText(runId, 200, true);
  const row = getDb().prepare(`
    SELECT * FROM tasks WHERE runId = ? ORDER BY updatedAt DESC, createdAt DESC LIMIT 1
  `).get(value) as unknown as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(opts: TaskListOptions = {}): { tasks: TaskRecord[]; total: number } {
  const db = getDb();
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (opts.statuses?.length) {
    const statuses = [...new Set(opts.statuses.map(assertTaskStatus))];
    clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (opts.kinds?.length) {
    const kinds = [...new Set(opts.kinds.map(assertTaskKind))];
    clauses.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  const equalFilters: Array<[keyof Pick<TaskListOptions, 'parentId' | 'originType' | 'originId' | 'agentId' | 'projectId' | 'sessionId'>, string]> = [
    ['parentId', 'parentId'], ['originType', 'originType'], ['originId', 'originId'],
    ['agentId', 'agentId'], ['projectId', 'projectId'], ['sessionId', 'sessionId'],
  ];
  for (const [option, column] of equalFilters) {
    const value = opts[option];
    if (value) { clauses.push(`${column} = ?`); params.push(cleanText(value, 500, true)); }
  }
  const q = cleanText(opts.q, 500);
  if (q) {
    const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const like = `%${escaped}%`;
    clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR IFNULL(result, '') LIKE ? ESCAPE '\\' OR IFNULL(error, '') LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM tasks ${where}`).get(...params) as { n: number }).n);
  const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY updatedAt DESC, createdAt DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as TaskRow[];
  return { tasks: rows.map(rowToTask), total };
}

export interface DetachedTaskOriginReport {
  tasksDetached: number;
  activeTasksCancelled: number;
}

/**
 * Settle live descendants and replace a deleted UI/entity pointer with an
 * immutable snapshot. The task history remains useful without retaining a
 * dangling originId.
 */
export function detachTasksFromDeletedOrigin(
  originTypeInput: TaskOriginType,
  originIdInput: string,
  snapshot: Record<string, unknown> = {},
): DetachedTaskOriginReport {
  const originType = assertOriginType(originTypeInput);
  const originId = cleanText(originIdInput, 500, true);
  const initial = (getDb().prepare('SELECT * FROM tasks WHERE originType = ? AND originId = ?')
    .all(originType, originId) as unknown as TaskRow[]).map(rowToTask);
  let activeTasksCancelled = 0;
  const idempotencyKey = `origin-deleted:${createHash('sha256')
    .update(`${originType}\0${originId}`)
    .digest('hex')
    .slice(0, 32)}`;
  for (const task of initial) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
    const command = enqueueTaskCommand({
      taskId: task.id,
      kind: 'cancel',
      expectedVersion: task.version,
      idempotencyKey,
    });
    applyTaskCommand(command.id);
    activeTasksCancelled += 1;
  }

  const db = getDb();
  const rows = db.prepare('SELECT * FROM tasks WHERE originType = ? AND originId = ?')
    .all(originType, originId) as unknown as TaskRow[];
  const detachedAt = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const task = rowToTask(row);
      const metadata = {
        ...task.metadata,
        deletedOrigin: {
          type: originType,
          id: originId,
          detachedAt,
          ...snapshot,
        },
      };
      const updated = db.prepare(`
        UPDATE tasks
        SET originId = NULL, metadata = ?, version = version + 1, updatedAt = ?
        WHERE id = ? AND version = ? AND originType = ? AND originId = ?
      `).run(JSON.stringify(metadata), detachedAt, task.id, task.version, originType, originId);
      if (Number(updated.changes) !== 1) {
        throw new Error(`Task changed while detaching deleted ${originType} origin`);
      }
      insertEvent(task.id, 'origin_detached', { originType, originId, snapshot });
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  if (rows.length) emitTaskChanges();
  return { tasksDetached: rows.length, activeTasksCancelled };
}

/** Durable retry/capacity intents, ordered oldest first for fair recovery. */
export function listQueuedRetryTasks(limit = 50): TaskRecord[] {
  const capped = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  return (getDb().prepare(`
    SELECT * FROM tasks
    WHERE status = 'queued' AND CASE
      WHEN retryCount > 0 THEN 1
      WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata, '$.capacityDeferred'), 0)
      ELSE 0
    END = 1
    ORDER BY updatedAt ASC, createdAt ASC
    LIMIT ?
  `).all(capped) as unknown as TaskRow[]).map(rowToTask);
}

export function getTaskDetails(id: string): TaskDetails | null {
  const task = getTask(id);
  if (!task) return null;
  const db = getDb();
  const children = (db.prepare('SELECT * FROM tasks WHERE parentId = ? ORDER BY createdAt ASC').all(task.id) as unknown as TaskRow[]).map(rowToTask);
  const evidence = (db.prepare('SELECT * FROM task_evidence WHERE taskId = ? ORDER BY recordedAt DESC').all(task.id) as unknown as EvidenceRow[]).map(rowToEvidence);
  const attention = (db.prepare('SELECT * FROM task_attention WHERE taskId = ? ORDER BY createdAt DESC').all(task.id) as unknown as AttentionRow[]).map(rowToAttention);
  const commands = (db.prepare('SELECT * FROM task_commands WHERE taskId = ? ORDER BY createdAt ASC').all(task.id) as unknown as CommandRow[]).map(rowToCommand);
  return { ...task, children, evidence, attention, commands };
}

/** Persist worker identity before launching so a crash never leaves an untraceable run. */
export function assignTaskExecution(input: {
  taskId: string;
  runId: string;
  agentId: string;
  expectedVersion?: number;
}): TaskRecord {
  const task = getTask(input.taskId);
  if (!task) throw new Error('Task not found');
  if (TERMINAL_TASK_STATUSES.has(task.status)) throw new Error('Cannot assign a terminal task');
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE tasks SET runId = ?, agentId = ?, version = version + 1, updatedAt = ?
    WHERE id = ? AND version = ?
  `).run(
    cleanText(input.runId, 200, true),
    cleanText(input.agentId, 200, true),
    now,
    task.id,
    input.expectedVersion ?? task.version,
  );
  if (Number(result.changes) !== 1) throw new Error('Task changed concurrently; reload and retry');
  insertEvent(task.id, 'execution_assigned', { runId: input.runId, agentId: input.agentId });
  emitTaskChanges();
  return getTask(task.id)!;
}

/** Register the exact workspace resolved by the runtime (including an isolated worktree). */
export function ensureTaskWorkspaceRoot(
  taskId: string,
  root: TaskWorkspaceRoot,
): TaskRecord {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.workspaceRoots.some((existing) => existing.path === root.path)) return task;
  const normalized = normalizeWorkspaceRoots([root])[0];
  let id = normalized.id;
  let suffix = 2;
  const ids = new Set(task.workspaceRoots.map((existing) => existing.id));
  while (ids.has(id)) id = `${normalized.id}-${suffix++}`;
  const workspaceRoots = [...task.workspaceRoots, { ...normalized, id }];
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE tasks SET workspaceRoots = ?, version = version + 1, updatedAt = ?
    WHERE id = ? AND version = ?
  `).run(JSON.stringify(workspaceRoots), now, task.id, task.version);
  if (Number(result.changes) !== 1) throw new Error('Task changed concurrently; reload and retry');
  insertEvent(task.id, 'workspace_root_registered', { id, path: normalized.path, permission: normalized.permission });
  emitTaskChanges();
  return getTask(task.id)!;
}

export function setTaskContract(taskId: string, contractInput: NonNullable<CreateTaskInput['contract']>): TaskRecord {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (TERMINAL_TASK_STATUSES.has(task.status)) throw new Error('Cannot change the completion contract of a terminal task');
  const contract = normalizeContract(contractInput, task.contract?.createdAt);
  const now = nowIso();
  const res = getDb().prepare(`
    UPDATE tasks SET contract = ?, completion = NULL, version = version + 1, updatedAt = ?
    WHERE id = ? AND version = ?
  `).run(JSON.stringify(contract), now, task.id, task.version);
  if (Number(res.changes) !== 1) throw new Error('Task changed concurrently; reload and retry');
  insertEvent(task.id, 'contract_updated', { requirements: contract?.requirements.length || 0 });
  emitTaskChanges();
  return getTask(task.id)!;
}

export function recordTaskEvidence(input: {
  id?: string;
  taskId: string;
  requirementId?: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  label: string;
  summary: string;
  uri?: string;
  command?: string;
  exitCode?: number;
  scope?: string;
  recordedAt?: string;
  metadata?: Record<string, unknown>;
}): TaskEvidence {
  const task = getTask(input.taskId);
  if (!task) throw new Error('Task not found');
  const kinds = new Set<EvidenceKind>(['command', 'test', 'build', 'diff', 'artifact', 'screenshot', 'deployment', 'integration', 'human_approval', 'assertion', 'other']);
  if (!kinds.has(input.kind)) throw new Error('Invalid evidence kind');
  if (!new Set<EvidenceStatus>(['passed', 'failed', 'informational']).has(input.status)) throw new Error('Invalid evidence status');
  const id = assertTaskId(input.id || randomUUID());
  const serverRecordedAt = Date.now();
  let recordedAt = new Date(serverRecordedAt).toISOString();
  if (input.recordedAt !== undefined) {
    const parsedRecordedAt = Date.parse(input.recordedAt);
    if (Number.isNaN(parsedRecordedAt)) throw new Error('Evidence recordedAt must be a valid timestamp');
    if (parsedRecordedAt > serverRecordedAt + MAX_EVIDENCE_FUTURE_SKEW_MS) {
      throw new Error('Evidence recordedAt cannot be more than five minutes in the future');
    }
    // Preserve legitimate historical evidence while preventing even tolerated
    // client clock skew from extending freshness beyond the server's clock.
    recordedAt = new Date(Math.min(parsedRecordedAt, serverRecordedAt)).toISOString();
  }
  getDb().prepare(`
    INSERT INTO task_evidence (
      id, taskId, requirementId, kind, status, label, summary, uri, command,
      exitCode, scope, recordedAt, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, task.id, input.requirementId ? cleanText(input.requirementId, 120) : null,
    input.kind, input.status, cleanText(input.label, 500, true),
    cleanText(input.summary, 10_000, true), input.uri ? cleanText(input.uri, 2_000) : null,
    input.command ? cleanText(input.command, 10_000) : null,
    Number.isFinite(input.exitCode) ? Number(input.exitCode) : null,
    input.scope ? cleanText(input.scope, 500) : null, recordedAt,
    JSON.stringify(input.metadata || {}),
  );
  getDb().prepare('UPDATE tasks SET completion = NULL, version = version + 1, updatedAt = ? WHERE id = ?')
    .run(nowIso(), task.id);
  insertEvent(task.id, 'evidence_recorded', { evidenceId: id, requirementId: input.requirementId, status: input.status });
  emitTaskChanges();
  const row = getDb().prepare('SELECT * FROM task_evidence WHERE id = ?').get(id) as unknown as EvidenceRow;
  return rowToEvidence(row);
}

function evaluateRequirement(
  requirement: CompletionRequirement,
  evidence: TaskEvidence[],
  evaluatedAt: string,
): RequirementEvaluation {
  let candidates = evidence.filter((item) => item.requirementId === requirement.id);
  if (requirement.acceptedKinds?.length) {
    const kinds = new Set(requirement.acceptedKinds);
    candidates = candidates.filter((item) => kinds.has(item.kind));
  }
  if (!candidates.length) {
    return { requirementId: requirement.id, label: requirement.label, status: 'missing', evidenceIds: [] };
  }
  if (requirement.scope) {
    const scoped = candidates.filter((item) => item.scope === requirement.scope);
    if (!scoped.length) {
      return { requirementId: requirement.id, label: requirement.label, status: 'scope_mismatch', evidenceIds: candidates.map((item) => item.id), detail: `Required scope: ${requirement.scope}` };
    }
    candidates = scoped;
  }
  if (requirement.maxAgeMinutes) {
    const cutoff = Date.parse(evaluatedAt) - requirement.maxAgeMinutes * 60_000;
    const fresh = candidates.filter((item) => Date.parse(item.recordedAt) >= cutoff);
    if (!fresh.length) {
      return { requirementId: requirement.id, label: requirement.label, status: 'stale', evidenceIds: candidates.map((item) => item.id), detail: `Evidence must be newer than ${requirement.maxAgeMinutes} minutes` };
    }
    candidates = fresh;
  }
  // Evidence is ordered newest-first. A later rerun supersedes an earlier
  // failure for the same requirement/scope instead of making success forever
  // impossible; the full history remains visible in the ledger.
  const decisive = candidates.find((item) => item.status !== 'informational');
  if (!decisive) {
    return { requirementId: requirement.id, label: requirement.label, status: 'missing', evidenceIds: candidates.map((item) => item.id), detail: 'Only informational evidence was recorded' };
  }
  return {
    requirementId: requirement.id,
    label: requirement.label,
    status: decisive.status === 'passed' ? 'proven' : 'failed',
    evidenceIds: [decisive.id],
  };
}

export function evaluateTaskCompletion(taskId: string, persist = true): CompletionEvaluation {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const evaluatedAt = nowIso();
  const evidence = (getDb().prepare('SELECT * FROM task_evidence WHERE taskId = ? ORDER BY recordedAt DESC').all(task.id) as unknown as EvidenceRow[]).map(rowToEvidence);
  const contract = task.contract;
  const requirements = contract?.requirements || [];
  const evaluations = requirements.map((requirement) => evaluateRequirement(requirement, evidence, evaluatedAt));

  for (const [index, artifact] of (contract?.requiredArtifacts || []).entries()) {
    const id = `artifact:${index + 1}`;
    const normalizedArtifact = artifact.replace(/\\/g, '/').toLowerCase();
    const candidates = evidence.filter((item) => item.kind === 'artifact' && item.status === 'passed'
      && (
        item.label === artifact
        || item.uri === artifact
        || item.metadata.artifact === artifact
        || item.metadata.path === artifact
        || (typeof item.uri === 'string' && item.uri.replace(/\\/g, '/').toLowerCase().endsWith(`/${normalizedArtifact}`))
      ));
    evaluations.push({
      requirementId: id,
      label: `Artifact: ${artifact}`,
      status: candidates.length ? 'proven' : 'missing',
      evidenceIds: candidates.map((item) => item.id),
    });
  }

  // A parent cannot claim completion while required worker children are
  // unfinished or have returned no passed evidence. Dynamic teams and external
  // harnesses therefore remain projections over this same contract evaluator.
  const requiredChildren = (getDb().prepare('SELECT * FROM tasks WHERE parentId = ? ORDER BY createdAt ASC')
    .all(task.id) as unknown as TaskRow[])
    .map(rowToTask)
    .filter((child) => child.metadata.required !== false);
  for (const child of requiredChildren) {
    const childEvidence = (getDb().prepare(`
      SELECT id FROM task_evidence WHERE taskId = ? AND status = 'passed' ORDER BY recordedAt DESC
    `).all(child.id) as Array<{ id: string }>).map((row) => row.id);
    evaluations.push({
      requirementId: `child:${child.id}`,
      label: `Child task: ${child.title}`,
      status: child.status === 'succeeded' && childEvidence.length
        ? 'proven'
        : child.status === 'failed' || child.status === 'lost' || child.status === 'cancelled'
          ? 'failed'
          : 'missing',
      evidenceIds: childEvidence,
      detail: child.status === 'succeeded' && !childEvidence.length
        ? 'The child reported success but returned no passed evidence.'
        : `Child status: ${child.status}`,
    });
  }

  const requiredIds = new Set(requirements.filter((requirement) => requirement.required !== false).map((requirement) => requirement.id));
  for (const child of requiredChildren) requiredIds.add(`child:${child.id}`);
  const complete = evaluations.every((evaluation) =>
    !requiredIds.has(evaluation.requirementId) && !evaluation.requirementId.startsWith('artifact:')
      ? true
      : evaluation.status === 'proven');
  const result: CompletionEvaluation = { complete, evaluatedAt, requirements: evaluations };
  if (persist) {
    getDb().prepare('UPDATE tasks SET completion = ?, version = version + 1, updatedAt = ? WHERE id = ?')
      .run(JSON.stringify(result), evaluatedAt, task.id);
    insertEvent(task.id, 'completion_evaluated', { complete });
    emitTaskChanges();
  }
  return result;
}

function upsertAttention(input: {
  taskId: string;
  kind: AttentionKind;
  severity: AttentionItem['severity'];
  title: string;
  body: string;
  dedupeKey: string;
  action?: Record<string, unknown>;
}, emit = true): AttentionItem {
  if (!getTask(input.taskId)) throw new Error('Task not found');
  const db = getDb();
  const now = nowIso();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO task_attention (
      id, taskId, kind, status, severity, title, body, action, dedupeKey,
      createdAt, updatedAt, resolvedAt
    ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(taskId, dedupeKey) DO UPDATE SET
      kind = excluded.kind,
      status = 'open',
      severity = excluded.severity,
      title = excluded.title,
      body = excluded.body,
      action = excluded.action,
      updatedAt = excluded.updatedAt,
      resolvedAt = NULL
  `).run(
    id, input.taskId, input.kind, input.severity, cleanText(input.title, 500, true),
    cleanText(input.body, 10_000, true), JSON.stringify(input.action || {}),
    cleanText(input.dedupeKey, 300, true), now, now,
  );
  const row = db.prepare('SELECT * FROM task_attention WHERE taskId = ? AND dedupeKey = ?')
    .get(input.taskId, input.dedupeKey) as unknown as AttentionRow;
  if (emit) emitTaskChanges(true);
  return rowToAttention(row);
}

/** Add or refresh a durable Attention item without exposing the SQL helper. */
export function requestTaskAttention(input: {
  taskId: string;
  kind: AttentionKind;
  severity?: AttentionItem['severity'];
  title: string;
  body: string;
  dedupeKey: string;
  action?: Record<string, unknown>;
}): AttentionItem {
  if (!getTask(input.taskId)) throw new Error('Task not found');
  return upsertAttention({
    ...input,
    severity: input.severity || 'warning',
    action: input.action || { taskId: input.taskId },
  });
}

export function listAttention(opts: {
  status?: AttentionItem['status'];
  taskId?: string;
  limit?: number;
  offset?: number;
} = {}): { items: AttentionItem[]; total: number } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (opts.status) { clauses.push('status = ?'); params.push(opts.status); }
  if (opts.taskId) { clauses.push('taskId = ?'); params.push(assertTaskId(opts.taskId)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const db = getDb();
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM task_attention ${where}`).get(...params) as { n: number }).n);
  const rows = db.prepare(`SELECT * FROM task_attention ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as AttentionRow[];
  return { items: rows.map(rowToAttention), total };
}

export function resolveAttention(id: string, status: 'resolved' | 'dismissed' = 'resolved'): AttentionItem {
  const now = nowIso();
  const res = getDb().prepare(`
    UPDATE task_attention SET status = ?, updatedAt = ?, resolvedAt = ? WHERE id = ?
  `).run(status, now, now, assertTaskId(id));
  if (Number(res.changes) !== 1) throw new Error('Attention item not found');
  const row = getDb().prepare('SELECT * FROM task_attention WHERE id = ?').get(id) as unknown as AttentionRow;
  insertEvent(row.taskId, 'attention_resolved', { attentionId: id, status });
  emitTaskChanges(true);
  return rowToAttention(row);
}

function enqueueOutbox(input: {
  taskId: string;
  kind: string;
  target: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  availableAt?: string;
}): void {
  const now = nowIso();
  getDb().prepare(`
    INSERT OR IGNORE INTO task_outbox (
      id, taskId, kind, target, payload, status, attempts, availableAt,
      createdAt, deliveredAt, lastError, idempotencyKey
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, ?)
  `).run(
    randomUUID(), input.taskId, cleanText(input.kind, 120, true),
    cleanText(input.target, 500, true), JSON.stringify(input.payload),
    input.availableAt || now, now, cleanText(input.idempotencyKey, 500, true),
  );
}

function terminalSignalsSuppressed(task: TaskRecord): boolean {
  if (task.metadata.suppressTerminalSignals === true) return true;
  return task.status !== 'succeeded' && task.metadata.suppressFailureSignals === true;
}

/** Returns true when Attention/outbox terminal signals were created. */
function terminalSignals(task: TaskRecord, emit = true): boolean {
  if (terminalSignalsSuppressed(task)) return false;
  const succeeded = task.status === 'succeeded';
  const cancelled = task.status === 'cancelled';
  const kind: AttentionKind = succeeded ? 'completion' : cancelled ? 'warning' : 'failure';
  const severity: AttentionItem['severity'] = succeeded ? 'info' : cancelled ? 'warning' : 'critical';
  const title = succeeded ? `${task.title} finished` : cancelled ? `${task.title} was cancelled` : `${task.title} needs attention`;
  const body = succeeded ? task.result || 'Task completed.' : task.error || `Task ended with status ${task.status}.`;
  upsertAttention({
    taskId: task.id,
    kind,
    severity,
    title,
    body,
    dedupeKey: `terminal:${task.status}:${task.retryCount}`,
    action: { taskId: task.id, status: task.status },
  }, emit);
  enqueueOutbox({
    taskId: task.id,
    kind: 'task_terminal',
    target: task.sessionId ? `chat:${task.sessionId}` : 'attention',
    payload: { taskId: task.id, status: task.status, title, body },
    idempotencyKey: `task-terminal:${task.id}:${task.status}:${task.retryCount}`,
  });
  return true;
}

interface TransitionTaskInput {
  taskId: string;
  status: TaskStatus;
  expectedVersion?: number;
  progress?: number;
  currentStep?: string | null;
  nextAction?: string | null;
  result?: string | null;
  error?: string | null;
  checkpointId?: string | null;
  metadata?: Record<string, unknown>;
}

interface TransitionTaskEffects {
  task: TaskRecord;
  attentionChanged: boolean;
}

/** Apply one task transition inside the caller's SQLite transaction. */
function transitionTaskInTransaction(input: TransitionTaskInput): TransitionTaskEffects {
  const task = getTask(input.taskId);
  if (!task) throw new Error('Task not found');
  const next = assertTaskStatus(input.status);
  // Terminal rows are immutable. Treat an exact terminal replay as an
  // idempotent no-op instead of allowing it to rewrite result/metadata or
  // move completedAt forward.
  if (next === task.status && TERMINAL_TASK_STATUSES.has(task.status)) {
    return { task, attentionChanged: false };
  }
  if (next !== task.status && !TRANSITIONS[task.status].has(next)) {
    throw new Error(`Invalid task transition: ${task.status} → ${next}`);
  }
  if (next === 'succeeded') {
    const evaluation = evaluateTaskCompletion(task.id, false);
    if (!evaluation.complete) {
      throw new Error('Completion contract is not proven; record valid evidence before succeeding the task');
    }
  }

  const now = nowIso();
  const version = input.expectedVersion ?? task.version;
  const progress = input.progress == null
    ? (next === 'succeeded' ? 1 : task.progress)
    : Math.max(0, Math.min(1, Number(input.progress) || 0));
  const terminal = TERMINAL_TASK_STATUSES.has(next);
  const startedAt = next === 'running' ? task.startedAt || now : task.startedAt || null;
  const completedAt = terminal ? now : null;
  const completion = next === 'succeeded' ? evaluateTaskCompletion(task.id, false) : task.completion;
  const metadata = input.metadata ? { ...task.metadata, ...input.metadata } : task.metadata;
  const db = getDb();
  const shouldSignalTerminal = terminal && (!TERMINAL_TASK_STATUSES.has(task.status) || task.status !== next);
  const shouldResolveTerminalAttention = next === 'queued'
    && (task.status === 'failed' || task.status === 'lost');
  let terminalSignalsCreated = false;
  let terminalAttentionResolved = false;
  let terminalOutboxSuperseded = false;
  const res = db.prepare(`
    UPDATE tasks SET
      status = ?, progress = ?, currentStep = ?, nextAction = ?, result = ?, error = ?,
      checkpointId = ?, metadata = ?, heartbeatAt = ?, startedAt = ?, completedAt = ?,
      completion = ?, version = version + 1, updatedAt = ?
    WHERE id = ? AND version = ?
  `).run(
    next, progress,
    input.currentStep === undefined ? task.currentStep || null : input.currentStep,
    input.nextAction === undefined ? task.nextAction || null : input.nextAction,
    input.result === undefined ? task.result || null : input.result,
    input.error === undefined ? task.error || null : input.error,
    input.checkpointId === undefined ? task.checkpointId || null : input.checkpointId,
    JSON.stringify(metadata), terminal ? task.heartbeatAt || now : now,
    startedAt, completedAt, completion ? JSON.stringify(completion) : null,
    now, task.id, version,
  );
  if (Number(res.changes) !== 1) throw new Error('Task changed concurrently; reload and retry');
  insertEvent(task.id, 'status_changed', { from: task.status, to: next });
  const updated = getTask(task.id)!;
  if (shouldResolveTerminalAttention) {
    const resolvedAt = nowIso();
    const resolved = db.prepare(`
      UPDATE task_attention SET status = 'resolved', updatedAt = ?, resolvedAt = ?
      WHERE taskId = ? AND status = 'open' AND dedupeKey LIKE 'terminal:%'
    `).run(resolvedAt, resolvedAt, task.id);
    terminalAttentionResolved = Number(resolved.changes) > 0;
    if (terminalAttentionResolved) {
      insertEvent(task.id, 'terminal_attention_resolved', { reason: 'task_retried' });
    }
    const superseded = db.prepare(`
      UPDATE task_outbox
      SET status = 'delivered', deliveredAt = ?, lastError = NULL, attempts = attempts + 1
      WHERE taskId = ? AND kind = 'task_terminal'
        AND status IN ('pending', 'failed', 'processing')
    `).run(resolvedAt, task.id);
    terminalOutboxSuperseded = Number(superseded.changes) > 0;
    if (terminalOutboxSuperseded) {
      insertEvent(task.id, 'terminal_delivery_superseded', { reason: 'task_retried' });
    }
  }
  if (shouldSignalTerminal) terminalSignalsCreated = terminalSignals(updated, false);
  return {
    task: updated,
    attentionChanged: terminalSignalsCreated || terminalAttentionResolved || terminalOutboxSuperseded,
  };
}

/** Apply a task transition inside a caller-owned SQLite transaction. */
export function transitionTaskInOpenTransaction(input: TransitionTaskInput): TaskRecord {
  return transitionTaskInTransaction(input).task;
}

export function transitionTask(input: TransitionTaskInput): TaskRecord {
  const db = getDb();
  let effects: TransitionTaskEffects;
  db.exec('BEGIN IMMEDIATE');
  try {
    effects = transitionTaskInTransaction(input);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  emitTaskChanges(effects.attentionChanged);
  return effects.task;
}

export function heartbeatTask(taskId: string, input: {
  progress?: number;
  currentStep?: string;
  nextAction?: string;
  expectedVersion?: number;
} = {}): TaskRecord {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.status !== 'running') throw new Error('Only a running task can be heartbeated');
  const expectedVersion = input.expectedVersion ?? task.version;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('A valid expectedVersion is required');
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE tasks SET progress = ?, currentStep = ?, nextAction = ?, heartbeatAt = ?,
      version = version + 1, updatedAt = ?
    WHERE id = ? AND version = ? AND status = 'running'
  `).run(
    input.progress == null ? task.progress : Math.max(0, Math.min(1, Number(input.progress) || 0)),
    input.currentStep === undefined ? task.currentStep || null : cleanText(input.currentStep, 1_000),
    input.nextAction === undefined ? task.nextAction || null : cleanText(input.nextAction, 1_000),
    now, now, task.id, expectedVersion,
  );
  if (Number(result.changes) !== 1) throw new Error('Task changed concurrently; reload and retry');
  emitTaskChanges();
  return getTask(task.id)!;
}

/**
 * Close the narrow start-up crash gap where a task was assigned a run id and
 * moved to running, but the process died before the matching runs row could be
 * inserted. Exact ids, staleness, active status, and run absence are all re-checked
 * under one write transaction so a late run insert cannot be mistaken as an
 * orphan. Normal terminal attention/outbox effects are retained.
 */
export function markStaleRunningTasksWithoutRunsLost(
  taskIds: readonly string[],
  staleBefore: string,
): string[] {
  const ids = [...new Set(taskIds.map(assertTaskId))].slice(0, 500);
  if (!ids.length) return [];
  const parsed = new Date(staleBefore);
  if (Number.isNaN(parsed.getTime())) throw new Error('A valid staleBefore timestamp is required');
  const cutoff = parsed.toISOString();
  const db = getDb();
  const lost: string[] = [];
  let attentionChanged = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const select = db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.id = ?
        AND t.status IN ('running', 'paused', 'waiting_for_input', 'waiting_for_approval')
        AND t.runId IS NOT NULL
        AND COALESCE(t.heartbeatAt, t.updatedAt, t.createdAt) <= ?
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = t.runId)
    `);
    for (const id of ids) {
      const row = select.get(id, cutoff) as unknown as TaskRow | undefined;
      if (!row) continue;
      const task = rowToTask(row);
      const effects = transitionTaskInTransaction({
        taskId: task.id,
        status: 'lost',
        expectedVersion: task.version,
        error: 'Worker process stopped before the run could be durably started.',
        currentStep: 'Run start was interrupted',
      });
      attentionChanged ||= effects.attentionChanged;
      lost.push(task.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  if (lost.length) emitTaskChanges(attentionChanged);
  return lost;
}

export function enqueueTaskCommand(input: {
  taskId: string;
  kind: TaskCommandKind;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  expectedVersion: number;
}): TaskCommand {
  const task = getTask(input.taskId);
  if (!task) throw new Error('Task not found');
  const idempotencyKey = cleanText(input.idempotencyKey, 300, true);
  const existing = getDb().prepare('SELECT * FROM task_commands WHERE taskId = ? AND idempotencyKey = ?')
    .get(task.id, idempotencyKey) as unknown as CommandRow | undefined;
  if (existing) return rowToCommand(existing);
  const allowed = new Set<TaskCommandKind>(['steer', 'pause', 'resume', 'cancel', 'retry', 'approve', 'deny']);
  if (!allowed.has(input.kind)) throw new Error('Invalid task command');
  if (TERMINAL_TASK_STATUSES.has(task.status) && input.kind !== 'retry') {
    throw new Error('Only retry is allowed for an eligible terminal task');
  }
  if (input.kind === 'retry' && task.status !== 'failed' && task.status !== 'lost') {
    throw new Error('Only failed or lost tasks can be retried');
  }
  if (input.kind === 'retry' && task.retryCount >= task.maxRetries) {
    throw new Error('Task retry limit reached');
  }
  if (input.kind === 'pause' && task.status !== 'running') throw new Error('Only a running task can be paused');
  if (input.kind === 'resume' && task.status !== 'paused') throw new Error('Only a paused task can be resumed');
  if (input.kind === 'steer' && !['running', 'paused', 'waiting_for_input', 'waiting_for_approval'].includes(task.status)) {
    throw new Error('This task is not currently steerable');
  }
  if ((input.kind === 'approve' || input.kind === 'deny') && task.status !== 'waiting_for_approval') {
    throw new Error('This task is not waiting for approval');
  }
  if (input.expectedVersion !== task.version) {
    throw new Error('Task changed concurrently; reload and retry');
  }
  const id = randomUUID();
  const now = nowIso();
  getDb().prepare(`
    INSERT OR IGNORE INTO task_commands (
      id, taskId, kind, status, payload, idempotencyKey, expectedVersion,
      createdAt, appliedAt
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL)
  `).run(id, task.id, input.kind, JSON.stringify(input.payload || {}), idempotencyKey, task.version, now);
  const row = getDb().prepare('SELECT * FROM task_commands WHERE taskId = ? AND idempotencyKey = ?')
    .get(task.id, idempotencyKey) as unknown as CommandRow;
  if (row.id !== id) return rowToCommand(row);
  insertEvent(task.id, 'command_enqueued', { commandId: id, kind: input.kind });
  emitTaskChanges();
  return rowToCommand(row);
}

export interface TaskCommandApplication extends TaskCommand {
  /** True only for the caller that atomically claimed and applied this command. */
  appliedNow: boolean;
}

type RunControlKind = 'cancel' | 'pause' | 'resume' | 'steer';

type RunControlSignal = {
  kind: RunControlKind;
  taskId: string;
  runId: string;
  instruction?: string;
};

export interface TaskRunControlSignal extends RunControlSignal {
  id: string;
  commandId: string;
  attempts: number;
  createdAt: string;
}

export interface ProcessingTaskCommandReconciliation {
  inspected: number;
  requeued: number;
  applied: number;
  rejected: number;
  errors: number;
  pendingCommandIds: string[];
  retryTaskIds: string[];
}

const TASK_COMMAND_CLAIM_TIMEOUT_MS = 30_000;

function ensureRunControlSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS task_run_controls (
      id TEXT PRIMARY KEY,
      commandId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      runId TEXT NOT NULL,
      kind TEXT NOT NULL,
      instruction TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      availableAt TEXT NOT NULL,
      consumerId TEXT,
      leaseUntil TEXT,
      lastError TEXT,
      createdAt TEXT NOT NULL,
      acknowledgedAt TEXT,
      UNIQUE(commandId, runId)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_controls_claim
      ON task_run_controls(runId, status, availableAt, leaseUntil);
    CREATE INDEX IF NOT EXISTS idx_task_run_controls_acknowledged
      ON task_run_controls(status, acknowledgedAt);
  `);
}

function rowToRunControl(row: RunControlRow): TaskRunControlSignal {
  return {
    id: row.id,
    commandId: row.commandId,
    taskId: row.taskId,
    runId: row.runId,
    kind: row.kind as RunControlKind,
    ...(row.instruction ? { instruction: row.instruction } : {}),
    attempts: Number(row.attempts) || 0,
    createdAt: row.createdAt,
  };
}

function persistRunControlSignalsInTransaction(commandId: string, signals: readonly RunControlSignal[]): void {
  if (!signals.length) return;
  const now = nowIso();
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO task_run_controls (
      id, commandId, taskId, runId, kind, instruction, status, attempts,
      availableAt, consumerId, leaseUntil, lastError, createdAt, acknowledgedAt
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, NULL)
  `);
  for (const signal of signals) {
    insert.run(
      randomUUID(), commandId, signal.taskId, signal.runId, signal.kind,
      signal.instruction || null, now, now,
    );
  }
}

/**
 * Claim durable controls for the process that owns a run. The runtime should
 * apply each signal and then call finishTaskRunControlSignal with the returned
 * attempt generation. Expired claims are safely retryable.
 */
export function claimTaskRunControlSignals(
  runId: string,
  consumerId: string,
  limit = 20,
): TaskRunControlSignal[] {
  ensureRunControlSchema();
  const exactRunId = cleanText(runId, 200, true);
  const exactConsumerId = cleanText(consumerId, 200, true);
  const capped = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + 30_000).toISOString();
  const db = getDb();
  const claimed: RunControlRow[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const candidates = db.prepare(`
      SELECT * FROM task_run_controls
      WHERE runId = ? AND (
        (status = 'pending' AND availableAt <= ?)
        OR (status = 'processing' AND leaseUntil IS NOT NULL AND leaseUntil <= ?)
      )
      ORDER BY createdAt ASC, rowid ASC LIMIT ?
    `).all(exactRunId, now, now, capped) as unknown as RunControlRow[];
    const update = db.prepare(`
      UPDATE task_run_controls
      SET status = 'processing', attempts = attempts + 1, consumerId = ?,
        leaseUntil = ?, lastError = NULL
      WHERE id = ? AND runId = ? AND (
        (status = 'pending' AND availableAt <= ?)
        OR (status = 'processing' AND leaseUntil IS NOT NULL AND leaseUntil <= ?)
      )
    `);
    for (const row of candidates) {
      const result = update.run(exactConsumerId, leaseUntil, row.id, exactRunId, now, now);
      if (Number(result.changes) === 1) {
        claimed.push({
          ...row,
          status: 'processing',
          attempts: row.attempts + 1,
          consumerId: exactConsumerId,
          leaseUntil,
          lastError: null,
        });
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  return claimed.map(rowToRunControl);
}

export function finishTaskRunControlSignal(input: {
  id: string;
  runId: string;
  consumerId: string;
  expectedAttempts: number;
  delivered: boolean;
  error?: string;
}): boolean {
  ensureRunControlSchema();
  const id = assertTaskId(input.id);
  const runId = cleanText(input.runId, 200, true);
  const consumerId = cleanText(input.consumerId, 200, true);
  if (!Number.isInteger(input.expectedAttempts) || input.expectedAttempts < 1) {
    throw new Error('A valid expectedAttempts value is required');
  }
  const now = nowIso();
  const result = input.delivered
    ? getDb().prepare(`
        UPDATE task_run_controls
        SET status = 'acknowledged', acknowledgedAt = ?, leaseUntil = NULL, lastError = NULL
        WHERE id = ? AND runId = ? AND status = 'processing'
          AND consumerId = ? AND attempts = ?
      `).run(now, id, runId, consumerId, input.expectedAttempts)
    : getDb().prepare(`
        UPDATE task_run_controls
        SET status = 'pending', availableAt = ?, consumerId = NULL, leaseUntil = NULL,
          lastError = ?
        WHERE id = ? AND runId = ? AND status = 'processing'
          AND consumerId = ? AND attempts = ?
      `).run(
        new Date(Date.now() + 1_000).toISOString(),
        cleanText(input.error || 'Run control delivery failed', 2_000),
        id, runId, consumerId, input.expectedAttempts,
      );
  return Number(result.changes) === 1;
}

export interface TaskDeliveryRetentionCleanup {
  acknowledgedRunControls: number;
  deliveredOutbox: number;
  cutoff: string;
}

/**
 * Prune transport receipts after their retry/idempotency window has passed.
 * Commands and task events remain task-owned history; only acknowledged run
 * controls and delivered outbox rows are disposable delivery bookkeeping.
 */
export function pruneTaskDeliveryReceipts(options: {
  nowMs?: number;
  olderThanMs?: number;
  limit?: number;
} = {}): TaskDeliveryRetentionCleanup {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const requestedRetention = Number(options.olderThanMs);
  const olderThanMs = Number.isFinite(requestedRetention) && requestedRetention >= 0
    ? requestedRetention
    : 30 * 24 * 60 * 60 * 1_000;
  const limit = Math.max(1, Math.min(5_000, Math.floor(Number(options.limit) || 1_000)));
  const cutoff = new Date(nowMs - olderThanMs).toISOString();
  if (isAutomationMaintenanceActive()) {
    return { acknowledgedRunControls: 0, deliveredOutbox: 0, cutoff };
  }
  ensureRunControlSchema();
  const db = getDb();
  let acknowledgedRunControls = 0;
  let deliveredOutbox = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    acknowledgedRunControls = Number(db.prepare(`
      DELETE FROM task_run_controls
      WHERE id IN (
        SELECT id FROM task_run_controls
        WHERE status = 'acknowledged'
          AND acknowledgedAt IS NOT NULL
          AND acknowledgedAt < ?
        ORDER BY acknowledgedAt ASC, rowid ASC
        LIMIT ?
      )
    `).run(cutoff, limit).changes);
    deliveredOutbox = Number(db.prepare(`
      DELETE FROM task_outbox
      WHERE id IN (
        SELECT id FROM task_outbox
        WHERE status = 'delivered'
          AND deliveredAt IS NOT NULL
          AND deliveredAt < ?
        ORDER BY deliveredAt ASC, rowid ASC
        LIMIT ?
      )
    `).run(cutoff, limit).changes);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  return { acknowledgedRunControls, deliveredOutbox, cutoff };
}

function runControlSignal(
  task: TaskRecord,
  kind: TaskCommandKind,
  instruction?: string,
): RunControlSignal | null {
  if (!task.runId || !['cancel', 'pause', 'resume', 'steer'].includes(kind)) return null;
  return { kind: kind as RunControlKind, taskId: task.id, runId: task.runId, instruction };
}

/**
 * Parent tasks (notably routines) own the user-facing command while their
 * direct children own the active runtimes. Mirror lifecycle state to those
 * children and return their exact run identities for cooperative signalling.
 */
function cascadeTaskCommandToChildrenInTransaction(
  parent: TaskRecord,
  command: TaskCommand,
  instruction?: string,
): { signals: RunControlSignal[]; attentionChanged: boolean } {
  if (!['cancel', 'pause', 'resume', 'steer'].includes(command.kind)) {
    return { signals: [], attentionChanged: false };
  }
  const childRows = (command.kind === 'cancel'
    ? getDb().prepare(`
        SELECT * FROM tasks
        WHERE parentId = ?
          AND status IN ('queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked')
        ORDER BY createdAt ASC
      `).all(parent.id)
    : getDb().prepare(`
        SELECT * FROM tasks
        WHERE parentId = ?
          AND status IN ('running', 'paused', 'waiting_for_input', 'waiting_for_approval')
        ORDER BY createdAt ASC
      `).all(parent.id)
  ) as unknown as TaskRow[];
  const signals: RunControlSignal[] = [];
  let attentionChanged = false;

  for (const row of childRows) {
    const child = rowToTask(row);
    if (command.kind === 'cancel') {
      const effects = transitionTaskInTransaction({
        taskId: child.id,
        status: 'cancelled',
        expectedVersion: child.version,
        error: 'Cancelled by the parent task.',
      });
      attentionChanged ||= effects.attentionChanged;
    } else if (command.kind === 'pause' && child.status === 'running') {
      const effects = transitionTaskInTransaction({ taskId: child.id, status: 'paused', expectedVersion: child.version });
      attentionChanged ||= effects.attentionChanged;
    } else if (command.kind === 'resume' && child.status === 'paused') {
      const effects = transitionTaskInTransaction({ taskId: child.id, status: 'running', expectedVersion: child.version });
      attentionChanged ||= effects.attentionChanged;
    }
    const signal = runControlSignal(child, command.kind, instruction);
    if (signal) signals.push(signal);
  }
  return { signals, attentionChanged };
}

function applyCommandMutationsInTransaction(
  task: TaskRecord,
  command: TaskCommand,
  instruction?: string,
): { signals: RunControlSignal[]; attentionChanged: boolean; approvalId?: string } {
  const signals: RunControlSignal[] = [];
  let attentionChanged = false;
  let approvalId: string | undefined;

  if (command.kind === 'pause') {
    attentionChanged ||= transitionTaskInTransaction({
      taskId: task.id, status: 'paused', expectedVersion: task.version,
    }).attentionChanged;
  } else if (command.kind === 'resume') {
    attentionChanged ||= transitionTaskInTransaction({
      taskId: task.id, status: 'running', expectedVersion: task.version,
    }).attentionChanged;
  } else if (command.kind === 'cancel') {
    attentionChanged ||= transitionTaskInTransaction({
      taskId: task.id, status: 'cancelled', expectedVersion: task.version,
    }).attentionChanged;
  } else if (command.kind === 'retry') {
    const retryUpdate = getDb().prepare(`
      UPDATE tasks SET retryCount = retryCount + 1, result = NULL, error = NULL,
        completion = NULL, version = version + 1, updatedAt = ?
      WHERE id = ? AND version = ? AND status IN ('failed', 'lost') AND retryCount < maxRetries
    `).run(nowIso(), task.id, task.version);
    if (Number(retryUpdate.changes) !== 1) {
      throw new Error('Task retry state changed concurrently or retry limit reached');
    }
    const retryable = getTask(task.id)!;
    attentionChanged ||= transitionTaskInTransaction({
      taskId: retryable.id,
      status: 'queued',
      expectedVersion: retryable.version,
      result: null,
      error: null,
    }).attentionChanged;
  } else if (command.kind === 'steer' && task.status === 'waiting_for_input') {
    attentionChanged ||= transitionTaskInTransaction({
      taskId: task.id,
      status: 'running',
      expectedVersion: task.version,
      currentStep: 'Continuing with appended instruction',
    }).attentionChanged;
  } else if (command.kind === 'approve' || command.kind === 'deny') {
    approvalId = cleanText(command.payload.approvalId, 200, true);
    if (!getPendingApproval(approvalId)) throw new Error('Approval no longer exists or has expired');
    if (task.status === 'waiting_for_approval') {
      attentionChanged ||= transitionTaskInTransaction({
        taskId: task.id,
        status: 'running',
        expectedVersion: task.version,
        currentStep: command.kind === 'approve' ? 'Approved action continuing' : 'Denied action handled',
      }).attentionChanged;
    }
  }

  const parentSignal = runControlSignal(task, command.kind, instruction);
  if (parentSignal) signals.push(parentSignal);
  const cascaded = cascadeTaskCommandToChildrenInTransaction(task, command, instruction);
  signals.push(...cascaded.signals);
  attentionChanged ||= cascaded.attentionChanged;
  return { signals, attentionChanged, ...(approvalId ? { approvalId } : {}) };
}

function processingCommandProvesApplied(command: TaskCommand, task: TaskRecord): boolean {
  const nextVersion = command.expectedVersion + 1;
  if (command.kind === 'pause') return task.version === nextVersion && task.status === 'paused';
  if (command.kind === 'resume') return task.version === nextVersion && task.status === 'running';
  if (command.kind === 'cancel') return task.version === nextVersion && task.status === 'cancelled';
  if (command.kind === 'steer') return task.version === nextVersion && task.status === 'running';
  if (command.kind === 'approve' || command.kind === 'deny') {
    return task.version === nextVersion && task.status === 'running';
  }
  return command.kind === 'retry'
    && task.version === command.expectedVersion + 2
    && task.status === 'queued';
}

function processingCommandIsHalfAppliedRetry(command: TaskCommand, task: TaskRecord): boolean {
  return command.kind === 'retry'
    && task.version === command.expectedVersion + 1
    && (task.status === 'failed' || task.status === 'lost')
    && task.result === undefined
    && task.error === undefined;
}

function applyTaskCommandInternal(
  commandId: string,
  accepted: boolean,
  reapplyUnchangedProcessing: boolean,
  staleBefore = new Date(Date.now() - TASK_COMMAND_CLAIM_TIMEOUT_MS).toISOString(),
  throwDeferredErrors = reapplyUnchangedProcessing,
): TaskCommandApplication {
  const db = getDb();
  const id = assertTaskId(commandId);
  ensureRunControlSchema();
  let appliedNow = false;
  let attentionChanged = false;
  let approvalToResolve: { id: string; approved: boolean; taskId: string } | undefined;
  let deferredError: Error | undefined;
  let resultRow: CommandRow | undefined;

  db.exec('BEGIN IMMEDIATE');
  try {
    let row = db.prepare('SELECT * FROM task_commands WHERE id = ?').get(id) as unknown as CommandRow | undefined;
    if (!row) throw new Error('Task command not found');
    if (row.status === 'processing') {
      const claimedAt = row.appliedAt || row.createdAt;
      if (claimedAt > staleBefore) {
        resultRow = row;
      } else {
        const command = rowToCommand(row);
        const task = getTask(command.taskId);
        if (!task) {
          db.prepare("UPDATE task_commands SET status = 'rejected', appliedAt = ? WHERE id = ? AND status = 'processing'")
            .run(nowIso(), command.id);
          if (throwDeferredErrors) deferredError = new Error('Task not found');
        } else if (task.version === command.expectedVersion) {
          if (command.kind === 'approve' || command.kind === 'deny') {
            db.prepare("UPDATE task_commands SET status = 'rejected', appliedAt = ? WHERE id = ? AND status = 'processing'")
              .run(nowIso(), command.id);
            insertEvent(task.id, 'command_rejected', {
              commandId: command.id,
              kind: command.kind,
              reason: 'Approval command expired during process recovery',
            });
            if (throwDeferredErrors) {
              deferredError = new Error('Approval command expired before it could be safely applied');
            }
          } else {
            db.prepare("UPDATE task_commands SET status = 'pending', appliedAt = NULL WHERE id = ? AND status = 'processing'")
              .run(command.id);
            insertEvent(task.id, 'command_requeued', { commandId: command.id, kind: command.kind, reason: 'stale_processing_claim' });
            row = { ...row, status: 'pending', appliedAt: null };
            if (!reapplyUnchangedProcessing) resultRow = row;
          }
        } else if (processingCommandProvesApplied(command, task) || processingCommandIsHalfAppliedRetry(command, task)) {
          db.exec('SAVEPOINT recover_task_command');
          try {
            let recoveredAttentionChanged = false;
            let recoveredTask = task;
            if (processingCommandIsHalfAppliedRetry(command, task)) {
              const effects = transitionTaskInTransaction({
                taskId: task.id,
                status: 'queued',
                expectedVersion: task.version,
                result: null,
                error: null,
              });
              recoveredTask = effects.task;
              recoveredAttentionChanged ||= effects.attentionChanged;
            }
            const instruction = command.kind === 'steer'
              ? cleanText(command.payload.instruction, 8_000, true)
              : undefined;
            const signals: RunControlSignal[] = [];
            const parentSignal = runControlSignal(recoveredTask, command.kind, instruction);
            if (parentSignal) signals.push(parentSignal);
            const cascaded = cascadeTaskCommandToChildrenInTransaction(recoveredTask, command, instruction);
            signals.push(...cascaded.signals);
            recoveredAttentionChanged ||= cascaded.attentionChanged;
            persistRunControlSignalsInTransaction(command.id, signals);
            const finalized = db.prepare(`
              UPDATE task_commands SET status = 'applied', appliedAt = ?
              WHERE id = ? AND status = 'processing'
            `).run(nowIso(), command.id);
            if (Number(finalized.changes) !== 1) throw new Error('Task command recovery claim was lost');
            insertEvent(task.id, 'command_recovered', { commandId: command.id, kind: command.kind, status: 'applied' });
            db.exec('RELEASE recover_task_command');
            attentionChanged ||= recoveredAttentionChanged;
            appliedNow = true;
          } catch (error) {
            try { db.exec('ROLLBACK TO recover_task_command'); db.exec('RELEASE recover_task_command'); } catch { /* transaction will roll back */ }
            throw error;
          }
        } else {
          db.prepare("UPDATE task_commands SET status = 'rejected', appliedAt = ? WHERE id = ? AND status = 'processing'")
            .run(nowIso(), command.id);
          insertEvent(task.id, 'command_rejected', {
            commandId: command.id,
            kind: command.kind,
            reason: 'Task state changed while the command claim was abandoned',
          });
          if (throwDeferredErrors) {
            deferredError = new Error('Task changed concurrently; reload and retry');
          }
        }
      }
    }

    if (!resultRow) {
      row = db.prepare('SELECT * FROM task_commands WHERE id = ?').get(id) as unknown as CommandRow;
      if (row.status === 'pending') {
        const command = rowToCommand(row);
        const task = getTask(command.taskId);
        if (!task) {
          db.prepare("UPDATE task_commands SET status = 'rejected', appliedAt = ? WHERE id = ? AND status = 'pending'")
            .run(nowIso(), command.id);
          if (throwDeferredErrors) deferredError = new Error('Task not found');
        } else if (!accepted) {
          db.prepare("UPDATE task_commands SET status = 'rejected', appliedAt = ? WHERE id = ? AND status = 'pending'")
            .run(nowIso(), command.id);
          insertEvent(task.id, 'command_rejected', { commandId: command.id, kind: command.kind });
          appliedNow = true;
        } else {
          db.exec('SAVEPOINT apply_task_command');
          try {
            if (task.version !== command.expectedVersion) {
              throw new Error('Task changed concurrently; reload and retry');
            }
            const instruction = command.kind === 'steer'
              ? cleanText(command.payload.instruction, 8_000, true)
              : undefined;
            const effects = applyCommandMutationsInTransaction(task, command, instruction);
            persistRunControlSignalsInTransaction(command.id, effects.signals);
            const finalized = db.prepare(`
              UPDATE task_commands SET status = 'applied', appliedAt = ?
              WHERE id = ? AND status = 'pending'
            `).run(nowIso(), command.id);
            if (Number(finalized.changes) !== 1) throw new Error('Task command changed concurrently');
            insertEvent(task.id, 'command_applied', { commandId: command.id, kind: command.kind });
            if (effects.approvalId) {
              approvalToResolve = {
                id: effects.approvalId,
                approved: command.kind === 'approve',
                taskId: task.id,
              };
            }
            db.exec('RELEASE apply_task_command');
            attentionChanged ||= effects.attentionChanged;
            appliedNow = true;
          } catch (error) {
            try { db.exec('ROLLBACK TO apply_task_command'); db.exec('RELEASE apply_task_command'); } catch { /* transaction will roll back */ }
            const message = error instanceof Error ? error.message : String(error);
            db.prepare("UPDATE task_commands SET status = 'rejected', appliedAt = ? WHERE id = ? AND status = 'pending'")
              .run(nowIso(), command.id);
            insertEvent(task.id, 'command_rejected', {
              commandId: command.id,
              kind: command.kind,
              reason: message.slice(0, 500),
            });
            if (/Approval no longer exists/i.test(message)) {
              upsertAttention({
                taskId: task.id,
                kind: 'warning',
                severity: 'warning',
                title: 'Approval expired',
                body: 'This approval no longer exists or has already expired. No action was taken.',
                dedupeKey: `approval-expired:${String(command.payload.approvalId || '')}`,
              }, false);
              attentionChanged = true;
            }
            if (throwDeferredErrors) deferredError = error instanceof Error ? error : new Error(message);
          }
        }
      }
      resultRow = db.prepare('SELECT * FROM task_commands WHERE id = ?').get(id) as unknown as CommandRow;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }

  emitTaskChanges(attentionChanged);
  if (approvalToResolve && !resolveToolApproval(approvalToResolve.id, approvalToResolve.approved)) {
    requestTaskAttention({
      taskId: approvalToResolve.taskId,
      kind: 'warning',
      severity: 'warning',
      title: 'Approval delivery was interrupted',
      body: 'The decision was saved, but the original waiting process no longer exists.',
      dedupeKey: `approval-delivery-interrupted:${approvalToResolve.id}`,
    });
  }
  if (deferredError) throw deferredError;
  return { ...rowToCommand(resultRow!), appliedNow };
}

export function applyTaskCommand(commandId: string, accepted = true): TaskCommandApplication {
  return applyTaskCommandInternal(commandId, accepted, true);
}

/** Recover stale command claims without re-authorizing approval decisions. */
export async function reconcileProcessingTaskCommands(
  staleAfterMs = TASK_COMMAND_CLAIM_TIMEOUT_MS,
): Promise<ProcessingTaskCommandReconciliation> {
  const emptyResult = (): ProcessingTaskCommandReconciliation => ({
    inspected: 0,
    requeued: 0,
    applied: 0,
    rejected: 0,
    errors: 0,
    pendingCommandIds: [],
    retryTaskIds: [],
  });
  if (isAutomationMaintenanceActive()) return emptyResult();
  const staleBefore = new Date(Date.now() - Math.max(0, staleAfterMs)).toISOString();
  const rows = getDb().prepare(`
    SELECT * FROM task_commands
    WHERE status = 'processing' AND COALESCE(appliedAt, createdAt) <= ?
    ORDER BY createdAt ASC
  `).all(staleBefore) as unknown as CommandRow[];
  const result = emptyResult();
  result.inspected = rows.length;
  for (const row of rows) {
    if (isAutomationMaintenanceActive()) break;
    try {
      // Unchanged non-approval commands are safe to finish in the same
      // transaction: expectedVersion proves no task mutation committed.
      // Approve/deny are always rejected rather than re-authorized.
      const recovered = applyTaskCommandInternal(row.id, true, true, staleBefore, false);
      if (recovered.status === 'pending') {
        result.requeued += 1;
        result.pendingCommandIds.push(recovered.id);
      } else if (recovered.status === 'applied') {
        result.applied += 1;
        if (recovered.kind === 'retry') result.retryTaskIds.push(recovered.taskId);
      } else if (recovered.status === 'rejected') {
        result.rejected += 1;
      }
    } catch {
      result.errors += 1;
    }
  }
  // A process can also die after the durable command INSERT but before it
  // claims the row as processing. Recover aged commands as well: ordinary
  // control mutations remain protected by expectedVersion, while approvals
  // are rejected because their in-memory authorization cannot be recreated.
  const pendingRows = getDb().prepare(`
    SELECT * FROM task_commands
    WHERE status = 'pending' AND createdAt <= ?
    ORDER BY createdAt ASC
  `).all(staleBefore) as unknown as CommandRow[];
  result.inspected += pendingRows.length;
  for (const row of pendingRows) {
    if (isAutomationMaintenanceActive()) break;
    try {
      const safeToApply = row.kind !== 'approve' && row.kind !== 'deny';
      const recovered = applyTaskCommandInternal(row.id, safeToApply, false, staleBefore, false);
      if (recovered.status === 'applied') {
        result.applied += 1;
        if (recovered.kind === 'retry') result.retryTaskIds.push(recovered.taskId);
      } else if (recovered.status === 'rejected') {
        result.rejected += 1;
      }
    } catch {
      result.errors += 1;
    }
  }
  result.retryTaskIds = [...new Set(result.retryTaskIds)];
  if (result.retryTaskIds.length && !isAutomationMaintenanceActive()) {
    try {
      const { dispatchExistingTask } = await import('./background-tasks');
      const dispatches = await Promise.allSettled(result.retryTaskIds.map((taskId) => dispatchExistingTask(taskId)));
      result.errors += dispatches.filter((dispatch) => dispatch.status === 'rejected').length;
    } catch {
      result.errors += result.retryTaskIds.length;
    }
  }
  return result;
}

/** Instrumentation and the browser boot fallback can race on first request. */
export function reconcileProcessingTaskCommandsAtStartup(): Promise<ProcessingTaskCommandReconciliation> {
  const startup = globalThis as typeof globalThis & {
    __shibaTaskCommandStartupReconciliation?: Promise<ProcessingTaskCommandReconciliation>;
  };
  if (startup.__shibaTaskCommandStartupReconciliation) {
    return startup.__shibaTaskCommandStartupReconciliation;
  }
  const run = reconcileProcessingTaskCommands();
  const shared = run.catch((error) => {
    if (startup.__shibaTaskCommandStartupReconciliation === shared) {
      startup.__shibaTaskCommandStartupReconciliation = undefined;
    }
    throw error;
  });
  startup.__shibaTaskCommandStartupReconciliation = shared;
  startTaskCommandReconciler();
  return startup.__shibaTaskCommandStartupReconciliation;
}

interface TaskCommandReconcilerGlobals {
  __shibaTaskCommandReconcilerTimer?: ReturnType<typeof setInterval>;
  __shibaTaskCommandReconcilerPass?: Promise<ProcessingTaskCommandReconciliation>;
}

const taskCommandReconcilerGlobals = globalThis as typeof globalThis & TaskCommandReconcilerGlobals;

/** Keep the INSERT-before-apply crash window self-healing after startup. */
export function startTaskCommandReconciler(intervalMs = 15_000): void {
  if (taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerTimer) return;
  const period = Math.max(1_000, Math.floor(Number(intervalMs) || 15_000));
  taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerTimer = setInterval(() => {
    if (taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerPass || isAutomationMaintenanceActive()) return;
    const pass = reconcileProcessingTaskCommands();
    taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerPass = pass;
    void pass.catch((error) => {
      console.error('[task-ledger] task command reconciliation failed', error);
    }).finally(() => {
      if (taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerPass === pass) {
        taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerPass = undefined;
      }
    });
  }, period);
  taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerTimer.unref?.();
}

export async function stopTaskCommandReconciler(): Promise<void> {
  if (taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerTimer) {
    clearInterval(taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerTimer);
    taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerTimer = undefined;
  }
  await taskCommandReconcilerGlobals.__shibaTaskCommandReconcilerPass?.catch(() => undefined);
}

export function listPendingTaskCommands(taskId: string): TaskCommand[] {
  return (getDb().prepare("SELECT * FROM task_commands WHERE taskId = ? AND status = 'pending' ORDER BY createdAt ASC")
    .all(assertTaskId(taskId)) as unknown as CommandRow[]).map(rowToCommand);
}

export function claimOutbox(limit = 20): TaskOutboxItem[] {
  const db = getDb();
  const now = nowIso();
  const capped = Math.max(1, Math.min(100, Number(limit) || 20));
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db.prepare(`
      SELECT * FROM task_outbox
      WHERE status IN ('pending', 'failed', 'processing') AND availableAt <= ?
      ORDER BY createdAt ASC LIMIT ?
    `).all(now, capped) as unknown as OutboxRow[];
    const update = db.prepare(`
      UPDATE task_outbox SET status = 'processing', attempts = attempts + 1,
        availableAt = ?, lastError = NULL
      WHERE id = ? AND status IN ('pending', 'failed', 'processing') AND availableAt <= ?
    `);
    const claimed: OutboxRow[] = [];
    const leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString();
    for (const row of rows) {
      const result = update.run(leaseUntil, row.id, now);
      if (Number(result.changes) === 1) {
        claimed.push({
          ...row,
          status: 'processing',
          attempts: row.attempts + 1,
          availableAt: leaseUntil,
          lastError: null,
        });
      }
    }
    db.exec('COMMIT');
    return claimed.map(rowToOutbox);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
}

export function finishOutbox(id: string, result: {
  delivered: boolean;
  error?: string;
  retryAt?: string;
  expectedAttempts?: number;
}): TaskOutboxItem {
  const now = nowIso();
  const outboxId = assertTaskId(id);
  const expectedAttempts = result.expectedAttempts;
  if (expectedAttempts !== undefined && (!Number.isInteger(expectedAttempts) || expectedAttempts < 1)) {
    throw new Error('A valid expectedAttempts value is required');
  }
  const res = result.delivered
    ? expectedAttempts === undefined
      ? getDb().prepare("UPDATE task_outbox SET status = 'delivered', deliveredAt = ?, lastError = NULL WHERE id = ? AND status = 'processing'")
        .run(now, outboxId)
      : getDb().prepare("UPDATE task_outbox SET status = 'delivered', deliveredAt = ?, lastError = NULL WHERE id = ? AND status = 'processing' AND attempts = ?")
        .run(now, outboxId, expectedAttempts)
    : expectedAttempts === undefined
      ? getDb().prepare("UPDATE task_outbox SET status = 'failed', availableAt = ?, lastError = ? WHERE id = ? AND status = 'processing'")
        .run(result.retryAt || new Date(Date.now() + 60_000).toISOString(), cleanText(result.error || 'Delivery failed', 2_000), outboxId)
      : getDb().prepare("UPDATE task_outbox SET status = 'failed', availableAt = ?, lastError = ? WHERE id = ? AND status = 'processing' AND attempts = ?")
        .run(result.retryAt || new Date(Date.now() + 60_000).toISOString(), cleanText(result.error || 'Delivery failed', 2_000), outboxId, expectedAttempts);
  if (Number(res.changes) !== 1) throw new Error('Outbox item claim is no longer current');
  return rowToOutbox(getDb().prepare('SELECT * FROM task_outbox WHERE id = ?').get(id) as unknown as OutboxRow);
}

function mapRunStatus(status: AgentRun['status']): TaskStatus {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'succeeded';
  if (status === 'error') return 'failed';
  return 'queued';
}

export function taskIdForRun(runId: string): string {
  return assertTaskId(`run:${runId}`);
}

/** Project a legacy/current AgentRun into the universal ledger. Idempotent. */
export function syncTaskFromRun(run: AgentRun): TaskRecord {
  const id = run.taskId ? assertTaskId(run.taskId) : taskIdForRun(run.id);
  const desired = mapRunStatus(run.status);
  const existing = getTask(id);
  if (!existing) {
    createTask({
      id,
      kind: run.scheduleId ? 'routine' : 'agent',
      title: run.prompt.slice(0, 120) || `${run.agentName} run`,
      description: run.prompt,
      status: 'queued',
      originType: run.scheduleId ? 'schedule' : 'run',
      originId: run.scheduleId || run.id,
      agentId: run.agentId,
      projectId: run.projectId,
      runId: run.id,
      workspaceRoots: run.workspaceSnapshot
        ? [{ id: 'run-workspace', path: run.workspaceSnapshot, permission: 'write' }]
        : [],
      metadata: { agentName: run.agentName, model: run.model, scheduleInstructions: run.scheduleInstructions },
    });
  }
  let current = getTask(id)!;
  if (run.workspaceSnapshot && !current.workspaceRoots.some((root) => root.path === run.workspaceSnapshot)) {
    const roots = [
      ...current.workspaceRoots,
      {
        id: current.workspaceRoots.some((root) => root.id === 'run-workspace')
          ? `run-workspace-${current.workspaceRoots.length + 1}`
          : 'run-workspace',
        path: run.workspaceSnapshot,
        permission: 'write' as const,
        label: 'Resolved run workspace',
      },
    ];
    const now = nowIso();
    getDb().prepare('UPDATE tasks SET workspaceRoots = ?, version = version + 1, updatedAt = ? WHERE id = ?')
      .run(JSON.stringify(roots), now, id);
    current = getTask(id)!;
  }
  // The control plane may have reached a terminal decision (notably user
  // cancellation) before the worker writes its final run record. Preserve the
  // task decision while still allowing the run record itself to persist.
  if (TERMINAL_TASK_STATUSES.has(current.status) && desired !== current.status) {
    return current;
  }
  // A late/initial running projection must not erase a lifecycle decision that
  // was applied after assignment (notably pause before the first runs-row
  // insert). Terminal run results may still complete/fail these states.
  if (desired === 'running' && !['queued', 'running'].includes(current.status)) {
    return current;
  }
  if (desired === 'succeeded' && current.contract) {
    const evaluation = evaluateTaskCompletion(id, false);
    if (!evaluation.complete) {
      const awaiting = transitionTask({
        taskId: id,
        status: 'waiting_for_approval',
        result: run.finalOutput || '',
        currentStep: 'Awaiting completion evidence',
        nextAction: 'Record or review evidence against the completion contract',
        metadata: { sideEffects: run.sideEffects, agentName: run.agentName, model: run.model },
      });
      requestTaskAttention({
        taskId: id,
        kind: 'approval',
        severity: 'warning',
        title: `${awaiting.title} needs verification`,
        body: 'The work finished, but its completion contract is not yet proven. Review or record evidence before marking it complete.',
        dedupeKey: 'completion-contract-unproven',
        action: { taskId: id, href: `/tasks/${encodeURIComponent(id)}` },
      });
      return getTask(id)!;
    }
  }
  if (desired === current.status) {
    const now = nowIso();
    getDb().prepare(`
      UPDATE tasks SET result = ?, error = ?, heartbeatAt = ?, updatedAt = ?,
        projectId = COALESCE(?, projectId), metadata = ?, version = version + 1
      WHERE id = ?
    `).run(
      run.status === 'completed' ? run.finalOutput || null : current.result || null,
      run.status === 'error' ? run.finalOutput || 'Agent run failed' : current.error || null,
      run.status === 'running' ? now : current.heartbeatAt || null,
      now, run.projectId || null,
      JSON.stringify({ ...current.metadata, agentName: run.agentName, model: run.model, sideEffects: run.sideEffects }),
      id,
    );
    emitTaskChanges();
    return getTask(id)!;
  }
  return transitionTask({
    taskId: id,
    status: desired,
    result: run.status === 'completed' ? run.finalOutput || '' : null,
    error: run.status === 'error' ? run.finalOutput || 'Agent run failed' : null,
    metadata: { sideEffects: run.sideEffects, agentName: run.agentName, model: run.model },
  });
}

/**
 * Mark task projections for exact interrupted run identities as lost. Passing
 * the run ids prevents one server instance from declaring another instance's
 * live work orphaned. The no-argument running-only path remains for callers
 * migrating from the pre-run-id reconciler.
 */
export function reconcileOrphanedTasks(interruptedRunIds?: readonly string[]): number {
  const db = getDb();
  const now = nowIso();
  const interrupted = interruptedRunIds === undefined
    ? null
    : new Set(interruptedRunIds.map((id) => cleanText(id, 200)).filter(Boolean));
  if (interrupted?.size === 0) return 0;
  const rows = (interrupted
    ? db.prepare(`
        SELECT * FROM tasks
        WHERE status IN ('running', 'paused', 'waiting_for_input', 'waiting_for_approval')
          AND runId IS NOT NULL
        ORDER BY updatedAt ASC
      `).all()
    : db.prepare("SELECT * FROM tasks WHERE status = 'running' ORDER BY updatedAt ASC").all()
  ) as unknown as TaskRow[];
  let reconciled = 0;
  for (const row of rows) {
    const task = rowToTask(row);
    if (interrupted && (!task.runId || !interrupted.has(task.runId))) continue;
    try {
      transitionTask({
        taskId: task.id,
        status: 'lost',
        expectedVersion: task.version,
        error: 'Task execution was interrupted when the Shiba Studio server stopped.',
        metadata: { ...task.metadata, restartReconciledAt: now },
      });
      reconciled += 1;
    } catch (error) {
      if (!/concurrently|Invalid task transition/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
  return reconciled;
}
