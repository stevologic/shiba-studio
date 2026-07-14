// Retention pruning for the SQLite stores. Off by default — runs and the
// audit trail are kept forever until the user sets retention windows in
// Settings → Cost & safety. Runs at server start and daily thereafter.

import { getDb } from './db';
import { loadConfig } from './persistence';
import { audit } from './audit-log';

interface RetentionGlobals {
  __shibaRetentionTimer?: ReturnType<typeof setInterval>;
}
const g = globalThis as unknown as RetentionGlobals;

type ShibaDb = ReturnType<typeof getDb>;

function hasTable(db: ShibaDb, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * Remove terminal runs and their immediate weak references atomically. JSON
 * projections and filesystem-owned data are reconciled by data-integrity after
 * this commit, but callers never observe dangling SQL run references.
 */
function pruneTerminalRuns(db: ShibaDb, cutoff: string): number {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS retention_run_ids (
        id TEXT PRIMARY KEY
      );
      DELETE FROM retention_run_ids;
    `);
    db.prepare(`
      INSERT INTO retention_run_ids (id)
      SELECT r.id
      FROM runs r
      WHERE r.startedAt < ?
        AND r.status IN ('completed', 'error')
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE (t.runId = r.id OR t.id = r.taskId)
            AND t.status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')
        )
    `).run(cutoff);

    db.prepare(`
      UPDATE tasks
      SET runId = NULL, version = version + 1, updatedAt = ?
      WHERE runId IN (SELECT id FROM retention_run_ids)
    `).run(now);

    if (hasTable(db, 'task_run_controls')) {
      db.exec('DELETE FROM task_run_controls WHERE runId IN (SELECT id FROM retention_run_ids)');
    }
    if (hasTable(db, 'capability_packs')) {
      db.exec('UPDATE capability_packs SET lastSuccessRunId = NULL WHERE lastSuccessRunId IN (SELECT id FROM retention_run_ids)');
    }
    if (hasTable(db, 'agent_memory')) {
      db.exec("UPDATE agent_memory SET sourceId = NULL WHERE sourceId IN (SELECT id FROM retention_run_ids) AND source = 'learned'");
    }
    if (hasTable(db, 'context_sources')) {
      db.exec(`
        DELETE FROM context_sources
        WHERE scopeType = 'run' AND scopeId IN (SELECT id FROM retention_run_ids);
        UPDATE context_sources
        SET runId = NULL
        WHERE runId IN (SELECT id FROM retention_run_ids);
      `);
    }
    if (hasTable(db, 'context_compactions')) {
      db.exec("DELETE FROM context_compactions WHERE scopeType = 'run' AND scopeId IN (SELECT id FROM retention_run_ids)");
    }
    if (hasTable(db, 'context_scope_state')) {
      db.exec("DELETE FROM context_scope_state WHERE scopeType = 'run' AND scopeId IN (SELECT id FROM retention_run_ids)");
    }

    const removed = Number(db.prepare(`
      DELETE FROM runs WHERE id IN (SELECT id FROM retention_run_ids)
    `).run().changes) || 0;
    db.exec('DELETE FROM retention_run_ids');
    db.exec('COMMIT');
    return removed;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

export interface PruneResult {
  runsRemoved: number;
  auditRemoved: number;
}

/** Delete runs/audit entries older than the configured windows. */
export async function pruneStores(): Promise<PruneResult> {
  const cfg = await loadConfig();
  const result: PruneResult = { runsRemoved: 0, auditRemoved: 0 };
  const db = getDb();

  const runDays = Number(cfg.runRetentionDays) || 0;
  if (runDays > 0) {
    const cutoff = new Date(Date.now() - runDays * 24 * 60 * 60 * 1000).toISOString();
    const { withIntegrityMutation } = await import('./integrity-coordinator');
    const mutation = await withIntegrityMutation(
      'terminal run retention pruning',
      async () => pruneTerminalRuns(db, cutoff),
    );
    result.runsRemoved = mutation.result;
  }

  const auditDays = Number(cfg.auditRetentionDays) || 0;
  if (auditDays > 0) {
    const cutoff = new Date(Date.now() - auditDays * 24 * 60 * 60 * 1000).toISOString();
    const info = db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff);
    result.auditRemoved = Number(info.changes) || 0;
  }

  if (result.runsRemoved || result.auditRemoved) {
    audit('system', 'retention prune', `removed ${result.runsRemoved} runs, ${result.auditRemoved} audit entries`, {
      runRetentionDays: runDays || null,
      auditRetentionDays: auditDays || null,
    });
  }
  return result;
}

/** Arm the daily prune (idempotent across HMR/module copies). */
export function startRetentionSchedule(): void {
  if (g.__shibaRetentionTimer) return;
  pruneStores().catch(() => {});
  g.__shibaRetentionTimer = setInterval(() => {
    pruneStores().catch(() => {});
  }, 24 * 60 * 60 * 1000);
  g.__shibaRetentionTimer.unref?.();
}
