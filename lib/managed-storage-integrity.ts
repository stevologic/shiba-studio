import path from 'path';
import { dataDir } from './data-paths';
import {
  reconcileProjectStorage,
  type ProjectStorageReconcileReport,
} from './projects';
import {
  reconcileUploadMetadata,
  type UploadMetadataReconcileReport,
} from './workspace';
import {
  quarantineManagedPath,
  recoverPreparedManagedQuarantines,
  type PreparedQuarantineRecovery,
} from './managed-storage-quarantine';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

const DEFAULT_GRACE_MS = 24 * 60 * 60_000;
const TOP_LEVEL_MANAGED_FILES = [
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
  'xai-oauth-pending.json',
  'reddit-oauth-pending.json',
  'board.json',
  'shiba-studio.db',
] as const;

export interface StaleManagedFileReport {
  quarantined: number;
  bytesQuarantined: number;
  youngFilesRetained: number;
  errors: string[];
}

export interface ManagedStorageReconcileReport {
  startedAt: string;
  completedAt: string;
  quarantineRecovery: PreparedQuarantineRecovery;
  projects: Omit<ProjectStorageReconcileReport, 'validProjectFileKeys'> | null;
  uploadMetadata: UploadMetadataReconcileReport | null;
  staleManagedFiles: StaleManagedFileReport;
  errors: string[];
}

export interface ManagedStorageReconcileOptions {
  nowMs?: number;
  /** Grace for unindexed project bytes. Zero is useful only in isolated tests. */
  minOrphanAgeMs?: number;
  /** Grace for abandoned atomic-write/restore staging files. */
  minTemporaryAgeMs?: number;
  /** Avoid loading config when the caller already has its workspace snapshot. */
  defaultWorkspace?: string;
}

interface ManagedStorageGlobals {
  __shibaManagedStorageReconcile?: Promise<ManagedStorageReconcileReport>;
}

const globals = globalThis as typeof globalThis & ManagedStorageGlobals;

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegativeDuration(value: number | undefined, fallback: number): number {
  return Math.max(0, finiteNumber(value, fallback));
}

function isTopLevelLeftover(name: string): boolean {
  if (name.endsWith('.pre-restore')) return false;
  return TOP_LEVEL_MANAGED_FILES.some((base) => {
    if (name === `${base}.tmp`) return true;
    if (!name.startsWith(`${base}.`)) return false;
    return name.endsWith('.tmp') || name.endsWith('.restore') || name.endsWith('.rollback');
  });
}

async function collectNestedLeftovers(): Promise<string[]> {
  const found: string[] = [];
  const meetingAudio = dataDir('meetings', 'audio');
  for (const entry of await fs.readdir(meetingAudio, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() && entry.name.includes('.upload-')) found.push(path.join(meetingAudio, entry.name));
  }

  const registry = dataDir('capability-packs', 'registry');
  const walkRegistry = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walkRegistry(candidate);
      else if (/^pack\.json\..+\.tmp$/i.test(entry.name)) found.push(candidate);
    }
  };
  await walkRegistry(registry);
  return found;
}

async function reconcileStaleManagedFiles(nowMs: number, minAgeMs: number): Promise<StaleManagedFileReport> {
  const report: StaleManagedFileReport = {
    quarantined: 0,
    bytesQuarantined: 0,
    youngFilesRetained: 0,
    errors: [],
  };
  const root = dataDir();
  const candidates: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() && isTopLevelLeftover(entry.name)) candidates.push(path.join(root, entry.name));
  }
  candidates.push(...await collectNestedLeftovers());

  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat) continue;
    const ageMs = nowMs - stat.mtimeMs;
    if (!Number.isFinite(ageMs) || ageMs < minAgeMs) {
      report.youngFilesRetained += 1;
      continue;
    }
    try {
      await quarantineManagedPath(candidate, 'stale_managed_staging_file', {
        originalRelativePath: path.relative(root, candidate),
      }, nowMs);
      report.quarantined += 1;
      report.bytesQuarantined += stat.isFile() ? stat.size : 0;
    } catch (error) {
      report.errors.push(`${path.relative(root, candidate)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

async function runReconciliation(options: ManagedStorageReconcileOptions): Promise<ManagedStorageReconcileReport> {
  const nowMs = finiteNumber(options.nowMs, Date.now());
  const minOrphanAgeMs = nonNegativeDuration(options.minOrphanAgeMs, DEFAULT_GRACE_MS);
  const minTemporaryAgeMs = nonNegativeDuration(options.minTemporaryAgeMs, DEFAULT_GRACE_MS);
  const errors: string[] = [];
  const quarantineRecovery = await recoverPreparedManagedQuarantines();
  errors.push(...quarantineRecovery.errors.map((error) => `lost+found: ${error}`));

  let projectInternal: ProjectStorageReconcileReport | null = null;
  try {
    projectInternal = await reconcileProjectStorage({ nowMs, minOrphanAgeMs });
    errors.push(...projectInternal.errors.map((error) => `projects: ${error}`));
  } catch (error) {
    // Fail closed: without the authoritative projects store, no project blob
    // is classified or moved.
    errors.push(`projects: ${error instanceof Error ? error.message : String(error)}`);
  }

  let uploadMetadata: UploadMetadataReconcileReport | null = null;
  if (projectInternal?.ownershipScanComplete) {
    try {
      let defaultWorkspace = options.defaultWorkspace;
      if (defaultWorkspace === undefined) {
        const { loadConfig } = await import('./persistence');
        defaultWorkspace = (await loadConfig()).defaultWorkspace;
      }
      uploadMetadata = await reconcileUploadMetadata({
        validProjectFileKeys: new Set(projectInternal.validProjectFileKeys),
        defaultWorkspace,
        nowMs,
      });
    } catch (error) {
      errors.push(`uploads metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (projectInternal) {
    errors.push('uploads metadata: skipped because project ownership was incomplete');
  }

  const staleManagedFiles = await reconcileStaleManagedFiles(nowMs, minTemporaryAgeMs);
  errors.push(...staleManagedFiles.errors.map((error) => `staging: ${error}`));
  let projects: Omit<ProjectStorageReconcileReport, 'validProjectFileKeys'> | null = null;
  if (projectInternal) {
    const { validProjectFileKeys, ...publicReport } = projectInternal;
    void validProjectFileKeys;
    projects = publicReport;
  }
  return {
    startedAt: new Date(nowMs).toISOString(),
    completedAt: new Date().toISOString(),
    quarantineRecovery,
    projects,
    uploadMetadata,
    staleManagedFiles,
    errors,
  };
}

/**
 * Reconcile app-owned managed storage. Concurrent callers share one pass;
 * subsequent passes are idempotent and report no already-repaired items.
 */
export function reconcileManagedStorage(
  options: ManagedStorageReconcileOptions = {},
): Promise<ManagedStorageReconcileReport> {
  if (globals.__shibaManagedStorageReconcile) return globals.__shibaManagedStorageReconcile;
  const run = runReconciliation(options).finally(() => {
    if (globals.__shibaManagedStorageReconcile === run) {
      globals.__shibaManagedStorageReconcile = undefined;
    }
  });
  globals.__shibaManagedStorageReconcile = run;
  return run;
}
