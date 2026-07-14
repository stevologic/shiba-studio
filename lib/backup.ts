// One-file backup & restore. The bundle is a single JSON document holding
// every JSON store (read raw from disk — credential fields stay AES-sealed),
// the SQLite database (runs + audit log + memory) as base64, and — so a
// restore on a NEW machine can actually open the sealed credentials — the
// machine encryption key. Treat exported bundles like a password.

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { audit } from './audit-log';
import { beginAutomationMaintenance } from './automation-maintenance';
import { dataDir } from './data-paths';
import { beginDbMaintenance, databasePath, getDb, validateDatabaseFile } from './db';
import { exportSecretKeyHex, importSecretKeyHex } from './secure-store';
import { ownershipStoreFencePath, withStoreFileLock } from './store-file-lock';

export const BACKUP_FORMAT = 'shiba-studio-backup';
export const BACKUP_VERSION = 1;

/** Every JSON store under the data dir that belongs in a backup. Binary
 * artifacts (screenshots, uploaded files) are deliberately excluded. */
const JSON_STORES = [
  'config.json',
  'agents.json',
  'chat-sessions.json',
  'projects.json',
  'custom-skills.json',
  'mcp-servers.json',
  'usage.json',
  'uploads-meta.json',
  'cloud-sync.json',
  'xai-oauth.json',
  'board.json',
] as const;

export interface BackupBundle {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** JSON stores as raw text (secrets sealed, exactly as on disk). */
  stores: Record<string, string>;
  /** shiba-studio.db as base64 (runs, audit log, agent memory). */
  sqliteBase64: string | null;
  /** Machine encryption key (64 hex chars) — needed to open sealed secrets. */
  secretKeyHex?: string;
}

function withOwnershipStoreFence<T>(operation: () => Promise<T>): Promise<T> {
  return withStoreFileLock(ownershipStoreFencePath(dataDir()), operation);
}

async function buildBackupUnlocked(opts: { includeKey?: boolean } = {}): Promise<BackupBundle> {
  const stores: Record<string, string> = {};
  for (const name of JSON_STORES) {
    try {
      stores[name] = await fs.readFile(dataDir(name), 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error(`Could not read ${name} for backup: ${errorMessage(error)}`);
      }
      /* store does not exist yet - skip */
    }
  }

  let sqliteBase64: string | null = null;
  try {
    // Fold the WAL into the main file so the copy is a complete snapshot.
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    sqliteBase64 = (await fs.readFile(databasePath())).toString('base64');
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error(`Could not create the SQLite backup snapshot: ${errorMessage(error)}`);
    }
    /* no database yet */
  }

  const bundle: BackupBundle = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    stores,
    sqliteBase64,
    ...(opts.includeKey === false ? {} : { secretKeyHex: exportSecretKeyHex() }),
  };
  audit('system', 'backup exported', `stores: ${Object.keys(stores).length}, sqlite: ${sqliteBase64 ? 'yes' : 'no'}, key: ${bundle.secretKeyHex ? 'included' : 'omitted'}`);
  return bundle;
}

export function buildBackup(opts: { includeKey?: boolean } = {}): Promise<BackupBundle> {
  return withOwnershipStoreFence(() => buildBackupUnlocked(opts));
}

export interface RestoreResult {
  ok: boolean;
  restored: string[];
  warnings: string[];
  error?: string;
}

interface StagedJsonStore {
  name: (typeof JSON_STORES)[number];
  target: string;
  staged: string;
}

type JsonStoreName = (typeof JSON_STORES)[number];
type RestoreJournalPhase = 'prepared' | 'installing' | 'validating' | 'committed' | 'rolling_back';

interface RestoreFileFingerprint {
  size: number;
  mtimeMs: number;
}

interface RestoreJournalComponent {
  hadPrevious: boolean;
  previous?: RestoreFileFingerprint;
}

interface RestoreJournal {
  version: 1;
  restoreId: string;
  phase: RestoreJournalPhase;
  createdAt: string;
  stores: Array<{ name: JsonStoreName } & RestoreJournalComponent>;
  database?: RestoreJournalComponent;
}

export interface BackupRestoreRecoveryResult {
  recovered: boolean;
  action: 'none' | 'rolled_back' | 'completed_commit';
  restoreId?: string;
}

