// Universal durable task control plane. Runs, chat background work, routines,
// Board work, dynamic workers, artifacts, and external harnesses project into
// this one SQLite ledger instead of maintaining parallel lifecycle stores.

import { randomUUID } from 'node:crypto';
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
import { resolveToolApproval } from './tool-approval';

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

export function createTask(input: CreateTaskInput): TaskRecord {
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

  db.exec('BEGIN IMMEDIATE');
  try {
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
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  emitTaskChanges();
  return getTask(id)!;
}

export function getTask(id: string): TaskRecord | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(assertTaskId(id)) as unknown as TaskRow | undefined;
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

function terminalSignals(task: TaskRecord, emit = true): void {
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
}

export function transitionTask(input: {
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
}): TaskRecord {
  const task = getTask(input.taskId);
  if (!task) throw new Error('Task not found');
  const next = assertTaskStatus(input.status);
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
  let updated: TaskRecord;
  db.exec('BEGIN IMMEDIATE');
  try {
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
    updated = getTask(task.id)!;
    if (shouldSignalTerminal) terminalSignals(updated, false);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  emitTaskChanges(shouldSignalTerminal);
  return updated;
}

export function heartbeatTask(taskId: string, input: {
  progress?: number;
  currentStep?: string;
  nextAction?: string;
} = {}): TaskRecord {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (TERMINAL_TASK_STATUSES.has(task.status)) throw new Error('Cannot heartbeat a terminal task');
  const now = nowIso();
  getDb().prepare(`
    UPDATE tasks SET progress = ?, currentStep = ?, nextAction = ?, heartbeatAt = ?,
      version = version + 1, updatedAt = ? WHERE id = ?
  `).run(
    input.progress == null ? task.progress : Math.max(0, Math.min(1, Number(input.progress) || 0)),
    input.currentStep === undefined ? task.currentStep || null : cleanText(input.currentStep, 1_000),
    input.nextAction === undefined ? task.nextAction || null : cleanText(input.nextAction, 1_000),
    now, now, task.id,
  );
  emitTaskChanges();
  return getTask(task.id)!;
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

export function applyTaskCommand(commandId: string, accepted = true): TaskCommandApplication {
  const db = getDb();
  const id = assertTaskId(commandId);
  let row: CommandRow | undefined;
  let claimed = false;

  db.exec('BEGIN IMMEDIATE');
  try {
    row = db.prepare('SELECT * FROM task_commands WHERE id = ?').get(id) as unknown as CommandRow | undefined;
    if (!row) throw new Error('Task command not found');
    if (row.status === 'pending') {
      const result = db.prepare("UPDATE task_commands SET status = 'processing' WHERE id = ? AND status = 'pending'").run(id);
      claimed = Number(result.changes) === 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }

  if (!claimed) {
    const current = db.prepare('SELECT * FROM task_commands WHERE id = ?').get(id) as unknown as CommandRow;
    return { ...rowToCommand(current), appliedNow: false };
  }

  const command = rowToCommand({ ...row!, status: 'processing' });
  const task = getTask(command.taskId);
  if (!task) {
    db.prepare("UPDATE task_commands SET status = 'rejected', appliedAt = ? WHERE id = ? AND status = 'processing'")
      .run(nowIso(), command.id);
    throw new Error('Task not found');
  }
  try {
    if (task.version !== command.expectedVersion) throw new Error('Task changed concurrently; reload and retry');
    if (accepted) {
      if (command.kind === 'pause') transitionTask({ taskId: task.id, status: 'paused', expectedVersion: task.version });
      if (command.kind === 'resume') transitionTask({ taskId: task.id, status: 'running', expectedVersion: task.version });
      if (command.kind === 'cancel') transitionTask({ taskId: task.id, status: 'cancelled', expectedVersion: task.version });
      if (command.kind === 'retry') {
        const retryUpdate = db.prepare(`
          UPDATE tasks SET retryCount = retryCount + 1, result = NULL, error = NULL,
            completion = NULL, version = version + 1, updatedAt = ?
          WHERE id = ? AND version = ? AND status IN ('failed', 'lost') AND retryCount < maxRetries
        `).run(nowIso(), task.id, task.version);
        if (Number(retryUpdate.changes) !== 1) throw new Error('Task retry state changed concurrently or retry limit reached');
        const retryable = getTask(task.id)!;
        transitionTask({ taskId: retryable.id, status: 'queued', expectedVersion: retryable.version, result: null, error: null });
      }
      if (command.kind === 'steer' && task.status === 'waiting_for_input') {
        transitionTask({ taskId: task.id, status: 'running', expectedVersion: task.version, currentStep: 'Continuing with appended instruction' });
      }
      if (command.kind === 'approve' || command.kind === 'deny') {
        const approvalId = cleanText(command.payload.approvalId, 200, true);
        if (!resolveToolApproval(approvalId, command.kind === 'approve')) {
          requestTaskAttention({
            taskId: task.id,
            kind: 'warning',
            severity: 'warning',
            title: 'Approval expired',
            body: 'This approval no longer exists or has already expired. No action was taken.',
            dedupeKey: `approval-expired:${approvalId}`,
          });
          throw new Error('Approval no longer exists or has expired');
        }
        if (task.status === 'waiting_for_approval') {
          transitionTask({
            taskId: task.id,
            status: 'running',
            expectedVersion: task.version,
            currentStep: command.kind === 'approve' ? 'Approved action continuing' : 'Denied action handled',
          });
        }
      }
    }

    const now = nowIso();
    const finalized = db.prepare(`
      UPDATE task_commands SET status = ?, appliedAt = ? WHERE id = ? AND status = 'processing'
    `).run(accepted ? 'applied' : 'rejected', now, command.id);
    if (Number(finalized.changes) !== 1) throw new Error('Task command claim was lost before it could be finalized');
    insertEvent(task.id, accepted ? 'command_applied' : 'command_rejected', { commandId: command.id, kind: command.kind });

    if (accepted && task.runId) {
      if (command.kind === 'cancel') {
        void import('./agent-runtime').then(({ requestRunCancel }) => requestRunCancel(task.runId!));
      } else if (command.kind === 'pause') {
        void import('./agent-runtime').then(({ requestRunPause }) => requestRunPause(task.runId!));
      } else if (command.kind === 'resume') {
        void import('./agent-runtime').then(({ requestRunResume }) => requestRunResume(task.runId!));
      } else if (command.kind === 'steer') {
        const instruction = cleanText(command.payload.instruction, 8_000, true);
        void import('./agent-runtime').then(({ appendRunInstruction }) => appendRunInstruction(task.runId!, instruction));
      }
    }
    emitTaskChanges();
    const applied = rowToCommand(db.prepare('SELECT * FROM task_commands WHERE id = ?').get(command.id) as unknown as CommandRow);
    return { ...applied, appliedNow: true };
  } catch (error) {
    const rejectedAt = nowIso();
    db.prepare("UPDATE task_commands SET status = 'rejected', appliedAt = ? WHERE id = ? AND status = 'processing'")
      .run(rejectedAt, command.id);
    insertEvent(task.id, 'command_rejected', {
      commandId: command.id,
      kind: command.kind,
      reason: error instanceof Error ? error.message.slice(0, 500) : 'command_failed',
    });
    emitTaskChanges();
    throw error;
  }
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

export function finishOutbox(id: string, result: { delivered: boolean; error?: string; retryAt?: string }): TaskOutboxItem {
  const now = nowIso();
  const res = result.delivered
    ? getDb().prepare("UPDATE task_outbox SET status = 'delivered', deliveredAt = ?, lastError = NULL WHERE id = ? AND status = 'processing'")
      .run(now, assertTaskId(id))
    : getDb().prepare("UPDATE task_outbox SET status = 'failed', availableAt = ?, lastError = ? WHERE id = ? AND status = 'processing'")
      .run(result.retryAt || new Date(Date.now() + 60_000).toISOString(), cleanText(result.error || 'Delivery failed', 2_000), assertTaskId(id));
  if (Number(res.changes) !== 1) throw new Error('Outbox item is not currently claimed');
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

/** Mark active task leases as lost after a process restart. */
export function reconcileOrphanedTasks(): number {
  const db = getDb();
  const now = nowIso();
  const ids = (db.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as Array<{ id: string }>).map((row) => row.id);
  for (const id of ids) {
    const task = getTask(id);
    if (!task) continue;
    transitionTask({
      taskId: id,
      status: 'lost',
      error: 'Task execution was interrupted when the Shiba Studio server stopped.',
      metadata: { ...task.metadata, restartReconciledAt: now },
    });
  }
  return ids.length;
}
