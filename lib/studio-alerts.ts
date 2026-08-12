/**
 * Durable ops notices for terminal failures and skipped automations.
 * This is not the Attention inbox — approvals stay an exact-action queue.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { emitAppEvent } from './app-events';

export type StudioAlertKind = 'task_failed' | 'task_lost' | 'automation_skipped';
export type StudioAlertSeverity = 'info' | 'warning' | 'critical';

export interface StudioAlert {
  id: string;
  kind: StudioAlertKind;
  severity: StudioAlertSeverity;
  title: string;
  body: string;
  href?: string;
  sourceId?: string;
  dedupeKey: string;
  createdAt: string;
  readAt?: string;
}

export interface RecordStudioAlertInput {
  kind: StudioAlertKind;
  severity?: StudioAlertSeverity;
  title: string;
  body: string;
  href?: string;
  sourceId?: string;
  dedupeKey: string;
}

const MAX_ALERTS = 100;

function ensureStudioAlertSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS studio_alerts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      href TEXT,
      sourceId TEXT,
      dedupeKey TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL,
      readAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_studio_alerts_unread ON studio_alerts(readAt, createdAt);
  `);
}

function clip(value: unknown, max: number): string {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function rowToAlert(row: {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  href: string | null;
  sourceId: string | null;
  dedupeKey: string;
  createdAt: string;
  readAt: string | null;
}): StudioAlert {
  return {
    id: row.id,
    kind: row.kind as StudioAlertKind,
    severity: row.severity as StudioAlertSeverity,
    title: row.title,
    body: row.body,
    ...(row.href ? { href: row.href } : {}),
    ...(row.sourceId ? { sourceId: row.sourceId } : {}),
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
    ...(row.readAt ? { readAt: row.readAt } : {}),
  };
}

export function recordStudioAlert(input: RecordStudioAlertInput, opts?: { emit?: boolean }): StudioAlert {
  ensureStudioAlertSchema();
  const now = new Date().toISOString();
  const dedupeKey = clip(input.dedupeKey, 300);
  if (!dedupeKey) throw new Error('Studio alert dedupeKey is required');
  const db = getDb();
  const existing = db.prepare('SELECT * FROM studio_alerts WHERE dedupeKey = ?').get(dedupeKey) as
    | Parameters<typeof rowToAlert>[0]
    | undefined;
  if (existing) {
    db.prepare(`
      UPDATE studio_alerts
      SET kind = ?, severity = ?, title = ?, body = ?, href = ?, sourceId = ?, createdAt = ?, readAt = NULL
      WHERE dedupeKey = ?
    `).run(
      input.kind,
      input.severity || 'warning',
      clip(input.title, 300),
      clip(input.body, 4_000),
      input.href ? clip(input.href, 500) : null,
      input.sourceId ? clip(input.sourceId, 200) : null,
      now,
      dedupeKey,
    );
    if (opts?.emit !== false) emitAppEvent('attention');
    return rowToAlert(db.prepare('SELECT * FROM studio_alerts WHERE dedupeKey = ?').get(dedupeKey) as Parameters<typeof rowToAlert>[0]);
  }
  const alert: StudioAlert = {
    id: randomUUID(),
    kind: input.kind,
    severity: input.severity || 'warning',
    title: clip(input.title, 300),
    body: clip(input.body, 4_000),
    ...(input.href ? { href: clip(input.href, 500) } : {}),
    ...(input.sourceId ? { sourceId: clip(input.sourceId, 200) } : {}),
    dedupeKey,
    createdAt: now,
  };
  db.prepare(`
    INSERT INTO studio_alerts (id, kind, severity, title, body, href, sourceId, dedupeKey, createdAt, readAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    alert.id, alert.kind, alert.severity, alert.title, alert.body,
    alert.href || null, alert.sourceId || null, alert.dedupeKey, alert.createdAt,
  );
  db.prepare(`
    DELETE FROM studio_alerts WHERE id IN (
      SELECT id FROM studio_alerts ORDER BY createdAt DESC, id DESC LIMIT -1 OFFSET ?
    )
  `).run(MAX_ALERTS);
  if (opts?.emit !== false) emitAppEvent('attention');
  return alert;
}

export function listStudioAlerts(opts: {
  unreadOnly?: boolean;
  limit?: number;
} = {}): { items: StudioAlert[]; total: number; unread: number } {
  ensureStudioAlertSchema();
  const db = getDb();
  const unread = Number((db.prepare("SELECT COUNT(*) AS n FROM studio_alerts WHERE readAt IS NULL").get() as { n: number }).n);
  const clauses = opts.unreadOnly ? ['readAt IS NULL'] : [];
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM studio_alerts ${where}`).get() as { n: number }).n);
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(opts.limit) || 40)));
  const rows = db.prepare(`
    SELECT * FROM studio_alerts ${where}
    ORDER BY createdAt DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<Parameters<typeof rowToAlert>[0]>;
  return { items: rows.map(rowToAlert), total, unread };
}

export function unreadStudioAlertCount(): number {
  ensureStudioAlertSchema();
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM studio_alerts WHERE readAt IS NULL").get() as { n: number }).n);
}

export function markStudioAlertRead(id: string): StudioAlert | null {
  ensureStudioAlertSchema();
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE studio_alerts SET readAt = COALESCE(readAt, ?) WHERE id = ?
  `).run(now, clip(id, 80));
  if (Number(result.changes) !== 1) return null;
  const row = getDb().prepare('SELECT * FROM studio_alerts WHERE id = ?').get(clip(id, 80)) as
    | Parameters<typeof rowToAlert>[0]
    | undefined;
  if (row) emitAppEvent('attention');
  return row ? rowToAlert(row) : null;
}

export function markAllStudioAlertsRead(): number {
  ensureStudioAlertSchema();
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE studio_alerts SET readAt = ? WHERE readAt IS NULL
  `).run(now);
  const changed = Number(result.changes) || 0;
  if (changed > 0) emitAppEvent('attention');
  return changed;
}
