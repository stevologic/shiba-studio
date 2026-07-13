import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as cron from 'node-cron';
import { getDb } from './db';
import { emitAppEvent } from './app-events';
import { audit } from './audit-log';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secure-store';
import { getTask, requestTaskAttention } from './task-ledger';
import type {
  CreateRoutineInput,
  RoutineCondition,
  RoutineDefinition,
  RoutineInvocation,
  RoutineStep,
  RoutineTrigger,
  RoutineTriggerType,
} from './routine-types';

const REDACTED_SECRET = '••••••••';
const ROUTINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const workerId = `${process.pid}:${randomUUID()}`;

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
      if (!cron.validate(expression)) throw new Error(`Invalid cron expression for trigger ${id}`);
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
  try {
    getDb().prepare(`
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
  } catch (error) {
    if (/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw new Error('Routine id already exists');
    throw error;
  }
  initializeScheduleState(routine);
  audit('run', 'routine created', routine.name, { routineId: routine.id, triggers: routine.triggers.map((trigger) => trigger.type) });
  emitAppEvent('routines');
  void syncRoutineSchedules();
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
  const result = getDb().prepare(`
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
  const nextById = new Map(merged.triggers.map((trigger) => [trigger.id, trigger]));
  const resetTriggerIds = new Set<string>();
  for (const trigger of current.triggers) {
    const next = nextById.get(trigger.id);
    if (!next || JSON.stringify(trigger) !== JSON.stringify(next)) resetTriggerIds.add(trigger.id);
  }
  for (const trigger of merged.triggers) {
    if (!current.triggers.some((candidate) => candidate.id === trigger.id)) resetTriggerIds.add(trigger.id);
  }
  if (resetTriggerIds.size) {
    for (const triggerId of resetTriggerIds) {
      getDb().prepare('DELETE FROM routine_trigger_state WHERE routineId = ? AND triggerId = ?').run(current.id, triggerId);
    }
  }
  initializeScheduleState(merged, resetTriggerIds);
  emitAppEvent('routines');
  void syncRoutineSchedules();
  return getRoutine(current.id)!;
}

export function deleteRoutine(id: string, expectedVersion: number): void {
  const current = getRoutine(id);
  if (!current) throw new Error('Routine not found');
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE routines SET enabled = 0, deletedAt = ?, updatedAt = ?, version = version + 1
    WHERE id = ? AND version = ? AND deletedAt IS NULL
  `).run(now, now, current.id, expectedVersion);
  if (Number(result.changes) !== 1) throw new Error('Routine changed concurrently; reload and retry');
  audit('run', 'routine deleted', current.name, { routineId: current.id });
  emitAppEvent('routines');
  void syncRoutineSchedules();
}

export function resetRoutineCircuit(id: string, expectedVersion: number): RoutineDefinition {
  const current = getRoutine(id);
  if (!current) throw new Error('Routine not found');
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE routines SET failureStreak = 0, circuitState = 'closed', circuitOpenedAt = NULL,
      circuitOpenUntil = NULL, version = version + 1, updatedAt = ?
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
}): { invocation: RoutineInvocation; inserted: boolean } {
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
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO routine_invocations (
      id, routineId, triggerId, triggerType, dedupeKey, concurrencyKey, status,
      payload, attempt, maxAttempts, availableAt, leaseOwner, leaseExpiresAt,
      taskId, error, result, createdAt, updatedAt, completedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?)
  `).run(
    id, routine.id, triggerId, input.triggerType, dedupeKey, cleanText(concurrencyKey, 300, true), status,
    payloadJson, routine.retryPolicy.maxAttempts, now, reason || null, now, now, status === 'skipped' ? now : null,
  );
  const row = db.prepare('SELECT * FROM routine_invocations WHERE routineId = ? AND dedupeKey = ?')
    .get(routine.id, dedupeKey) as unknown as InvocationRow;
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
  ensureRoutineSchema();
  const db = getDb();
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + Math.max(10_000, leaseMs)).toISOString();
  const claimed: RoutineInvocation[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE routine_invocations SET status = 'pending', leaseOwner = NULL, leaseExpiresAt = NULL,
        availableAt = ?, updatedAt = ?, error = COALESCE(error, 'Worker lease expired; retrying')
      WHERE status = 'processing' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt < ?
    `).run(now, now, now);
    db.prepare(`
      UPDATE routines SET circuitState = 'closed', circuitOpenedAt = NULL, circuitOpenUntil = NULL,
        failureStreak = 0, version = version + 1, updatedAt = ?
      WHERE circuitState = 'open' AND circuitOpenUntil IS NOT NULL AND circuitOpenUntil <= ?
    `).run(now, now);
    const candidates = db.prepare(`
      SELECT i.* FROM routine_invocations i
      JOIN routines r ON r.id = i.routineId
      WHERE i.status = 'pending' AND i.availableAt <= ? AND r.enabled = 1
        AND r.deletedAt IS NULL AND r.circuitState = 'closed'
      ORDER BY i.availableAt ASC, i.createdAt ASC LIMIT ?
    `).all(now, clampInt(limit, 10, 1, 100) * 4) as unknown as InvocationRow[];
    for (const candidate of candidates) {
      if (claimed.length >= limit) break;
      const busy = db.prepare(`
        SELECT 1 AS busy FROM routine_invocations
        WHERE concurrencyKey = ? AND status = 'processing'
          AND (leaseExpiresAt IS NULL OR leaseExpiresAt >= ?) LIMIT 1
      `).get(candidate.concurrencyKey, now) as { busy: number } | undefined;
      if (busy) continue;
      const result = db.prepare(`
        UPDATE routine_invocations SET status = 'processing', attempt = attempt + 1,
          leaseOwner = ?, leaseExpiresAt = ?, updatedAt = ?, error = NULL
        WHERE id = ? AND status = 'pending'
      `).run(workerId, leaseExpiresAt, now, candidate.id);
      if (Number(result.changes) !== 1) continue;
      claimed.push(rowToInvocation(db.prepare('SELECT * FROM routine_invocations WHERE id = ?').get(candidate.id) as unknown as InvocationRow));
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  if (claimed.length) emitAppEvent('routines');
  return claimed;
}

function retryDelay(routine: RoutineDefinition, attempt: number): number {
  return Math.min(
    routine.retryPolicy.maxDelayMs,
    Math.round(routine.retryPolicy.baseDelayMs * Math.pow(routine.retryPolicy.multiplier, Math.max(0, attempt - 1))),
  );
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
          circuitOpenUntil = NULL, version = version + 1, updatedAt = ? WHERE id = ?
      `).run(now, routine.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
      throw error;
    }
  } else if (invocation.attempt < invocation.maxAttempts) {
    const availableAt = new Date(Date.now() + retryDelay(routine, invocation.attempt)).toISOString();
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
      db.prepare('UPDATE routines SET failureStreak = failureStreak + 1, version = version + 1, updatedAt = ? WHERE id = ?')
        .run(now, routine.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
      throw error;
    }
    const failedRoutine = getRoutineInternal(routine.id)!;
    if (failedRoutine.failureStreak >= failedRoutine.circuitBreaker.failureThreshold) {
      const openUntil = new Date(Date.now() + failedRoutine.circuitBreaker.cooldownSeconds * 1_000).toISOString();
      const opened = db.prepare(`
        UPDATE routines SET circuitState = 'open', circuitOpenedAt = ?, circuitOpenUntil = ?,
          version = version + 1, updatedAt = ? WHERE id = ? AND circuitState = 'closed'
      `).run(now, openUntil, now, failedRoutine.id);
      if (Number(opened.changes) === 1 && invocation.taskId && getTask(invocation.taskId)) {
        requestTaskAttention({
          taskId: invocation.taskId,
          kind: 'failure',
          severity: 'critical',
          title: `${failedRoutine.name} circuit breaker opened`,
          body: `${failedRoutine.failureStreak} consecutive routine invocations failed. Automatic runs are paused until ${openUntil}.`,
          dedupeKey: `routine-circuit:${failedRoutine.id}`,
          action: { taskId: invocation.taskId, routineId: failedRoutine.id },
        });
      }
    }
  }
  audit('run', outcome.ok ? 'routine invocation succeeded' : 'routine invocation failed', routine.name, {
    routineId: routine.id, invocationId: invocation.id, attempt: invocation.attempt,
  });
  emitAppEvent('routines');
  return rowToInvocation(db.prepare('SELECT * FROM routine_invocations WHERE id = ?').get(invocation.id) as unknown as InvocationRow);
}

