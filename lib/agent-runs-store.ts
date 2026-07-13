// Agent run persistence on SQLite (node:sqlite). Replaces the one-JSON-file-
// per-run store whose full-directory scans made the dashboard slow; legacy
// files migrate into the DB automatically on first open (see lib/db.ts).

import type { AgentRun, TraceStep } from './types';
import { randomUUID } from 'crypto';
import { getDb } from './db';
import { emitAppEvent } from './app-events';
import { indexRunContext } from './context-engine';
import { isAutomationMaintenanceActive } from './automation-maintenance';

export const RUN_LEASE_HEARTBEAT_MS = 10_000;
export const RUN_LEASE_TIMEOUT_MS = 45_000;
const RUN_LEASE_RECONCILE_MS = 30_000;
const EXPIRED_RUN_OUTPUT = 'Run was interrupted after its execution lease expired.';

interface RunLeaseGlobals {
  __shibaRunOwnerId?: string;
  __shibaRunLeaseReconciler?: ReturnType<typeof setInterval>;
  __shibaRunLeaseReconcilePromise?: Promise<RunLeaseReconciliation>;
}

const leaseGlobals = globalThis as unknown as RunLeaseGlobals;
const runOwnerId = leaseGlobals.__shibaRunOwnerId
  ?? (leaseGlobals.__shibaRunOwnerId = `${process.pid}:${randomUUID()}`);

export interface RunLeaseReconciliation {
  count: number;
  runIds: string[];
}

/** A run without its (potentially huge) trace — what lists and tables need. */
export type AgentRunSummary = Omit<AgentRun, 'trace'> & { traceSteps: number };

interface RunRow {
  id: string;
  taskId?: string | null;
  attemptNo?: number | null;
  agentId: string;
  agentName: string;
  model: string;
  status: string;
  prompt: string;
  startedAt: string;
  completedAt: string | null;
  finalOutput: string | null;
  projectId: string | null;
  scheduleId: string | null;
  scheduleInstructions: string | null;
  sideEffects: string;
  workspaceSnapshot?: string | null;
  trace?: string;
  traceSteps?: number;
  ownerId?: string | null;
  heartbeatAt?: string | null;
}

/** Tolerant parse for the JSON columns: one corrupt/truncated row must not
 *  take down the whole list load (dashboard, automations, run log all read
 *  through these), so bad JSON degrades to an empty array. */
function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function rowToSummary(row: RunRow): AgentRunSummary {
  return {
    id: row.id,
    taskId: row.taskId ?? undefined,
    attemptNo: row.attemptNo ?? undefined,
    agentId: row.agentId,
    agentName: row.agentName,
    model: row.model,
    status: row.status as AgentRun['status'],
    prompt: row.prompt,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    finalOutput: row.finalOutput ?? undefined,
    projectId: row.projectId ?? undefined,
    scheduleId: row.scheduleId ?? undefined,
    scheduleInstructions: row.scheduleInstructions ?? undefined,
    sideEffects: parseJsonArray(row.sideEffects),
    workspaceSnapshot: row.workspaceSnapshot ?? undefined,
    traceSteps: row.traceSteps ?? 0,
  };
}

function rowToRun(row: RunRow): AgentRun {
  return {
    ...rowToSummary(row),
    trace: parseJsonArray(row.trace),
  };
}

