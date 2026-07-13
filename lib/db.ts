// Shared SQLite database (Node's built-in node:sqlite — no native deps).
// Holds agent runs and the audit log; JSON-file stores that were hot paths
// (one file per run, full-directory scans) migrate in on first open.

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import * as fs from 'fs';
import path from 'path';
import { dataDir } from './data-paths';

type DatabaseSync = DatabaseSyncType;

let db: DatabaseSync | null = null;
let maintenanceDepth = 0;

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
const SCHEMA_VERSION = 8;

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
  // v2 → v3: move agent/chat memory into the versioned schema and add the
  // metadata needed for automatic learning, review, pinning, provenance, and
  // management. Older installs may already have the four-column table because
  // memory used to create it lazily, so add columns only when they are absent.
  2: (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agentId TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'fact',
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'manual',
        sourceId TEXT,
        confidence REAL NOT NULL DEFAULT 1,
        pinned INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT,
        updatedAt TEXT NOT NULL,
        lastUsedAt TEXT,
        useCount INTEGER NOT NULL DEFAULT 0,
        UNIQUE(agentId, key)
      );
    `);
    const columns = new Set(
      (d.prepare('PRAGMA table_info(agent_memory)').all() as Array<{ name: string }>).map((row) => row.name),
    );
    const additions: Array<[string, string]> = [
      ['kind', "TEXT NOT NULL DEFAULT 'fact'"],
      ['status', "TEXT NOT NULL DEFAULT 'active'"],
      ['source', "TEXT NOT NULL DEFAULT 'manual'"],
      ['sourceId', 'TEXT'],
      ['confidence', 'REAL NOT NULL DEFAULT 1'],
      ['pinned', 'INTEGER NOT NULL DEFAULT 0'],
      ['createdAt', 'TEXT'],
      ['lastUsedAt', 'TEXT'],
      ['useCount', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) d.exec(`ALTER TABLE agent_memory ADD COLUMN ${name} ${definition}`);
    }
    d.exec(`
      UPDATE agent_memory SET createdAt = updatedAt WHERE createdAt IS NULL OR createdAt = '';
      CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agentId, status, pinned DESC, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_status ON agent_memory(status, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_source ON agent_memory(source, updatedAt DESC);
    `);
  },
  // v3 → v5: persist the run's workspace path. The runtime always knew it
  // (workspaceSnapshot) but the store dropped it, so deliverable links (Board
  // "View work") couldn't resolve files written with workspace-relative paths.
  // Registered at BOTH 3 and 4 (column-guarded, so idempotent): some dev
  // databases were stamped user_version=4 by an interim build without this
  // column, and both paths must converge on the same schema.
  3: addRunsWorkspaceColumn,
  4: addRunsWorkspaceColumn,
  // v5 → v6: universal task control plane. Existing runs are projected into
  // this ledger lazily by agent-runs-store; the schema also owns completion
  // evidence, attention, steering commands, an event history, and the durable
  // delivery outbox so those concerns never split into parallel stores.
  5: createTaskControlPlane,
  // v6 → v7: command idempotency and optimistic revision binding. Column
  // guards keep this safe for a development database that observed an early
  // v6 build while the control-plane slice was still landing.
  6: hardenTaskCommands,
  // v7 → v8: immutable, task-owned file checkpoints. Checkpoint rows bind
  // the task state and declared workspace paths captured before a mutation;
  // file rows also retain the sealed post-mutation state used to reject an
  // unsafe rewind when another actor changed an owned path afterward.
  7: createTaskCheckpoints,
};

function createTaskCheckpoints(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS task_checkpoints (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      reason TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      taskSnapshot TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL,
      sealedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task
      ON task_checkpoints(taskId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS task_checkpoint_files (
      checkpointId TEXT NOT NULL,
      workspaceRootId TEXT NOT NULL,
      workspacePath TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      beforeExists INTEGER NOT NULL,
      beforeHash TEXT,
      beforeMode INTEGER,
      beforeContent BLOB,
      afterExists INTEGER,
      afterHash TEXT,
      afterMode INTEGER,
      afterContent BLOB,
      PRIMARY KEY (checkpointId, workspaceRootId, relativePath)
    );
    CREATE INDEX IF NOT EXISTS idx_task_checkpoint_files_checkpoint
      ON task_checkpoint_files(checkpointId, workspaceRootId, relativePath);

    CREATE TABLE IF NOT EXISTS task_checkpoint_restores (
      id TEXT PRIMARY KEY,
      checkpointId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      status TEXT NOT NULL,
      restoredPaths TEXT NOT NULL DEFAULT '[]',
      conflicts TEXT NOT NULL DEFAULT '[]',
      startedAt TEXT NOT NULL,
      completedAt TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_checkpoint_restores_checkpoint
      ON task_checkpoint_restores(checkpointId, startedAt DESC);
  `);
}