const RESTORE_JOURNAL_FILE = dataDir('backup-restore-journal.json');
const RESTORE_JOURNAL_PHASES = new Set<RestoreJournalPhase>([
  'prepared', 'installing', 'validating', 'committed', 'rolling_back',
]);

function isBundle(value: unknown): value is BackupBundle {
  const bundle = value as BackupBundle;
  return !!bundle
    && bundle.format === BACKUP_FORMAT
    && typeof bundle.version === 'number'
    && !!bundle.stores
    && typeof bundle.stores === 'object';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function pathFingerprint(file: string): Promise<RestoreFileFingerprint | undefined> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function fingerprintsMatch(
  actual: RestoreFileFingerprint | undefined,
  expected: RestoreFileFingerprint | undefined,
): boolean {
  return Boolean(actual && expected
    && actual.size === expected.size
    && Math.abs(actual.mtimeMs - expected.mtimeMs) <= 1);
}

async function syncFile(file: string): Promise<void> {
  // Windows requires a writable handle for FlushFileBuffers/fsync.
  const handle = await fs.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(file: string, content: string | Buffer): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeDurableFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function copyFileAtomic(source: string, target: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary);
    await syncFile(temporary);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function restoreStorePaths(restoreId: string, name: JsonStoreName): {
  target: string;
  staged: string;
  rollback: string;
} {
  const target = dataDir(name);
  return {
    target,
    staged: `${target}.${restoreId}.restore`,
    rollback: `${target}.${restoreId}.rollback`,
  };
}

function restoreDatabasePaths(restoreId: string): {
  target: string;
  staged: string;
  rollback: string;
} {
  const target = databasePath();
  return {
    target,
    staged: `${target}.${restoreId}.restore`,
    rollback: `${target}.${restoreId}.rollback`,
  };
}

function parseRestoreJournal(value: unknown): RestoreJournal {
  const candidate = value as Partial<RestoreJournal>;
  if (!candidate || candidate.version !== 1
    || typeof candidate.restoreId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.restoreId)
    || typeof candidate.phase !== 'string'
    || !RESTORE_JOURNAL_PHASES.has(candidate.phase as RestoreJournalPhase)
    || typeof candidate.createdAt !== 'string'
    || !Array.isArray(candidate.stores)) {
    throw new Error('Backup restore recovery journal is malformed');
  }
  const seen = new Set<string>();
  const stores = candidate.stores.map((entry) => {
    const name = entry?.name;
    if (!JSON_STORES.includes(name as JsonStoreName) || seen.has(String(name))) {
      throw new Error('Backup restore recovery journal contains an invalid or duplicate store');
    }
    seen.add(String(name));
    return parseJournalComponent(entry, { name: name as JsonStoreName });
  });
  const database = candidate.database === undefined
    ? undefined
    : parseJournalComponent(candidate.database);
  return {
    version: 1,
    restoreId: candidate.restoreId,
    phase: candidate.phase as RestoreJournalPhase,
    createdAt: candidate.createdAt,
    stores,
    ...(database ? { database } : {}),
  };
}

function parseJournalComponent<T extends object>(
  value: Partial<RestoreJournalComponent>,
  extra?: T,
): RestoreJournalComponent & T {
  if (typeof value?.hadPrevious !== 'boolean') {
    throw new Error('Backup restore recovery journal has an invalid component state');
  }
  let previous: RestoreFileFingerprint | undefined;
  if (value.hadPrevious) {
    const raw = value.previous;
    if (!raw || !Number.isFinite(raw.size) || raw.size < 0
      || !Number.isFinite(raw.mtimeMs) || raw.mtimeMs < 0) {
      throw new Error('Backup restore recovery journal is missing its original-file fingerprint');
    }
    previous = { size: Number(raw.size), mtimeMs: Number(raw.mtimeMs) };
  }
  return {
    ...(extra ?? ({} as T)),
    hadPrevious: value.hadPrevious,
    ...(previous ? { previous } : {}),
  } as RestoreJournalComponent & T;
}

async function loadRestoreJournal(): Promise<RestoreJournal | null> {
  try {
    return parseRestoreJournal(JSON.parse(await fs.readFile(RESTORE_JOURNAL_FILE, 'utf8')) as unknown);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function saveRestoreJournal(journal: RestoreJournal): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await writeAtomicJson(RESTORE_JOURNAL_FILE, journal);
}

async function removeStrict(file: string): Promise<void> {
  try {
    await fs.rm(file, { force: true });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function restoreJournalComponent(
  label: string,
  paths: { target: string; staged: string; rollback: string },
  component: RestoreJournalComponent,
): Promise<void> {
  const rollback = await pathFingerprint(paths.rollback);
  if (component.hadPrevious) {
    if (rollback) {
      await removeStrict(paths.target);
      await fs.rename(paths.rollback, paths.target);
    } else {
      const live = await pathFingerprint(paths.target);
      if (!fingerprintsMatch(live, component.previous)) {
        throw new Error(`${label} rollback is missing and the live file is not the original`);
      }
    }
  } else {
    await removeStrict(paths.target);
    await removeStrict(paths.rollback);
  }
  await removeStrict(paths.staged);
}

async function rollbackRestoreJournal(journal: RestoreJournal): Promise<void> {
  journal.phase = 'rolling_back';
  await saveRestoreJournal(journal);
  const errors: Error[] = [];
  if (journal.database) {
    const paths = restoreDatabasePaths(journal.restoreId);
    try {
      await removeStrict(`${paths.target}-wal`);
      await removeStrict(`${paths.target}-shm`);
      await restoreJournalComponent('SQLite database', paths, journal.database);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  for (const store of [...journal.stores].reverse()) {
    try {
      await restoreJournalComponent(store.name, restoreStorePaths(journal.restoreId, store.name), store);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Backup restore rollback was incomplete');
  }
  await removeStrict(RESTORE_JOURNAL_FILE);
}

async function completeCommittedRestoreJournal(journal: RestoreJournal): Promise<void> {
  for (const store of journal.stores) {
    const paths = restoreStorePaths(journal.restoreId, store.name);
    await removeStrict(paths.staged);
    await removeStrict(paths.rollback);
  }
  if (journal.database) {
    const paths = restoreDatabasePaths(journal.restoreId);
    await removeStrict(paths.staged);
    await removeStrict(paths.rollback);
  }
  await removeStrict(RESTORE_JOURNAL_FILE);
}

/**
 * Recover a process exit that interrupted a restore. Call this before starting
 * schedulers or request handling. An uncommitted journal rolls back; a journal
 * whose semantic validation committed is completed by removing old copies.
 */
async function recoverInterruptedBackupRestoreUnlocked(): Promise<BackupRestoreRecoveryResult> {
  const journal = await loadRestoreJournal();
  if (!journal) return { recovered: false, action: 'none' };
  if (journal.phase === 'committed') {
    await completeCommittedRestoreJournal(journal);
    return { recovered: true, action: 'completed_commit', restoreId: journal.restoreId };
  }
  const releaseDatabase = beginDbMaintenance();
  try {
    await rollbackRestoreJournal(journal);
  } finally {
    releaseDatabase();
  }
  getDb();
  return { recovered: true, action: 'rolled_back', restoreId: journal.restoreId };
}

export function recoverInterruptedBackupRestore(): Promise<BackupRestoreRecoveryResult> {
  return withOwnershipStoreFence(recoverInterruptedBackupRestoreUnlocked);
}

function countActiveBackgroundWork(): { runs: number; tasks: number; routines: number } {
  const db = getDb();
  const runs = Number((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'running'").get() as { count: number }).count);
  const tasks = Number((db.prepare(`
    SELECT COUNT(*) AS count FROM tasks
    WHERE status IN ('queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked')
  `).get() as { count: number }).count);
  const routineTable = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'routine_invocations'")
    .get() as { present: number } | undefined;
  const routines = routineTable
    ? Number((db.prepare("SELECT COUNT(*) AS count FROM routine_invocations WHERE status IN ('pending', 'processing')").get() as { count: number }).count)
    : 0;
  return { runs, tasks, routines };
}

function activeWorkError(active: { runs: number; tasks: number; routines: number }): string {
  return `Backup restore is blocked while background work is active (${active.runs} run(s), ${active.tasks} task(s), ${active.routines} routine invocation(s)). Finish or cancel it, then retry.`;
}

async function stopAutomationControlPlane(): Promise<void> {
  const { stopDataIntegritySchedule } = await import('./integrity-coordinator');
  await stopDataIntegritySchedule();
  const { stopBoardAssignmentProcessor } = await import('./board-runner');
  await stopBoardAssignmentProcessor();
  const { stopQueuedRetryDispatcher } = await import('./background-tasks');
  await stopQueuedRetryDispatcher();
  const { stopTaskCommandReconciler } = await import('./task-ledger');
  await stopTaskCommandReconciler();
  const { stopTeamWorkerClaimReconciler } = await import('./task-teams');
  await stopTeamWorkerClaimReconciler();
  const { stopTaskDeliveryPump } = await import('./task-delivery');
  await stopTaskDeliveryPump();
  const { stopRunLeaseReconciler } = await import('./agent-runs-store');
  await stopRunLeaseReconciler();
  const { stopRoutineEngine } = await import('./routines');
  await stopRoutineEngine();
}

async function startAutomationControlPlane(): Promise<void> {
  const { startRunLeaseReconciler } = await import('./agent-runs-store');
  startRunLeaseReconciler();
  const { startTeamWorkerClaimReconciler } = await import('./task-teams');
  startTeamWorkerClaimReconciler();
  const { reconcileProcessingTaskCommands, startTaskCommandReconciler } = await import('./task-ledger');
  await reconcileProcessingTaskCommands();
  startTaskCommandReconciler();
  const { startQueuedRetryDispatcher } = await import('./background-tasks');
  startQueuedRetryDispatcher();
  const { startTaskDeliveryPump } = await import('./task-delivery');
  startTaskDeliveryPump();
  const { startRoutineEngine } = await import('./routines');
  await startRoutineEngine();
}

async function removeFiles(paths: Array<string | undefined>): Promise<void> {
  await Promise.all(paths.filter((path): path is string => Boolean(path)).map((path) => (
    fs.rm(path, { force: true }).catch(() => {})
  )));
}

/**
 * Restore a bundle as one control-plane transaction. All payloads are staged
 * and validated first; then schedulers, delivery, and lease recovery are
 * fenced while JSON and SQLite are swapped. Any failure restores every live
 * component, preventing a mixed-generation "successful" restore.
 */
interface RestoreFenceState {
  intentionallyStopped: boolean;
}

async function restoreBackupUnlocked(
  raw: unknown,
  fenceState: RestoreFenceState,
): Promise<RestoreResult> {
  if (!isBundle(raw)) {
    return { ok: false, restored: [], warnings: [], error: 'Not a Shiba Studio backup file' };
  }
  if (raw.version > BACKUP_VERSION) {
    return {
      ok: false,
      restored: [],
      warnings: [],
      error: `Backup version ${raw.version} is newer than this app supports (${BACKUP_VERSION}) — update Shiba Studio first`,
    };
  }

  const restoreId = randomUUID();
  const warnings: string[] = [];
  const restored: string[] = [];
  const stagedStores: StagedJsonStore[] = [];
  const dbFile = databasePath();
  let stagedDatabase: string | undefined;

  // Validate and stage the complete payload before pausing live services.
  try {
    for (const [candidateName, content] of Object.entries(raw.stores)) {
      if (!JSON_STORES.includes(candidateName as (typeof JSON_STORES)[number])) continue;
      if (typeof content !== 'string') {
        throw new Error(`${candidateName} is not a serialized JSON store`);
      }
      try {
        JSON.parse(content);
      } catch (error) {
        throw new Error(`${candidateName} contains invalid JSON: ${errorMessage(error)}`);
      }
      const name = candidateName as (typeof JSON_STORES)[number];
      const target = dataDir(name);
      const staged = `${target}.${restoreId}.restore`;
      await writeDurableFile(staged, content);
      stagedStores.push({ name, target, staged });
    }
    if (raw.sqliteBase64) {
      stagedDatabase = `${dbFile}.${restoreId}.restore`;
      await writeDurableFile(stagedDatabase, Buffer.from(raw.sqliteBase64, 'base64'));
      validateDatabaseFile(stagedDatabase);
    }
  } catch (error) {
    await removeFiles([
      stagedDatabase,
      ...stagedStores.map((store) => store.staged),
    ]);
    return {
      ok: false,
      restored: [],
      warnings,
      error: `Backup restore payload could not be staged safely: ${errorMessage(error)}`,
    };
  }

  let releaseDatabase: (() => void) | undefined;
  let integrityFailed = false;
  let restoreJournal: RestoreJournal | undefined;
  let restoreCommitted = false;
  let interruptedRecoveryPending = false;

  try {
    // A prior process may have exited between atomic rename phases. Recover it
    // before inspecting live work or starting another restore transaction.
    let interrupted: RestoreJournal | null;
    try {
      interrupted = await loadRestoreJournal();
    } catch (journalError) {
      interruptedRecoveryPending = true;
      integrityFailed = true;
      throw journalError;
    }
    if (interrupted) {
      interruptedRecoveryPending = true;
      try {
        await recoverInterruptedBackupRestoreUnlocked();
        interruptedRecoveryPending = false;
      } catch (recoveryError) {
        integrityFailed = true;
        throw recoveryError;
      }
    } else {
      const preflight = countActiveBackgroundWork();
      if (preflight.runs || preflight.tasks || preflight.routines) {
        return { ok: false, restored: [], warnings, error: activeWorkError(preflight) };
      }
    }

    if (!stagedStores.length && !stagedDatabase) {
      return {
        ok: false,
        restored: [],
        warnings,
        error: 'Backup contains no restorable JSON stores or SQLite database',
      };
    }

    const active = countActiveBackgroundWork();
    if (active.runs || active.tasks || active.routines) {
      return { ok: false, restored: [], warnings, error: activeWorkError(active) };
    }

    releaseDatabase = beginDbMaintenance();

    const journalStores: RestoreJournal['stores'] = [];
    for (const store of stagedStores) {
      const previous = await pathFingerprint(store.target);
      journalStores.push({
        name: store.name,
        hadPrevious: Boolean(previous),
        ...(previous ? { previous } : {}),
      });
    }
    const previousDatabase = stagedDatabase ? await pathFingerprint(dbFile) : undefined;
    restoreJournal = {
      version: 1,
      restoreId,
      phase: 'prepared',
      createdAt: new Date().toISOString(),
      stores: journalStores,
      ...(stagedDatabase ? {
        database: {
          hadPrevious: Boolean(previousDatabase),
          ...(previousDatabase ? { previous: previousDatabase } : {}),
        },
      } : {}),
    };
    await saveRestoreJournal(restoreJournal);
    restoreJournal.phase = 'installing';
    await saveRestoreJournal(restoreJournal);

    for (const component of restoreJournal.stores) {
      const paths = restoreStorePaths(restoreId, component.name);
      if (component.hadPrevious) {
        await copyFileAtomic(paths.target, `${paths.target}.pre-restore`);
        await fs.rename(paths.target, paths.rollback);
      }
      await fs.rename(paths.staged, paths.target);
      restored.push(component.name);
    }

    if (stagedDatabase && restoreJournal.database) {
      const paths = restoreDatabasePaths(restoreId);
      if (restoreJournal.database.hadPrevious) {
        await copyFileAtomic(paths.target, `${paths.target}.pre-restore`);
        await fs.rename(paths.target, paths.rollback);
      }
      await removeFiles([`${dbFile}-wal`, `${dbFile}-shm`]);
      await fs.rename(paths.staged, paths.target);
      restored.push('shiba-studio.db (runs, audit log, memory)');
    }

    restoreJournal.phase = 'validating';
    await saveRestoreJournal(restoreJournal);

    // Reopen immediately so migrations/schema incompatibilities fail inside
    // this transaction while every original file is still available.
    releaseDatabase();
    releaseDatabase = undefined;
    getDb();

    // Install/adopt the key only after every file has successfully reopened.
    // If it is incompatible, the catch block rolls all swapped files back.
    if (raw.secretKeyHex) {
      const keyResult = importSecretKeyHex(raw.secretKeyHex);
      if (!keyResult.ok) throw new Error(keyResult.reason || 'Encryption key was not installed');
      restored.push('encryption key');
    } else {
      warnings.push('Backup contains no encryption key — restored credentials open only if this machine already has the original key');
    }

    // This pass may repair the restored JSON/SQLite generation, but deliberately
    // excludes external storage and Docker. Those side effects cannot be
    // atomically undone with this bundle and therefore run only after commit.
    const { reconcileAllDataIntegrity } = await import('./integrity-coordinator');
    const semanticIntegrity = await reconcileAllDataIntegrity({
      reason: 'backup restore semantic validation',
      includeStorage: false,
      includeExternalCleanup: false,
    });
    if (semanticIntegrity.skippedBecauseLeaseHeld || !semanticIntegrity.database) {
      throw new Error(semanticIntegrity.skippedBecauseLeaseHeld
        ? 'the data-integrity lease is held by another process'
        : 'the restored database was not semantically validated');
    }

    restoreJournal.phase = 'committed';
    await saveRestoreJournal(restoreJournal);
    restoreCommitted = true;
    try {
      await completeCommittedRestoreJournal(restoreJournal);
      restoreJournal = undefined;
    } catch (error) {
      // The committed journal is itself the durable cleanup retry. The live
      // generation is valid, so failing to delete an old copy is not a failed
      // restore and must never trigger rollback.
      warnings.push(`Restore committed, but old staging files still need cleanup (${errorMessage(error)})`);
    }

    // Reconcile binary/app-owned storage only after the JSON+SQLite generation
    // is irrevocably committed. Rolling back after quarantine or Docker side
    // effects would make the previous generation point at moved resources.
    try {
      const storageIntegrity = await reconcileAllDataIntegrity({
        reason: 'backup restore storage reconciliation',
        includeStorage: true,
        minOrphanAgeMs: 0,
      });
      if (
        storageIntegrity.skippedBecauseLeaseHeld
        || storageIntegrity.storage?.errors.length
        || storageIntegrity.binaryStorage?.errors.length
      ) {
        throw new Error(storageIntegrity.skippedBecauseLeaseHeld
          ? 'the data-integrity lease is held by another process'
          : [
              ...(storageIntegrity.storage?.errors || []),
              ...(storageIntegrity.binaryStorage?.errors || []),
            ].join('; '));
      }
    } catch (error) {
      integrityFailed = true;
      warnings.push(`Post-restore storage reconciliation did not finish; background work remains stopped - restart the server (${errorMessage(error)})`);
    }

    try {
      audit('system', 'backup restored', `restored: ${restored.join(', ') || 'nothing'}${warnings.length ? ` · warnings: ${warnings.length}` : ''}`);
    } catch {
      warnings.push('Restore completed, but its audit entry could not be written');
    }
    return { ok: restored.length > 0, restored, warnings };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (restoreJournal && !restoreCommitted) {
      if (!releaseDatabase) {
        try {
          releaseDatabase = beginDbMaintenance();
        } catch (maintenanceError) {
          rollbackErrors.push(`could not enter rollback maintenance: ${errorMessage(maintenanceError)}`);
        }
      }

      if (releaseDatabase) {
        try {
          await rollbackRestoreJournal(restoreJournal);
          restoreJournal = undefined;
        } catch (rollbackError) {
          rollbackErrors.push(errorMessage(rollbackError));
        }
        releaseDatabase();
        releaseDatabase = undefined;
        try {
          getDb();
        } catch (reopenError) {
          rollbackErrors.push(`previous database could not be reopened: ${errorMessage(reopenError)}`);
        }
      }
    }
    if (rollbackErrors.length || interruptedRecoveryPending) integrityFailed = true;

    const recovery = rollbackErrors.length
      ? `Rollback was incomplete: ${rollbackErrors.join('; ')}`
      : interruptedRecoveryPending
        ? 'A prior interrupted restore remains incomplete; its recovery journal was preserved and background work remains fenced.'
        : restoreJournal || restored.length
          ? 'All live files were restored to their pre-restore state.'
          : 'Live files were not changed.';
    return {
      ok: false,
      restored: [],
      warnings,
      error: `Backup restore failed: ${errorMessage(error)} ${recovery}`,
    };
  } finally {
    fenceState.intentionallyStopped = integrityFailed;
    releaseDatabase?.();
    // Never erase evidence needed by an incomplete journal. Staging created
    // before journal persistence is safe to discard.
    if (!restoreJournal) {
      await removeFiles([stagedDatabase, ...stagedStores.map((store) => store.staged)]);
    }
  }
}

export function restoreBackup(raw: unknown): Promise<RestoreResult> {
  const fenceState: RestoreFenceState = { intentionallyStopped: false };
  if (!isBundle(raw) || raw.version > BACKUP_VERSION) {
    return restoreBackupUnlocked(raw, fenceState);
  }
  return (async () => {
    // Refuse active work before joining the control plane. A paused Routine
    // can remain intentionally unsettled, and stopRoutineEngine waits for its
    // execution promise; stopping first would make this request hang forever.
    const initialPreflight = countActiveBackgroundWork();
    if (initialPreflight.runs || initialPreflight.tasks || initialPreflight.routines) {
      return { ok: false, restored: [], warnings: [], error: activeWorkError(initialPreflight) };
    }

    const boardRunner = await import('./board-runner');
    const boardWasRunning = boardRunner.isBoardAssignmentProcessorRunning();
    const releaseFenceMaintenance = beginAutomationMaintenance('backup restore ownership fence');
    let fenceReleased = false;
    const releaseFence = () => {
      if (fenceReleased) return;
      fenceReleased = true;
      releaseFenceMaintenance();
    };
    let result: RestoreResult | undefined;
    let controlPlaneStopStarted = false;
    try {
      // Close the check-to-fence race before awaiting any worker. New Routine
      // dispatch is blocked by maintenance now; restoreBackupUnlocked performs
      // another check after every control-plane loop has fully joined.
      const fencedPreflight = countActiveBackgroundWork();
      if (fencedPreflight.runs || fencedPreflight.tasks || fencedPreflight.routines) {
        return { ok: false, restored: [], warnings: [], error: activeWorkError(fencedPreflight) };
      }

      // Stop and join every control-plane pass before taking the ownership
      // store fence. Otherwise restore could hold the fence while awaiting a
      // worker that is itself queued behind that same fence.
      controlPlaneStopStarted = true;
      await stopAutomationControlPlane();
      result = await withOwnershipStoreFence(() => restoreBackupUnlocked(raw, fenceState));
      if (!fenceState.intentionallyStopped) {
        // Engine startup performs lossless legacy-automation migration and
        // must run after the dispatch fence is released. This request still
        // owns the restore transaction until all services have restarted.
        releaseFence();
        const restartErrors: string[] = [];
        try {
          const { startDataIntegritySchedule } = await import('./integrity-coordinator');
          startDataIntegritySchedule();
        } catch (error) {
          restartErrors.push(`data-integrity schedule: ${errorMessage(error)}`);
        }
        try {
          await startAutomationControlPlane();
        } catch (error) {
          restartErrors.push(`automation control plane: ${errorMessage(error)}`);
        }
        if (boardWasRunning) {
          try {
            boardRunner.startBoardAssignmentProcessor();
          } catch (error) {
            restartErrors.push(`Board assignment processor: ${errorMessage(error)}`);
          }
        }
        if (restartErrors.length) {
          result.warnings.push(`Background services did not all restart automatically — restart the server (${restartErrors.join('; ')})`);
        }
      }
      return result;
    } catch (error) {
      if (!fenceState.intentionallyStopped && controlPlaneStopStarted) {
        try {
          releaseFence();
          const { startDataIntegritySchedule } = await import('./integrity-coordinator');
          startDataIntegritySchedule();
          await startAutomationControlPlane();
          if (boardWasRunning) boardRunner.startBoardAssignmentProcessor();
        } catch {
          // The structured error below tells the operator to restart. Keep the
          // original failure as the primary diagnostic.
        }
      }
      return result ?? {
        ok: false,
        restored: [],
        warnings: ['Background services may need a server restart.'],
        error: `Backup restore could not enter its maintenance transaction: ${errorMessage(error)}`,
      };
    } finally {
      // An incomplete rollback intentionally leaves the process fenced, just
      // by retaining this maintenance token until process restart. A clean
      // success/failure restarts the control plane before requests are admitted.
      if (!fenceState.intentionallyStopped) releaseFence();
    }
  })();
}
