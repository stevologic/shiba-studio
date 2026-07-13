// One-file backup & restore. The bundle is a single JSON document holding
// every JSON store (read raw from disk — credential fields stay AES-sealed),
// the SQLite database (runs + audit log + memory) as base64, and — so a
// restore on a NEW machine can actually open the sealed credentials — the
// machine encryption key. Treat exported bundles like a password.

import { promises as fs } from 'fs';
import { dataDir } from './data-paths';
import { beginDbMaintenance, databasePath, getDb, validateDatabaseFile } from './db';
import { exportSecretKeyHex, importSecretKeyHex } from './secure-store';
import { audit } from './audit-log';
import { randomUUID } from 'crypto';

export const BACKUP_FORMAT = 'shiba-studio-backup';
export const BACKUP_VERSION = 1;

/** Every JSON store under the data dir that belongs in a backup. Binary
 *  artifacts (screenshots, uploaded files) are deliberately excluded. */
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

export async function buildBackup(opts: { includeKey?: boolean } = {}): Promise<BackupBundle> {
  const stores: Record<string, string> = {};
  for (const name of JSON_STORES) {
    try {
      stores[name] = await fs.readFile(dataDir(name), 'utf8');
    } catch {
      /* store doesn't exist yet — skip */
    }
  }

  let sqliteBase64: string | null = null;
  try {
    // Fold the WAL into the main file so the copy is a complete snapshot.
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    sqliteBase64 = (await fs.readFile(databasePath())).toString('base64');
  } catch {
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

export interface RestoreResult {
  ok: boolean;
  restored: string[];
  warnings: string[];
  error?: string;
}

function isBundle(value: unknown): value is BackupBundle {
  const b = value as BackupBundle;
  return !!b && b.format === BACKUP_FORMAT && typeof b.version === 'number' && !!b.stores && typeof b.stores === 'object';
}

/**
 * Restore a bundle into the live data dir. Existing stores are saved to
 * `<name>.pre-restore` first, so a bad import is recoverable by hand.
 */
export async function restoreBackup(raw: unknown): Promise<RestoreResult> {
  if (!isBundle(raw)) {
    return { ok: false, restored: [], warnings: [], error: 'Not a Shiba Studio backup file' };
  }
  if (raw.version > BACKUP_VERSION) {
    return { ok: false, restored: [], warnings: [], error: `Backup version ${raw.version} is newer than this app supports (${BACKUP_VERSION}) — update Shiba Studio first` };
  }

  const restored: string[] = [];
  const warnings: string[] = [];

  // 1. Encryption key first — restored stores are useless without it.
  if (raw.secretKeyHex) {
    const keyRes = importSecretKeyHex(raw.secretKeyHex);
    if (keyRes.ok) restored.push('encryption key');
    else {
      return {
        ok: false,
        restored: [],
        warnings: [],
        error: keyRes.reason || 'Encryption key not installed; nothing was restored',
      };
    }
  } else {
    warnings.push('Backup contains no encryption key — restored credentials open only if this machine already has the original key');
  }

  // 2. JSON stores (with .pre-restore safety copies).
  for (const [name, content] of Object.entries(raw.stores)) {
    if (!JSON_STORES.includes(name as (typeof JSON_STORES)[number])) continue; // never write arbitrary paths
    if (typeof content !== 'string') continue;
    const target = dataDir(name);
    try {
      JSON.parse(content); // refuse corrupt payloads
      try { await fs.copyFile(target, `${target}.pre-restore`); } catch { /* no existing store */ }
      await fs.writeFile(target, content, 'utf8');
      restored.push(name);
    } catch {
      warnings.push(`${name}: invalid JSON in backup — skipped`);
    }
  }

  // 3. SQLite database (runs + audit log). Close the shared handle, swap the
  //    file, reopen lazily on next access (migrations re-run automatically).
  if (raw.sqliteBase64) {
    const dbFile = databasePath();
    const previousFile = `${dbFile}.pre-restore`;
    const stagedFile = `${dbFile}.${randomUUID()}.restore`;
    let hadPrevious = false;
    let liveSwapStarted = false;
    let releaseMaintenance: (() => void) | undefined;
    try {
      await fs.writeFile(stagedFile, Buffer.from(raw.sqliteBase64, 'base64'));
      validateDatabaseFile(stagedFile);
      releaseMaintenance = beginDbMaintenance();
      liveSwapStarted = true;
      try {
        await fs.copyFile(dbFile, previousFile);
        hadPrevious = true;
      } catch { /* fresh install */ }
      for (const ext of ['-wal', '-shm']) {
        try { await fs.rm(dbFile + ext, { force: true }); } catch { /* fine */ }
      }
      await fs.rm(dbFile, { force: true });
      await fs.rename(stagedFile, dbFile);
      releaseMaintenance();
      releaseMaintenance = undefined;
      getDb(); // reopen + validate immediately so a corrupt import fails loudly here
      restored.push('shiba-studio.db (runs, audit log, memory)');
    } catch (e) {
      const restoreError = e instanceof Error ? e.message : String(e);
      let rollbackError = '';
      if (liveSwapStarted) {
        releaseMaintenance ??= beginDbMaintenance();
        try { await fs.rm(dbFile, { force: true }); } catch { /* fine */ }
        for (const ext of ['-wal', '-shm']) {
          try { await fs.rm(dbFile + ext, { force: true }); } catch { /* fine */ }
        }
        if (hadPrevious) {
          try {
            await fs.copyFile(previousFile, dbFile);
          } catch (rollbackCopyError) {
            rollbackError = `could not restore the previous database: ${rollbackCopyError instanceof Error ? rollbackCopyError.message : String(rollbackCopyError)}`;
          }
        }
        releaseMaintenance();
        releaseMaintenance = undefined;
        try {
          getDb();
        } catch (reopenError) {
          const detail = `database could not be reopened: ${reopenError instanceof Error ? reopenError.message : String(reopenError)}`;
          rollbackError = rollbackError ? `${rollbackError}; ${detail}` : detail;
        }
      }
      if (liveSwapStarted) {
        const recovery = rollbackError
          ? `rollback incomplete (${rollbackError})`
          : hadPrevious
            ? 'previous database restored and reopened'
            : 'no previous database existed; a fresh database was opened';
        warnings.push(`SQLite restore failed: ${restoreError} — ${recovery}`);
      } else {
        warnings.push(`SQLite restore rejected before swap: ${restoreError} — live database left unchanged`);
      }
    } finally {
      releaseMaintenance?.();
      await fs.rm(stagedFile, { force: true }).catch(() => {});
    }
  }

  // 4. Rearm schedules against the restored agents.
  try {
    const { loadAndScheduleAll } = await import('./scheduler');
    await loadAndScheduleAll();
  } catch {
    warnings.push('Schedules did not rearm automatically — restart the server');
  }

  audit('system', 'backup restored', `restored: ${restored.join(', ') || 'nothing'}${warnings.length ? ` · warnings: ${warnings.length}` : ''}`);
  return { ok: restored.length > 0, restored, warnings };
}
