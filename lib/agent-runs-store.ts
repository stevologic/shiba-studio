// Agent run persistence on SQLite (node:sqlite). Replaces the one-JSON-file-
// per-run store whose full-directory scans made the dashboard slow; legacy
// files migrate into the DB automatically on first open (see lib/db.ts).

import type { AgentRun } from './types';
import { getDb } from './db';

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
         finalOutput, projectId, scheduleId, scheduleInstructions, sideEffects, trace)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      run.id, run.agentId, run.agentName, run.model, run.status, run.prompt,
      run.startedAt, run.completedAt ?? null, run.finalOutput ?? null,
      run.projectId ?? null, run.scheduleId ?? null, run.scheduleInstructions ?? null,
      JSON.stringify(run.sideEffects || []), JSON.stringify(run.trace || []),
    );
}

/** Full runs including traces — kept for compatibility (agent-runtime, tests). */
export async function loadRuns(agentId?: string): Promise<AgentRun[]> {
  const rows = agentId
    ? getDb().prepare('SELECT * FROM runs WHERE agentId = ? ORDER BY startedAt DESC LIMIT 80').all(agentId)
    : getDb().prepare('SELECT * FROM runs ORDER BY startedAt DESC LIMIT 80').all();
  return (rows as unknown as RunRow[]).map(rowToRun);
}

/** Lightweight listing (no trace payloads) — the fast path for dashboards. */
export async function listRunSummaries(opts: { agentId?: string; limit?: number } = {}): Promise<AgentRunSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const select = `
    SELECT id, agentId, agentName, model, status, prompt, startedAt, completedAt,
           finalOutput, projectId, scheduleId, scheduleInstructions, sideEffects,
           json_array_length(trace) AS traceSteps
    FROM runs
  `;
  const rows = opts.agentId
    ? getDb().prepare(`${select} WHERE agentId = ? ORDER BY startedAt DESC LIMIT ?`).all(opts.agentId, limit)
    : getDb().prepare(`${select} ORDER BY startedAt DESC LIMIT ?`).all(limit);
  return (rows as unknown as RunRow[]).map(rowToSummary);
}

/** One full run (with trace) by id. */
export async function getRun(id: string): Promise<AgentRun | null> {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
  return row ? rowToRun(row) : null;
}
