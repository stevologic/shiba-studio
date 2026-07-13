import { randomUUID } from 'crypto';
import path from 'path';
import { dataDir } from './data-paths';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

export type ManagedQuarantineState = 'prepared' | 'quarantined' | 'recorded' | 'missing';

export interface ManagedQuarantineManifest {
  version: 1;
  id: string;
  state: ManagedQuarantineState;
  reason: string;
  originalRelativePath?: string;
  discoveredAt: string;
  quarantinedAt?: string;
  size?: number;
  modifiedAt?: string;
  entryType?: 'file' | 'directory' | 'symbolic_link' | 'other';
  details: Record<string, unknown>;
}

export interface ManagedQuarantineResult {
  id: string;
  itemDirectory: string;
  manifestPath: string;
  payloadPath?: string;
}

const quarantineGlobals = globalThis as typeof globalThis & {
  __shibaManagedQuarantineChain?: Promise<unknown>;
};

function withQuarantineLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = quarantineGlobals.__shibaManagedQuarantineChain ?? Promise.resolve();
  const run = previous.then(operation, operation);
  quarantineGlobals.__shibaManagedQuarantineChain = run.then(() => undefined, () => undefined);
  return run;
}

function storageRelative(candidate: string): string {
  const root = path.resolve(dataDir());
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Managed quarantine only accepts paths inside the Shiba data directory');
  }
  const first = relative.split(path.sep)[0]?.toLowerCase();
  if (first === 'lost+found') throw new Error('A lost+found item cannot be quarantined again');
  return relative;
}

function quarantineRoot(): string {
  return dataDir('lost+found', 'managed-storage');
}

async function writeManifestAtomic(target: string, manifest: ManagedQuarantineManifest): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function itemId(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${randomUUID()}`;
}

type ManagedStat = Awaited<ReturnType<typeof fs.lstat>>;

function entryType(stat: ManagedStat): NonNullable<ManagedQuarantineManifest['entryType']> {
  if (stat.isSymbolicLink()) return 'symbolic_link';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

function matchesPreparedSource(stat: ManagedStat, manifest: ManagedQuarantineManifest): boolean {
  if (manifest.entryType && entryType(stat) !== manifest.entryType) return false;
  if (manifest.size !== undefined && stat.size !== manifest.size) return false;
  if (manifest.modifiedAt && stat.mtime.toISOString() !== manifest.modifiedAt) return false;
  return true;
}

/**
 * Move an app-owned path to durable lost+found. The prepared manifest is
 * written first, so a process death on either side of rename is recoverable.
 */
export function quarantineManagedPath(
  sourcePath: string,
  reason: string,
  details: Record<string, unknown> = {},
  nowMs = Date.now(),
): Promise<ManagedQuarantineResult> {
  return withQuarantineLock(async () => {
    const originalRelativePath = storageRelative(sourcePath);
    const stat = await fs.lstat(sourcePath);
    const id = itemId(nowMs);
    const itemDirectory = path.join(quarantineRoot(), id);
    const manifestPath = path.join(itemDirectory, 'manifest.json');
    const payloadPath = path.join(itemDirectory, 'payload');
    await fs.mkdir(quarantineRoot(), { recursive: true });
    await fs.mkdir(itemDirectory, { recursive: false });
    const manifest: ManagedQuarantineManifest = {
      version: 1,
      id,
      state: 'prepared',
      reason,
      originalRelativePath,
      discoveredAt: new Date(nowMs).toISOString(),
      ...(stat.isFile() ? { size: stat.size } : {}),
      modifiedAt: stat.mtime.toISOString(),
      entryType: entryType(stat),
      details,
    };
    await writeManifestAtomic(manifestPath, manifest);
    const beforeMove = await fs.lstat(sourcePath);
    if (!matchesPreparedSource(beforeMove, manifest)) {
      manifest.state = 'missing';
      manifest.details = {
        ...manifest.details,
        recoveryConflict: 'source_changed_while_preparing_quarantine',
      };
      await writeManifestAtomic(manifestPath, manifest);
      throw new Error('Managed path changed while quarantine was being prepared');
    }
    await fs.rename(sourcePath, payloadPath);
    manifest.state = 'quarantined';
    manifest.quarantinedAt = new Date().toISOString();
    await writeManifestAtomic(manifestPath, manifest);
    return { id, itemDirectory, manifestPath, payloadPath };
  });
}

/** Preserve a removed dangling reference even when no payload remains. */
export function recordManagedStorageIssue(
  reason: string,
  details: Record<string, unknown> = {},
  nowMs = Date.now(),
): Promise<ManagedQuarantineResult> {
  return withQuarantineLock(async () => {
    const id = itemId(nowMs);
    const itemDirectory = path.join(quarantineRoot(), id);
    const manifestPath = path.join(itemDirectory, 'manifest.json');
    await fs.mkdir(quarantineRoot(), { recursive: true });
    await fs.mkdir(itemDirectory, { recursive: false });
    await writeManifestAtomic(manifestPath, {
      version: 1,
      id,
      state: 'recorded',
      reason,
      discoveredAt: new Date(nowMs).toISOString(),
      quarantinedAt: new Date().toISOString(),
      details,
    });
    return { id, itemDirectory, manifestPath };
  });
}

export interface PreparedQuarantineRecovery {
  recovered: number;
  markedMissing: number;
  errors: string[];
}

/** Finish quarantine renames interrupted by a previous process exit. */
export function recoverPreparedManagedQuarantines(): Promise<PreparedQuarantineRecovery> {
  return withQuarantineLock(async () => {
    const report: PreparedQuarantineRecovery = { recovered: 0, markedMissing: 0, errors: [] };
    const root = quarantineRoot();
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const itemDirectory = path.join(root, entry.name);
      const manifestPath = path.join(itemDirectory, 'manifest.json');
      let manifest: ManagedQuarantineManifest;
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as ManagedQuarantineManifest;
      } catch {
        // Never guess ownership for an unparseable lost+found entry.
        continue;
      }
      if (manifest.version !== 1 || manifest.state !== 'prepared') continue;
      const payloadPath = path.join(itemDirectory, 'payload');
      try {
        const payload = await fs.lstat(payloadPath).catch(() => null);
        if (!payload) {
          if (!manifest.originalRelativePath) throw new Error('Prepared quarantine has no source path');
          const sourcePath = path.resolve(dataDir(), manifest.originalRelativePath);
          storageRelative(sourcePath);
          const source = await fs.lstat(sourcePath).catch(() => null);
          if (source && matchesPreparedSource(source, manifest)) {
            await fs.rename(sourcePath, payloadPath);
          } else if (source) {
            manifest.state = 'missing';
            manifest.details = {
              ...manifest.details,
              recoveryConflict: 'source_changed_after_quarantine_was_prepared',
              observedEntryType: entryType(source),
              observedSize: source.isFile() ? source.size : undefined,
              observedModifiedAt: source.mtime.toISOString(),
            };
            report.markedMissing += 1;
            await writeManifestAtomic(manifestPath, manifest);
            continue;
          }
        }
        if (await fs.lstat(payloadPath).catch(() => null)) {
          manifest.state = 'quarantined';
          manifest.quarantinedAt = new Date().toISOString();
          report.recovered += 1;
        } else {
          manifest.state = 'missing';
          report.markedMissing += 1;
        }
        await writeManifestAtomic(manifestPath, manifest);
      } catch (error) {
        report.errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
  });
}
