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
    const info = db.prepare('DELETE FROM runs WHERE startedAt < ?').run(cutoff);
    result.runsRemoved = Number(info.changes) || 0;
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