export async function persistAgentRun(run: AgentRun): Promise<void> {
  const leaseNow = new Date().toISOString();
  const ownerId = run.status === 'running' ? runOwnerId : null;
  const heartbeatAt = run.status === 'running' ? leaseNow : null;
  const result = getDb()
    .prepare(`
      INSERT INTO runs
        (id, taskId, attemptNo, agentId, agentName, model, status, prompt, startedAt, completedAt,
         finalOutput, projectId, scheduleId, scheduleInstructions, sideEffects,
         workspaceSnapshot, trace, ownerId, heartbeatAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        taskId = COALESCE(excluded.taskId, runs.taskId),
        attemptNo = excluded.attemptNo,
        agentId = excluded.agentId,
        agentName = excluded.agentName,
        model = excluded.model,
        status = excluded.status,
        prompt = excluded.prompt,
        startedAt = excluded.startedAt,
        completedAt = excluded.completedAt,
        finalOutput = excluded.finalOutput,
        projectId = excluded.projectId,
        scheduleId = excluded.scheduleId,
        scheduleInstructions = excluded.scheduleInstructions,
        sideEffects = excluded.sideEffects,
        workspaceSnapshot = excluded.workspaceSnapshot,
        trace = excluded.trace,
        ownerId = excluded.ownerId,
        heartbeatAt = excluded.heartbeatAt
      WHERE runs.status = 'running' AND runs.ownerId = ?
    `)
    .run(
      run.id, run.taskId ?? null, run.attemptNo ?? 1,
      run.agentId, run.agentName, run.model, run.status, run.prompt,
      run.startedAt, run.completedAt ?? null, run.finalOutput ?? null,
      run.projectId ?? null, run.scheduleId ?? null, run.scheduleInstructions ?? null,
      JSON.stringify(run.sideEffects || []), run.workspaceSnapshot ?? null,
      JSON.stringify(run.trace || []), ownerId, heartbeatAt, runOwnerId,
    );
  if (Number(result.changes) !== 1) {
    throw new Error(`Run ${run.id} lease ownership was lost; refusing a stale persistence write.`);
  }
  try {
    const { syncTaskFromRun } = await import('./task-ledger');
    syncTaskFromRun({ ...run, taskId: run.taskId || undefined, attemptNo: run.attemptNo || 1 });
  } catch (error) {
    // The run row above is already committed. Task projection is derived and
    // periodically repairable; never make a caller rewrite/lose an
    // authoritative terminal outcome because this second write failed.
    console.error(`[agent-runs] task projection failed for ${run.id}; reconciliation will retry`, error);
  }
  try {
    indexRunContext(run);
  } catch {
    // Search/context indexing is derived bookkeeping. The durable run and its
    // task projection are already committed and must remain authoritative.
  }
  // Live UI: dashboards refresh the run list the moment a run starts/finishes.
  emitAppEvent('runs');
}

/**
 * Persist a bounded in-flight trace snapshot without re-projecting the whole
 * run into the task ledger or context index. Autonomous workers use this on a
 * throttle so the Automations detail poll can show real progress while the run
 * is still executing. The terminal `persistAgentRun` remains authoritative.
 */
export function persistAgentRunProgress(runId: string, trace: TraceStep[]): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`
      UPDATE runs
      SET trace = ?, ownerId = ?, heartbeatAt = ?
      WHERE id = ? AND status = 'running' AND (ownerId = ? OR ownerId IS NULL)
  `)
    .run(JSON.stringify(trace), runOwnerId, now, runId, runOwnerId);
  // Run detail views already poll their exact row. Broadcasting every trace
  // snapshot would make every open shell reload the full run list each second.
  return Number(result.changes) === 1;
}

/** Refresh ownership for a live run without rewriting its trace. */
export function heartbeatAgentRun(runId: string): boolean {
  const result = getDb()
    .prepare(`
      UPDATE runs SET heartbeatAt = ?
      WHERE id = ? AND status = 'running' AND ownerId = ?
    `)
    .run(new Date().toISOString(), runId, runOwnerId);
  return Number(result.changes) === 1;
}

/** Mark only expired running leases as interrupted and return their exact ids.
 * Recent heartbeats may belong to another live server process. */