function hardenTaskCommands(d: DatabaseSync): void {
  const columns = new Set(
    (d.prepare('PRAGMA table_info(task_commands)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has('idempotencyKey')) d.exec('ALTER TABLE task_commands ADD COLUMN idempotencyKey TEXT');
  if (!columns.has('expectedVersion')) d.exec('ALTER TABLE task_commands ADD COLUMN expectedVersion INTEGER NOT NULL DEFAULT 1');
  d.exec(`
    UPDATE task_commands SET idempotencyKey = id WHERE idempotencyKey IS NULL OR idempotencyKey = '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_commands_idempotency
      ON task_commands(taskId, idempotencyKey);
  `);
}

function createTaskControlPlane(d: DatabaseSync): void {
  const runColumns = new Set(
    (d.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!runColumns.has('taskId')) d.exec('ALTER TABLE runs ADD COLUMN taskId TEXT');
  if (!runColumns.has('attemptNo')) d.exec('ALTER TABLE runs ADD COLUMN attemptNo INTEGER NOT NULL DEFAULT 1');
  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      parentId TEXT,
      originType TEXT NOT NULL,
      originId TEXT,
      agentId TEXT,
      projectId TEXT,
      runId TEXT,
      sessionId TEXT,
      workspaceRoots TEXT NOT NULL DEFAULT '[]',
      plan TEXT NOT NULL DEFAULT '[]',
      progress REAL NOT NULL DEFAULT 0,
      currentStep TEXT,
      nextAction TEXT,
      retryCount INTEGER NOT NULL DEFAULT 0,
      maxRetries INTEGER NOT NULL DEFAULT 0,
      heartbeatAt TEXT,
      startedAt TEXT,
      completedAt TEXT,
      result TEXT,
      error TEXT,
      contract TEXT,
      completion TEXT,
      checkpointId TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentId, createdAt ASC);
    CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(originType, originId);
    CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(runId);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(sessionId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(taskId, attemptNo);

    CREATE TABLE IF NOT EXISTS task_evidence (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      requirementId TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      label TEXT NOT NULL,
      summary TEXT NOT NULL,
      uri TEXT,
      command TEXT,
      exitCode INTEGER,
      scope TEXT,
      recordedAt TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_task_evidence_task ON task_evidence(taskId, recordedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_task_evidence_requirement ON task_evidence(taskId, requirementId, recordedAt DESC);

    CREATE TABLE IF NOT EXISTS task_attention (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT '{}',
      dedupeKey TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      resolvedAt TEXT,
      UNIQUE(taskId, dedupeKey)
    );
    CREATE INDEX IF NOT EXISTS idx_task_attention_status ON task_attention(status, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_task_attention_task ON task_attention(taskId, status, createdAt DESC);

    CREATE TABLE IF NOT EXISTS task_commands (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      idempotencyKey TEXT NOT NULL,
      expectedVersion INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      appliedAt TEXT,
      UNIQUE(taskId, idempotencyKey)
    );
    CREATE INDEX IF NOT EXISTS idx_task_commands_pending ON task_commands(taskId, status, createdAt ASC);

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId TEXT NOT NULL,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(taskId, id DESC);

    CREATE TABLE IF NOT EXISTS task_outbox (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      availableAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      deliveredAt TEXT,
      lastError TEXT,
      idempotencyKey TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_task_outbox_pending ON task_outbox(status, availableAt, createdAt);

    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      title, description, result, error,
      content='tasks', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
      INSERT INTO tasks_fts(rowid, title, description, result, error)
      VALUES (new.rowid, new.title, new.description, new.result, new.error);
    END;
    CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, result, error)
      VALUES ('delete', old.rowid, old.title, old.description, old.result, old.error);
    END;
    CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, result, error)
      VALUES ('delete', old.rowid, old.title, old.description, old.result, old.error);
      INSERT INTO tasks_fts(rowid, title, description, result, error)
      VALUES (new.rowid, new.title, new.description, new.result, new.error);
    END;
  `);
}

function addRunsWorkspaceColumn(d: DatabaseSync): void {
  const columns = new Set(
    (d.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has('workspaceSnapshot')) {
    d.exec('ALTER TABLE runs ADD COLUMN workspaceSnapshot TEXT');
  }
}

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
      // A gap in MIGRATIONS must never silently stamp the version forward —
      // that leaves the schema behind the stamp and breaks every later check.
      else if (v > 0) throw new Error(`No migration registered for v${v} → v${v + 1}`);
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
  if (maintenanceDepth > 0) throw new Error('Database maintenance in progress; retry shortly');
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

/** Prevent another request from reopening the shared handle while a validated
 * backup is swapped into place. The release callback is idempotent. */
export function beginDbMaintenance(): () => void {
  if (maintenanceDepth > 0) throw new Error('Database maintenance is already in progress');
  maintenanceDepth = 1;
  closeDb();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    maintenanceDepth = 0;
  };
}

/** Open a staged database separately and run SQLite's structural check before
 * it is allowed anywhere near the live file. */
export function validateDatabaseFile(file: string): void {
  const { DatabaseSync } = loadSqlite();
  const candidate = new DatabaseSync(file);
  try {
    const row = candidate.prepare('PRAGMA quick_check').get() as { quick_check?: string };
    if (row?.quick_check !== 'ok') throw new Error(`SQLite quick_check failed: ${row?.quick_check || 'unknown error'}`);
  } finally {
    candidate.close();
  }
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
