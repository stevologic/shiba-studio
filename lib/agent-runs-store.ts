// Agent run persistence on SQLite (node:sqlite). Replaces the one-JSON-file-
// per-run store whose full-directory scans made the dashboard slow; legacy
// files migrate into the DB automatically on first open (see lib/db.ts).

import type { AgentRun } from './types';
import { getDb } from './db';
import { emitAppEvent } from './app-events';

/** A run without its (potentially huge) trace — what lists and tables need. */
export type AgentRunSummary = Omit<AgentRun, 'trace'> & { traceSteps: number };

interface RunRow {
  id: string;
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
}

function rowToSummary(row: RunRow): AgentRunSummary {
  return {
    id: row.id,
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
    sideEffects: JSON.parse(row.sideEffects || '[]'),
    workspaceSnapshot: row.workspaceSnapshot ?? undefined,
    traceSteps: row.traceSteps ?? 0,
  };
}

function rowToRun(row: RunRow): AgentRun {
  return {
    ...rowToSummary(row),
    trace: JSON.parse(row.trace || '[]'),
  };
}

export async function persistAgentRun(run: AgentRun): Promise<void> {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO runs
        (id, agentId, agentName, model, status, prompt, startedAt, completedAt,
         finalOutput, projectId, scheduleId, scheduleInstructions, sideEffects,
         workspaceSnapshot, trace)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      run.id, run.agentId, run.agentName, run.model, run.status, run.prompt,
      run.startedAt, run.completedAt ?? null, run.finalOutput ?? null,
      run.projectId ?? null, run.scheduleId ?? null, run.scheduleInstructions ?? null,
      JSON.stringify(run.sideEffects || []), run.workspaceSnapshot ?? null,
      JSON.stringify(run.trace || []),
    );
  // Live UI: dashboards refresh the run list the moment a run starts/finishes.
  emitAppEvent('runs');
}

/**
 * Mark any run still flagged 'running' as an interrupted error. A run only
 * stays 'running' if the process died mid-execution (crash / restart) — call
 * this on server start so orphaned runs don't leave a permanent spinner on the
 * Automations page. Returns how many were reconciled.
 */
export function reconcileOrphanedRuns(): number {
  const res = getDb()
    .prepare(`
      UPDATE runs
      SET status = 'error',
          completedAt = ?,
          finalOutput = COALESCE(finalOutput, 'Run was interrupted (server restarted while it was executing).')
      WHERE status = 'running'
    `)
    .run(new Date().toISOString());
  const n = Number(res.changes || 0);
  if (n > 0) emitAppEvent('runs');
  return n;
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
           finalOutput, projectId, scheduleId, scheduleInstructions, sideEffects,
           workspaceSnapshot, json_array_length(trace) AS traceSteps
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
