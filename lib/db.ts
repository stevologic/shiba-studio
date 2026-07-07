// Shared SQLite database (Node's built-in node:sqlite — no native deps).
// Holds agent runs and the audit log; JSON-file stores that were hot paths
// (one file per run, full-directory scans) migrate in on first open.

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import path from 'path';
import { dataDir } from './data-paths';

let db: DatabaseSync | null = null;

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

export function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(dataDir('grokdesk.db'));
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
  `);
  migrateRunsFromJson(db);
  return db;
}
