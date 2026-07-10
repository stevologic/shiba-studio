// Shared SQLite database (Node's built-in node:sqlite — no native deps).
// Holds agent runs and the audit log; JSON-file stores that were hot paths
// (one file per run, full-directory scans) migrate in on first open.

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import * as fs from 'fs';
import path from 'path';
import { dataDir } from './data-paths';

type DatabaseSync = DatabaseSyncType;

let db: DatabaseSync | null = null;

/**
 * node:sqlite ships with Node 22.5+. Loaded via getBuiltinModule (works in
 * ESM and every bundler) so older Node fails with an actionable message
 * instead of a cryptic module-resolution crash — same story on macOS, Linux,
 * and Windows: no native modules to compile.
 */
function loadSqlite(): { DatabaseSync: new (path: string) => DatabaseSync } {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    throw new Error(
      `Shiba Studio needs Node.js 22.5+ for its built-in SQLite store (running ${process.version}). ` +
      'Upgrade Node — no native modules or build tools are required on any platform.',
    );
  }
  const mod = process.getBuiltinModule?.('node:sqlite');
  if (!mod) throw new Error('node:sqlite is unavailable in this runtime');
  return mod as unknown as { DatabaseSync: new (path: string) => DatabaseSync };
}

function migrateRunsFromJson(database: DatabaseSync): void {
  try {
    const count = (database.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
    if (count > 0) return;
    const runsDir = dataDir('runs');
    if (!fs.existsSync(runsDir)) return;
    const files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json'));
    if (!files.length) return;
    const insert = database.prepare(`
      INSERT OR REPLACE INTO runs
        (id, agentId, agentName, model, status, prompt, startedAt, completedAt,
         finalOutput, projectId, scheduleId, scheduleInstructions, sideEffects, trace)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    database.exec('BEGIN');
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
        insert.run(
          String(r.id), String(r.agentId || ''), String(r.agentName || ''), String(r.model || ''),
          String(r.status || 'completed'), String(r.prompt || ''), String(r.startedAt || ''),
          r.completedAt ? String(r.completedAt) : null, r.finalOutput ? String(r.finalOutput) : null,
          r.projectId ? String(r.projectId) : null, r.scheduleId ? String(r.scheduleId) : null,
          r.scheduleInstructions ? String(r.scheduleInstructions) : null,
          JSON.stringify(r.sideEffects || []), JSON.stringify(r.trace || []),
        );
      } catch {
        /* skip corrupt legacy file */
      }
    }
    database.exec('COMMIT');
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* no txn open */ }
  }
}

/** Pre-rebrand databases were named grokdesk.db — rename (with WAL sidecars)
 *  before opening so run history and the audit log survive the upgrade. */
function dbPath(): string {
  const file = dataDir('shiba-studio.db');
  const legacy = dataDir('grokdesk.db');
  if (!fs.existsSync(file) && fs.existsSync(legacy)) {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        if (fs.existsSync(legacy + ext)) fs.renameSync(legacy + ext, file + ext);
      } catch { /* sidecar in use — handled below */ }
    }
    if (!fs.existsSync(file)) return legacy; // rename blocked (old server still holds it)
  }
  return file;
}

/**
 * Schema version stamped into the database (PRAGMA user_version).
 *
 * The baseline CREATE TABLE IF NOT EXISTS block below IS version 1 — it is
 * idempotent, so fresh databases and pre-versioning databases both end up at
 * v1. Any future change to the schema must NOT edit the baseline; instead:
 *   1. bump SCHEMA_VERSION,
 *   2. append a migration to MIGRATIONS keyed by the version it upgrades FROM.
 * Migrations run in order inside a transaction on next open, so an existing
 * ~/.shiba-studio/data/shiba-studio.db always upgrades safely.
 */
const SCHEMA_VERSION = 2;

/** MIGRATIONS[n] upgrades a database at user_version n to n+1. */
const MIGRATIONS: Record<number, (database: DatabaseSync) => void> = {
  // v1 → v2: FTS5 search over runs and the audit log (external-content
  // tables kept in sync by triggers; seeded from existing rows).
  1: (d) => d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS runs_fts USING fts5(
      prompt, finalOutput, agentName,
      content='runs', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS runs_fts_ai AFTER INSERT ON runs BEGIN
      INSERT INTO runs_fts(rowid, prompt, finalOutput, agentName)
      VALUES (new.rowid, new.prompt, new.finalOutput, new.agentName);
    END;
    CREATE TRIGGER IF NOT EXISTS runs_fts_ad AFTER DELETE ON runs BEGIN
      INSERT INTO runs_fts(runs_fts, rowid, prompt, finalOutput, agentName)
      VALUES ('delete', old.rowid, old.prompt, old.finalOutput, old.agentName);
    END;
    CREATE TRIGGER IF NOT EXISTS runs_fts_au AFTER UPDATE ON runs BEGIN
      INSERT INTO runs_fts(runs_fts, rowid, prompt, finalOutput, agentName)
      VALUES ('delete', old.rowid, old.prompt, old.finalOutput, old.agentName);
      INSERT INTO runs_fts(rowid, prompt, finalOutput, agentName)
      VALUES (new.rowid, new.prompt, new.finalOutput, new.agentName);
    END;
    INSERT INTO runs_fts(rowid, prompt, finalOutput, agentName)
      SELECT rowid, prompt, finalOutput, agentName FROM runs;

    CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
      action, detail, category,
      content='audit_log', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS audit_fts_ai AFTER INSERT ON audit_log BEGIN
      INSERT INTO audit_fts(rowid, action, detail, category)
      VALUES (new.id, new.action, new.detail, new.category);
    END;
    CREATE TRIGGER IF NOT EXISTS audit_fts_ad AFTER DELETE ON audit_log BEGIN
      INSERT INTO audit_fts(audit_fts, rowid, action, detail, category)
      VALUES ('delete', old.id, old.action, old.detail, old.category);
    END;
    INSERT INTO audit_fts(rowid, action, detail, category)
      SELECT id, action, detail, category FROM audit_log;
  `),
};

function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: number };
  return Number(row?.user_version ?? 0);
}

