// Application audit trail — every consequential action lands here (SQLite).
// Writes are fire-and-forget: auditing must never break the action it records.

import { getDb } from './db';

export type AuditCategory =
  | 'agent' | 'run' | 'chat' | 'config' | 'integration'
  | 'skill' | 'sync' | 'workspace' | 'auth' | 'system';

export interface AuditEntry {
  id: number;
  ts: string;
  category: AuditCategory;
  action: string;
  detail: string | null;
  meta: Record<string, unknown> | null;
}

export function audit(
  category: AuditCategory,
  action: string,
  detail?: string,
  meta?: Record<string, unknown>,
): void {
  try {
    getDb()
      .prepare('INSERT INTO audit_log (ts, category, action, detail, meta) VALUES (?, ?, ?, ?, ?)')
      .run(
        new Date().toISOString(),
        category,
        action,
        detail ? detail.slice(0, 500) : null,
        meta ? JSON.stringify(meta).slice(0, 2000) : null,
      );
  } catch {
    /* never fail the action being audited */
  }
}

export function listAuditLogs(opts: {
  limit?: number;
  offset?: number;
  category?: string;
} = {}): { entries: AuditEntry[]; total: number } {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = opts.category ? 'WHERE category = ?' : '';
  const params = opts.category ? [opts.category] : [];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT id, ts, category, action, detail, meta FROM audit_log ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<Omit<AuditEntry, 'meta'> & { meta: string | null }>;

  return {
    total,
    entries: rows.map((r) => ({
      ...r,
      category: r.category as AuditCategory,
      meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
    })),
  };
}
