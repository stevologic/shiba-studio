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
  migrateRunsFromJson(db);
  return db;
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
