import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as cron from 'node-cron';
import { getDb } from './db';
import { emitAppEvent } from './app-events';
import { audit } from './audit-log';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secure-store';
import {
  getTask,
  heartbeatTask,
  publishTaskChanges,
  transitionTask,
  transitionTaskInOpenTransaction,
} from './task-ledger';
import { automationCronError, automationTick, isSupportedAutomationCron } from './automation-cron';
import { automationMaintenanceReason, isAutomationMaintenanceActive } from './automation-maintenance';
import { loadAgents, mutateAgents, withAgentOwnershipSnapshot } from './persistence';
import type {
  CreateRoutineInput,
  RoutineCondition,
  RoutineDefinition,
  RoutineExecutionSnapshot,
  RoutineInvocation,
  RoutineRetryPolicy,
  RoutineStep,
  RoutineTrigger,
  RoutineTriggerType,
} from './routine-types';

const REDACTED_SECRET = '••••••••';
const ROUTINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const workerId = `${process.pid}:${randomUUID()}`;

class RoutineInvocationCancelledError extends Error {
  constructor(message = 'Routine invocation was cancelled by the user') {
    super(message);
    this.name = 'RoutineInvocationCancelledError';
  }
}

class RoutineInvocationLeaseLostError extends Error {
  constructor(message = 'Routine invocation lease was reclaimed by another worker attempt') {
    super(message);
    this.name = 'RoutineInvocationLeaseLostError';
  }
}