export function reconcileExpiredRunLeases(nowMs = Date.now()): RunLeaseReconciliation {
  if (isAutomationMaintenanceActive()) return { count: 0, runIds: [] };
  const db = getDb();
  const completedAt = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - RUN_LEASE_TIMEOUT_MS).toISOString();
  const candidates = db.prepare(`
    SELECT id FROM runs
    WHERE status = 'running' AND COALESCE(heartbeatAt, startedAt) < ?
    ORDER BY startedAt ASC
  `).all(cutoff) as Array<{ id: string }>;
  const reconciled: string[] = [];
  if (candidates.length) {
    const update = db.prepare(`
      UPDATE runs
      SET status = 'error',
          completedAt = ?,
          finalOutput = ?,
          ownerId = NULL,
          heartbeatAt = NULL
      WHERE id = ? AND status = 'running' AND COALESCE(heartbeatAt, startedAt) < ?
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const candidate of candidates) {
        const result = update.run(completedAt, EXPIRED_RUN_OUTPUT, candidate.id, cutoff);
        if (Number(result.changes) === 1) reconciled.push(candidate.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    }
  }
  if (reconciled.length) emitAppEvent('runs');
  // If a process died after reconciling the run but before projecting its task,
  // surface that exact id again. This closes the only crash gap without ever
  // sweeping unrelated running/paused tasks.
  const pendingTaskProjection = db.prepare(`
    SELECT DISTINCT r.id
    FROM runs r
    JOIN tasks t ON t.runId = r.id
    WHERE r.status = 'error' AND r.finalOutput = ?
      AND t.status IN ('queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked')
  `).all(EXPIRED_RUN_OUTPUT) as Array<{ id: string }>;
  const runIds = [...new Set([...reconciled, ...pendingTaskProjection.map((row) => row.id)])];
  return { count: reconciled.length, runIds };
}

/** Compatibility count for older callers; prefer exact lease results. */
export function reconcileOrphanedRuns(): number {
  return reconcileExpiredRunLeases().count;
}

/**
 * Repair the crash window between committing a terminal run row and projecting
 * that outcome into its exact task. Completion-contract tasks that are already
 * waiting for verification are intentionally nonterminal and are not drift.
 */
export async function repairTerminalRunTaskProjections(
  options: { duringMaintenance?: boolean } = {},
): Promise<number> {
  if (isAutomationMaintenanceActive() && !options.duringMaintenance) return 0;
  const rows = getDb().prepare(`
    SELECT r.*
    FROM runs r
    LEFT JOIN tasks t ON t.id = COALESCE(r.taskId, 'run:' || r.id)
    WHERE r.status IN ('completed', 'error')
      AND (
        t.id IS NULL
        OR (
          t.status IN ('queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked')
          AND NOT (
            r.status = 'completed'
            AND t.status = 'waiting_for_approval'
            AND t.contract IS NOT NULL
          )
        )
      )
    ORDER BY r.completedAt ASC, r.startedAt ASC
  `).all() as unknown as RunRow[];
  if (!rows.length) return 0;
  const { syncTaskFromRun } = await import('./task-ledger');
  let repaired = 0;
  for (const row of rows) {
    try {
      syncTaskFromRun(rowToRun(row));
      repaired++;
    } catch (error) {
      // A concurrent task command can win this revision. The next periodic
      // pass will retry without preventing repairs for unrelated run ids.
      console.error(`[run-leases] task projection repair failed for ${row.id}`, error);
    }
  }
  return repaired;
}

/** Recreate a missing task projection while its run lease is still active. */
export async function repairMissingActiveRunTaskProjections(
  options: { duringMaintenance?: boolean } = {},
): Promise<number> {
  if (isAutomationMaintenanceActive() && !options.duringMaintenance) return 0;
  const rows = getDb().prepare(`
    SELECT r.*
    FROM runs r
    LEFT JOIN tasks t ON t.id = COALESCE(r.taskId, 'run:' || r.id)
    WHERE r.status = 'running' AND t.id IS NULL
    ORDER BY r.startedAt ASC
  `).all() as unknown as RunRow[];
  if (!rows.length) return 0;
  const { syncTaskFromRun } = await import('./task-ledger');
  let repaired = 0;
  for (const row of rows) {
    try {
      syncTaskFromRun(rowToRun(row));
      repaired++;
    } catch (error) {
      console.error(`[run-leases] missing task projection repair failed for ${row.id}`, error);
    }
  }
  return repaired;
}

/**
 * Recover the small launch window where a task was assigned/running but the
 * worker process died before it could insert the first run row. Fresh starts
 * are left alone, and the task-ledger helper rechecks absence atomically.
 */
export async function reconcileStaleRunStarts(nowMs = Date.now()): Promise<string[]> {
  if (isAutomationMaintenanceActive()) return [];
  const staleBefore = new Date(nowMs - RUN_LEASE_TIMEOUT_MS).toISOString();
  const candidates = getDb().prepare(`
    SELECT t.id
    FROM tasks t
    WHERE t.status IN ('running', 'paused', 'waiting_for_input', 'waiting_for_approval')
      AND t.runId IS NOT NULL
      AND t.runId <> ''
      AND COALESCE(t.heartbeatAt, t.updatedAt, t.createdAt) <= ?
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = t.runId)
    ORDER BY t.updatedAt ASC
    LIMIT 200
  `).all(staleBefore) as Array<{ id: string }>;
  if (!candidates.length) return [];
  const { markStaleRunningTasksWithoutRunsLost } = await import('./task-ledger');
  return markStaleRunningTasksWithoutRunsLost(
    candidates.map((candidate) => candidate.id),
    staleBefore,
  );
}

/** Reconcile expired runs and repair exact terminal task projections. */
export function reconcileExpiredRunsAndTasks(): Promise<RunLeaseReconciliation> {
  if (leaseGlobals.__shibaRunLeaseReconcilePromise) {
    return leaseGlobals.__shibaRunLeaseReconcilePromise;
  }
  if (isAutomationMaintenanceActive()) return Promise.resolve({ count: 0, runIds: [] });
  const operation = (async () => {
    // Create missing active projections before expiring leases so an abandoned
    // run is projected as lost rather than materializing later as failed.
    await repairMissingActiveRunTaskProjections();
    const reconciled = reconcileExpiredRunLeases();
    if (reconciled.runIds.length) {
      const { reconcileOrphanedTasks } = await import('./task-ledger');
      reconcileOrphanedTasks(reconciled.runIds);
    }
    await reconcileStaleRunStarts();
    await repairTerminalRunTaskProjections();
    return reconciled;
  })();
  leaseGlobals.__shibaRunLeaseReconcilePromise = operation.finally(() => {
    leaseGlobals.__shibaRunLeaseReconcilePromise = undefined;
  });
  return leaseGlobals.__shibaRunLeaseReconcilePromise;
}

/** Arm one periodic reconciler per process/module graph. */
export function startRunLeaseReconciler(): void {
  if (leaseGlobals.__shibaRunLeaseReconciler || isAutomationMaintenanceActive()) return;
  void reconcileExpiredRunsAndTasks().catch((error) => {
    console.error('[run-leases] initial reconciliation failed', error);
  });
  leaseGlobals.__shibaRunLeaseReconciler = setInterval(() => {
    void reconcileExpiredRunsAndTasks().catch((error) => {
      console.error('[run-leases] periodic reconciliation failed', error);
    });
  }, RUN_LEASE_RECONCILE_MS);
  leaseGlobals.__shibaRunLeaseReconciler.unref?.();
}

export async function stopRunLeaseReconciler(): Promise<void> {
  if (leaseGlobals.__shibaRunLeaseReconciler) {
    clearInterval(leaseGlobals.__shibaRunLeaseReconciler);
    leaseGlobals.__shibaRunLeaseReconciler = undefined;
  }
  const active = leaseGlobals.__shibaRunLeaseReconcilePromise;
  if (active) await active;
}

/** Full runs including traces — kept for compatibility (agent-runtime, tests). */
export async function loadRuns(agentId?: string): Promise<AgentRun[]> {
  const rows = agentId
    ? getDb().prepare('SELECT * FROM runs WHERE agentId = ? ORDER BY startedAt DESC LIMIT 80').all(agentId)
    : getDb().prepare('SELECT * FROM runs ORDER BY startedAt DESC LIMIT 80').all();
  return (rows as unknown as RunRow[]).map(rowToRun);
}

/** Lightweight listing (no trace payloads) — the fast path for dashboards. */
export async function listRunSummaries(opts: {
  agentId?: string;
  scheduleId?: string;
  scheduledOnly?: boolean;
  limit?: number;
} = {}): Promise<AgentRunSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const select = `
    SELECT id, agentId, agentName, model, status, prompt, startedAt, completedAt,
           taskId, attemptNo, finalOutput, projectId, scheduleId, scheduleInstructions, sideEffects,
           workspaceSnapshot,
           CASE WHEN json_valid(trace) THEN json_array_length(trace) ELSE 0 END AS traceSteps
    FROM runs
  `;
  const where: string[] = [];
  const params: string[] = [];
  if (opts.agentId) { where.push('agentId = ?'); params.push(opts.agentId); }
  if (opts.scheduleId) {
    where.push('scheduleId = ?');
    params.push(opts.scheduleId);
  } else if (opts.scheduledOnly) {
    where.push('scheduleId IS NOT NULL');
  }
  const sql = `${select} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY startedAt DESC LIMIT ?`;
  const rows = getDb().prepare(sql).all(...params, limit);
  return (rows as unknown as RunRow[]).map(rowToSummary);
}

/** One full run (with trace) by id. */
export async function getRun(id: string): Promise<AgentRun | null> {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
  return row ? rowToRun(row) : null;
}
