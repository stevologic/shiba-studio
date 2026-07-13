// Scheduler + inter-agent orchestration for Shiba Studio agents.
// Scoped schedules per agent. Runs in-process using node-cron.

import { randomUUID } from 'node:crypto';
import * as cron from 'node-cron';
import { Agent, normalizeAgent, ScheduleEntry } from './types';
import { loadAgents, mutateAgents } from './persistence';
import { getDb } from './db';
import { automationMaintenanceReason, isAutomationMaintenanceActive } from './automation-maintenance';

type ScheduleIntentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped';

interface ScheduleIntentRow {
  id: string;
  scheduleKey: string;
  tick: string;
  agentId: string;
  agentName: string;
  scheduleId: string;
  cron: string;
  instructions: string;
  status: ScheduleIntentStatus;
  attempt: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  runId: string | null;
  taskId: string | null;
  error: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const scheduleWorkerId = `${process.pid}:${randomUUID()}`;
const initializedIntentHandles = new WeakSet<object>();

function ensureScheduleIntentSchema(): void {
  const db = getDb();
  if (initializedIntentHandles.has(db as object)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_execution_intents (
      id TEXT PRIMARY KEY,
      scheduleKey TEXT NOT NULL,
      tick TEXT NOT NULL,
      agentId TEXT NOT NULL,
      agentName TEXT NOT NULL,
      scheduleId TEXT NOT NULL,
      cron TEXT NOT NULL,
      instructions TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      availableAt TEXT NOT NULL,
      leaseOwner TEXT,
      leaseExpiresAt TEXT,
      runId TEXT,
      taskId TEXT,
      error TEXT,
      result TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      completedAt TEXT,
      UNIQUE(scheduleKey, tick)
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_execution_intents_due
      ON schedule_execution_intents(status, availableAt, createdAt);
    CREATE INDEX IF NOT EXISTS idx_schedule_execution_intents_key
      ON schedule_execution_intents(scheduleKey, status, createdAt);
    CREATE INDEX IF NOT EXISTS idx_schedule_execution_intents_terminal
      ON schedule_execution_intents(status, completedAt DESC);
  `);
  initializedIntentHandles.add(db as object);
}

function enqueueScheduleExecutionIntent(input: {
  scheduleKey: string;
  tick: string;
  agentId: string;
  agentName: string;
  scheduleId: string;
  cron: string;
  instructions: string;
}): { intent: ScheduleIntentRow; inserted: boolean } {
  ensureScheduleIntentSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  let inserted: { changes: number | bigint };
  db.exec('BEGIN IMMEDIATE');
  try {
    // At most one waiting catch-up per schedule. If several ticks arrive while
    // offline or capacity-blocked, the newest replaces older pending work
    // instead of replaying an unbounded stale backlog later.
    db.prepare(`
      UPDATE schedule_execution_intents SET status = 'skipped',
        error = 'Superseded by a newer scheduled tick', updatedAt = ?, completedAt = ?
      WHERE scheduleKey = ? AND status = 'pending' AND tick <> ?
    `).run(now, now, input.scheduleKey, input.tick);
    inserted = db.prepare(`
      INSERT OR IGNORE INTO schedule_execution_intents (
        id, scheduleKey, tick, agentId, agentName, scheduleId, cron, instructions,
        status, attempt, availableAt, leaseOwner, leaseExpiresAt, runId, taskId,
        error, result, createdAt, updatedAt, completedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
    `).run(
      id, input.scheduleKey, input.tick, input.agentId, input.agentName,
      input.scheduleId, input.cron, input.instructions, now, now, now,
    );
    // Keep useful recent diagnostics, but do not let a per-minute scheduler
    // table grow forever.
    db.prepare(`
      DELETE FROM schedule_execution_intents
      WHERE status IN ('succeeded', 'failed', 'skipped')
        AND completedAt IS NOT NULL AND completedAt < ?
    `).run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString());
    db.prepare(`
      DELETE FROM schedule_execution_intents
      WHERE id IN (
        SELECT id FROM schedule_execution_intents
        WHERE status IN ('succeeded', 'failed', 'skipped')
        ORDER BY completedAt DESC LIMIT -1 OFFSET 10000
      )
    `).run();
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  const intent = db.prepare('SELECT * FROM schedule_execution_intents WHERE scheduleKey = ? AND tick = ?')
    .get(input.scheduleKey, input.tick) as unknown as ScheduleIntentRow | undefined;
  if (!intent) throw new Error('Scheduled execution intent could not be persisted');
  return { intent, inserted: Number(inserted.changes) === 1 };
}

/**
 * Shiba schedules intentionally use standard five-field cron expressions.
 * node-cron also accepts a leading seconds field, but durable dedupe and
 * catch-up both operate at minute granularity.
 */
export function isSupportedAutomationCron(expression: unknown): expression is string {
  if (typeof expression !== 'string') return false;
  const value = expression.trim();
  return value.split(/\s+/).length === 5 && cron.validate(value);
}

export function automationCronError(expression: unknown): string | null {
  return isSupportedAutomationCron(expression)
    ? null
    : 'Invalid cron expression. Automations require exactly five fields: minute hour day month weekday.';
}

export function automationTick(scheduledAt: Date): string {
  if (Number.isNaN(scheduledAt.getTime())) throw new Error('Scheduled execution date is invalid');
  return scheduledAt.toISOString().slice(0, 16);
}

/** Cross-process overlap guard backed by the shared run ledger. */
export function isPersistedScheduleStillRunning(agentId: string, scheduleId: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 AS running FROM runs
    WHERE agentId = ? AND scheduleId = ? AND status = 'running'
    LIMIT 1
  `).get(agentId, scheduleId) as { running: number } | undefined;
  return Boolean(row);
}

function retryableScheduleRunError(message: string): boolean {
  return /concurrent-run limit|already active|temporarily paused|maintenance|unreachable|offline|budget.*(reached|exceeded|paused)/i.test(message);
}

function deferScheduleIntent(intent: ScheduleIntentRow, reason: string, delayMs = 15_000): boolean {
  const now = new Date().toISOString();
  const ageMs = Date.now() - Date.parse(intent.createdAt);
  if (intent.attempt >= 20 || ageMs >= 24 * 60 * 60 * 1_000) {
    return finishScheduleIntent(intent, 'failed', `${reason}. Durable retry window exhausted.`);
  }
  const exponential = Math.min(15 * 60_000, Math.max(1_000, delayMs) * Math.pow(2, Math.max(0, intent.attempt - 1)));
  const jitter = ((intent.id.charCodeAt(0) + intent.attempt * 17) % 21) / 100;
  const availableAt = new Date(Date.now() + Math.round(exponential * (1 + jitter))).toISOString();
  const db = getDb();
  let changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const newer = db.prepare(`
      SELECT 1 AS found FROM schedule_execution_intents
      WHERE scheduleKey = ? AND status = 'pending' AND tick > ? LIMIT 1
    `).get(intent.scheduleKey, intent.tick) as { found: number } | undefined;
    if (newer) {
      changed = Number(db.prepare(`
        UPDATE schedule_execution_intents SET status = 'skipped',
          leaseOwner = NULL, leaseExpiresAt = NULL, error = ?, updatedAt = ?, completedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseOwner = ? AND attempt = ?
      `).run('Superseded by a newer scheduled tick', now, now, intent.id, scheduleWorkerId, intent.attempt).changes);
    } else {
      db.prepare(`
        UPDATE schedule_execution_intents SET status = 'skipped',
          error = 'Superseded by a newer scheduled tick', updatedAt = ?, completedAt = ?
        WHERE scheduleKey = ? AND status = 'pending' AND tick < ?
      `).run(now, now, intent.scheduleKey, intent.tick);
      changed = Number(db.prepare(`
        UPDATE schedule_execution_intents SET status = 'pending', availableAt = ?,
          leaseOwner = NULL, leaseExpiresAt = NULL, runId = NULL, taskId = NULL,
          error = ?, updatedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseOwner = ? AND attempt = ?
      `).run(availableAt, reason.slice(0, 20_000), now, intent.id, scheduleWorkerId, intent.attempt).changes);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  return changed === 1;
}

function finishScheduleIntent(
  intent: ScheduleIntentRow,
  status: Extract<ScheduleIntentStatus, 'succeeded' | 'failed' | 'skipped'>,
  message: string,
): boolean {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE schedule_execution_intents SET status = ?, result = ?, error = ?,
      leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
    WHERE id = ? AND status = 'processing' AND leaseOwner = ? AND attempt = ?
  `).run(
    status,
    status === 'succeeded' ? message.slice(0, 50_000) : null,
    status === 'succeeded' ? null : message.slice(0, 20_000),
    now, now, intent.id, scheduleWorkerId, intent.attempt,
  );
  return Number(result.changes) === 1;
}

function recoverExpiredScheduleIntents(at = new Date()): number {
  ensureScheduleIntentSchema();
  const db = getDb();
  const now = at.toISOString();
  const rows = db.prepare(`
    SELECT * FROM schedule_execution_intents
    WHERE status = 'processing' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?
    ORDER BY updatedAt ASC
  `).all(now) as unknown as ScheduleIntentRow[];
  let recovered = 0;
  for (const intent of rows) {
    const run = intent.runId
      ? db.prepare('SELECT status, finalOutput FROM runs WHERE id = ?').get(intent.runId) as { status: string; finalOutput: string | null } | undefined
      : undefined;
    if (run?.status === 'running') {
      // The agent-run lease reconciler owns deciding whether this exact run is
      // still alive. Do not create a duplicate while its durable row is live.
      const extended = db.prepare(`
        UPDATE schedule_execution_intents SET leaseExpiresAt = ?, updatedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseExpiresAt <= ?
      `).run(new Date(at.getTime() + 60_000).toISOString(), now, intent.id, now);
      recovered += Number(extended.changes);
      continue;
    }
    if (run?.status === 'completed') {
      const completed = db.prepare(`
        UPDATE schedule_execution_intents SET status = 'succeeded', result = ?, error = NULL,
          leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseExpiresAt <= ?
      `).run((run.finalOutput || '').slice(0, 50_000), now, now, intent.id, now);
      recovered += Number(completed.changes);
      continue;
    }
    if (run?.status === 'error' && !retryableScheduleRunError(run.finalOutput || '')) {
      const failed = db.prepare(`
        UPDATE schedule_execution_intents SET status = 'failed', error = ?, result = NULL,
          leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
        WHERE id = ? AND status = 'processing' AND leaseExpiresAt <= ?
      `).run((run.finalOutput || 'Scheduled run failed').slice(0, 20_000), now, now, intent.id, now);
      recovered += Number(failed.changes);
      continue;
    }
    const reset = db.prepare(`
      UPDATE schedule_execution_intents SET status = 'pending', availableAt = ?,
        leaseOwner = NULL, leaseExpiresAt = NULL, runId = NULL, taskId = NULL,
        error = ?, updatedAt = ?
      WHERE id = ? AND status = 'processing' AND leaseExpiresAt <= ?
    `).run(now, run?.finalOutput?.slice(0, 20_000) || 'Worker stopped before scheduled execution began; retrying', now, intent.id, now);
    recovered += Number(reset.changes);
  }
  return recovered;
}

function claimScheduleExecutionIntents(limit = 4): ScheduleIntentRow[] {
  ensureScheduleIntentSchema();
  recoverExpiredScheduleIntents();
  const db = getDb();
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + 90_000).toISOString();
  const claimed: ScheduleIntentRow[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const candidates = db.prepare(`
      WITH ranked AS (
        SELECT i.id, ROW_NUMBER() OVER (
          PARTITION BY i.scheduleKey ORDER BY i.availableAt ASC, i.createdAt ASC
        ) AS keyRank
        FROM schedule_execution_intents i
        WHERE i.status = 'pending' AND i.availableAt <= ?
          AND NOT EXISTS (
            SELECT 1 FROM schedule_execution_intents active
            WHERE active.scheduleKey = i.scheduleKey AND active.status = 'processing'
              AND active.leaseExpiresAt IS NOT NULL AND active.leaseExpiresAt > ?
          )
      )
      SELECT id FROM ranked WHERE keyRank = 1 LIMIT ?
    `).all(now, now, Math.max(1, Math.min(20, Math.floor(limit)))) as Array<{ id: string }>;
    for (const candidate of candidates) {
      const before = db.prepare('SELECT attempt FROM schedule_execution_intents WHERE id = ?')
        .get(candidate.id) as { attempt: number } | undefined;
      if (!before) continue;
      const attempt = before.attempt + 1;
      const runId = randomUUID();
      const taskId = `schedule:${candidate.id}:${attempt}`;
      const updated = db.prepare(`
        UPDATE schedule_execution_intents SET status = 'processing', attempt = ?,
          leaseOwner = ?, leaseExpiresAt = ?, runId = ?, taskId = ?, error = NULL, updatedAt = ?
        WHERE id = ? AND status = 'pending' AND availableAt <= ?
      `).run(attempt, scheduleWorkerId, leaseExpiresAt, runId, taskId, now, candidate.id, now);
      if (Number(updated.changes) !== 1) continue;
      claimed.push(db.prepare('SELECT * FROM schedule_execution_intents WHERE id = ?')
        .get(candidate.id) as unknown as ScheduleIntentRow);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  return claimed;
}

async function runScheduledAgent(
  agent: Agent,
  prompt: string,
  opts?: {
    scheduled?: boolean;
    scheduleId?: string;
    scheduleInstructions?: string;
    taskId?: string;
    runId?: string;
    attemptNo?: number;
  },
) {
  if (isAutomationMaintenanceActive()) throw new Error(schedulerMaintenanceMessage());
  const { runAgentOnce } = await import('./agent-runtime');
  if (isAutomationMaintenanceActive()) throw new Error(schedulerMaintenanceMessage());
  return runAgentOnce(agent, prompt, opts);
}

function schedulerMaintenanceMessage(): string {
  const reason = automationMaintenanceReason();
  return `Automations are temporarily paused for maintenance${reason ? `: ${reason}` : ''}. Retry shortly.`;
}

// Scheduler state MUST live on globalThis: Next bundles this module into
// several separate graphs (instrumentation.ts, each API route), and per-copy
// maps meant each copy armed its own cron task for every schedule — the cause
// of automations firing twice on the same tick. One shared map lets any
// copy's resync stop tasks armed by another.
interface SchedulerGlobals {
  __shibaCronTasks?: Map<string, cron.ScheduledTask>;
  __shibaCronAgents?: Map<string, Agent>;
  __shibaCronResync?: Promise<void>;
  __shibaCronInit?: Promise<void>;
  __shibaCronInterval?: ReturnType<typeof setInterval>;
  __shibaCronGeneration?: number;
  __shibaCronStopped?: boolean;
  __shibaCronFires?: Set<Promise<void>>;
  __shibaScheduleIntentInterval?: ReturnType<typeof setInterval>;
  __shibaScheduleIntentPump?: Promise<void>;
}
const g = globalThis as unknown as SchedulerGlobals;
const tasks: Map<string, cron.ScheduledTask> = g.__shibaCronTasks ?? (g.__shibaCronTasks = new Map());
const agentMap: Map<string, Agent> = g.__shibaCronAgents ?? (g.__shibaCronAgents = new Map());
const activeScheduleFires = g.__shibaCronFires ?? (g.__shibaCronFires = new Set());
g.__shibaCronGeneration ??= 0;
g.__shibaCronStopped ??= false;

function trackScheduleWork<T>(work: () => Promise<T>): Promise<T> {
  let markComplete!: () => void;
  const completion = new Promise<void>((resolve) => { markComplete = resolve; });
  activeScheduleFires.add(completion);
  return Promise.resolve()
    .then(work)
    .finally(() => {
      activeScheduleFires.delete(completion);
      markComplete();
    });
}

function schedulerFenceActive(generation: number): boolean {
  return isAutomationMaintenanceActive()
    || Boolean(g.__shibaCronStopped)
    || generation !== g.__shibaCronGeneration;
}

async function dispatchScheduleIntent(intent: ScheduleIntentRow, generation: number): Promise<void> {
  const defer = (reason: string, delayMs?: number) => { deferScheduleIntent(intent, reason, delayMs); };
  if (schedulerFenceActive(generation)) {
    defer(schedulerMaintenanceMessage(), 5_000);
    return;
  }
  try {
    const live = (await loadAgents()).find((candidate) => candidate.id === intent.agentId);
    if (schedulerFenceActive(generation)) {
      defer(schedulerMaintenanceMessage(), 5_000);
      return;
    }
    if (!live) {
      finishScheduleIntent(intent, 'skipped', 'Agent was deleted before the scheduled execution began');
      return;
    }
    const agent = normalizeAgent(live);
    const schedule = agent.schedules.find((entry) => entry.id === intent.scheduleId);
    if (!schedule?.enabled) {
      finishScheduleIntent(intent, 'skipped', 'Schedule was removed or disabled before execution began');
      return;
    }

    const [guards, { loadConfig }, { parseModelRef }] = await Promise.all([
      import('./run-guards'),
      import('./persistence'),
      import('./model-providers'),
    ]);
    if (schedulerFenceActive(generation)) {
      defer(schedulerMaintenanceMessage(), 5_000);
      return;
    }
    if (guards.isScheduleStillRunning(intent.scheduleKey)
      || isPersistedScheduleStillRunning(intent.agentId, intent.scheduleId)) {
      defer('Previous scheduled run is still in progress', 15_000);
      return;
    }
    const config = await loadConfig();
    if (schedulerFenceActive(generation)) {
      defer(schedulerMaintenanceMessage(), 5_000);
      return;
    }
    if (guards.activeRunCount() >= guards.maxConcurrentRuns(config)) {
      defer('Concurrent-run capacity is currently full', 10_000);
      return;
    }
    const modelRef = parseModelRef(agent.model);
    const spendError = await guards.checkSpendGuard(config, modelRef.provider !== 'cloud');
    if (schedulerFenceActive(generation)) {
      defer(schedulerMaintenanceMessage(), 5_000);
      return;
    }
    if (spendError) {
      defer(spendError, 60_000);
      return;
    }
    if (modelRef.provider === 'cloud') {
      const reach = await guards.cloudReachable();
      if (schedulerFenceActive(generation)) {
        defer(schedulerMaintenanceMessage(), 5_000);
        return;
      }
      if (!reach.ok) {
        defer('api.x.ai is unreachable; scheduled execution will retry', 30_000);
        return;
      }
    }

    if (schedulerFenceActive(generation)) {
      defer(schedulerMaintenanceMessage(), 5_000);
      return;
    }
    const run = await runScheduledAgent(agent, intent.instructions, {
      scheduled: true,
      scheduleId: intent.scheduleId,
      scheduleInstructions: intent.instructions,
      taskId: intent.taskId || undefined,
      runId: intent.runId || undefined,
      attemptNo: intent.attempt,
    });
    if (run.status === 'completed') {
      finishScheduleIntent(intent, 'succeeded', run.finalOutput || 'Scheduled execution completed');
    } else if (retryableScheduleRunError(run.finalOutput || '')) {
      defer(run.finalOutput || 'Scheduled execution was temporarily refused', 15_000);
    } else {
      finishScheduleIntent(intent, 'failed', run.finalOutput || 'Scheduled execution failed');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const persistedRun = intent.runId
      ? getDb().prepare('SELECT status, finalOutput FROM runs WHERE id = ?').get(intent.runId) as { status: string; finalOutput: string | null } | undefined
      : undefined;
    if (persistedRun?.status === 'completed') {
      finishScheduleIntent(intent, 'succeeded', persistedRun.finalOutput || 'Scheduled execution completed');
    } else if (persistedRun?.status === 'error' && !retryableScheduleRunError(persistedRun.finalOutput || message)) {
      finishScheduleIntent(intent, 'failed', persistedRun.finalOutput || message);
    } else {
      defer(persistedRun?.finalOutput || message, 15_000);
    }
  }
}

async function processScheduleExecutionIntents(generation: number, limit = 4): Promise<number> {
  if (schedulerFenceActive(generation)) return 0;
  const claimed = claimScheduleExecutionIntents(limit);
  await Promise.all(claimed.map((intent) => dispatchScheduleIntent(intent, generation)));
  return claimed.length;
}

function runScheduleIntentPump(generation: number): void {
  if (schedulerFenceActive(generation) || g.__shibaScheduleIntentPump) return;
  const promise = trackScheduleWork(async () => {
    await processScheduleExecutionIntents(generation);
  }).catch((error) => {
    console.error('[scheduler] durable intent pump failed', error);
  }).finally(() => {
    if (g.__shibaScheduleIntentPump === promise) g.__shibaScheduleIntentPump = undefined;
  });
  g.__shibaScheduleIntentPump = promise;
}

export const schedulerRuntimeTestHooks = {
  ensureScheduleIntentSchema,
  enqueueScheduleExecutionIntent,
  claimScheduleExecutionIntents,
  recoverExpiredScheduleIntents,
  deferScheduleIntent,
  list: () => {
    ensureScheduleIntentSchema();
    return getDb().prepare('SELECT * FROM schedule_execution_intents ORDER BY createdAt ASC')
      .all() as unknown as ScheduleIntentRow[];
  },
};

async function fireScheduledAgent(
  agent: Agent,
  entry: ScheduleEntry,
  taskKey: string,
  generation: number,
  scheduledAt: Date,
): Promise<void> {
  if (schedulerFenceActive(generation)) return;
  // Deleted agents must never fire: re-verify existence at trigger time.
  const live = (await loadAgents()).find((candidate) => candidate.id === agent.id);
  if (schedulerFenceActive(generation)) return;
  if (!live) {
    console.log(`[scheduler] agent ${agent.name} (${agent.id}) no longer exists — retiring schedule ${entry.id}`);
    const stale = tasks.get(taskKey);
    if (stale) { try { stale.stop(); } catch { /* already stopped */ } tasks.delete(taskKey); }
    const { audit } = await import('./audit-log');
    if (schedulerFenceActive(generation)) return;
    audit('run', 'schedule retired', `${agent.name}: agent deleted — automation stopped`, {
      agentId: agent.id,
      scheduleId: entry.id,
    });
    return;
  }
  const currentAgent = normalizeAgent(live);
  const currentEntry = currentAgent.schedules.find((candidate) => candidate.id === entry.id);
  // A callback already queued when a resync stopped its old cron task must not
  // fire a removed, disabled, or rescheduled definition.
  if (!currentEntry?.enabled || currentEntry.cron !== entry.cron || !isSupportedAutomationCron(currentEntry.cron)) return;
  if (schedulerFenceActive(generation)) return;

  // Persist the minute as recoverable work before any fallible guard, import,
  // or agent startup. The unique key is both the cross-process tick claim and
  // the durable retry identity.
  const tick = automationTick(scheduledAt);
  const queued = enqueueScheduleExecutionIntent({
    scheduleKey: taskKey,
    tick,
    agentId: currentAgent.id,
    agentName: currentAgent.name,
    scheduleId: currentEntry.id,
    cron: currentEntry.cron,
    instructions: currentEntry.instructions,
  });
  if (!queued.inserted) {
    console.log(`[scheduler] tick ${tick} for ${agent.name}/${entry.id} already has a durable execution intent`);
  }
  if (schedulerFenceActive(generation)) return;
  await processScheduleExecutionIntents(generation);
}

export function initScheduler(): Promise<void> {
  if (isAutomationMaintenanceActive()) return Promise.resolve();
  ensureScheduleIntentSchema();
  g.__shibaCronStopped = false;
  const generation = g.__shibaCronGeneration ?? 0;
  // Periodically resync (in case agents change) — one interval per process,
  // no matter how many module copies or /api/boot hits call this.
  if (!g.__shibaCronInterval) {
    g.__shibaCronInterval = setInterval(() => {
      loadAndScheduleAll().catch((error) => {
        console.error('[scheduler] periodic schedule reload failed', error);
      });
    }, 1000 * 60 * 4);
    g.__shibaCronInterval.unref?.();
  }
  if (!g.__shibaScheduleIntentInterval) {
    runScheduleIntentPump(generation);
    g.__shibaScheduleIntentInterval = setInterval(() => {
      runScheduleIntentPump(generation);
    }, 5_000);
    g.__shibaScheduleIntentInterval.unref?.();
  }
  // Instrumentation and /api/boot can race during the first request. Share
  // the same initial arm instead of immediately doing a second stop/re-arm.
  if (!g.__shibaCronInit) {
    const initial = loadAndScheduleAll();
    g.__shibaCronInit = initial.catch((error) => {
      g.__shibaCronInit = undefined;
      throw error;
    });
  }
  return g.__shibaCronInit;
}

/** Resyncs are serialized — two callers interleaving stop-all/arm-all (e.g.
 *  an agent save racing a page-load /api/boot) could otherwise overwrite a
 *  just-armed task in the map without stopping it, leaving a duplicate. */
export function loadAndScheduleAll(): Promise<void> {
  if (isAutomationMaintenanceActive() || g.__shibaCronStopped) return Promise.resolve();
  const generation = g.__shibaCronGeneration ?? 0;
  const resync = () => resyncAllSchedules(generation);
  const next = (g.__shibaCronResync ?? Promise.resolve()).then(resync, resync);
  g.__shibaCronResync = next.catch(() => {});
  return next;
}

async function resyncAllSchedules(generation: number) {
  let agents = await loadAgents();
  // A backup restore or shutdown can stop scheduling while loadAgents is in
  // flight. Never let that stale resync re-arm tasks after the stop returns.
  if (isAutomationMaintenanceActive() || g.__shibaCronStopped || generation !== g.__shibaCronGeneration) return;
  // Normalize legacy single-schedule agents to multi + skills for compatibility
  agents = agents.map(normalizeAgent);
  // Clean any accumulated 'manual' entries to prevent bad cron spam and clutter (fix accumulation bug)
  agents = agents.map(a => {
    if (a.schedules && Array.isArray(a.schedules)) {
      a.schedules = a.schedules.filter((s: ScheduleEntry) => s.cron && !String(s.cron).includes('manual'));
    }
    return a;
  });
  agentMap.clear();
  for (const a of agents) agentMap.set(a.id, a);

  // Stop all existing first for clean resync on edits
  for (const [id, task] of tasks) {
    try { task.stop(); } catch {}
    tasks.delete(id);
  }

  for (const agent of agents) {
    const scheds: ScheduleEntry[] = agent.schedules || [];
    for (const entry of scheds) {
      if (!entry.enabled || !entry.cron || String(entry.cron).includes('manual')) continue;
      const taskKey = `${agent.id}:${entry.id}`;
      if (!isSupportedAutomationCron(entry.cron)) {
        console.error('bad cron for', agent.name, entry.cron, entry.id, automationCronError(entry.cron));
        continue;
      }
      try {
        const task = cron.schedule(entry.cron, (context) => {
          if (schedulerFenceActive(generation)) return;
          return trackScheduleWork(() => fireScheduledAgent(agent, entry, taskKey, generation, context.date))
            .catch((error) => {
              console.error('scheduled run error', error);
            });
        });
        // Defensive: never orphan a still-running task under the same key.
        const existing = tasks.get(taskKey);
        if (existing) { try { existing.stop(); } catch { /* already stopped */ } }
        tasks.set(taskKey, task);
      } catch {
        console.error('bad cron for', agent.name, entry.cron, entry.id);
      }
    }
  }
}

export function scheduleAgentNow(agent: Agent, scheduleId?: string) {
  if (isAutomationMaintenanceActive()) {
    throw new Error(schedulerMaintenanceMessage());
  }
  // Run immediately using schedule-specific instructions if scheduleId provided or first enabled.
  // This makes schedule instructions for 'manual scheduler trigger' reachable (fix dead code gap).
  const ag = normalizeAgent(agent);
  let entry = scheduleId ? (ag.schedules || []).find((s: ScheduleEntry) => s.id === scheduleId) : null;
  if (!entry) entry = (ag.schedules || []).find((s: ScheduleEntry) => s.enabled);
  const prompt = entry ? entry.instructions : `Manual trigger from scheduler UI at ${new Date().toISOString()}`;
  const sid = entry ? entry.id : undefined;
  return trackScheduleWork(() => runScheduledAgent(ag, prompt, {
    scheduled: true,
    scheduleId: sid,
    scheduleInstructions: entry ? entry.instructions : undefined,
  }));
}

export async function updateAgentSchedule(agentId: string, cronExpr: string, enabled: boolean) {
  const validationError = automationCronError(cronExpr);
  if (validationError) throw new Error(validationError);
  // Legacy support: add/update a schedule entry (use first or create)
  const updated = await mutateAgents((agents) => {
    const idx = agents.findIndex(a => a.id === agentId);
    if (idx === -1) return false;
    const ag = normalizeAgent(agents[idx]);
    agents[idx] = ag;
    if (ag.schedules.length === 0) {
      ag.schedules.push({ id: 'sch-legacy', enabled, cron: cronExpr, instructions: ag.description || 'Scheduled task', description: '' });
    } else {
      // update first
      ag.schedules[0] = { ...ag.schedules[0], enabled, cron: cronExpr };
    }
    return true;
  });
  if (!updated) return;

  // resync all
  await loadAndScheduleAll();
}

export function listScheduled() {
  return Array.from(tasks.keys());
}

/** Stop all cron tasks — used by verification scripts so the process can exit cleanly. */
export async function stopAllScheduledTasks(): Promise<void> {
  g.__shibaCronStopped = true;
  g.__shibaCronGeneration = (g.__shibaCronGeneration ?? 0) + 1;
  if (g.__shibaCronInterval) clearInterval(g.__shibaCronInterval);
  g.__shibaCronInterval = undefined;
  if (g.__shibaScheduleIntentInterval) clearInterval(g.__shibaScheduleIntentInterval);
  g.__shibaScheduleIntentInterval = undefined;
  g.__shibaCronInit = undefined;
  await g.__shibaCronResync?.catch(() => {});
  for (const [, task] of tasks) {
    try {
      task.stop();
    } catch {
      /* ignore */
    }
  }
  tasks.clear();
  agentMap.clear();
  await g.__shibaScheduleIntentPump?.catch(() => {});
  await Promise.allSettled([...activeScheduleFires]);
}

// Support for schedule_task tool: durable one-time routines or legacy cron entries.
export async function scheduleFromAgentTool(agentId: string, when: string, prompt: string) {
  if (isAutomationMaintenanceActive()) {
    return { ok: false, error: schedulerMaintenanceMessage() };
  }
  let agents = await loadAgents();
  agents = agents.map(normalizeAgent);
  const ag = agents.find(a => a.id === agentId);
  if (!ag) return { ok: false, error: 'agent not found' };

  const instructions = prompt || 'Scheduled follow-up task';

  // Treat as cron string: add as enabled schedule entry
  if (when && cron.validate(when) && !isSupportedAutomationCron(when)) {
    return { ok: false, error: automationCronError(when)! };
  }
  if (isSupportedAutomationCron(when)) {
    const entry: ScheduleEntry = { id: 'sch-tool-' + Date.now(), enabled: true, cron: when, instructions, description: (prompt || '').slice(0, 80) };
    const scheduled = await mutateAgents((current) => {
      const idx = current.findIndex((agent) => agent.id === agentId);
      if (idx < 0) return false;
      const live = normalizeAgent(current[idx]);
      live.schedules.push(entry);
      current[idx] = live;
      return true;
    });
    if (!scheduled) return { ok: false, error: 'agent not found' };
    await loadAndScheduleAll();
    return { ok: true, type: 'cron', cron: when };
  }

  // Relative, ISO, and small natural-language forms become durable one-time
  // routines. The SQLite trigger + invocation survive process restarts.
  try {
    const { createDurableOneTimeRoutine } = await import('./routines');
    const created = createDurableOneTimeRoutine({ agentId, when, prompt: instructions });
    return {
      ok: true,
      type: 'one_time',
      durable: true,
      routineId: created.routine.id,
      runAt: created.runAt,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not understand the requested schedule' };
  }
}