function originForTrigger(type: RoutineTriggerType): 'manual' | 'schedule' | 'integration' | 'system' {
  if (type === 'manual') return 'manual';
  if (type === 'schedule' || type === 'one_time') return 'schedule';
  if (type === 'webhook' || type === 'integration_event') return 'integration';
  return 'system';
}

async function executeInvocation(invocation: RoutineInvocation): Promise<string> {
  const routine = getRoutineInternal(invocation.routineId);
  if (!routine) throw new Error('Routine no longer exists');
  const ledger = await import('./task-ledger');
  const parentTaskId = `routine:${invocation.id}:${invocation.attempt}`;
  const orderedSteps = routine.steps.length ? routine.steps : [{ id: 'run', name: routine.name, prompt: routine.prompt, kind: 'work' as const, dependsOn: [] }];
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
      getDb().prepare(`
        UPDATE routine_step_runs SET status = 'succeeded', output = ?, error = NULL, updatedAt = ?
        WHERE invocationId = ? AND stepId = ?
      `).run(priorTask.result || '', nowIso(), invocation.id, step.stepId);
      alreadyComplete.add(step.stepId);
      recovered.set(step.stepId, { ...step, status: 'succeeded', output: priorTask.result || '' });
    }
  }
  const parent = ledger.createTask({
    id: parentTaskId,
    kind: 'routine',
    title: routine.name,
    description: routine.prompt,
    status: 'running',
    originType: originForTrigger(invocation.triggerType),
    originId: routine.id,
    agentId: routine.agentId,
    plan: orderedSteps.map((step) => ({ id: step.id, title: step.name, status: alreadyComplete.has(step.id) ? 'completed' : 'pending' })),
    metadata: { routineId: routine.id, invocationId: invocation.id, triggerId: invocation.triggerId, attempt: invocation.attempt },
  });
  getDb().prepare('UPDATE routine_invocations SET taskId = ?, updatedAt = ? WHERE id = ?')
    .run(parent.id, nowIso(), invocation.id);
  try {
    const { loadAgents } = await import('./persistence');
    const { normalizeAgent } = await import('./types');
    const agent = (await loadAgents()).find((candidate) => candidate.id === routine.agentId);
    if (!agent) throw new Error(`Routine agent ${routine.agentId} was not found`);
    const values = { ...routine.parameters, ...invocation.payload, trigger: invocation.payload };
    const outputs: string[] = [];
    const completed = new Set(alreadyComplete);
    const deadline = Date.now() + routine.timeoutMs;
    for (const [index, step] of orderedSteps.entries()) {
      if (!(step.dependsOn || []).every((dependency) => completed.has(dependency))) {
        throw new Error(`Dependencies for step ${step.name} did not complete`);
      }
      if (completed.has(step.id)) {
        const output = recovered.get(step.id)?.output;
        if (output) outputs.push(output);
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(`Routine timed out after ${routine.timeoutMs}ms`);
      ledger.heartbeatTask(parent.id, {
        progress: index / orderedSteps.length,
        currentStep: step.name,
        nextAction: index + 1 < orderedSteps.length ? orderedSteps[index + 1].name : 'Complete routine',
      });
      const childId = randomUUID();
      const runId = randomUUID();
      const prompt = renderTemplate(
        routine.steps.length ? `${routine.prompt}\n\nRoutine step: ${step.name}\n${step.prompt}` : step.prompt,
        values,
      );
      const child = ledger.createTask({
        id: childId,
        kind: step.kind === 'code' ? 'code' : 'work',
        title: `${routine.name}: ${step.name}`,
        description: prompt,
        parentId: parent.id,
        originType: originForTrigger(invocation.triggerType),
        originId: routine.id,
        agentId: routine.agentId,
        runId,
        metadata: { routineId: routine.id, invocationId: invocation.id, stepId: step.id },
      });
      getDb().prepare(`
        INSERT INTO routine_step_runs (invocationId, stepId, status, attempt, taskId, output, error, updatedAt)
        VALUES (?, ?, 'processing', 1, ?, NULL, NULL, ?)
        ON CONFLICT(invocationId, stepId) DO UPDATE SET
          status = 'processing', attempt = routine_step_runs.attempt + 1,
          taskId = excluded.taskId, output = NULL, error = NULL, updatedAt = excluded.updatedAt
      `).run(invocation.id, step.id, child.id, nowIso());
      const assigned = ledger.assignTaskExecution({ taskId: child.id, runId, agentId: routine.agentId, expectedVersion: child.version });
      ledger.transitionTask({ taskId: child.id, status: 'running', expectedVersion: assigned.version, currentStep: 'Starting routine step' });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`Routine timed out after ${routine.timeoutMs}ms`)), remainingMs);
      try {
        const { runAgentOnce } = await import('./agent-runtime');
        const run = await runAgentOnce(normalizeAgent(agent), prompt, {
          scheduled: true,
          scheduleId: routine.id,
          scheduleInstructions: prompt,
          taskId: child.id,
          runId,
          attemptNo: invocation.attempt,
          signal: controller.signal,
        });
        if (run.status !== 'completed') throw new Error(run.finalOutput || `Routine step ${step.name} failed`);
        const output = run.finalOutput || `${step.name} completed`;
        getDb().prepare(`
          UPDATE routine_step_runs SET status = 'succeeded', output = ?, error = NULL, updatedAt = ?
          WHERE invocationId = ? AND stepId = ?
        `).run(output, nowIso(), invocation.id, step.id);
        outputs.push(output);
        completed.add(step.id);
      } catch (error) {
        getDb().prepare(`
          UPDATE routine_step_runs SET status = 'failed', error = ?, updatedAt = ?
          WHERE invocationId = ? AND stepId = ?
        `).run(error instanceof Error ? error.message.slice(0, 20_000) : String(error).slice(0, 20_000), nowIso(), invocation.id, step.id);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    const result = outputs.join('\n\n');
    ledger.heartbeatTask(parent.id, { progress: 1, currentStep: 'Routine complete', nextAction: '' });
    const current = ledger.getTask(parent.id);
    if (current?.status === 'running') ledger.transitionTask({ taskId: parent.id, status: 'succeeded', result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = ledger.getTask(parent.id);
    if (current?.status === 'running') ledger.transitionTask({ taskId: parent.id, status: 'failed', error: message });
    throw error;
  }
}

export async function processRoutineInvocations(limit = 4): Promise<number> {
  const claimed = claimRoutineInvocations(limit);
  await Promise.all(claimed.map(async (invocation) => {
    const heartbeat = setInterval(() => {
      const now = nowIso();
      const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      getDb().prepare(`
        UPDATE routine_invocations SET leaseExpiresAt = ?, updatedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseOwner = ?
      `).run(leaseExpiresAt, now, invocation.id, workerId);
    }, 20_000);
    try {
      const result = await executeInvocation(invocation);
      finishRoutineInvocation(invocation.id, { ok: true, result }, invocation.attempt);
    } catch (error) {
      finishRoutineInvocation(invocation.id, { ok: false, error: error instanceof Error ? error.message : String(error) }, invocation.attempt);
    } finally {
      clearInterval(heartbeat);
    }
  }));
  return claimed.length;
}

function claimTriggerCheck(routineId: string, triggerId: string, intervalSeconds: number, now: Date): { dueKey: string; state: Record<string, unknown> } | null {
  const db = getDb();
  const current = now.toISOString();
  const next = new Date(now.getTime() + intervalSeconds * 1_000).toISOString();
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
    const result = db.prepare(`
      UPDATE routine_trigger_state SET nextDueAt = ?, lastCheckedAt = ?
      WHERE routineId = ? AND triggerId = ? AND nextDueAt = ?
    `).run(next, current, routineId, triggerId, before.dueAt);
    db.exec('COMMIT');
    return Number(result.changes) === 1 ? { dueKey: before.dueAt, state: parseJson(before.state, {}) } : null;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
}

function saveTriggerState(routineId: string, triggerId: string, state: Record<string, unknown>): void {
  getDb().prepare('UPDATE routine_trigger_state SET state = ? WHERE routineId = ? AND triggerId = ?')
    .run(JSON.stringify(state), routineId, triggerId);
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function replaceCronNames(field: string, names?: Record<string, number>): string {
  if (!names) return field;
  return field.replace(/[A-Za-z]{3}/g, (name) => String(names[name.toLowerCase()] ?? name));
}

function cronFieldMatches(raw: string, value: number, min: number, max: number, names?: Record<string, number>, sunday = false): boolean {
  const field = replaceCronNames(raw.toLowerCase(), names);
  return field.split(',').some((part) => {
    const [base, stepRaw] = part.split('/');
    const step = clampInt(stepRaw, 1, 1, Math.max(1, max - min + 1));
    let start = min;
    let end = max;
    if (base !== '*') {
      const range = base.split('-').map(Number);
      if (range.some((number) => !Number.isInteger(number))) return false;
      start = range[0];
      end = range.length > 1 ? range[1] : range[0];
    }
    const normalizedValue = sunday && value === 0 && end >= 7 ? 7 : value;
    return normalizedValue >= start && normalizedValue <= end && (normalizedValue - start) % step === 0;
  });
}

function cronDateParts(date: Date, timezone?: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  if (!timezone) {
    return {
      minute: date.getMinutes(), hour: date.getHours(), day: date.getDate(),
      month: date.getMonth() + 1, weekday: date.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: '2-digit', hour: '2-digit', hourCycle: 'h23', day: '2-digit', month: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return {
    minute: Number(part('minute')),
    hour: Number(part('hour')),
    day: Number(part('day')),
    month: Number(part('month')),
    weekday: DAY_NAMES[part('weekday').toLowerCase()] ?? 0,
  };
}

/** Five-field cron matcher used only to recover ticks missed while the host was offline. */
function cronMatchesMinute(expression: string, date: Date, timezone?: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const value = cronDateParts(date, timezone);
  return cronFieldMatches(fields[0], value.minute, 0, 59)
    && cronFieldMatches(fields[1], value.hour, 0, 23)
    && cronFieldMatches(fields[2], value.day, 1, 31)
    && cronFieldMatches(fields[3], value.month, 1, 12, MONTH_NAMES)
    && cronFieldMatches(fields[4], value.weekday, 0, 7, DAY_NAMES, true);
}

function latestMissedScheduleTick(trigger: Extract<RoutineTrigger, { type: 'schedule' }>, previous: Date, now: Date): Date | null {
  // Bound recovery work after a very long outage. Catch-up is explicitly one run,
  // so only the newest matching minute matters.
  const floor = Math.max(previous.getTime(), now.getTime() - 7 * 24 * 60 * 60_000);
  let cursor = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const first = Math.floor(floor / 60_000) * 60_000 + 60_000;
  while (cursor.getTime() >= first) {
    if (cronMatchesMinute(trigger.cron, cursor, trigger.timezone)) return cursor;
    cursor = new Date(cursor.getTime() - 60_000);
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

export async function pollRoutineTriggers(at = new Date()): Promise<number> {
  ensureRoutineSchema();
  let queued = 0;
  for (const routine of activeRoutines()) {
    for (const trigger of routine.triggers) {
      if (!trigger.enabled) continue;
      if (trigger.type === 'schedule') {
        const claim = claimTriggerCheck(routine.id, trigger.id, 60, at);
        if (!claim) continue;
        const previousValue = typeof claim.state.lastObservedAt === 'string' ? claim.state.lastObservedAt : undefined;
        saveTriggerState(routine.id, trigger.id, { lastObservedAt: at.toISOString() });
        if (!previousValue) continue;
        const previous = new Date(previousValue);
        if (Number.isNaN(previous.getTime())) continue;
        const missed = latestMissedScheduleTick(trigger, previous, at);
        if (!missed) continue;
        const tick = missed.toISOString().slice(0, 16);
        const skip = routine.catchUpPolicy === 'skip';
        const result = enqueueRoutineInvocation({
          routineId: routine.id,
          triggerId: trigger.id,
          triggerType: trigger.type,
          dedupeKey: `schedule:${trigger.id}:${tick}`,
          payload: { tick, scheduledAt: missed.toISOString(), caughtUpAt: at.toISOString() },
          ...(skip ? { forceStatus: 'skipped' as const, skipReason: 'Missed schedule skipped by catch-up policy' } : {}),
        });
        if (result.inserted && !skip) queued += 1;
      } else if (trigger.type === 'one_time') {
        const due = new Date(trigger.at).getTime();
        if (due > at.getTime()) continue;
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
        if (result.inserted && !skip) queued += 1;
      } else if (trigger.type === 'health') {
        const claim = claimTriggerCheck(routine.id, trigger.id, trigger.intervalSeconds, at);
        if (!claim) continue;
        const status = await healthStatus(trigger);
        saveTriggerState(routine.id, trigger.id, { ...claim.state, healthy: status.healthy, detail: status.detail, checkedAt: at.toISOString() });
        if (!status.healthy) {
          const result = enqueueRoutineInvocation({
            routineId: routine.id,
            triggerId: trigger.id,
            triggerType: trigger.type,
            dedupeKey: `health:${trigger.id}:${claim.dueKey}`,
            payload: { healthy: false, detail: status.detail, checkedAt: at.toISOString(), url: trigger.url, processPid: trigger.processPid },
          });
          if (result.inserted) queued += 1;
        }
      } else if (trigger.type === 'filesystem') {
        const claim = claimTriggerCheck(routine.id, trigger.id, trigger.intervalSeconds, at);
        if (!claim) continue;
        let signature = 'missing';
        try {
          const stat = await fs.stat(trigger.path);
          signature = `${stat.mtimeMs}:${stat.size}:${stat.isDirectory() ? 'dir' : 'file'}`;
        } catch { /* missing is a meaningful state */ }
        const previous = typeof claim.state.signature === 'string' ? claim.state.signature : undefined;
        saveTriggerState(routine.id, trigger.id, { signature, checkedAt: at.toISOString() });
        if (previous !== undefined && previous !== signature) {
          const result = enqueueRoutineInvocation({
            routineId: routine.id,
            triggerId: trigger.id,
            triggerType: trigger.type,
            dedupeKey: `filesystem:${trigger.id}:${claim.dueKey}:${signature}`,
            payload: { path: trigger.path, previousSignature: previous, signature, checkedAt: at.toISOString() },
          });
          if (result.inserted) queued += 1;
        }
      }
    }
  }
  return queued;
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
  __shibaRoutinePumpActive?: boolean;
  __shibaRoutineCrons?: Map<string, cron.ScheduledTask>;
  __shibaRoutineCronSync?: Promise<void>;
}

const engine = globalThis as typeof globalThis & RoutineEngineGlobals;
const routineCrons = engine.__shibaRoutineCrons ?? (engine.__shibaRoutineCrons = new Map());

async function resyncRoutineSchedules(): Promise<void> {
  for (const [, task] of routineCrons) {
    try { task.stop(); } catch { /* already stopped */ }
  }
  routineCrons.clear();
  for (const routine of activeRoutines()) {
    for (const trigger of routine.triggers) {
      if (trigger.type !== 'schedule' || !trigger.enabled) continue;
      const key = `${routine.id}:${trigger.id}`;
      try {
        const task = cron.schedule(trigger.cron, () => {
          const tick = new Date().toISOString().slice(0, 16);
          try {
            enqueueRoutineInvocation({
              routineId: routine.id,
              triggerId: trigger.id,
              triggerType: trigger.type,
              dedupeKey: `schedule:${trigger.id}:${tick}`,
              payload: { tick, firedAt: nowIso() },
            });
          } catch (error) {
            audit('run', 'routine schedule fire failed', error instanceof Error ? error.message : String(error), { routineId: routine.id, triggerId: trigger.id });
          }
        }, trigger.timezone ? { timezone: trigger.timezone } : undefined);
        routineCrons.set(key, task);
      } catch (error) {
        audit('run', 'routine schedule rejected', error instanceof Error ? error.message : String(error), { routineId: routine.id, triggerId: trigger.id });
      }
    }
  }
}

export function syncRoutineSchedules(): Promise<void> {
  const next = (engine.__shibaRoutineCronSync ?? Promise.resolve()).then(resyncRoutineSchedules, resyncRoutineSchedules);
  engine.__shibaRoutineCronSync = next.catch(() => {});
  return next;
}

export function startRoutineEngine(): void {
  ensureRoutineSchema();
  void syncRoutineSchedules();
  if (!engine.__shibaRoutinePoll) {
    void pollRoutineTriggers().catch(() => {});
    engine.__shibaRoutinePoll = setInterval(() => { void pollRoutineTriggers().catch(() => {}); }, 5_000);
  }
  if (!engine.__shibaRoutinePump) {
    engine.__shibaRoutinePump = setInterval(() => {
      if (engine.__shibaRoutinePumpActive) return;
      engine.__shibaRoutinePumpActive = true;
      void processRoutineInvocations().catch(() => {}).finally(() => { engine.__shibaRoutinePumpActive = false; });
    }, 1_000);
  }
}

export async function stopRoutineEngine(): Promise<void> {
  await engine.__shibaRoutineCronSync?.catch(() => {});
  if (engine.__shibaRoutinePoll) clearInterval(engine.__shibaRoutinePoll);
  if (engine.__shibaRoutinePump) clearInterval(engine.__shibaRoutinePump);
  engine.__shibaRoutinePoll = undefined;
  engine.__shibaRoutinePump = undefined;
  engine.__shibaRoutinePumpActive = false;
  for (const [, task] of routineCrons) {
    try { task.stop(); } catch { /* already stopped */ }
  }
  routineCrons.clear();
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

export function createDurableOneTimeRoutine(input: { agentId: string; when: string; prompt: string }): { routine: RoutineDefinition; runAt: string } {
  const runAt = parseNaturalOneTime(input.when);
  if (!runAt || runAt.getTime() <= Date.now()) throw new Error('One-time routine must resolve to a future date');
  const routine = createRoutine({
    name: cleanText(input.prompt, 100) || 'Scheduled follow-up',
    description: `Created by schedule_task for ${runAt.toISOString()}`,
    agentId: input.agentId,
    prompt: input.prompt || 'Scheduled follow-up task',
    triggers: [{ id: 'one-time', type: 'one_time', enabled: true, at: runAt.toISOString() }],
    catchUpPolicy: 'run_once',
    retryPolicy: { maxAttempts: 3, baseDelayMs: 5_000, multiplier: 2, maxDelayMs: 5 * 60_000 },
  });
  return { routine, runAt: runAt.toISOString() };
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