class RoutineInvocationHeartbeatError extends RoutineInvocationLeaseLostError {
  constructor(cause: unknown) {
    super(`Routine invocation lease heartbeat could not be persisted: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'RoutineInvocationHeartbeatError';
  }
}

export class RoutineMaintenanceError extends Error {
  readonly code = 'AUTOMATION_MAINTENANCE';
  readonly retryable = true;

  constructor() {
    super(`Automations are temporarily paused for maintenance${automationMaintenanceReason() ? `: ${automationMaintenanceReason()}` : ''}. Retry shortly.`);
    this.name = 'RoutineMaintenanceError';
  }
}

function assertRoutineDispatchAvailable(): void {
  if (isAutomationMaintenanceActive()) throw new RoutineMaintenanceError();
}

function throwIfInvocationLeaseLost(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof RoutineInvocationLeaseLostError
    ? signal.reason
    : new RoutineInvocationLeaseLostError();
}

const PAUSE_LIKE_TASK_STATUSES = new Set(['paused', 'waiting_for_input', 'waiting_for_approval']);

class RoutineActiveTimeBudget {
  private readonly controller = new AbortController();
  private readonly timeoutMs: number;
  private lastSampleAt: number;
  private previouslyPaused = false;
  private remaining: number;

  constructor(timeoutMs: number, startAt = Date.now()) {
    this.timeoutMs = timeoutMs;
    this.remaining = timeoutMs;
    this.lastSampleAt = startAt;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get remainingMs(): number {
    return Math.max(0, this.remaining);
  }

  sample(paused: boolean, sampledAt = Date.now()): void {
    if (this.signal.aborted) return;
    const elapsed = Math.max(0, sampledAt - this.lastSampleAt);
    // A status poll cannot know the exact instant a pause/resume occurred. Be
    // conservative on both transition samples so a legitimate pause can never
    // turn into an immediate timeout merely because it landed between polls.
    if (!paused && !this.previouslyPaused) this.remaining -= elapsed;
    this.lastSampleAt = Math.max(this.lastSampleAt, sampledAt);
    this.previouslyPaused = paused;
    if (this.remaining <= 0) this.abort(new Error(`Routine timed out after ${this.timeoutMs}ms of active execution`));
  }

  abort(reason: unknown): void {
    if (!this.signal.aborted) this.controller.abort(reason);
  }

  throwIfExpired(): void {
    if (!this.signal.aborted) return;
    throw this.signal.reason instanceof Error
      ? this.signal.reason
      : new Error(`Routine timed out after ${this.timeoutMs}ms of active execution`);
  }
}

function startRoutineActiveTimeBudget(timeoutMs: number, isPaused: () => boolean): {
  budget: RoutineActiveTimeBudget;
  stop: () => void;
} {
  const budget = new RoutineActiveTimeBudget(timeoutMs);
  const timer = setInterval(() => {
    try {
      budget.sample(isPaused());
    } catch (error) {
      // Timer callbacks must never let a transient task-store read escape as an
      // uncaught process exception. Abort the attempt through its normal path.
      try { budget.abort(new Error(`Routine timeout monitor failed: ${error instanceof Error ? error.message : String(error)}`)); } catch { /* best effort */ }
    }
  }, 500);
  timer.unref?.();
  return { budget, stop: () => clearInterval(timer) };
}

function runRoutineLeaseHeartbeatTick(controller: AbortController, renew: () => boolean): void {
  if (controller.signal.aborted) return;
  try {
    if (!renew()) controller.abort(new RoutineInvocationLeaseLostError());
  } catch (error) {
    // A thrown SQLite prepare/run from setInterval would otherwise become an
    // uncaught exception and terminate the server.
    try { controller.abort(new RoutineInvocationHeartbeatError(error)); } catch { /* best effort */ }
  }
}

export const routineRuntimeTestHooks = {
  RoutineActiveTimeBudget,
  runRoutineLeaseHeartbeatTick,
};

interface RoutineRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  agentId: string;
  prompt: string;
  triggers: string;
  conditions: string;
  parameters: string;
  retryPolicy: string;
  timeoutMs: number;
  concurrencyKey: string;
  catchUpPolicy: string;
  circuitBreaker: string;
  steps: string;
  failureStreak: number;
  circuitState: string;
  circuitOpenedAt: string | null;
  circuitOpenUntil: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface InvocationRow {
  id: string;
  routineId: string;
  triggerId: string;
  triggerType: string;
  dedupeKey: string;
  concurrencyKey: string;
  status: string;
  payload: string;
  definitionSnapshot: string;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  taskId: string | null;
  error: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface TriggerStateRow {
  state: string;
  dueAt: string;
}

interface TriggerCheckClaim {
  routineId: string;
  triggerId: string;
  dueKey: string;
  token: string;
  intervalSeconds: number;
  checkedAt: string;
  state: Record<string, unknown>;
}

const initializedHandles = new WeakSet<object>();

/** Routines intentionally use a guarded extension schema while the v8 checkpoint migration lands. */
export function ensureRoutineSchema(): void {
  const db = getDb();
  if (initializedHandles.has(db as object)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      agentId TEXT NOT NULL,
      prompt TEXT NOT NULL,
      triggers TEXT NOT NULL DEFAULT '[]',
      conditions TEXT NOT NULL DEFAULT '[]',
      parameters TEXT NOT NULL DEFAULT '{}',
      retryPolicy TEXT NOT NULL,
      timeoutMs INTEGER NOT NULL,
      concurrencyKey TEXT NOT NULL,
      catchUpPolicy TEXT NOT NULL,
      circuitBreaker TEXT NOT NULL,
      steps TEXT NOT NULL DEFAULT '[]',
      failureStreak INTEGER NOT NULL DEFAULT 0,
      circuitState TEXT NOT NULL DEFAULT 'closed',
      circuitOpenedAt TEXT,
      circuitOpenUntil TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_routines_active ON routines(deletedAt, enabled, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS routine_invocations (
      id TEXT PRIMARY KEY,
      routineId TEXT NOT NULL REFERENCES routines(id),
      triggerId TEXT NOT NULL,
      triggerType TEXT NOT NULL,
      dedupeKey TEXT NOT NULL,
      concurrencyKey TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      definitionSnapshot TEXT NOT NULL DEFAULT '{}',
      attempt INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL,
      availableAt TEXT NOT NULL,
      leaseOwner TEXT,
      leaseExpiresAt TEXT,
      taskId TEXT,
      error TEXT,
      result TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      completedAt TEXT,
      UNIQUE(routineId, dedupeKey)
    );
    CREATE INDEX IF NOT EXISTS idx_routine_invocations_due
      ON routine_invocations(status, availableAt, createdAt);
    CREATE INDEX IF NOT EXISTS idx_routine_invocations_routine
      ON routine_invocations(routineId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_routine_invocations_concurrency
      ON routine_invocations(concurrencyKey, status, leaseExpiresAt);

    CREATE TABLE IF NOT EXISTS routine_step_runs (
      invocationId TEXT NOT NULL REFERENCES routine_invocations(id),
      stepId TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      taskId TEXT,
      output TEXT,
      error TEXT,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY(invocationId, stepId)
    );

    CREATE TABLE IF NOT EXISTS routine_trigger_state (
      routineId TEXT NOT NULL REFERENCES routines(id),
      triggerId TEXT NOT NULL,
      nextDueAt TEXT NOT NULL,
      lastCheckedAt TEXT,
      state TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(routineId, triggerId)
    );
  `);
  const invocationColumns = new Set(
    (db.prepare('PRAGMA table_info(routine_invocations)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!invocationColumns.has('definitionSnapshot')) {
    try {
      db.exec("ALTER TABLE routine_invocations ADD COLUMN definitionSnapshot TEXT NOT NULL DEFAULT '{}'");
    } catch (error) {
      // A second server process can observe the old schema before the first
      // process commits the ALTER. Only that exact race is safe to ignore.
      if (!/duplicate column name:\s*definitionSnapshot/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  // Pin active rows created by older builds before the app can edit their
  // definitions. Terminal legacy rows do not execute again and need no guess
  // at historical inputs.
  const legacyActive = db.prepare(`
    SELECT id, routineId FROM routine_invocations
    WHERE status IN ('pending', 'processing')
      AND (definitionSnapshot IS NULL OR trim(definitionSnapshot) IN ('', '{}'))
  `).all() as Array<{ id: string; routineId: string }>;
  for (const invocation of legacyActive) {
    const routineRow = db.prepare('SELECT * FROM routines WHERE id = ? AND deletedAt IS NULL')
      .get(invocation.routineId) as unknown as RoutineRow | undefined;
    if (!routineRow) continue;
    const snapshot = JSON.stringify(executionSnapshotForRoutine(rowToRoutine(routineRow)));
    db.prepare(`
      UPDATE routine_invocations SET definitionSnapshot = ?
      WHERE id = ? AND (definitionSnapshot IS NULL OR trim(definitionSnapshot) IN ('', '{}'))
    `).run(snapshot, invocation.id);
  }
  initializedHandles.add(db as object);
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const value = JSON.parse(raw) as T;
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function cleanText(value: unknown, max: number, required = false): string {
  const text = String(value ?? '').trim().slice(0, max);
  if (required && !text) throw new Error('Required routine field is empty');
  return text;
}

function assertId(value: unknown, label = 'routine id'): string {
  const id = cleanText(value, 160, true);
  if (!ROUTINE_ID_RE.test(id)) throw new Error(`Invalid ${label}`);
  return id;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function normalizeConditions(input: unknown): RoutineCondition[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 50).map((raw) => {
    const value = raw as Partial<RoutineCondition>;
    const operator = value.operator || 'exists';
    if (!['exists', 'equals', 'not_equals', 'contains', 'matches'].includes(operator)) {
      throw new Error('Invalid routine condition operator');
    }
    return { path: cleanText(value.path, 300, true), operator, ...(value.value === undefined ? {} : { value: value.value }) };
  });
}

function topologicalSteps(input: unknown): RoutineStep[] {
  if (!Array.isArray(input)) return [];
  const steps = input.slice(0, 50).map((raw, index) => {
    const value = raw as Partial<RoutineStep>;
    const id = assertId(value.id || `step-${index + 1}`, 'routine step id');
    return {
      id,
      name: cleanText(value.name || id, 300, true),
      prompt: cleanText(value.prompt, 20_000, true),
      kind: value.kind === 'code' ? 'code' as const : 'work' as const,
      dependsOn: Array.isArray(value.dependsOn)
        ? [...new Set(value.dependsOn.map((dependency) => assertId(dependency, 'step dependency')))]
        : [],
    };
  });
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length) throw new Error('Routine step ids must be unique');
  for (const step of steps) {
    for (const dependency of step.dependsOn || []) {
      if (!byId.has(dependency)) throw new Error(`Unknown routine step dependency: ${dependency}`);
      if (dependency === step.id) throw new Error('A routine step cannot depend on itself');
    }
  }
  const sorted: RoutineStep[] = [];
  const remaining = new Set(byId.keys());
  while (remaining.size) {
    const ready = steps.filter((step) => remaining.has(step.id) && (step.dependsOn || []).every((dependency) => !remaining.has(dependency)));
    if (!ready.length) throw new Error('Routine step dependencies contain a cycle');
    for (const step of ready) {
      sorted.push(step);
      remaining.delete(step.id);
    }
  }
  return sorted;
}

function normalizeTrigger(raw: RoutineTrigger, existing?: RoutineTrigger): RoutineTrigger {
  const id = assertId(raw.id, 'routine trigger id');
  const enabled = raw.enabled !== false;
  switch (raw.type) {
    case 'manual':
      return { id, type: 'manual', enabled };
    case 'schedule': {
      const expression = cleanText(raw.cron, 200, true);
      if (!isSupportedAutomationCron(expression)) {
        throw new Error(`Invalid cron expression for trigger ${id}; automations require exactly five fields (minute hour day month weekday)`);
      }
      const timezone = raw.timezone ? cleanText(raw.timezone, 100) : undefined;
      if (timezone) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); }
        catch { throw new Error(`Invalid timezone for trigger ${id}`); }
      }
      return { id, type: 'schedule', enabled, cron: expression, ...(timezone ? { timezone } : {}) };
    }
    case 'one_time': {
      const at = new Date(raw.at);
      if (Number.isNaN(at.getTime())) throw new Error(`Invalid one-time date for trigger ${id}`);
      return { id, type: 'one_time', enabled, at: at.toISOString() };
    }
    case 'webhook': {
      const oldSecret = existing?.type === 'webhook' ? existing.secret : undefined;
      const submitted = raw.secret && raw.secret !== REDACTED_SECRET ? raw.secret : oldSecret;
      if (!submitted || submitted.length < 16) throw new Error(`Webhook trigger ${id} requires a secret of at least 16 characters`);
      const secret = isEncryptedSecret(submitted) ? submitted : encryptSecret(submitted);
      return { id, type: 'webhook', enabled, secret };
    }
    case 'health': {
      const url = raw.url ? cleanText(raw.url, 2_000) : undefined;
      if (url && !/^https?:\/\//i.test(url)) throw new Error('Health URL must use http or https');
      const processPid = raw.processPid ? clampInt(raw.processPid, 0, 1, 2_147_483_647) : undefined;
      if (!url && !processPid) throw new Error(`Health trigger ${id} requires a URL or processPid`);
      return {
        id,
        type: 'health',
        enabled,
        intervalSeconds: clampInt(raw.intervalSeconds, 60, 5, 86_400),
        timeoutMs: clampInt(raw.timeoutMs, 10_000, 250, 120_000),
        ...(url ? { url } : {}),
        ...(processPid ? { processPid } : {}),
        ...(raw.expectedStatus ? { expectedStatus: clampInt(raw.expectedStatus, 200, 100, 599) } : {}),
      };
    }
    case 'filesystem':
      return {
        id,
        type: 'filesystem',
        enabled,
        path: cleanText(raw.path, 2_000, true),
        intervalSeconds: clampInt(raw.intervalSeconds, 30, 2, 86_400),
      };
    case 'integration_event':
      return {
        id,
        type: 'integration_event',
        enabled,
        integration: cleanText(raw.integration, 200, true),
        event: cleanText(raw.event, 300, true),
      };
    default:
      throw new Error('Invalid routine trigger type');
  }
}

function normalizeTriggers(input: unknown, existing: RoutineTrigger[] = []): RoutineTrigger[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('A routine needs at least one trigger');
  const existingById = new Map(existing.map((trigger) => [trigger.id, trigger]));
  const triggers = input.slice(0, 50).map((raw) => normalizeTrigger(raw as RoutineTrigger, existingById.get((raw as RoutineTrigger).id)));
  if (new Set(triggers.map((trigger) => trigger.id)).size !== triggers.length) throw new Error('Routine trigger ids must be unique');
  return triggers;
}

function storedTriggers(row: RoutineRow): RoutineTrigger[] {
  return parseJson<RoutineTrigger[]>(row.triggers, []);
}

function rowToRoutine(row: RoutineRow, includeSecrets = false): RoutineDefinition {
  const triggers = storedTriggers(row).map((trigger) => {
    if (trigger.type !== 'webhook') return trigger;
    return {
      ...trigger,
      secret: includeSecrets && trigger.secret ? decryptSecret(trigger.secret) : REDACTED_SECRET,
    };
  });
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    agentId: row.agentId,
    prompt: row.prompt,
    triggers,
    conditions: parseJson(row.conditions, []),
    parameters: parseJson(row.parameters, {}),
    retryPolicy: parseJson(row.retryPolicy, { maxAttempts: 3, baseDelayMs: 1_000, multiplier: 2, maxDelayMs: 60_000 }),
    timeoutMs: row.timeoutMs,
    concurrencyKey: row.concurrencyKey,
    catchUpPolicy: row.catchUpPolicy === 'skip' ? 'skip' : 'run_once',
    circuitBreaker: parseJson(row.circuitBreaker, { failureThreshold: 3, cooldownSeconds: 900 }),
    steps: parseJson(row.steps, []),
    failureStreak: row.failureStreak,
    circuitState: row.circuitState === 'open' ? 'open' : 'closed',
    ...(row.circuitOpenedAt ? { circuitOpenedAt: row.circuitOpenedAt } : {}),
    ...(row.circuitOpenUntil ? { circuitOpenUntil: row.circuitOpenUntil } : {}),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function executionSnapshotForRoutine(routine: RoutineDefinition): RoutineExecutionSnapshot {
  // Agent credentials and mutable provider settings stay in the agent store;
  // pinning the assignment is enough to prevent a definition edit from
  // switching workers without copying secrets into every invocation.
  return {
    schema: 1,
    definitionVersion: routine.version,
    name: routine.name,
    agentId: routine.agentId,
    prompt: routine.prompt,
    parameters: JSON.parse(JSON.stringify(routine.parameters)) as Record<string, unknown>,
    retryPolicy: { ...routine.retryPolicy },
    timeoutMs: routine.timeoutMs,
    concurrencyKey: routine.concurrencyKey,
    steps: topologicalSteps(routine.steps),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseExecutionSnapshot(raw: string): RoutineExecutionSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Routine invocation execution snapshot is corrupt; refusing to use a mutable definition');
  }
  if (!isRecord(value) || value.schema !== 1
    || !Number.isInteger(value.definitionVersion) || Number(value.definitionVersion) < 1
    || typeof value.name !== 'string' || !value.name
    || typeof value.agentId !== 'string' || !ROUTINE_ID_RE.test(value.agentId)
    || typeof value.prompt !== 'string' || !value.prompt
    || !isRecord(value.parameters)
    || !isRecord(value.retryPolicy)
    || !Number.isFinite(value.timeoutMs) || Number(value.timeoutMs) < 1
    || typeof value.concurrencyKey !== 'string' || !value.concurrencyKey
    || !Array.isArray(value.steps)) {
    throw new Error('Routine invocation execution snapshot is invalid; refusing to use a mutable definition');
  }
  const retry = value.retryPolicy;
  if (!Number.isInteger(retry.maxAttempts) || Number(retry.maxAttempts) < 1
    || !Number.isFinite(retry.baseDelayMs) || Number(retry.baseDelayMs) < 0
    || !Number.isFinite(retry.multiplier) || Number(retry.multiplier) < 1
    || !Number.isFinite(retry.maxDelayMs) || Number(retry.maxDelayMs) < 0) {
    throw new Error('Routine invocation execution snapshot has an invalid retry policy');
  }
  let steps: RoutineStep[];
  try {
    steps = topologicalSteps(value.steps);
  } catch (error) {
    throw new Error(`Routine invocation execution snapshot has invalid steps: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    schema: 1,
    definitionVersion: Number(value.definitionVersion),
    name: value.name,
    agentId: value.agentId,
    prompt: value.prompt,
    parameters: JSON.parse(JSON.stringify(value.parameters)) as Record<string, unknown>,
    retryPolicy: {
      maxAttempts: Number(retry.maxAttempts),
      baseDelayMs: Number(retry.baseDelayMs),
      multiplier: Number(retry.multiplier),
      maxDelayMs: Number(retry.maxDelayMs),
    },
    timeoutMs: Number(value.timeoutMs),
    concurrencyKey: value.concurrencyKey,
    steps,
  };
}

function missingExecutionSnapshot(raw: string | null | undefined): boolean {
  return !raw || raw.trim() === '' || raw.trim() === '{}';
}

function executionSnapshotForInvocationRow(
  row: InvocationRow,
  currentRoutine?: RoutineDefinition | null,
): RoutineExecutionSnapshot {
  if (!missingExecutionSnapshot(row.definitionSnapshot)) return parseExecutionSnapshot(row.definitionSnapshot);
  const routine = currentRoutine === undefined ? getRoutineInternal(row.routineId) : currentRoutine;
  if (!routine) throw new Error('Routine invocation has no execution snapshot and its definition no longer exists');
  const snapshotJson = JSON.stringify(executionSnapshotForRoutine(routine));
  getDb().prepare(`
    UPDATE routine_invocations SET definitionSnapshot = ?
    WHERE id = ? AND (definitionSnapshot IS NULL OR trim(definitionSnapshot) IN ('', '{}'))
  `).run(snapshotJson, row.id);
  const stored = getDb().prepare('SELECT definitionSnapshot FROM routine_invocations WHERE id = ?')
    .get(row.id) as { definitionSnapshot: string } | undefined;
  if (!stored) throw new Error('Routine invocation not found');
  return parseExecutionSnapshot(stored.definitionSnapshot);
}

export function getRoutineInvocationExecutionSnapshot(id: string): RoutineExecutionSnapshot {
  ensureRoutineSchema();
  const row = getDb().prepare('SELECT * FROM routine_invocations WHERE id = ?')
    .get(assertId(id, 'routine invocation id')) as unknown as InvocationRow | undefined;
  if (!row) throw new Error('Routine invocation not found');
  return executionSnapshotForInvocationRow(row);
}

function rowToInvocation(row: InvocationRow): RoutineInvocation {
  return {
    id: row.id,
    routineId: row.routineId,
    triggerId: row.triggerId,
    triggerType: row.triggerType as RoutineTriggerType,
    dedupeKey: row.dedupeKey,
    concurrencyKey: row.concurrencyKey,
    status: row.status as RoutineInvocation['status'],
    payload: parseJson(row.payload, {}),
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.taskId ? { taskId: row.taskId } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.result ? { result: row.result } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  };
}

function selectRoutineRow(id: string): RoutineRow | undefined {
  ensureRoutineSchema();
  return getDb().prepare('SELECT * FROM routines WHERE id = ? AND deletedAt IS NULL').get(assertId(id)) as unknown as RoutineRow | undefined;
}

function selectRoutineRowIncludingDeleted(id: string): RoutineRow | undefined {
  ensureRoutineSchema();
  return getDb().prepare('SELECT * FROM routines WHERE id = ?').get(assertId(id)) as unknown as RoutineRow | undefined;
}

function getRoutineInternal(id: string): RoutineDefinition | null {
  const row = selectRoutineRow(id);
  return row ? rowToRoutine(row, true) : null;
}

export function getRoutine(id: string): RoutineDefinition | null {
  const row = selectRoutineRow(id);
  return row ? rowToRoutine(row) : null;
}

export function listRoutines(opts: { enabled?: boolean; limit?: number; offset?: number } = {}): { routines: RoutineDefinition[]; total: number } {
  ensureRoutineSchema();
  const clauses = ['deletedAt IS NULL'];
  const params: Array<string | number> = [];
  if (opts.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(opts.enabled ? 1 : 0);
  }
  const where = clauses.join(' AND ');
  const limit = clampInt(opts.limit, 100, 1, 500);
  const offset = clampInt(opts.offset, 0, 0, 1_000_000);
  const db = getDb();
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM routines WHERE ${where}`).get(...params) as { n: number }).n);
  const rows = db.prepare(`SELECT * FROM routines WHERE ${where} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as RoutineRow[];
  return { routines: rows.map((row) => rowToRoutine(row)), total };
}

function activeRoutines(): RoutineDefinition[] {
  ensureRoutineSchema();
  return (getDb().prepare('SELECT * FROM routines WHERE enabled = 1 AND deletedAt IS NULL ORDER BY updatedAt DESC')
    .all() as unknown as RoutineRow[]).map((row) => rowToRoutine(row));
}

function normalizedDefinition(input: CreateRoutineInput, existing?: RoutineDefinition): Omit<RoutineDefinition, 'failureStreak' | 'circuitState' | 'circuitOpenedAt' | 'circuitOpenUntil' | 'version' | 'createdAt' | 'updatedAt'> {
  const id = assertId(input.id || existing?.id || randomUUID());
  const retry = input.retryPolicy || existing?.retryPolicy || {};
  const breaker = input.circuitBreaker || existing?.circuitBreaker || {};
  return {
    id,
    name: cleanText(input.name, 300, true),
    description: cleanText(input.description, 5_000),
    enabled: input.enabled !== false,
    agentId: assertId(input.agentId, 'agent id'),
    prompt: cleanText(input.prompt, 20_000, true),
    triggers: normalizeTriggers(input.triggers, existing?.triggers || []),
    conditions: normalizeConditions(input.conditions),
    parameters: input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters) ? input.parameters : {},
    retryPolicy: {
      maxAttempts: clampInt(retry.maxAttempts, 3, 1, 20),
      baseDelayMs: clampInt(retry.baseDelayMs, 1_000, 100, 86_400_000),
      multiplier: Math.max(1, Math.min(10, Number(retry.multiplier) || 2)),
      maxDelayMs: clampInt(retry.maxDelayMs, 60_000, 100, 604_800_000),
    },
    timeoutMs: clampInt(input.timeoutMs ?? existing?.timeoutMs, 15 * 60_000, 1_000, 24 * 60 * 60_000),
    concurrencyKey: cleanText(input.concurrencyKey || existing?.concurrencyKey || `routine:${id}`, 300, true),
    catchUpPolicy: input.catchUpPolicy === 'skip' ? 'skip' : 'run_once',
    circuitBreaker: {
      failureThreshold: clampInt(breaker.failureThreshold, 3, 1, 100),
      cooldownSeconds: clampInt(breaker.cooldownSeconds, 900, 5, 604_800),
    },
    steps: topologicalSteps(input.steps),
  };
}

function initializeScheduleState(routine: Pick<RoutineDefinition, 'id' | 'triggers'>, resetIds: Set<string> = new Set()): void {
  const db = getDb();
  const now = nowIso();
  const next = new Date(Date.now() + 60_000).toISOString();
  for (const trigger of routine.triggers) {
    if (trigger.type !== 'schedule') continue;
    if (resetIds.has(trigger.id)) {
      db.prepare('DELETE FROM routine_trigger_state WHERE routineId = ? AND triggerId = ?').run(routine.id, trigger.id);
    }
    db.prepare(`
      INSERT OR IGNORE INTO routine_trigger_state (routineId, triggerId, nextDueAt, lastCheckedAt, state)
      VALUES (?, ?, ?, ?, ?)
    `).run(routine.id, trigger.id, next, now, JSON.stringify({ lastObservedAt: now }));
  }
}

export function createRoutine(input: CreateRoutineInput): RoutineDefinition {
  ensureRoutineSchema();
  const routine = normalizedDefinition(input);
  const now = nowIso();
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO routines (
        id, name, description, enabled, agentId, prompt, triggers, conditions,
        parameters, retryPolicy, timeoutMs, concurrencyKey, catchUpPolicy,
        circuitBreaker, steps, failureStreak, circuitState, circuitOpenedAt,
        circuitOpenUntil, version, createdAt, updatedAt, deletedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'closed', NULL, NULL, 1, ?, ?, NULL)
    `).run(
      routine.id, routine.name, routine.description, routine.enabled ? 1 : 0,
      routine.agentId, routine.prompt, JSON.stringify(routine.triggers),
      JSON.stringify(routine.conditions), JSON.stringify(routine.parameters),
      JSON.stringify(routine.retryPolicy), routine.timeoutMs, routine.concurrencyKey,
      routine.catchUpPolicy, JSON.stringify(routine.circuitBreaker), JSON.stringify(routine.steps), now, now,
    );
    initializeScheduleState(routine);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    if (/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw new Error('Routine id already exists');
    throw error;
  }
  audit('run', 'routine created', routine.name, { routineId: routine.id, triggers: routine.triggers.map((trigger) => trigger.type) });
  emitAppEvent('routines');
  requestRoutineScheduleSync();
  return getRoutine(routine.id)!;
}

export function updateRoutine(id: string, patch: Partial<CreateRoutineInput>, expectedVersion: number): RoutineDefinition {
  const current = getRoutineInternal(id);
  if (!current) throw new Error('Routine not found');
  if (expectedVersion !== current.version) throw new Error('Routine changed concurrently; reload and retry');
  const merged = normalizedDefinition({
    id: current.id,
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    enabled: patch.enabled ?? current.enabled,
    agentId: patch.agentId ?? current.agentId,
    prompt: patch.prompt ?? current.prompt,
    triggers: patch.triggers ?? current.triggers,
    conditions: patch.conditions ?? current.conditions,
    parameters: patch.parameters ?? current.parameters,
    retryPolicy: patch.retryPolicy ? { ...current.retryPolicy, ...patch.retryPolicy } : current.retryPolicy,
    timeoutMs: patch.timeoutMs ?? current.timeoutMs,
    concurrencyKey: patch.concurrencyKey ?? current.concurrencyKey,
    catchUpPolicy: patch.catchUpPolicy ?? current.catchUpPolicy,
    circuitBreaker: patch.circuitBreaker ? { ...current.circuitBreaker, ...patch.circuitBreaker } : current.circuitBreaker,
    steps: patch.steps ?? current.steps,
  }, current);
  const now = nowIso();
  const nextById = new Map(merged.triggers.map((trigger) => [trigger.id, trigger]));
  const resetTriggerIds = new Set<string>();
  for (const trigger of current.triggers) {
    const next = nextById.get(trigger.id);
    if (!next || JSON.stringify(trigger) !== JSON.stringify(next)) resetTriggerIds.add(trigger.id);
  }
  for (const trigger of merged.triggers) {
    if (!current.triggers.some((candidate) => candidate.id === trigger.id)) resetTriggerIds.add(trigger.id);
  }
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`
      UPDATE routines SET name = ?, description = ?, enabled = ?, agentId = ?, prompt = ?,
        triggers = ?, conditions = ?, parameters = ?, retryPolicy = ?, timeoutMs = ?,
        concurrencyKey = ?, catchUpPolicy = ?, circuitBreaker = ?, steps = ?,
        version = version + 1, updatedAt = ?
      WHERE id = ? AND version = ? AND deletedAt IS NULL
    `).run(
      merged.name, merged.description, merged.enabled ? 1 : 0, merged.agentId, merged.prompt,
      JSON.stringify(merged.triggers), JSON.stringify(merged.conditions), JSON.stringify(merged.parameters),
      JSON.stringify(merged.retryPolicy), merged.timeoutMs, merged.concurrencyKey, merged.catchUpPolicy,
      JSON.stringify(merged.circuitBreaker), JSON.stringify(merged.steps), now, current.id, expectedVersion,
    );
    if (Number(result.changes) !== 1) throw new Error('Routine changed concurrently; reload and retry');
    for (const triggerId of resetTriggerIds) {
      db.prepare('DELETE FROM routine_trigger_state WHERE routineId = ? AND triggerId = ?').run(current.id, triggerId);
    }
    initializeScheduleState(merged, resetTriggerIds);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  emitAppEvent('routines');
  requestRoutineScheduleSync();
  return getRoutine(current.id)!;
}

/**
 * Public/API writes hold the Agent store stable until the Automation row is
 * committed. Agent deletion uses the same ownership fence, so a create or
 * reassignment cannot race it and leave an armed Automation without an owner.
 */
export async function createOwnedRoutine(input: CreateRoutineInput): Promise<RoutineDefinition> {
  const agentId = assertId(input.agentId, 'agent id');
  return withAgentOwnershipSnapshot(async (agentIds) => {
    if (!agentIds.has(agentId)) throw new Error('Automation agent not found');
    return createRoutine(input);
  });
}

export async function updateOwnedRoutine(
  id: string,
  patch: Partial<CreateRoutineInput>,
  expectedVersion: number,
): Promise<RoutineDefinition> {
  return withAgentOwnershipSnapshot(async (agentIds) => {
    const current = getRoutineInternal(id);
    if (!current) throw new Error('Routine not found');
    const agentId = patch.agentId === undefined
      ? current.agentId
      : assertId(patch.agentId, 'agent id');
    if (!agentIds.has(agentId)) throw new Error('Automation agent not found');
    return updateRoutine(id, patch, expectedVersion);
  });
}

const ACTIVE_ROUTINE_TASK_STATUSES = new Set([
  'queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked',
]);

interface RoutineTaskTreeSettlement {
  tasksSettled: number;
  runIds: string[];
}

export interface DeletedRoutineLifecycleRepairReport {
  invocationsSkipped: number;
  tasksSettled: number;
}

function settleRoutineTaskTreeInOpenTransaction(
  taskId: string,
  parentStatus: 'failed' | 'cancelled' | 'lost',
  error: string,
  parentMetadata?: Record<string, unknown>,
): RoutineTaskTreeSettlement {
  const db = getDb();
  const rows = db.prepare(`
    WITH RECURSIVE task_tree(id, depth, path) AS (
      SELECT ?, 0, ',' || ? || ','
      UNION ALL
      SELECT child.id, task_tree.depth + 1, task_tree.path || child.id || ','
      FROM tasks child JOIN task_tree ON child.parentId = task_tree.id
      WHERE instr(task_tree.path, ',' || child.id || ',') = 0
    )
    SELECT task.id, task_tree.depth
    FROM task_tree JOIN tasks task ON task.id = task_tree.id
    ORDER BY task_tree.depth DESC, task.id ASC
  `).all(taskId, taskId) as Array<{ id: string; depth: number }>;
  const childStatus = parentStatus === 'cancelled' ? 'cancelled' : 'lost';
  const runIds = new Set<string>();
  let tasksSettled = 0;
  for (const row of rows) {
    const task = getTask(row.id);
    if (!task || !ACTIVE_ROUTINE_TASK_STATUSES.has(task.status)) continue;
    if (task.runId) runIds.add(task.runId);
    const isParent = row.id === taskId;
    transitionTaskInOpenTransaction({
      taskId: task.id,
      status: isParent ? parentStatus : childStatus,
      expectedVersion: task.version,
      error,
      metadata: isParent
        ? parentMetadata
        : { suppressTerminalSignals: true },
    });
    tasksSettled += 1;
  }
  return { tasksSettled, runIds: [...runIds] };
}

function requestRoutineRunCancellation(runIds: Iterable<string>): void {
  const unique = [...new Set(runIds)];
  if (!unique.length) return;
  void import('./agent-runtime').then(({ requestRunCancel }) => {
    for (const runId of unique) requestRunCancel(runId);
  }).catch((error) => {
    console.error('[routines] could not signal settled runs for cancellation', error);
  });
}

function publishRoutineTaskSettlement(tasksSettled: number): void {
  if (!tasksSettled) return;
  try { publishTaskChanges(true); } catch (error) {
    // Task rows/events are already committed. App-event publication is a
    // cache hint and must never turn a successful lifecycle transition into a
    // retryable API error.
    console.error('[routines] could not publish task settlement', error);
  }
}

function settleRoutineTaskTree(
  taskId: string,
  parentStatus: 'failed' | 'cancelled' | 'lost',
  error: string,
  parentMetadata?: Record<string, unknown>,
): void {
  const db = getDb();
  let settlement: RoutineTaskTreeSettlement;
  try {
    db.exec('BEGIN IMMEDIATE');
    settlement = settleRoutineTaskTreeInOpenTransaction(taskId, parentStatus, error, parentMetadata);
    db.exec('COMMIT');
  } catch (caught) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    // This helper is derived lifecycle cleanup invoked after an invocation has
    // already committed. Periodic reconciliation retries it; callers must not
    // report the earlier authoritative mutation as failed.
    console.error(`[routines] task-tree settlement deferred for ${taskId}`, caught);
    return;
  }
  publishRoutineTaskSettlement(settlement.tasksSettled);
  requestRoutineRunCancellation(settlement.runIds);
}

export function deleteRoutine(id: string, expectedVersion: number): void {
  const current = getRoutine(id);
  if (!current) throw new Error('Routine not found');
  const now = nowIso();
  const db = getDb();
  let taskRows: Array<{ taskId: string }> = [];
  let tasksSettled = 0;
  const runIds = new Set<string>();
  db.exec('BEGIN IMMEDIATE');
  try {
    taskRows = db.prepare(`
      SELECT DISTINCT taskId FROM routine_invocations
      WHERE routineId = ? AND taskId IS NOT NULL
    `).all(current.id) as Array<{ taskId: string }>;
    const result = db.prepare(`
      UPDATE routines SET enabled = 0, deletedAt = ?, updatedAt = ?, version = version + 1
      WHERE id = ? AND version = ? AND deletedAt IS NULL
    `).run(now, now, current.id, expectedVersion);
    if (Number(result.changes) !== 1) throw new Error('Routine changed concurrently; reload and retry');
    db.prepare(`
      UPDATE routine_invocations SET status = 'skipped', error = ?, result = NULL,
        leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
      WHERE routineId = ? AND status IN ('pending', 'processing')
    `).run('Routine was deleted before this invocation completed', now, now, current.id);
    for (const { taskId } of taskRows) {
      const settlement = settleRoutineTaskTreeInOpenTransaction(
        taskId,
        'cancelled',
        'Cancelled because the automation was deleted.',
        { suppressTerminalSignals: true, routineLifecycleReconciled: true },
      );
      tasksSettled += settlement.tasksSettled;
      for (const runId of settlement.runIds) runIds.add(runId);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  publishRoutineTaskSettlement(tasksSettled);
  requestRoutineRunCancellation(runIds);
  try {
    audit('run', 'routine deleted', current.name, { routineId: current.id });
  } catch (error) {
    console.error('[routines] could not audit routine deletion', error);
  }
  try { emitAppEvent('routines'); } catch (error) {
    console.error('[routines] could not publish routine deletion', error);
  }
  try { requestRoutineScheduleSync(); } catch (error) {
    console.error('[routines] could not schedule post-delete sync', error);
  }
  // Cross-store consumers (for example a confirmed meeting output) are
  // detached promptly. The routine row is soft-deleted, so the hourly sweep
  // can always retry this idempotently if the immediate pass is interrupted.
  void import('./data-integrity')
    .then(({ reconcileDataIntegrity }) =>
      reconcileDataIntegrity({ reason: `routine deletion:${current.id}` }))
    .catch((error) => {
      console.error('[routines] post-delete integrity reconciliation failed', error);
    });
}

/**
 * Recover a process crash from older builds that committed a routine tombstone
 * before settling its invocation task trees. This is idempotent and keeps the
 * invocation fence and every task transition in one SQLite transaction.
 */
export function repairDeletedRoutineTaskProjections(): DeletedRoutineLifecycleRepairReport {
  ensureRoutineSchema();
  const db = getDb();
  const now = nowIso();
  const report: DeletedRoutineLifecycleRepairReport = { invocationsSkipped: 0, tasksSettled: 0 };
  const runIds = new Set<string>();
  db.exec('BEGIN IMMEDIATE');
  try {
    const taskRows = db.prepare(`
      WITH RECURSIVE task_tree(rootTaskId, taskId, depth, path) AS (
        SELECT DISTINCT invocation.taskId, invocation.taskId, 0, ',' || invocation.taskId || ','
        FROM routine_invocations invocation
        JOIN routines routine ON routine.id = invocation.routineId
        WHERE routine.deletedAt IS NOT NULL AND invocation.taskId IS NOT NULL
        UNION ALL
        SELECT task_tree.rootTaskId, child.id, task_tree.depth + 1, task_tree.path || child.id || ','
        FROM tasks child JOIN task_tree ON child.parentId = task_tree.taskId
        WHERE instr(task_tree.path, ',' || child.id || ',') = 0
      )
      SELECT DISTINCT task_tree.rootTaskId AS taskId
      FROM task_tree JOIN tasks task ON task.id = task_tree.taskId
      WHERE task.status IN ('queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked')
      ORDER BY task_tree.rootTaskId
    `).all() as Array<{ taskId: string }>;
    report.invocationsSkipped = Number(db.prepare(`
      UPDATE routine_invocations SET status = 'skipped',
        error = 'Routine was deleted before this invocation completed', result = NULL,
        leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
      WHERE status IN ('pending', 'processing') AND EXISTS (
        SELECT 1 FROM routines routine
        WHERE routine.id = routine_invocations.routineId AND routine.deletedAt IS NOT NULL
      )
    `).run(now, now).changes) || 0;
    for (const { taskId } of taskRows) {
      const settlement = settleRoutineTaskTreeInOpenTransaction(
        taskId,
        'cancelled',
        'Cancelled because the automation was deleted.',
        { suppressTerminalSignals: true, routineLifecycleReconciled: true },
      );
      report.tasksSettled += settlement.tasksSettled;
      for (const runId of settlement.runIds) runIds.add(runId);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
  publishRoutineTaskSettlement(report.tasksSettled);
  requestRoutineRunCancellation(runIds);
  if (report.invocationsSkipped) {
    try { emitAppEvent('routines'); } catch (error) {
      console.error('[routines] could not publish repaired routine lifecycle', error);
    }
  }
  return report;
}

export function resetRoutineCircuit(id: string, expectedVersion: number): RoutineDefinition {
  const current = getRoutine(id);
  if (!current) throw new Error('Routine not found');
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE routines SET failureStreak = 0, circuitState = 'closed', circuitOpenedAt = NULL,
      circuitOpenUntil = NULL, updatedAt = ?
    WHERE id = ? AND version = ? AND deletedAt IS NULL
  `).run(now, current.id, expectedVersion);
  if (Number(result.changes) !== 1) throw new Error('Routine changed concurrently; reload and retry');
  emitAppEvent('routines');
  return getRoutine(current.id)!;
}

export function listRoutineInvocations(routineId: string, limit = 100): RoutineInvocation[] {
  ensureRoutineSchema();
  return (getDb().prepare('SELECT * FROM routine_invocations WHERE routineId = ? ORDER BY createdAt DESC LIMIT ?')
    .all(assertId(routineId), clampInt(limit, 100, 1, 500)) as unknown as InvocationRow[]).map(rowToInvocation);
}

function getPath(input: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, input);
}

function conditionsMatch(conditions: RoutineCondition[], payload: Record<string, unknown>): boolean {
  return conditions.every((condition) => {
    const actual = getPath(payload, condition.path);
    if (condition.operator === 'exists') return actual !== undefined && actual !== null;
    if (condition.operator === 'equals') return JSON.stringify(actual) === JSON.stringify(condition.value);
    if (condition.operator === 'not_equals') return JSON.stringify(actual) !== JSON.stringify(condition.value);
    if (condition.operator === 'contains') {
      return Array.isArray(actual)
        ? actual.some((item) => JSON.stringify(item) === JSON.stringify(condition.value))
        : String(actual ?? '').includes(String(condition.value ?? ''));
    }
    try {
      const pattern = String(condition.value ?? '').slice(0, 300);
      // Reject common nested-quantifier forms that can cause catastrophic backtracking.
      if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return false;
      return new RegExp(pattern, 'i').test(String(actual ?? '').slice(0, 20_000));
    } catch {
      return false;
    }
  });
}

function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g, (_match, path: string) => {
    const value = getPath(values, path);
    return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  });
}

export function enqueueRoutineInvocation(input: {
  routineId: string;
  triggerId: string;
  triggerType: RoutineTriggerType;
  dedupeKey: string;
  payload?: Record<string, unknown>;
  forceStatus?: 'pending' | 'skipped';
  skipReason?: string;
  availableAt?: string;
}): { invocation: RoutineInvocation; inserted: boolean } {
  assertRoutineDispatchAvailable();
  const routine = getRoutineInternal(input.routineId);
  if (!routine) throw new Error('Routine not found');
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
  const now = nowIso();
  const circuitOpen = routine.circuitState === 'open' && (!routine.circuitOpenUntil || routine.circuitOpenUntil > now);
  const conditionsPass = conditionsMatch(routine.conditions, payload);
  const status = input.forceStatus || (!routine.enabled || circuitOpen || !conditionsPass ? 'skipped' : 'pending');
  const reason = input.skipReason
    || (!routine.enabled ? 'Routine is disabled' : circuitOpen ? 'Routine circuit breaker is open' : !conditionsPass ? 'Routine conditions did not match' : undefined);
  const id = randomUUID();
  const dedupeKey = cleanText(input.dedupeKey, 500, true);
  const triggerId = assertId(input.triggerId, 'routine trigger id');
  const concurrencyKey = renderTemplate(routine.concurrencyKey, { ...routine.parameters, ...payload }) || `routine:${routine.id}`;
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 1_000_000) throw new Error('Routine payload exceeds the 1 MB limit');
  const definitionSnapshot = JSON.stringify(executionSnapshotForRoutine(routine));
  const requestedAt = input.availableAt ? new Date(input.availableAt) : null;
  const availableAt = requestedAt && !Number.isNaN(requestedAt.getTime()) && requestedAt.getTime() > Date.now()
    ? requestedAt.toISOString()
    : now;
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO routine_invocations (
      id, routineId, triggerId, triggerType, dedupeKey, concurrencyKey, status,
      payload, definitionSnapshot, attempt, maxAttempts, availableAt, leaseOwner, leaseExpiresAt,
      taskId, error, result, createdAt, updatedAt, completedAt
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM routines WHERE id = ? AND deletedAt IS NULL)
  `).run(
    id, routine.id, triggerId, input.triggerType, dedupeKey, cleanText(concurrencyKey, 300, true), status,
    payloadJson, definitionSnapshot, routine.retryPolicy.maxAttempts, availableAt, reason || null, now, now, status === 'skipped' ? now : null,
    routine.id,
  );
  const row = db.prepare('SELECT * FROM routine_invocations WHERE routineId = ? AND dedupeKey = ?')
    .get(routine.id, dedupeKey) as unknown as InvocationRow | undefined;
  if (!row) throw new Error('Routine no longer exists');
  if (Number(result.changes) === 1) {
    audit('run', status === 'pending' ? 'routine invocation queued' : 'routine invocation skipped', routine.name, {
      routineId: routine.id, invocationId: id, triggerType: input.triggerType, triggerId,
    });
    emitAppEvent('routines');
  }
  return { invocation: rowToInvocation(row), inserted: Number(result.changes) === 1 };
}

export function triggerRoutineManually(routineId: string, payload: Record<string, unknown> = {}, dedupeKey = `manual:${randomUUID()}`) {
  return enqueueRoutineInvocation({ routineId, triggerId: 'manual', triggerType: 'manual', dedupeKey, payload });
}

export function claimRoutineInvocations(limit = 10, leaseMs = 60_000): RoutineInvocation[] {
  if (isAutomationMaintenanceActive()) return [];
  ensureRoutineSchema();
  const db = getDb();
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + Math.max(10_000, leaseMs)).toISOString();
  const claimLimit = clampInt(limit, 10, 1, 100);
  const claimed: RoutineInvocation[] = [];
  const exhausted: InvocationRow[] = [];
  const recovered: InvocationRow[] = [];
  const openedCircuits: Array<{ routine: RoutineDefinition; invocation: InvocationRow; openUntil: string }> = [];
  let closedCircuits = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const exhaustedCandidates = db.prepare(`
      SELECT * FROM routine_invocations
      WHERE attempt >= maxAttempts AND (
        status = 'pending'
        OR (status = 'processing' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt < ?)
      )
      ORDER BY updatedAt ASC
    `).all(now) as unknown as InvocationRow[];
    for (const candidate of exhaustedCandidates) {
      const failed = db.prepare(`
        UPDATE routine_invocations SET status = 'failed', error = ?, leaseOwner = NULL,
          leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
        WHERE id = ? AND attempt >= maxAttempts AND (
          status = 'pending'
          OR (status = 'processing' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt < ?)
        )
      `).run('Worker lease expired after the final allowed attempt', now, now, candidate.id, now);
      if (Number(failed.changes) !== 1) continue;
      exhausted.push(candidate);
      db.prepare(`
        UPDATE routines SET failureStreak = failureStreak + 1, updatedAt = ?
        WHERE id = ? AND deletedAt IS NULL
      `).run(now, candidate.routineId);
      const routineRow = db.prepare('SELECT * FROM routines WHERE id = ? AND deletedAt IS NULL')
        .get(candidate.routineId) as unknown as RoutineRow | undefined;
      if (!routineRow) continue;
      const routine = rowToRoutine(routineRow);
      if (routine.circuitState === 'closed' && routine.failureStreak >= routine.circuitBreaker.failureThreshold) {
        const openUntil = new Date(Date.now() + routine.circuitBreaker.cooldownSeconds * 1_000).toISOString();
        const opened = db.prepare(`
          UPDATE routines SET circuitState = 'open', circuitOpenedAt = ?, circuitOpenUntil = ?, updatedAt = ?
          WHERE id = ? AND circuitState = 'closed' AND deletedAt IS NULL
        `).run(now, openUntil, now, routine.id);
        if (Number(opened.changes) === 1) openedCircuits.push({ routine, invocation: candidate, openUntil });
      }
    }
    const recoveredCandidates = db.prepare(`
      SELECT * FROM routine_invocations
      WHERE status = 'processing' AND attempt < maxAttempts
        AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt < ?
      ORDER BY updatedAt ASC
    `).all(now) as unknown as InvocationRow[];
    for (const candidate of recoveredCandidates) {
      const reset = db.prepare(`
        UPDATE routine_invocations SET status = 'pending', leaseOwner = NULL, leaseExpiresAt = NULL,
          availableAt = ?, updatedAt = ?, error = 'Worker lease expired; retrying'
        WHERE id = ? AND status = 'processing' AND attempt < maxAttempts
          AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt < ?
      `).run(now, now, candidate.id, now);
      if (Number(reset.changes) === 1) recovered.push(candidate);
    }
    const closed = db.prepare(`
      UPDATE routines SET circuitState = 'closed', circuitOpenedAt = NULL, circuitOpenUntil = NULL,
        failureStreak = 0, updatedAt = ?
      WHERE circuitState = 'open' AND circuitOpenUntil IS NOT NULL AND circuitOpenUntil <= ?
    `).run(now, now);
    closedCircuits = Number(closed.changes);
    const candidates = db.prepare(`
      WITH eligible AS (
        SELECT i.*,
          ROW_NUMBER() OVER (
            PARTITION BY i.concurrencyKey
            ORDER BY i.availableAt ASC, i.createdAt ASC, i.id ASC
          ) AS queueRank
        FROM routine_invocations i
        JOIN routines r ON r.id = i.routineId
        WHERE i.status = 'pending' AND i.attempt < i.maxAttempts
          AND i.availableAt <= ? AND r.enabled = 1
          AND r.deletedAt IS NULL AND r.circuitState = 'closed'
          AND NOT EXISTS (
            SELECT 1 FROM routine_invocations active
            WHERE active.concurrencyKey = i.concurrencyKey
              AND active.status = 'processing'
              AND (active.leaseExpiresAt IS NULL OR active.leaseExpiresAt >= ?)
          )
      )
      SELECT * FROM eligible WHERE queueRank = 1
      ORDER BY availableAt ASC, createdAt ASC, id ASC LIMIT ?
    `).all(now, now, claimLimit) as unknown as InvocationRow[];
    for (const candidate of candidates) {
      const result = db.prepare(`
        UPDATE routine_invocations SET status = 'processing', attempt = attempt + 1,
          leaseOwner = ?, leaseExpiresAt = ?, updatedAt = ?, error = NULL
        WHERE id = ? AND status = 'pending' AND attempt < maxAttempts
      `).run(workerId, leaseExpiresAt, now, candidate.id);
      if (Number(result.changes) !== 1) continue;
      claimed.push(rowToInvocation(db.prepare('SELECT * FROM routine_invocations WHERE id = ?').get(candidate.id) as unknown as InvocationRow));
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  for (const invocation of recovered) {
    audit('run', 'routine invocation recovered', 'Worker lease expired; retrying with a new fenced attempt', {
      routineId: invocation.routineId,
      invocationId: invocation.id,
      attempt: invocation.attempt,
    });
    if (invocation.taskId) {
      settleRoutineTaskTree(
        invocation.taskId,
        'lost',
        'Automation worker lease expired before this attempt completed.',
        { suppressFailureSignals: true },
      );
    }
  }
  for (const invocation of exhausted) {
    audit('run', 'routine invocation failed', 'Retry budget exhausted after worker lease expiry', {
      routineId: invocation.routineId,
      invocationId: invocation.id,
      attempt: invocation.attempt,
      leaseExpired: true,
    });
    if (invocation.taskId) settleRoutineTaskTree(
      invocation.taskId,
      'failed',
      'Automation worker stopped responding after the final allowed attempt.',
    );
    maybeRetireOneTimeRoutine(invocation.routineId);
  }
  if (claimed.length || recovered.length || exhausted.length || openedCircuits.length || closedCircuits) emitAppEvent('routines');
  return claimed;
}

function retryDelay(retryPolicy: RoutineRetryPolicy, attempt: number): number {
  return Math.min(
    retryPolicy.maxDelayMs,
    Math.round(retryPolicy.baseDelayMs * Math.pow(retryPolicy.multiplier, Math.max(0, attempt - 1))),
  );
}

function readTriggerState(routineId: string, triggerId: string): Record<string, unknown> {
  const row = getDb().prepare(`
    SELECT state FROM routine_trigger_state WHERE routineId = ? AND triggerId = ?
  `).get(routineId, triggerId) as { state: string } | undefined;
  return row ? parseJson(row.state, {}) : {};
}

function markOneTimeTriggerConsumed(
  routineId: string,
  trigger: Extract<RoutineTrigger, { type: 'one_time' }>,
  invocationId: string,
  at: Date,
): void {
  const state = {
    ...readTriggerState(routineId, trigger.id),
    consumedAt: at.toISOString(),
    invocationId,
  };
  getDb().prepare(`
    INSERT INTO routine_trigger_state (routineId, triggerId, nextDueAt, lastCheckedAt, state)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(routineId, triggerId) DO UPDATE SET
      lastCheckedAt = excluded.lastCheckedAt, state = excluded.state
  `).run(routineId, trigger.id, trigger.at, at.toISOString(), JSON.stringify(state));
}

function maybeRetireOneTimeRoutine(routineId: string): boolean {
  const routine = getRoutineInternal(routineId);
  if (!routine || routine.triggers.length === 0 || routine.triggers.some((trigger) => trigger.type !== 'one_time')) return false;
  const enabled = routine.triggers.filter((trigger): trigger is Extract<RoutineTrigger, { type: 'one_time' }> => (
    trigger.type === 'one_time' && trigger.enabled
  ));
  if (!enabled.length || enabled.some((trigger) => !readTriggerState(routine.id, trigger.id).consumedAt)) return false;
  const active = getDb().prepare(`
    SELECT 1 AS active FROM routine_invocations
    WHERE routineId = ? AND status IN ('pending', 'processing') LIMIT 1
  `).get(routine.id) as { active: number } | undefined;
  if (active) return false;
  const now = nowIso();
  const retired = getDb().prepare(`
    UPDATE routines SET enabled = 0, updatedAt = ?
    WHERE id = ? AND enabled = 1 AND deletedAt IS NULL
  `).run(now, routine.id);
  if (Number(retired.changes) !== 1) return false;
  audit('run', 'one-time routine retired', routine.name, { routineId: routine.id });
  return true;
}

function skipCancelledInvocation(id: string, expectedAttempt: number, reason: string): RoutineInvocation {
  const db = getDb();
  const now = nowIso();
  const result = db.prepare(`
    UPDATE routine_invocations SET status = 'skipped', error = ?, result = NULL,
      leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
    WHERE id = ? AND status = 'processing' AND leaseOwner = ? AND attempt = ?
      AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ?
  `).run(cleanText(reason, 20_000, true), now, now, id, workerId, expectedAttempt, now);
  const row = db.prepare('SELECT * FROM routine_invocations WHERE id = ?').get(id) as unknown as InvocationRow | undefined;
  if (!row) throw new Error('Routine invocation not found');
  if (Number(result.changes) !== 1 && row.status !== 'skipped') {
    throw new Error('Routine invocation lease is no longer owned by this worker attempt');
  }
  maybeRetireOneTimeRoutine(row.routineId);
  audit('run', 'routine invocation cancelled', reason, { routineId: row.routineId, invocationId: row.id, attempt: expectedAttempt });
  emitAppEvent('routines');
  return rowToInvocation(row);
}

export function finishRoutineInvocation(
  id: string,
  outcome: { ok: true; result?: string } | { ok: false; error: string },
  expectedAttempt: number,
): RoutineInvocation {
  ensureRoutineSchema();
  const db = getDb();
  const row = db.prepare('SELECT * FROM routine_invocations WHERE id = ?').get(assertId(id, 'routine invocation id')) as unknown as InvocationRow | undefined;
  if (!row) throw new Error('Routine invocation not found');
  if (
    row.status !== 'processing'
    || row.leaseOwner !== workerId
    || row.attempt !== expectedAttempt
    || !row.leaseExpiresAt
    || Date.parse(row.leaseExpiresAt) <= Date.now()
  ) {
    throw new Error('Routine invocation lease is no longer owned by this worker attempt');
  }
  const invocation = rowToInvocation(row);
  const routine = getRoutineInternal(invocation.routineId);
  if (!routine) throw new Error('Routine not found');
  const execution = executionSnapshotForInvocationRow(row, routine);
  const now = nowIso();
  if (outcome.ok) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const completed = db.prepare(`
        UPDATE routine_invocations SET status = 'succeeded', result = ?, error = NULL,
          leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseOwner = ? AND attempt = ?
          AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ?
      `).run(cleanText(outcome.result, 50_000), now, now, invocation.id, workerId, expectedAttempt, now);
      if (Number(completed.changes) !== 1) throw new Error('Routine invocation lease was reclaimed before completion');
      db.prepare(`
        UPDATE routines SET failureStreak = 0, circuitState = 'closed', circuitOpenedAt = NULL,
          circuitOpenUntil = NULL, updatedAt = ? WHERE id = ?
      `).run(now, routine.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
      throw error;
    }
  } else if (invocation.attempt < invocation.maxAttempts) {
    const availableAt = new Date(Date.now() + retryDelay(execution.retryPolicy, invocation.attempt)).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const retried = db.prepare(`
        UPDATE routine_invocations SET status = 'pending', availableAt = ?, error = ?,
          leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseOwner = ? AND attempt = ?
          AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ?
      `).run(
        cleanText(availableAt, 100, true), cleanText(outcome.error, 20_000, true), now,
        invocation.id, workerId, expectedAttempt, now,
      );
      if (Number(retried.changes) !== 1) throw new Error('Routine invocation lease was reclaimed before retry scheduling');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
      throw error;
    }
  } else {
    db.exec('BEGIN IMMEDIATE');
    try {
      const failed = db.prepare(`
        UPDATE routine_invocations SET status = 'failed', error = ?, leaseOwner = NULL,
          leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseOwner = ? AND attempt = ?
          AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ?
      `).run(cleanText(outcome.error, 20_000, true), now, now, invocation.id, workerId, expectedAttempt, now);
      if (Number(failed.changes) !== 1) throw new Error('Routine invocation lease was reclaimed before failure recording');
      db.prepare('UPDATE routines SET failureStreak = failureStreak + 1, updatedAt = ? WHERE id = ?')
        .run(now, routine.id);
      const failedRoutineRow = db.prepare('SELECT * FROM routines WHERE id = ? AND deletedAt IS NULL')
        .get(routine.id) as unknown as RoutineRow | undefined;
      const failedRoutine = failedRoutineRow ? rowToRoutine(failedRoutineRow) : null;
      if (failedRoutine && failedRoutine.circuitState === 'closed'
        && failedRoutine.failureStreak >= failedRoutine.circuitBreaker.failureThreshold) {
        const openUntil = new Date(Date.now() + failedRoutine.circuitBreaker.cooldownSeconds * 1_000).toISOString();
        db.prepare(`
          UPDATE routines SET circuitState = 'open', circuitOpenedAt = ?, circuitOpenUntil = ?,
            updatedAt = ? WHERE id = ? AND circuitState = 'closed' AND deletedAt IS NULL
        `).run(now, openUntil, now, failedRoutine.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
      throw error;
    }
  }
  audit('run', outcome.ok ? 'routine invocation succeeded' : 'routine invocation failed', routine.name, {
    routineId: routine.id, invocationId: invocation.id, attempt: invocation.attempt,
  });
  if (outcome.ok || invocation.attempt >= invocation.maxAttempts) maybeRetireOneTimeRoutine(routine.id);
  emitAppEvent('routines');
  return rowToInvocation(db.prepare('SELECT * FROM routine_invocations WHERE id = ?').get(invocation.id) as unknown as InvocationRow);
}

function originForTrigger(type: RoutineTriggerType): 'manual' | 'schedule' | 'integration' | 'system' {
  if (type === 'manual') return 'manual';
  if (type === 'schedule' || type === 'one_time') return 'schedule';
  if (type === 'webhook' || type === 'integration_event') return 'integration';
  return 'system';
}

async function waitForRunnableRoutineTask(
  taskId: string,
  leaseSignal?: AbortSignal,
  activeBudget?: RoutineActiveTimeBudget,
): Promise<void> {
  for (;;) {
    throwIfInvocationLeaseLost(leaseSignal);
    const task = getTask(taskId);
    if (!task) throw new Error('Routine task no longer exists');
    if (task.status === 'running') {
      activeBudget?.sample(false);
      activeBudget?.throwIfExpired();
      return;
    }
    if (task.status === 'cancelled') throw new RoutineInvocationCancelledError(task.error || undefined);
    if (task.status === 'paused' || task.status === 'waiting_for_input' || task.status === 'waiting_for_approval') {
      activeBudget?.sample(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      continue;
    }
    throw new Error(task.error || `Routine task stopped with status ${task.status}`);
  }
}

async function heartbeatRunnableRoutineTask(
  taskId: string,
  input: { progress?: number; currentStep?: string; nextAction?: string },
  leaseSignal?: AbortSignal,
  activeBudget?: RoutineActiveTimeBudget,
): Promise<void> {
  for (;;) {
    await waitForRunnableRoutineTask(taskId, leaseSignal, activeBudget);
    const current = getTask(taskId);
    if (!current) throw new Error('Routine task no longer exists');
    try {
      heartbeatTask(taskId, { ...input, expectedVersion: current.version });
      return;
    } catch (error) {
      throwIfInvocationLeaseLost(leaseSignal);
      if (!/concurrently|Only a running task/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

async function completeRunnableRoutineTask(
  taskId: string,
  result: string,
  leaseSignal?: AbortSignal,
  activeBudget?: RoutineActiveTimeBudget,
): Promise<void> {
  for (;;) {
    await waitForRunnableRoutineTask(taskId, leaseSignal, activeBudget);
    const current = getTask(taskId);
    if (!current) throw new Error('Routine task no longer exists');
    try {
      transitionTask({ taskId, status: 'succeeded', expectedVersion: current.version, result });
      return;
    } catch (error) {
      throwIfInvocationLeaseLost(leaseSignal);
      if (!/concurrently|Invalid task transition/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

function requestRoutineScheduleSync(): void {
  void syncRoutineSchedules().catch((error) => {
    audit('run', 'routine schedule sync failed', error instanceof Error ? error.message : String(error));
  });
}

function startRoutineStepRunFenced(input: {
  invocationId: string;
  stepId: string;
  taskId: string;
  attempt: number;
}): boolean {
  const now = nowIso();
  const result = getDb().prepare(`
    INSERT INTO routine_step_runs (invocationId, stepId, status, attempt, taskId, output, error, updatedAt)
    SELECT ?, ?, 'processing', 1, ?, NULL, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM routine_invocations owned
      WHERE owned.id = ? AND owned.status = 'processing'
        AND owned.leaseOwner = ? AND owned.attempt = ?
        AND owned.leaseExpiresAt IS NOT NULL AND owned.leaseExpiresAt > ?
    )
    ON CONFLICT(invocationId, stepId) DO UPDATE SET
      status = 'processing', attempt = routine_step_runs.attempt + 1,
      taskId = excluded.taskId, output = NULL, error = NULL, updatedAt = excluded.updatedAt
    WHERE EXISTS (
      SELECT 1 FROM routine_invocations owned
      WHERE owned.id = routine_step_runs.invocationId AND owned.status = 'processing'
        AND owned.leaseOwner = ? AND owned.attempt = ?
        AND owned.leaseExpiresAt IS NOT NULL AND owned.leaseExpiresAt > ?
    )
  `).run(
    input.invocationId, input.stepId, input.taskId, now,
    input.invocationId, workerId, input.attempt, now,
    workerId, input.attempt, now,
  );
  return Number(result.changes) === 1;
}

function updateRoutineStepRunFenced(input: {
  invocationId: string;
  stepId: string;
  taskId: string;
  attempt: number;
  status: 'succeeded' | 'failed';
  output?: string;
  error?: string;
}): boolean {
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE routine_step_runs SET status = ?, output = ?, error = ?, updatedAt = ?
    WHERE invocationId = ? AND stepId = ? AND taskId = ?
      AND EXISTS (
        SELECT 1 FROM routine_invocations owned
        WHERE owned.id = routine_step_runs.invocationId
          AND owned.status = 'processing' AND owned.leaseOwner = ? AND owned.attempt = ?
          AND owned.leaseExpiresAt IS NOT NULL AND owned.leaseExpiresAt > ?
      )
  `).run(
    input.status,
    input.status === 'succeeded' ? (input.output || '').slice(0, 50_000) : null,
    input.status === 'failed' ? (input.error || 'Routine step failed').slice(0, 20_000) : null,
    now,
    input.invocationId,
    input.stepId,
    input.taskId,
    workerId,
    input.attempt,
    now,
  );
  return Number(result.changes) === 1;
}

export const routineStepRuntimeTestHooks = {
  startRoutineStepRunFenced,
  updateRoutineStepRunFenced,
};

async function executeInvocation(invocation: RoutineInvocation, leaseSignal?: AbortSignal): Promise<string> {
  throwIfInvocationLeaseLost(leaseSignal);
  const routine = getRoutineInternal(invocation.routineId);
  if (!routine) throw new Error('Routine no longer exists');
  const invocationRow = getDb().prepare('SELECT * FROM routine_invocations WHERE id = ?')
    .get(invocation.id) as unknown as InvocationRow | undefined;
  if (!invocationRow) throw new Error('Routine invocation no longer exists');
  const execution = executionSnapshotForInvocationRow(invocationRow, routine);
  const ledger = await import('./task-ledger');
  const parentTaskId = `routine:${invocation.id}:${invocation.attempt}`;
  const orderedSteps = execution.steps.length
    ? execution.steps
    : [{ id: 'run', name: execution.name, prompt: execution.prompt, kind: 'work' as const, dependsOn: [] }];
  const previousSteps = getDb().prepare('SELECT stepId, status, taskId, output FROM routine_step_runs WHERE invocationId = ?')
    .all(invocation.id) as Array<{ stepId: string; status: string; taskId: string | null; output: string | null }>;
  const recovered = new Map(previousSteps.map((step) => [step.stepId, step]));
  const alreadyComplete = new Set<string>();
  for (const step of previousSteps) {
    if (step.status === 'succeeded') {
      alreadyComplete.add(step.stepId);
      continue;
    }
    const priorTask = step.taskId ? ledger.getTask(step.taskId) : null;
    if (priorTask?.status === 'succeeded') {
      if (!updateRoutineStepRunFenced({
        invocationId: invocation.id,
        stepId: step.stepId,
        taskId: step.taskId!,
        attempt: invocation.attempt,
        status: 'succeeded',
        output: priorTask.result || '',
      })) throw new RoutineInvocationLeaseLostError();
      alreadyComplete.add(step.stepId);
      recovered.set(step.stepId, { ...step, status: 'succeeded', output: priorTask.result || '' });
    }
  }
  const parent = ledger.createTask({
    id: parentTaskId,
    kind: 'routine',
    title: execution.name,
    description: execution.prompt,
    status: 'running',
    originType: originForTrigger(invocation.triggerType),
    originId: invocation.routineId,
    agentId: execution.agentId,
    plan: orderedSteps.map((step) => ({ id: step.id, title: step.name, status: alreadyComplete.has(step.id) ? 'completed' : 'pending' })),
    metadata: {
      routineId: invocation.routineId,
      invocationId: invocation.id,
      triggerId: invocation.triggerId,
      attempt: invocation.attempt,
      definitionVersion: execution.definitionVersion,
      ...(invocation.attempt < invocation.maxAttempts ? { suppressFailureSignals: true } : {}),
    },
  });
  const bound = getDb().prepare(`
    UPDATE routine_invocations SET taskId = ?, updatedAt = ?
    WHERE id = ? AND status = 'processing' AND leaseOwner = ? AND attempt = ?
      AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > ?
  `).run(parent.id, nowIso(), invocation.id, workerId, invocation.attempt, nowIso());
  if (Number(bound.changes) !== 1) {
    const current = getTask(parent.id);
    if (current && current.status === 'running') {
      transitionTask({
        taskId: current.id,
        status: 'cancelled',
        expectedVersion: current.version,
        error: 'Automation invocation was cancelled before execution began.',
        metadata: { suppressTerminalSignals: true },
      });
    }
    throw new RoutineInvocationCancelledError('Automation invocation was cancelled before execution began');
  }
  emitAppEvent('routines');
  let currentChildTaskId: string | undefined;
  let timeoutMonitor: ReturnType<typeof startRoutineActiveTimeBudget> | undefined;
  try {
    await waitForRunnableRoutineTask(parent.id, leaseSignal);
    timeoutMonitor = startRoutineActiveTimeBudget(execution.timeoutMs, () => {
      const rows = getDb().prepare('SELECT status FROM tasks WHERE id = ? OR id = ?')
        .all(parent.id, currentChildTaskId || parent.id) as Array<{ status: string }>;
      return rows.some((task) => PAUSE_LIKE_TASK_STATUSES.has(task.status));
    });
    const { loadAgents } = await import('./persistence');
    const { normalizeAgent } = await import('./types');
    const agent = (await loadAgents()).find((candidate) => candidate.id === execution.agentId);
    if (!agent) throw new Error(`Routine agent ${execution.agentId} was not found`);
    const values = { ...execution.parameters, ...invocation.payload, trigger: invocation.payload };
    const outputs: string[] = [];
    const completed = new Set(alreadyComplete);
    for (const [index, step] of orderedSteps.entries()) {
      await waitForRunnableRoutineTask(parent.id, leaseSignal, timeoutMonitor.budget);
      timeoutMonitor.budget.sample(false);
      timeoutMonitor.budget.throwIfExpired();
      if (!(step.dependsOn || []).every((dependency) => completed.has(dependency))) {
        throw new Error(`Dependencies for step ${step.name} did not complete`);
      }
      if (completed.has(step.id)) {
        const output = recovered.get(step.id)?.output;
        if (output) outputs.push(output);
        continue;
      }
      await heartbeatRunnableRoutineTask(parent.id, {
        progress: index / orderedSteps.length,
        currentStep: step.name,
        nextAction: index + 1 < orderedSteps.length ? orderedSteps[index + 1].name : 'Complete routine',
      }, leaseSignal, timeoutMonitor.budget);
      const childId = randomUUID();
      const runId = randomUUID();
      const prompt = renderTemplate(
        execution.steps.length ? `${execution.prompt}\n\nRoutine step: ${step.name}\n${step.prompt}` : step.prompt,
        values,
      );
      const child = ledger.createTask({
        id: childId,
        kind: step.kind === 'code' ? 'code' : 'work',
        title: `${execution.name}: ${step.name}`,
        description: prompt,
        parentId: parent.id,
        originType: originForTrigger(invocation.triggerType),
        originId: invocation.routineId,
        agentId: execution.agentId,
        runId,
        metadata: {
          routineId: invocation.routineId,
          invocationId: invocation.id,
          stepId: step.id,
          definitionVersion: execution.definitionVersion,
          suppressTerminalSignals: true,
        },
      });
      if (!startRoutineStepRunFenced({
        invocationId: invocation.id,
        stepId: step.id,
        taskId: child.id,
        attempt: invocation.attempt,
      })) throw new RoutineInvocationLeaseLostError();
      const assigned = ledger.assignTaskExecution({ taskId: child.id, runId, agentId: execution.agentId, expectedVersion: child.version });
      ledger.transitionTask({ taskId: child.id, status: 'running', expectedVersion: assigned.version, currentStep: 'Starting routine step' });
      await waitForRunnableRoutineTask(parent.id, leaseSignal, timeoutMonitor.budget);
      currentChildTaskId = child.id;
      try {
        const { runAgentOnce } = await import('./agent-runtime');
        const executionSignal = leaseSignal
          ? AbortSignal.any([timeoutMonitor.budget.signal, leaseSignal])
          : timeoutMonitor.budget.signal;
        const run = await runAgentOnce(normalizeAgent(agent), prompt, {
          scheduled: true,
          scheduleId: invocation.routineId,
          scheduleInstructions: prompt,
          taskId: child.id,
          runId,
          attemptNo: invocation.attempt,
          signal: executionSignal,
        });
        throwIfInvocationLeaseLost(leaseSignal);
        timeoutMonitor.budget.throwIfExpired();
        await waitForRunnableRoutineTask(parent.id, leaseSignal, timeoutMonitor.budget);
        if (run.status !== 'completed') throw new Error(run.finalOutput || `Routine step ${step.name} failed`);
        const output = run.finalOutput || `${step.name} completed`;
        if (!updateRoutineStepRunFenced({
          invocationId: invocation.id,
          stepId: step.id,
          taskId: child.id,
          attempt: invocation.attempt,
          status: 'succeeded',
          output,
        })) throw new RoutineInvocationLeaseLostError();
        outputs.push(output);
        completed.add(step.id);
      } catch (error) {
        if (!updateRoutineStepRunFenced({
          invocationId: invocation.id,
          stepId: step.id,
          taskId: child.id,
          attempt: invocation.attempt,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })) throw new RoutineInvocationLeaseLostError();
        throw error;
      } finally {
        currentChildTaskId = undefined;
      }
    }
    await waitForRunnableRoutineTask(parent.id, leaseSignal, timeoutMonitor.budget);
    timeoutMonitor.budget.sample(false);
    timeoutMonitor.budget.throwIfExpired();
    const result = outputs.join('\n\n');
    await heartbeatRunnableRoutineTask(parent.id, { progress: 1, currentStep: 'Routine complete', nextAction: '' }, leaseSignal, timeoutMonitor.budget);
    await completeRunnableRoutineTask(parent.id, result, leaseSignal, timeoutMonitor.budget);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = ledger.getTask(parent.id);
    const cancellation = error instanceof RoutineInvocationCancelledError
      ? error
      : current?.status === 'cancelled'
        ? new RoutineInvocationCancelledError(current.error || message)
        : null;
    if (error instanceof RoutineInvocationLeaseLostError) {
      settleRoutineTaskTree(
        parent.id,
        'lost',
        error.message,
        { suppressFailureSignals: true },
      );
    } else if (cancellation) {
      if (current && ['running', 'paused', 'waiting_for_input', 'waiting_for_approval'].includes(current.status)) {
        ledger.transitionTask({
          taskId: parent.id,
          status: 'cancelled',
          expectedVersion: current.version,
          error: message,
        });
      }
      settleRoutineTaskTree(parent.id, 'cancelled', cancellation.message);
    } else if (current && ['running', 'paused', 'waiting_for_input', 'waiting_for_approval'].includes(current.status)) {
      ledger.transitionTask({ taskId: parent.id, status: 'failed', expectedVersion: current.version, error: message });
    }
    throw cancellation || error;
  } finally {
    timeoutMonitor?.stop();
  }
}

interface ActiveRoutineExecution {
  routineId: string;
  agentId: string;
  promise: Promise<void>;
}

interface RoutineWorkerGlobals {
  __shibaActiveRoutineExecutions?: Map<string, ActiveRoutineExecution>;
}

const routineWorkerGlobals = globalThis as typeof globalThis & RoutineWorkerGlobals;
const activeRoutineExecutions = routineWorkerGlobals.__shibaActiveRoutineExecutions
  ?? (routineWorkerGlobals.__shibaActiveRoutineExecutions = new Map());

function availableRoutineExecutionSlots(
  maxConcurrent: number,
  executions: Array<Pick<ActiveRoutineExecution, 'routineId' | 'agentId'>>,
  activeRuns: Array<{ scheduleKey?: string }>,
): number {
  const activeScheduleKeys = new Set(executions.map((execution) => `${execution.agentId}:${execution.routineId}`));
  const outsideRuns = activeRuns.filter((run) => !run.scheduleKey || !activeScheduleKeys.has(run.scheduleKey)).length;
  return Math.max(0, maxConcurrent - executions.length - outsideRuns);
}

function observeDetachedRoutineExecution(
  execution: Promise<void>,
  report: (error: unknown) => void = (error) => {
    audit('run', 'routine invocation worker failed', error instanceof Error ? error.message : String(error));
  },
): Promise<void> {
  return execution.catch((error) => { report(error); });
}

export const routineWorkerTestHooks = {
  availableRoutineExecutionSlots,
  observeDetachedRoutineExecution,
};

async function executeClaimedRoutineInvocation(invocation: RoutineInvocation): Promise<void> {
  const leaseController = new AbortController();
  const heartbeat = setInterval(() => {
    runRoutineLeaseHeartbeatTick(leaseController, () => {
      const now = nowIso();
      const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      const renewed = getDb().prepare(`
        UPDATE routine_invocations SET leaseExpiresAt = ?, updatedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseOwner = ? AND attempt = ?
      `).run(leaseExpiresAt, now, invocation.id, workerId, invocation.attempt);
      return Number(renewed.changes) === 1;
    });
  }, 20_000);
  heartbeat.unref?.();
  try {
    try {
      const result = await executeInvocation(invocation, leaseController.signal);
      finishRoutineInvocation(invocation.id, { ok: true, result }, invocation.attempt);
    } catch (error) {
      if (error instanceof RoutineInvocationLeaseLostError || leaseController.signal.aborted) return;
      if (error instanceof RoutineInvocationCancelledError) {
        skipCancelledInvocation(invocation.id, invocation.attempt, error.message);
        return;
      }
      const current = getDb().prepare('SELECT status FROM routine_invocations WHERE id = ?')
        .get(invocation.id) as { status: string } | undefined;
      if (current && ['succeeded', 'failed', 'skipped'].includes(current.status)) return;
      finishRoutineInvocation(
        invocation.id,
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        invocation.attempt,
      );
    }
  } finally {
    clearInterval(heartbeat);
  }
}

function startClaimedRoutineInvocation(invocation: RoutineInvocation): Promise<void> {
  const execution = getRoutineInvocationExecutionSnapshot(invocation.id);
  const promise = Promise.resolve()
    .then(() => executeClaimedRoutineInvocation(invocation))
    .finally(() => {
      if (activeRoutineExecutions.get(invocation.id)?.promise === promise) {
        activeRoutineExecutions.delete(invocation.id);
      }
    });
  activeRoutineExecutions.set(invocation.id, {
    routineId: invocation.routineId,
    agentId: execution.agentId,
    promise,
  });
  return promise;
}

async function claimAndStartRoutineInvocations(
  limit: number,
  dispatchAllowed: () => boolean = () => true,
): Promise<{
  claimed: RoutineInvocation[];
  executions: Promise<void>[];
}> {
  if (isAutomationMaintenanceActive() || !dispatchAllowed()) return { claimed: [], executions: [] };
  const [{ loadConfig }, guards] = await Promise.all([
    import('./persistence'),
    import('./run-guards'),
  ]);
  const config = await loadConfig();
  if (isAutomationMaintenanceActive() || !dispatchAllowed()) return { claimed: [], executions: [] };
  const availableSlots = availableRoutineExecutionSlots(
    guards.maxConcurrentRuns(config),
    [...activeRoutineExecutions.values()],
    guards.listActiveRuns(),
  );
  const requested = Math.max(0, Math.min(100, Math.floor(Number(limit) || 0)));
  const claimCount = Math.min(requested, availableSlots);
  if (claimCount === 0) return { claimed: [], executions: [] };
  const claimed = claimRoutineInvocations(claimCount);
  return { claimed, executions: claimed.map(startClaimedRoutineInvocation) };
}

export async function processRoutineInvocations(limit = 4): Promise<number> {
  const started = await claimAndStartRoutineInvocations(limit);
  await Promise.all(started.executions);
  return started.claimed.length;
}

async function dispatchRoutineInvocations(generation: number, limit = 4): Promise<number> {
  const started = await claimAndStartRoutineInvocations(limit, () => !routineEngineFenceActive(generation));
  for (const execution of started.executions) void observeDetachedRoutineExecution(execution);
  return started.claimed.length;
}

const TRIGGER_CHECK_CLAIM_KEY = '__shibaTriggerCheck';

function triggerStateWithoutClaim(state: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...state };
  delete clean[TRIGGER_CHECK_CLAIM_KEY];
  return clean;
}

function claimTriggerCheck(routineId: string, triggerId: string, intervalSeconds: number, now: Date): TriggerCheckClaim | null {
  const db = getDb();
  const current = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT OR IGNORE INTO routine_trigger_state (routineId, triggerId, nextDueAt, lastCheckedAt, state)
      VALUES (?, ?, ?, NULL, '{}')
    `).run(routineId, triggerId, current);
    const before = db.prepare('SELECT state, nextDueAt AS dueAt FROM routine_trigger_state WHERE routineId = ? AND triggerId = ?')
      .get(routineId, triggerId) as TriggerStateRow;
    if (before.dueAt > current) {
      db.exec('COMMIT');
      return null;
    }
    const state = parseJson<Record<string, unknown>>(before.state, {});
    const existingClaim = isRecord(state[TRIGGER_CHECK_CLAIM_KEY])
      ? state[TRIGGER_CHECK_CLAIM_KEY] as Record<string, unknown>
      : null;
    if (existingClaim && typeof existingClaim.leaseUntil === 'string' && existingClaim.leaseUntil > current) {
      db.exec('COMMIT');
      return null;
    }
    const token = randomUUID();
    const claimedState = {
      ...triggerStateWithoutClaim(state),
      [TRIGGER_CHECK_CLAIM_KEY]: {
        token,
        dueKey: before.dueAt,
        claimedAt: current,
        leaseUntil: new Date(now.getTime() + 5 * 60_000).toISOString(),
      },
    };
    const result = db.prepare(`
      UPDATE routine_trigger_state SET state = ?, lastCheckedAt = ?
      WHERE routineId = ? AND triggerId = ? AND nextDueAt = ? AND state = ?
    `).run(JSON.stringify(claimedState), current, routineId, triggerId, before.dueAt, before.state);
    db.exec('COMMIT');
    return Number(result.changes) === 1
      ? {
          routineId,
          triggerId,
          dueKey: before.dueAt,
          token,
          intervalSeconds,
          checkedAt: current,
          state: triggerStateWithoutClaim(state),
        }
      : null;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
}

function releaseTriggerCheck(claim: TriggerCheckClaim): void {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT state FROM routine_trigger_state WHERE routineId = ? AND triggerId = ?')
      .get(claim.routineId, claim.triggerId) as { state: string } | undefined;
    if (row) {
      const state = parseJson<Record<string, unknown>>(row.state, {});
      const marker = isRecord(state[TRIGGER_CHECK_CLAIM_KEY]) ? state[TRIGGER_CHECK_CLAIM_KEY] as Record<string, unknown> : null;
      if (marker?.token === claim.token) {
        db.prepare(`
          UPDATE routine_trigger_state SET state = ?
          WHERE routineId = ? AND triggerId = ? AND state = ?
        `).run(JSON.stringify(triggerStateWithoutClaim(state)), claim.routineId, claim.triggerId, row.state);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
}

function finalizeTriggerCheck(
  claim: TriggerCheckClaim,
  state: Record<string, unknown>,
  invocation?: Parameters<typeof enqueueRoutineInvocation>[0],
): { invocation: RoutineInvocation; inserted: boolean } | null {
  const db = getDb();
  const nextDueAt = new Date(Date.parse(claim.checkedAt) + claim.intervalSeconds * 1_000).toISOString();
  let queued: { invocation: RoutineInvocation; inserted: boolean } | null = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT state, nextDueAt AS dueAt FROM routine_trigger_state WHERE routineId = ? AND triggerId = ?')
      .get(claim.routineId, claim.triggerId) as TriggerStateRow | undefined;
    const currentState = row ? parseJson<Record<string, unknown>>(row.state, {}) : {};
    const marker = isRecord(currentState[TRIGGER_CHECK_CLAIM_KEY])
      ? currentState[TRIGGER_CHECK_CLAIM_KEY] as Record<string, unknown>
      : null;
    if (!row || row.dueAt !== claim.dueKey || marker?.token !== claim.token) {
      throw new Error('Routine trigger check claim is no longer current');
    }
    if (invocation) queued = enqueueRoutineInvocation(invocation);
    const updated = db.prepare(`
      UPDATE routine_trigger_state SET nextDueAt = ?, lastCheckedAt = ?, state = ?
      WHERE routineId = ? AND triggerId = ? AND nextDueAt = ? AND state = ?
    `).run(
      nextDueAt,
      claim.checkedAt,
      JSON.stringify(triggerStateWithoutClaim(state)),
      claim.routineId,
      claim.triggerId,
      claim.dueKey,
      row.state,
    );
    if (Number(updated.changes) !== 1) throw new Error('Routine trigger check claim was reclaimed before completion');
    db.exec('COMMIT');
    return queued;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
}

export const routineTriggerTestHooks = {
  claimTriggerCheck,
  finalizeTriggerCheck,
  releaseTriggerCheck,
  latestMissedScheduleTick,
};

function latestMissedScheduleTick(trigger: Extract<RoutineTrigger, { type: 'schedule' }>, previous: Date, now: Date): Date | null {
  // Bound recovery work after a very long outage. Catch-up is explicitly one run,
  // so only the newest matching minute matters.
  const floor = Math.max(previous.getTime(), now.getTime() - 7 * 24 * 60 * 60_000);
  let cursor = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const first = Math.floor(floor / 60_000) * 60_000 + 60_000;
  const matcher = cron.createTask(trigger.cron, () => {}, trigger.timezone ? { timezone: trigger.timezone } : undefined);
  try {
    while (cursor.getTime() >= first) {
      if (matcher.match(cursor)) return cursor;
      cursor = new Date(cursor.getTime() - 60_000);
    }
  } finally {
    matcher.destroy();
  }
  return null;
}

async function healthStatus(trigger: Extract<RoutineTrigger, { type: 'health' }>): Promise<{ healthy: boolean; detail: string }> {
  if (trigger.url) {
    try {
      const response = await fetch(trigger.url, { method: 'GET', signal: AbortSignal.timeout(trigger.timeoutMs || 10_000) });
      const expected = trigger.expectedStatus;
      const healthy = expected ? response.status === expected : response.ok;
      void response.body?.cancel().catch(() => {});
      return { healthy, detail: `HTTP ${response.status} from ${trigger.url}` };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : `Health request failed for ${trigger.url}` };
    }
  }
  try {
    process.kill(trigger.processPid!, 0);
    return { healthy: true, detail: `Process ${trigger.processPid} is running` };
  } catch {
    return { healthy: false, detail: `Process ${trigger.processPid} is not running` };
  }
}

async function pollRoutineTrigger(routine: RoutineDefinition, trigger: RoutineTrigger, at: Date): Promise<number> {
  if (!trigger.enabled) return 0;
  if (trigger.type === 'schedule') {
    const claim = claimTriggerCheck(routine.id, trigger.id, 60, at);
    if (!claim) return 0;
    try {
      const nextState = { ...claim.state, lastObservedAt: at.toISOString() };
      const previousValue = typeof claim.state.lastObservedAt === 'string' ? claim.state.lastObservedAt : undefined;
      if (!previousValue) {
        finalizeTriggerCheck(claim, nextState);
        return 0;
      }
      const previous = new Date(previousValue);
      if (Number.isNaN(previous.getTime())) {
        finalizeTriggerCheck(claim, nextState);
        return 0;
      }
      const missed = latestMissedScheduleTick(trigger, previous, at);
      if (!missed) {
        finalizeTriggerCheck(claim, nextState);
        return 0;
      }
      const tick = missed.toISOString().slice(0, 16);
      const skip = routine.catchUpPolicy === 'skip';
      const result = finalizeTriggerCheck(claim, nextState, {
        routineId: routine.id,
        triggerId: trigger.id,
        triggerType: trigger.type,
        dedupeKey: `schedule:${trigger.id}:${tick}`,
        payload: { tick, scheduledAt: missed.toISOString(), caughtUpAt: at.toISOString() },
        ...(skip ? { forceStatus: 'skipped' as const, skipReason: 'Missed schedule skipped by catch-up policy' } : {}),
      });
      return Boolean(result?.inserted && !skip) ? 1 : 0;
    } catch (error) {
      try { releaseTriggerCheck(claim); } catch { /* the claim lease will expire */ }
      throw error;
    }
  }
  if (trigger.type === 'one_time') {
    if (readTriggerState(routine.id, trigger.id).consumedAt) {
      maybeRetireOneTimeRoutine(routine.id);
      return 0;
    }
    const due = new Date(trigger.at).getTime();
    if (due > at.getTime()) return 0;
    const lateBy = at.getTime() - due;
    const skip = routine.catchUpPolicy === 'skip' && lateBy > 60_000;
    const result = enqueueRoutineInvocation({
      routineId: routine.id,
      triggerId: trigger.id,
      triggerType: trigger.type,
      dedupeKey: `one-time:${trigger.id}:${trigger.at}`,
      payload: { scheduledAt: trigger.at, firedAt: at.toISOString(), lateByMs: lateBy },
      ...(skip ? { forceStatus: 'skipped' as const, skipReason: 'Missed one-time trigger skipped by catch-up policy' } : {}),
    });
    markOneTimeTriggerConsumed(routine.id, trigger, result.invocation.id, at);
    if (result.invocation.status === 'skipped') maybeRetireOneTimeRoutine(routine.id);
    return result.inserted && !skip ? 1 : 0;
  }
  if (trigger.type === 'health') {
    const claim = claimTriggerCheck(routine.id, trigger.id, trigger.intervalSeconds, at);
    if (!claim) return 0;
    try {
      const status = await healthStatus(trigger);
      const nextState = { ...claim.state, healthy: status.healthy, detail: status.detail, checkedAt: at.toISOString() };
      if (status.healthy) {
        finalizeTriggerCheck(claim, nextState);
        return 0;
      }
      const result = finalizeTriggerCheck(claim, nextState, {
        routineId: routine.id,
        triggerId: trigger.id,
        triggerType: trigger.type,
        dedupeKey: `health:${trigger.id}:${claim.dueKey}`,
        payload: { healthy: false, detail: status.detail, checkedAt: at.toISOString(), url: trigger.url, processPid: trigger.processPid },
      });
      return result?.inserted ? 1 : 0;
    } catch (error) {
      try { releaseTriggerCheck(claim); } catch { /* the claim lease will expire */ }
      throw error;
    }
  }
  if (trigger.type === 'filesystem') {
    const claim = claimTriggerCheck(routine.id, trigger.id, trigger.intervalSeconds, at);
    if (!claim) return 0;
    try {
      let signature = 'missing';
      try {
        const stat = await fs.stat(trigger.path);
        signature = `${stat.mtimeMs}:${stat.size}:${stat.isDirectory() ? 'dir' : 'file'}`;
      } catch { /* missing is a meaningful state */ }
      const previous = typeof claim.state.signature === 'string' ? claim.state.signature : undefined;
      const nextState = { ...claim.state, signature, checkedAt: at.toISOString() };
      if (previous === undefined || previous === signature) {
        finalizeTriggerCheck(claim, nextState);
        return 0;
      }
      const result = finalizeTriggerCheck(claim, nextState, {
        routineId: routine.id,
        triggerId: trigger.id,
        triggerType: trigger.type,
        dedupeKey: `filesystem:${trigger.id}:${claim.dueKey}:${signature}`,
        payload: { path: trigger.path, previousSignature: previous, signature, checkedAt: at.toISOString() },
      });
      return result?.inserted ? 1 : 0;
    } catch (error) {
      try { releaseTriggerCheck(claim); } catch { /* the claim lease will expire */ }
      throw error;
    }
  }
  return 0;
}

export async function pollRoutineTriggers(at = new Date()): Promise<number> {
  if (isAutomationMaintenanceActive()) return 0;
  ensureRoutineSchema();
  const jobs = activeRoutines().flatMap((routine) => routine.triggers
    .filter((trigger) => trigger.enabled)
    .map((trigger) => ({ routine, trigger })));
  if (!jobs.length) return 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, jobs.length) }, async () => {
    let queued = 0;
    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) return queued;
      const { routine, trigger } = jobs[index];
      try {
        queued += await pollRoutineTrigger(routine, trigger, at);
      } catch (error) {
        audit('run', 'routine trigger poll failed', error instanceof Error ? error.message : String(error), {
          routineId: routine.id,
          triggerId: trigger.id,
          triggerType: trigger.type,
        });
      }
    }
  });
  return (await Promise.all(workers)).reduce((total, count) => total + count, 0);
}

export function emitRoutineIntegrationEvent(input: {
  integration: string;
  event: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
}): RoutineInvocation[] {
  const payload = input.payload || {};
  const fallback = createHash('sha256').update(`${input.integration}:${input.event}:${JSON.stringify(payload)}`).digest('hex');
  const invocations: RoutineInvocation[] = [];
  for (const routine of activeRoutines()) {
    for (const trigger of routine.triggers) {
      if (trigger.type !== 'integration_event' || !trigger.enabled) continue;
      if (trigger.integration !== input.integration || trigger.event !== input.event) continue;
      invocations.push(enqueueRoutineInvocation({
        routineId: routine.id,
        triggerId: trigger.id,
        triggerType: trigger.type,
        dedupeKey: input.dedupeKey || `integration:${fallback}`,
        payload,
      }).invocation);
    }
  }
  return invocations;
}

export function verifyAndEnqueueRoutineWebhook(input: {
  routineId: string;
  triggerId?: string;
  timestamp: string;
  signature: string;
  deliveryId?: string;
  rawBody: string;
}): { invocation: RoutineInvocation; inserted: boolean } {
  if (input.rawBody.length > 1_000_000) throw new Error('Webhook payload exceeds the 1 MB limit');
  const routine = getRoutineInternal(input.routineId);
  if (!routine) throw new Error('Routine not found');
  const trigger = routine.triggers.find((candidate) => candidate.type === 'webhook' && candidate.enabled && (!input.triggerId || candidate.id === input.triggerId));
  if (!trigger || trigger.type !== 'webhook' || !trigger.secret) throw new Error('Webhook trigger not found');
  const timestampMs = Number(input.timestamp) * 1_000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) throw new Error('Webhook timestamp is outside the five-minute replay window');
  const expected = createHmac('sha256', trigger.secret).update(`${input.timestamp}.${input.rawBody}`).digest('hex');
  const supplied = input.signature.replace(/^sha256=/i, '').trim().toLowerCase();
  const expectedBuffer = Buffer.from(expected, 'hex');
  let suppliedBuffer: Buffer;
  try { suppliedBuffer = Buffer.from(supplied, 'hex'); } catch { throw new Error('Invalid webhook signature'); }
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) throw new Error('Invalid webhook signature');
  let payload: Record<string, unknown> = {};
  if (input.rawBody.trim()) {
    const parsed = JSON.parse(input.rawBody) as unknown;
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
  }
  return enqueueRoutineInvocation({
    routineId: routine.id,
    triggerId: trigger.id,
    triggerType: 'webhook',
    dedupeKey: `webhook:${cleanText(input.deliveryId || `${input.timestamp}:${expected}`, 500, true)}`,
    payload,
  });
}

interface RoutineEngineGlobals {
  __shibaRoutinePoll?: ReturnType<typeof setInterval>;
  __shibaRoutinePump?: ReturnType<typeof setInterval>;
  __shibaRoutinePollActive?: Promise<void>;
  __shibaRoutinePumpPromise?: Promise<void>;
  __shibaRoutinePumpActive?: boolean;
  __shibaRoutineCrons?: Map<string, cron.ScheduledTask>;
  __shibaRoutineCronSync?: Promise<void>;
  __shibaRoutineStart?: Promise<void>;
  __shibaRoutineGeneration?: number;
  __shibaRoutineStopped?: boolean;
}

const engine = globalThis as typeof globalThis & RoutineEngineGlobals;
const routineCrons = engine.__shibaRoutineCrons ?? (engine.__shibaRoutineCrons = new Map());
engine.__shibaRoutineGeneration ??= 0;
engine.__shibaRoutineStopped ??= false;

function routineEngineFenceActive(generation: number): boolean {
  return isAutomationMaintenanceActive()
    || Boolean(engine.__shibaRoutineStopped)
    || generation !== engine.__shibaRoutineGeneration;
}

async function resyncRoutineSchedules(generation: number): Promise<void> {
  if (routineEngineFenceActive(generation)) return;
  for (const [, task] of routineCrons) {
    try { task.stop(); } catch { /* already stopped */ }
  }
  routineCrons.clear();
  if (routineEngineFenceActive(generation)) return;
  const routines = activeRoutines();
  if (routineEngineFenceActive(generation)) return;
  for (const routine of routines) {
    for (const trigger of routine.triggers) {
      if (routineEngineFenceActive(generation)) return;
      if (trigger.type !== 'schedule' || !trigger.enabled) continue;
      const key = `${routine.id}:${trigger.id}`;
      try {
        const task = cron.schedule(trigger.cron, (context) => {
          if (routineEngineFenceActive(generation)) return;
          const tick = automationTick(context.date);
          try {
            const live = getRoutineInternal(routine.id);
            if (routineEngineFenceActive(generation)) return;
            const liveTrigger = live?.triggers.find((candidate) => (
              candidate.id === trigger.id
              && candidate.type === 'schedule'
              && candidate.enabled
              && candidate.cron === trigger.cron
              && (candidate.timezone || '') === (trigger.timezone || '')
            ));
            if (!live?.enabled || !liveTrigger) return;
            if (routineEngineFenceActive(generation)) return;
            enqueueRoutineInvocation({
              routineId: live.id,
              triggerId: liveTrigger.id,
              triggerType: liveTrigger.type,
              dedupeKey: `schedule:${trigger.id}:${tick}`,
              payload: { tick, firedAt: nowIso() },
            });
          } catch (error) {
            if (routineEngineFenceActive(generation)) return;
            audit('run', 'routine schedule fire failed', error instanceof Error ? error.message : String(error), { routineId: routine.id, triggerId: trigger.id });
          }
        }, trigger.timezone ? { timezone: trigger.timezone } : undefined);
        if (routineEngineFenceActive(generation)) {
          try { task.stop(); } catch { /* already stopped */ }
          return;
        }
        routineCrons.set(key, task);
      } catch (error) {
        audit('run', 'routine schedule rejected', error instanceof Error ? error.message : String(error), { routineId: routine.id, triggerId: trigger.id });
      }
    }
  }
}

export function syncRoutineSchedules(): Promise<void> {
  if (isAutomationMaintenanceActive() || engine.__shibaRoutineStopped) return Promise.resolve();
  const generation = engine.__shibaRoutineGeneration ?? 0;
  const resync = () => resyncRoutineSchedules(generation);
  const next = (engine.__shibaRoutineCronSync ?? Promise.resolve()).then(resync, resync);
  engine.__shibaRoutineCronSync = next.catch(() => {});
  return next;
}

export function getRoutineEngineStatus(): { running: boolean; armedSchedules: number; expectedSchedules: number } {
  const expectedSchedules = activeRoutines().reduce((count, routine) => (
    count + routine.triggers.filter((trigger) => trigger.type === 'schedule' && trigger.enabled).length
  ), 0);
  return {
    running: !engine.__shibaRoutineStopped && Boolean(engine.__shibaRoutinePoll && engine.__shibaRoutinePump),
    armedSchedules: routineCrons.size,
    expectedSchedules,
  };
}

function runRoutinePoll(generation: number): void {
  if (isAutomationMaintenanceActive() || engine.__shibaRoutineStopped || generation !== engine.__shibaRoutineGeneration || engine.__shibaRoutinePollActive) return;
  const promise = pollRoutineTriggers()
    .then(() => {})
    .catch((error) => {
      audit('run', 'routine trigger poll failed', error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      if (engine.__shibaRoutinePollActive === promise) engine.__shibaRoutinePollActive = undefined;
    });
  engine.__shibaRoutinePollActive = promise;
}

function runRoutinePump(generation: number): void {
  if (isAutomationMaintenanceActive() || engine.__shibaRoutineStopped || generation !== engine.__shibaRoutineGeneration || engine.__shibaRoutinePumpActive) return;
  engine.__shibaRoutinePumpActive = true;
  // This promise covers only the fast claim/dispatch phase. Individual
  // invocation promises live in activeRoutineExecutions, so a single paused
  // routine cannot hold every newly freed worker slot behind Promise.all.
  const promise = dispatchRoutineInvocations(generation)
    .then(() => {})
    .catch((error) => {
      audit('run', 'routine invocation pump failed', error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      if (engine.__shibaRoutinePumpPromise === promise) {
        engine.__shibaRoutinePumpPromise = undefined;
        engine.__shibaRoutinePumpActive = false;
      }
    });
  engine.__shibaRoutinePumpPromise = promise;
}

export function startRoutineEngine(): Promise<void> {
  if (isAutomationMaintenanceActive()) return Promise.resolve();
  if (!engine.__shibaRoutineStopped && engine.__shibaRoutinePoll && engine.__shibaRoutinePump) return Promise.resolve();
  if (engine.__shibaRoutineStart) return engine.__shibaRoutineStart;
  ensureRoutineSchema();
  engine.__shibaRoutineStopped = false;
  const generation = engine.__shibaRoutineGeneration ?? 0;
  const start = (async () => {
    const migration = await migrateLegacyAgentSchedules();
    if (migration.migrated > 0) {
      audit('system', 'legacy agent schedules migrated', `${migration.migrated} Automation${migration.migrated === 1 ? '' : 's'} created`, migration);
    }
    if (routineEngineFenceActive(generation)) return;
    await migrateLegacyScheduleIntents();
    if (routineEngineFenceActive(generation)) return;
    await syncRoutineSchedules();
    if (routineEngineFenceActive(generation)) return;
    if (!engine.__shibaRoutinePoll) {
      runRoutinePoll(generation);
      engine.__shibaRoutinePoll = setInterval(() => { runRoutinePoll(generation); }, 5_000);
      engine.__shibaRoutinePoll.unref?.();
    }
    if (!engine.__shibaRoutinePump) {
      runRoutinePump(generation);
      engine.__shibaRoutinePump = setInterval(() => { runRoutinePump(generation); }, 1_000);
      engine.__shibaRoutinePump.unref?.();
    }
  })();
  const wrapped = start.finally(() => {
    if (engine.__shibaRoutineStart === wrapped) engine.__shibaRoutineStart = undefined;
  });
  engine.__shibaRoutineStart = wrapped;
  return wrapped;
}

export async function stopRoutineEngine(): Promise<void> {
  engine.__shibaRoutineStopped = true;
  engine.__shibaRoutineGeneration = (engine.__shibaRoutineGeneration ?? 0) + 1;
  if (engine.__shibaRoutinePoll) clearInterval(engine.__shibaRoutinePoll);
  if (engine.__shibaRoutinePump) clearInterval(engine.__shibaRoutinePump);
  engine.__shibaRoutinePoll = undefined;
  engine.__shibaRoutinePump = undefined;
  await Promise.allSettled([
    engine.__shibaRoutineStart,
    engine.__shibaRoutineCronSync,
    engine.__shibaRoutinePollActive,
    engine.__shibaRoutinePumpPromise,
    ...[...activeRoutineExecutions.values()].map((execution) => execution.promise),
  ].filter((promise): promise is Promise<void> => Boolean(promise)));
  engine.__shibaRoutinePollActive = undefined;
  engine.__shibaRoutineStart = undefined;
  engine.__shibaRoutinePumpPromise = undefined;
  engine.__shibaRoutinePumpActive = false;
  for (const [, task] of routineCrons) {
    try { task.stop(); } catch { /* already stopped */ }
  }
  routineCrons.clear();
}

type LegacyAgentSchedule = {
  id?: unknown;
  enabled?: unknown;
  cron?: unknown;
  instructions?: unknown;
  description?: unknown;
};

function legacyScheduleEntries(agent: unknown): LegacyAgentSchedule[] {
  if (!agent || typeof agent !== 'object') return [];
  const value = agent as Record<string, unknown>;
  const schedules = Array.isArray(value.schedules)
    ? value.schedules.filter((entry): entry is LegacyAgentSchedule => Boolean(entry && typeof entry === 'object'))
    : [];
  if (schedules.length > 0) return schedules;
  return value.schedule && typeof value.schedule === 'object'
    ? [value.schedule as LegacyAgentSchedule]
    : [];
}

function hasLegacyScheduleFields(agent: unknown): boolean {
  if (!agent || typeof agent !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(agent, 'schedules')
    || Object.prototype.hasOwnProperty.call(agent, 'schedule');
}

function legacyScheduleRoutineId(agentId: string, entry: LegacyAgentSchedule, index: number): string {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    agentId,
    index,
    id: entry.id,
    cron: entry.cron,
    instructions: entry.instructions,
    description: entry.description,
  })).digest('hex').slice(0, 32);
  return `legacy-agent-schedule:${fingerprint}`;
}

/**
 * Convert the retired per-agent schedule shape into durable Automations.
 * Routine ids are content-derived, so a process crash after SQLite commits but
 * before agents.json is rewritten simply reuses the same rows on the next run.
 * The legacy fields are removed only after every entry has been created.
 */
export async function migrateLegacyAgentSchedules(snapshot?: readonly unknown[]): Promise<{
  migrated: number;
  created: number;
  existing: number;
  invalid: number;
  agents: number;
}> {
  const observed = snapshot ?? await loadAgents();
  if (!observed.some(hasLegacyScheduleFields)) {
    return { migrated: 0, created: 0, existing: 0, invalid: 0, agents: 0 };
  }

  return mutateAgents(async (agents) => {
    let migrated = 0;
    let created = 0;
    let existing = 0;
    let invalid = 0;
    let migratedAgents = 0;

    for (const agent of agents) {
      if (!hasLegacyScheduleFields(agent)) continue;
      const entries = legacyScheduleEntries(agent);
      for (const [index, entry] of entries.entries()) {
        const cronExpression = typeof entry.cron === 'string' ? entry.cron.trim() : '';
        const prompt = cleanText(
          typeof entry.instructions === 'string' ? entry.instructions : entry.description,
          20_000,
        ) || 'Perform the scheduled task.';
        const legacyDescription = cleanText(entry.description, 5_000);
        const id = legacyScheduleRoutineId(agent.id, entry, index);
        const validCron = isSupportedAutomationCron(cronExpression);
        migrated++;
        if (!validCron) invalid++;

        // A tombstone proves this exact legacy schedule was migrated and then
        // deliberately removed. Treat it as handled instead of resurrecting it
        // or repeatedly colliding with the retained primary key.
        if (selectRoutineRowIncludingDeleted(id)) {
          existing++;
          continue;
        }

        createRoutine({
          id,
          name: cleanText(legacyDescription || prompt, 100) || `${agent.name} automation`,
          description: validCron
            ? `Migrated from an agent schedule.${legacyDescription ? ` ${legacyDescription}` : ''}`
            : `Migrated from an agent schedule with an invalid cron expression (${cronExpression || 'empty'}). Review the trigger and enable this Automation.${legacyDescription ? ` ${legacyDescription}` : ''}`,
          enabled: validCron && entry.enabled === true,
          agentId: agent.id,
          prompt,
          triggers: validCron
            ? [{ id: 'schedule', type: 'schedule', enabled: true, cron: cronExpression }]
            : [{ id: 'manual', type: 'manual', enabled: true }],
          parameters: {
            migratedFrom: 'agent_schedule',
            ...(typeof entry.id === 'string' && entry.id ? { legacyScheduleId: entry.id } : {}),
            ...(cronExpression ? { legacyCron: cronExpression } : {}),
          },
          retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, multiplier: 2, maxDelayMs: 60_000 },
          catchUpPolicy: 'run_once',
          circuitBreaker: { failureThreshold: 3, cooldownSeconds: 900 },
        });
        created++;
      }

      const record = agent as unknown as Record<string, unknown>;
      delete record.schedules;
      delete record.schedule;
      migratedAgents++;
    }

    return { migrated, created, existing, invalid, agents: migratedAgents };
  });
}

type LegacyScheduleIntentMigrationRow = {
  id: string;
  scheduleKey: string;
  tick: string;
  agentId: string;
  agentName: string;
  scheduleId: string;
  cron: string;
  instructions: string;
  status: string;
  availableAt: string;
  runId: string | null;
  taskId: string | null;
  createdAt: string;
};

function allRoutineDefinitions(): RoutineDefinition[] {
  const definitions: RoutineDefinition[] = [];
  for (let offset = 0;; offset += 500) {
    const page = listRoutines({ limit: 500, offset });
    definitions.push(...page.routines);
    if (definitions.length >= page.total || page.routines.length === 0) return definitions;
  }
}

/** Consume pending work staged by the v14 database migration. */
export async function migrateLegacyScheduleIntents(): Promise<{ queued: number; linked: number; skipped: number; pending: number }> {
  const db = getDb();
  const inboxExists = () => Boolean(db.prepare(`
    SELECT 1 AS found FROM sqlite_master
    WHERE type = 'table' AND name = 'automation_legacy_intents'
  `).get());
  if (!inboxExists()) return { queued: 0, linked: 0, skipped: 0, pending: 0 };
  if (isAutomationMaintenanceActive()) {
    // Another process may finish the one-time migration between the existence
    // check and this read. A vanished inbox means there is no work left here.
    if (!inboxExists()) return { queued: 0, linked: 0, skipped: 0, pending: 0 };
    let pending = 0;
    try {
      pending = Number((db.prepare('SELECT COUNT(*) AS count FROM automation_legacy_intents').get() as { count: number }).count);
    } catch (error) {
      if (!inboxExists()) return { queued: 0, linked: 0, skipped: 0, pending: 0 };
      throw error;
    }
    return { queued: 0, linked: 0, skipped: 0, pending };
  }

  return withAgentOwnershipSnapshot(async (agentIds) => {
  const definitions = allRoutineDefinitions();
  const byLegacyId = new Map<string, RoutineDefinition>();
  const byLegacyShape = new Map<string, RoutineDefinition>();
  for (const routine of definitions) {
    if (routine.parameters?.migratedFrom !== 'agent_schedule') continue;
    const legacyId = typeof routine.parameters.legacyScheduleId === 'string' ? routine.parameters.legacyScheduleId : '';
    const legacyCron = typeof routine.parameters.legacyCron === 'string' ? routine.parameters.legacyCron : '';
    if (legacyId) byLegacyId.set(`${routine.agentId}\0${legacyId}`, routine);
    if (legacyCron) byLegacyShape.set(`${routine.agentId}\0${legacyCron}\0${routine.prompt}`, routine);
  }

  let queued = 0;
  let linked = 0;
  let skipped = 0;
  let rows: LegacyScheduleIntentMigrationRow[] = [];
  let pending = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another process may have consumed and removed the inbox while this one
    // was loading Agent ownership. Recheck after taking SQLite's writer lock.
    if (!inboxExists()) {
      db.exec('COMMIT');
      return { queued: 0, linked: 0, skipped: 0, pending: 0 };
    }
    rows = db.prepare('SELECT * FROM automation_legacy_intents ORDER BY createdAt ASC')
      .all() as unknown as LegacyScheduleIntentMigrationRow[];
    for (const row of rows) {
      try {
        // A linked run/task proves the old worker already dispatched this
        // intent. Keep that durable history and never execute it twice.
        const hasLinkedRun = Boolean(row.runId && db.prepare('SELECT 1 AS found FROM runs WHERE id = ?').get(row.runId));
        const hasLinkedTask = Boolean(row.taskId && db.prepare('SELECT 1 AS found FROM tasks WHERE id = ?').get(row.taskId));
        if (hasLinkedRun || hasLinkedTask) {
          linked++;
        } else if (!agentIds.has(row.agentId)) {
          skipped++;
        } else {
          const matchedRoutine = byLegacyId.get(`${row.agentId}\0${row.scheduleId}`)
            || byLegacyShape.get(`${row.agentId}\0${row.cron}\0${row.instructions}`);
          const routine = matchedRoutine ? getRoutineInternal(matchedRoutine.id) : null;
          if (!routine) {
            // The retired scheduler rechecked the live Agent schedule before
            // dispatch. No matching migrated definition means it was removed,
            // disabled through deletion, or never valid; do not resurrect a
            // recurring external side effect from an orphaned tick.
            skipped++;
          } else {
            const trigger = routine.triggers.find((candidate) => candidate.type === 'schedule')
              || routine.triggers[0];
            const result = enqueueRoutineInvocation({
              routineId: routine.id,
              triggerId: trigger.id,
              triggerType: trigger.type,
              dedupeKey: trigger.type === 'schedule'
                ? `schedule:${trigger.id}:${row.tick}`
                : `legacy-intent:${row.id}`,
              payload: {
                tick: row.tick,
                migratedFrom: 'agent_schedule_intent',
                legacyIntentId: row.id,
                legacyScheduleKey: row.scheduleKey,
              },
              availableAt: row.availableAt,
            });
            if (result.inserted && result.invocation.status === 'pending') queued++;
            else skipped++;
          }
        }
        db.prepare('DELETE FROM automation_legacy_intents WHERE id = ?').run(row.id);
      } catch (error) {
        audit('system', 'legacy schedule intent migration deferred', error instanceof Error ? error.message : String(error), {
          legacyIntentId: row.id,
          agentId: row.agentId,
        });
      }
    }

    pending = Number((db.prepare('SELECT COUNT(*) AS count FROM automation_legacy_intents').get() as { count: number }).count);
    if (pending === 0) db.exec('DROP TABLE IF EXISTS automation_legacy_intents');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }

  if (rows.length > 0) {
    audit('system', 'legacy schedule intents retired', `${queued} queued, ${linked} already linked, ${skipped} skipped, ${pending} pending`);
  }
  if (pending > 0) {
    throw new Error(`${pending} legacy schedule intent${pending === 1 ? '' : 's'} could not be migrated; Automation startup is paused until retry succeeds`);
  }
  return { queued, linked, skipped, pending };
  });
}

export async function scheduleFromAgentTool(agentId: string, when: string, prompt: string): Promise<Record<string, unknown>> {
  if (isAutomationMaintenanceActive()) {
    return {
      ok: false,
      error: `Automations are temporarily paused for maintenance${automationMaintenanceReason() ? `: ${automationMaintenanceReason()}` : ''}. Retry shortly.`,
    };
  }

  const agent = (await loadAgents()).find((candidate) => candidate.id === agentId);
  if (!agent) return { ok: false, error: 'agent not found' };
  const requested = when.trim();
  const instructions = cleanText(prompt, 20_000) || 'Scheduled follow-up task';

  try {
    if (isSupportedAutomationCron(requested)) {
      const routine = await createOwnedRoutine({
        name: cleanText(instructions, 100) || 'Scheduled follow-up',
        description: `Created by schedule_task for ${agent.name}.`,
        agentId,
        prompt: instructions,
        triggers: [{ id: 'schedule', type: 'schedule', enabled: true, cron: requested }],
        retryPolicy: { maxAttempts: 3, baseDelayMs: 5_000, multiplier: 2, maxDelayMs: 5 * 60_000 },
        catchUpPolicy: 'run_once',
        circuitBreaker: { failureThreshold: 3, cooldownSeconds: 900 },
      });
      return { ok: true, type: 'cron', durable: true, routineId: routine.id, cron: requested };
    }

    const fieldCount = requested ? requested.split(/\s+/).length : 0;
    if (fieldCount === 5 || fieldCount === 6) {
      return { ok: false, error: automationCronError(requested) };
    }

    const oneTime = durableOneTimeRoutineDefinition({ agentId, when: requested, prompt: instructions });
    const routine = await createOwnedRoutine(oneTime.definition);
    return {
      ok: true,
      type: 'one_time',
      durable: true,
      routineId: routine.id,
      runAt: oneTime.runAt,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not understand the requested schedule' };
  }
}

export function parseNaturalOneTime(value: string, base = new Date()): Date | null {
  const input = value.trim();
  const relative = input.match(/^in\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit.startsWith('s') ? 1_000 : unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000;
    return new Date(base.getTime() + amount * multiplier);
  }
  const tomorrow = input.match(/^tomorrow(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (tomorrow) {
    const result = new Date(base);
    result.setDate(result.getDate() + 1);
    let hour = Number(tomorrow[1] || 9);
    if (tomorrow[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (tomorrow[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
    result.setHours(hour, Number(tomorrow[2] || 0), 0, 0);
    return result;
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function durableOneTimeRoutineDefinition(input: { agentId: string; when: string; prompt: string }): {
  definition: CreateRoutineInput;
  runAt: string;
} {
  const runAt = parseNaturalOneTime(input.when);
  if (!runAt || runAt.getTime() <= Date.now()) throw new Error('One-time routine must resolve to a future date');
  const at = runAt.toISOString();
  return {
    runAt: at,
    definition: {
      name: cleanText(input.prompt, 100) || 'Scheduled follow-up',
      description: `Created by schedule_task for ${at}`,
      agentId: input.agentId,
      prompt: input.prompt || 'Scheduled follow-up task',
      triggers: [{ id: 'one-time', type: 'one_time', enabled: true, at }],
      catchUpPolicy: 'run_once',
      retryPolicy: { maxAttempts: 3, baseDelayMs: 5_000, multiplier: 2, maxDelayMs: 5 * 60_000 },
    },
  };
}

export function createDurableOneTimeRoutine(input: { agentId: string; when: string; prompt: string }): { routine: RoutineDefinition; runAt: string } {
  const oneTime = durableOneTimeRoutineDefinition(input);
  return { routine: createRoutine(oneTime.definition), runAt: oneTime.runAt };
}

function yamlScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map((item) => {
      if (item && typeof item === 'object') return `${pad}-\n${toYaml(item, indent + 2)}`;
      return `${pad}- ${yamlScalar(item)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    if (!entries.length) return `${pad}{}`;
    return entries.map(([key, item]) => {
      const safeKey = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
      if (item && typeof item === 'object') return `${pad}${safeKey}:\n${toYaml(item, indent + 2)}`;
      return `${pad}${safeKey}: ${yamlScalar(item)}`;
    }).join('\n');
  }
  return `${pad}${yamlScalar(value)}`;
}

export function exportRoutine(id: string, format: 'json' | 'yaml'): string {
  const routine = getRoutine(id);
  if (!routine) throw new Error('Routine not found');
  const definition = { ...routine } as Record<string, unknown>;
  for (const key of ['failureStreak', 'circuitState', 'circuitOpenedAt', 'circuitOpenUntil', 'version', 'createdAt', 'updatedAt']) {
    delete definition[key];
  }
  const portable = {
    schema: 'shiba.routine/v1',
    routine: {
      ...definition,
      triggers: routine.triggers.map((trigger) => trigger.type === 'webhook' ? { ...trigger, secret: '<redacted>' } : trigger),
    },
  };
  return format === 'yaml' ? `${toYaml(portable)}\n` : `${JSON.stringify(portable, null, 2)}\n`;
}
