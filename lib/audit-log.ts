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

/** Escape LIKE wildcards so user input is treated as a literal substring. */
function escapeLike(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Tolerant parse of the meta JSON column — bad JSON degrades to null instead
 *  of throwing and 500ing the entire Logs listing. */
function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function listAuditLogs(opts: {
  limit?: number;
  offset?: number;
  category?: string;
  /** Case-insensitive substring match across all columns (and meta JSON). */
  q?: string;
} = {}): { entries: AuditEntry[]; total: number } {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.category) {
    clauses.push('category = ?');
    params.push(opts.category);
  }

  const q = typeof opts.q === 'string' ? opts.q.trim() : '';
  if (q) {
    // Search every column the UI shows: when (ts), category, action, agent/model
    // (inside meta), detail, plus raw meta and id for power users.
    const like = `%${escapeLike(q)}%`;
    clauses.push(`(
      ts LIKE ? ESCAPE '\\'
      OR category LIKE ? ESCAPE '\\'
      OR action LIKE ? ESCAPE '\\'
      OR IFNULL(detail, '') LIKE ? ESCAPE '\\'
      OR IFNULL(meta, '') LIKE ? ESCAPE '\\'
      OR CAST(id AS TEXT) LIKE ? ESCAPE '\\'
    )`);
    params.push(like, like, like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT id, ts, category, action, detail, meta FROM audit_log ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<Omit<AuditEntry, 'meta'> & { meta: string | null }>;

  return {
    total,
    entries: rows.map((r) => ({
      ...r,
      category: r.category as AuditCategory,
      // Tolerant: a corrupt meta cell must not 500 the whole Logs page.
      meta: parseMeta(r.meta),
    })),
  };
}