function runMigrations(database: DatabaseSync): void {
  let v = schemaVersion(database);
  if (v >= SCHEMA_VERSION) return;
  while (v < SCHEMA_VERSION) {
    const migrate = MIGRATIONS[v];
    database.exec('BEGIN');
    try {
      if (migrate) migrate(database); // v0 → v1 is the baseline itself
      database.exec(`PRAGMA user_version = ${v + 1}`);
      database.exec('COMMIT');
    } catch (e) {
      try { database.exec('ROLLBACK'); } catch { /* no txn open */ }
      throw new Error(`Database migration v${v} → v${v + 1} failed: ${e instanceof Error ? e.message : e}`);
    }
    v += 1;
  }
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const { DatabaseSync } = loadSqlite();
  db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      agentName TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      completedAt TEXT,
      finalOutput TEXT,
      projectId TEXT,
      scheduleId TEXT,
      scheduleInstructions TEXT,
      sideEffects TEXT NOT NULL DEFAULT '[]',
      trace TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(startedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agentId, startedAt DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_log(category, ts DESC);

    CREATE TABLE IF NOT EXISTS schedule_ticks (
      scheduleKey TEXT NOT NULL,
      tick TEXT NOT NULL,
      claimedAt TEXT NOT NULL,
      PRIMARY KEY (scheduleKey, tick)
    );
  `);
  runMigrations(db);
  migrateRunsFromJson(db);
  return db;
}

/** Absolute path of the SQLite file (for backup/restore). */
export function databasePath(): string {
  return dbPath();
}

/**
 * Close the shared handle so the file can be replaced (backup restore).
 * The next getDb() reopens and re-runs migrations.
 */
export function closeDb(): void {
  if (!db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
  try { db.close(); } catch { /* already closed */ }
  db = null;
}

/**
 * Atomically claim one cron tick for a schedule (tick = UTC minute). Cron
 * fires can be duplicated — extra module copies of the scheduler, or a second
 * server process on the same data dir — and every duplicate lands here; the
 * PRIMARY KEY guarantees exactly one caller wins the minute.
 */
export function claimScheduleTick(scheduleKey: string, tick: string): boolean {
  const database = getDb();
  try {
    database
      .prepare('INSERT INTO schedule_ticks (scheduleKey, tick, claimedAt) VALUES (?, ?, ?)')
      .run(scheduleKey, tick, new Date().toISOString());
  } catch {
    return false; // this minute was already claimed by another task/process
  }
  // Opportunistic cleanup — claims are meaningless after the minute passes.
  try {
    database
      .prepare('DELETE FROM schedule_ticks WHERE claimedAt < ?')
      .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  } catch { /* cleanup is best-effort */ }
  return true;
}
