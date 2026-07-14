import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

const DEFAULT_TIMEOUT_MS = 30_000;
const MALFORMED_LOCK_GRACE_MS = 5_000;
const TRANSIENT_WINDOWS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

interface StoreLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

interface ActiveLockSnapshot {
  raw: string;
  owner: StoreLockOwner | null;
  mtimeMs: number;
  identity: string;
}

interface StoreLockGlobals {
  __shibaStoreFileLockChains?: Map<string, Promise<unknown>>;
  __shibaStoreFileLockContext?: AsyncLocalStorage<ReadonlyMap<string, string>>;
  __shibaActiveStoreFileLockTokens?: Set<string>;
}

const globals = globalThis as typeof globalThis & StoreLockGlobals;
const lockChains = globals.__shibaStoreFileLockChains
  ?? (globals.__shibaStoreFileLockChains = new Map());
const lockContext = globals.__shibaStoreFileLockContext
  ?? (globals.__shibaStoreFileLockContext = new AsyncLocalStorage<ReadonlyMap<string, string>>());
const activeContextTokens = globals.__shibaActiveStoreFileLockTokens
  ?? (globals.__shibaActiveStoreFileLockTokens = new Set());

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function parseOwner(raw: string): StoreLockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<StoreLockOwner>;
    if (
      Number.isInteger(value.pid)
      && Number(value.pid) > 0
      && typeof value.token === 'string'
      && /^[a-f0-9-]{20,}$/i.test(value.token)
      && typeof value.createdAt === 'string'
      && Number.isFinite(Date.parse(value.createdAt))
    ) {
      return value as StoreLockOwner;
    }
  } catch {
    // Corrupt legacy/manual lock generations use the malformed grace path.
  }
  return null;
}

function directoryIdentity(stat: Awaited<ReturnType<typeof fs.stat>>): string {
  return `${String(stat.dev)}:${String(stat.ino)}:${stat.birthtimeMs}`;
}

function lockRoot(target: string): string {
  return `${path.resolve(target)}.lock`;
}

function transientWindowsError(error: unknown): boolean {
  return TRANSIENT_WINDOWS_CODES.has(String((error as NodeJS.ErrnoException)?.code));
}

async function ensureGenerationLockRoot(root: string, deadline: number, target: string): Promise<void> {
  await fs.mkdir(path.dirname(root), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(root);
      return;
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException)?.code);
      if (code !== 'EEXIST') {
        if (transientWindowsError(error) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw error;
      }
    }

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    let raw: string;
    try {
      stat = await fs.lstat(root);
      if (stat.isDirectory() && !stat.isSymbolicLink()) return;
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Refusing unsafe ${path.basename(target)} store lock root`);
      }
      raw = await fs.readFile(root, 'utf8');
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException)?.code);
      if (code === 'ENOENT' || (transientWindowsError(error) && Date.now() < deadline)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw error;
    }

    // Before generation-directory locks, the worktree registry used this
    // pathname as a single JSON lock file. Respect a live legacy owner, but
    // atomically retire a dead/crashed generation so upgrades self-heal.
    const owner = parseOwner(raw);
    const abandoned = owner
      ? !processIsAlive(owner.pid)
      : Date.now() - stat.mtimeMs >= MALFORMED_LOCK_GRACE_MS;
    if (abandoned) {
      let currentStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
      let currentRaw: string | null = null;
      try {
        [currentStat, currentRaw] = await Promise.all([
          fs.lstat(root),
          fs.readFile(root, 'utf8'),
        ]);
      } catch (error) {
        const code = String((error as NodeJS.ErrnoException)?.code);
        if (code !== 'ENOENT' && !transientWindowsError(error)) throw error;
      }
      const sameLegacyGeneration = currentStat?.isFile()
        && !currentStat.isSymbolicLink()
        && directoryIdentity(currentStat) === directoryIdentity(stat)
        && currentRaw === raw;
      if (sameLegacyGeneration) {
        const identity = createHash('sha256')
          .update(`${directoryIdentity(stat)}\0${raw}`)
          .digest('hex')
          .slice(0, 32);
        const retired = `${root}.retired-legacy-${identity}`;
        try {
          await fs.rename(root, retired);
          await fs.unlink(retired).catch(() => undefined);
        } catch (error) {
          const code = String((error as NodeJS.ErrnoException)?.code);
          if (!['ENOENT', 'EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error;
        }
        continue;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the ${path.basename(target)} store lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
  }
}

async function sealMissingOwnerGeneration(active: string): Promise<boolean> {
  const marker = path.join(active, '.malformed-generation');
  try {
    const handle = await fs.open(marker, 'wx', 0o600);
    try {
      await handle.writeFile('Malformed store-lock generation.\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return true;
    if (transientWindowsError(error)) return false;
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Shared generation fence for ownership-bearing JSON stores in one data dir. */
export function ownershipStoreFencePath(directory: string): string {
  return path.join(path.resolve(directory), '.ownership-stores');
}

/** Exposed for isolated concurrency verification and restore fencing. */
export function storeFileLockActivePath(target: string): string {
  return path.join(lockRoot(target), 'active');
}

async function readActiveLock(active: string): Promise<ActiveLockSnapshot | null | undefined> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(active);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    // Windows can briefly deny inspection while another process renames the
    // directory. Treat that as contention; the deadline still bounds it.
    if (TRANSIENT_WINDOWS_CODES.has(String(code))) return undefined;
    throw error;
  }

  const ownerFile = path.join(active, 'owner.json');
  try {
    const raw = await fs.readFile(ownerFile, 'utf8');
    return { raw, owner: parseOwner(raw), mtimeMs: stat.mtimeMs, identity: directoryIdentity(stat) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (TRANSIENT_WINDOWS_CODES.has(String(code))) return undefined;
    if (code !== 'ENOENT') throw error;
    // Active generations are published by renaming a fully-written candidate,
    // so a missing owner file is abandoned corruption, never a live write gap.
    // Seal the malformed directory before exposing it to reapers. Even an
    // empty corrupt generation then becomes a non-empty permanent tombstone,
    // so a delayed POSIX rename cannot replace it with a later live owner.
    if (!await sealMissingOwnerGeneration(active)) return undefined;
    try {
      const [raw, freshStat] = await Promise.all([
        fs.readFile(ownerFile, 'utf8'),
        fs.stat(active),
      ]);
      return {
        raw,
        owner: parseOwner(raw),
        mtimeMs: freshStat.mtimeMs,
        identity: directoryIdentity(freshStat),
      };
    } catch (retryError) {
      const retryCode = (retryError as NodeJS.ErrnoException)?.code;
      if (TRANSIENT_WINDOWS_CODES.has(String(retryCode))) return undefined;
      if (retryCode !== 'ENOENT') throw retryError;
    }
    let stillActive: Awaited<ReturnType<typeof fs.stat>> | null;
    try {
      stillActive = await fs.stat(active);
    } catch (statError) {
      const statCode = (statError as NodeJS.ErrnoException)?.code;
      if (TRANSIENT_WINDOWS_CODES.has(String(statCode))) return undefined;
      if (statCode !== 'ENOENT') throw statError;
      stillActive = null;
    }
    return stillActive
      ? {
          raw: '<missing-owner>',
          owner: null,
          mtimeMs: Math.min(stat.mtimeMs, stillActive.mtimeMs),
          identity: directoryIdentity(stillActive),
        }
      : null;
  }
}

function transientRenameError(error: unknown): boolean {
  return ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(
    String((error as NodeJS.ErrnoException)?.code),
  );
}

async function publishCandidate(root: string, owner: StoreLockOwner): Promise<string> {
  const candidate = path.join(root, `candidate-${owner.token}`);
  await fs.mkdir(candidate);
  const ownerFile = path.join(candidate, 'owner.json');
  const handle = await fs.open(ownerFile, 'wx', 0o600);
  let writeError: unknown;
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    writeError = error;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (writeError) {
    await fs.rm(candidate, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
      .catch(() => undefined);
    throw writeError;
  }
  return candidate;
}

async function cleanupAbandonedCandidates(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('released-')) {
      await fs.rm(path.join(root, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 20,
      }).catch(() => undefined);
      continue;
    }
    if (!entry.isDirectory() || !entry.name.startsWith('candidate-')) continue;
    const candidate = path.join(root, entry.name);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(path.join(candidate, 'owner.json'), 'utf8'),
        fs.stat(candidate),
      ]);
      const owner = parseOwner(raw);
      const abandoned = owner
        ? !processIsAlive(owner.pid)
        : Date.now() - stat.mtimeMs >= MALFORMED_LOCK_GRACE_MS;
      if (abandoned) {
        await fs.rm(candidate, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 20,
        });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        const stat = await fs.stat(candidate).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs >= MALFORMED_LOCK_GRACE_MS) {
          await fs.rm(candidate, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 20,
          }).catch(() => undefined);
        }
        continue;
      }
      if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(String(code))) throw error;
    }
  }
}

async function tryReapAbandonedLock(
  root: string,
  active: string,
  snapshot: ActiveLockSnapshot,
): Promise<void> {
  const abandoned = snapshot.owner
    ? !processIsAlive(snapshot.owner.pid)
    : Date.now() - snapshot.mtimeMs >= MALFORMED_LOCK_GRACE_MS;
  if (!abandoned) return;

  const generation = snapshot.owner?.token
    || `malformed-${createHash('sha256')
      .update(`${snapshot.identity}\0${snapshot.raw}`)
      .digest('hex')
      .slice(0, 32)}`;
  const tombstone = path.join(root, `reaped-${generation}`);

  // Re-read the immutable generation immediately before the atomic rename.
  // Every reaper for this generation uses the same permanent destination. The
  // first rename wins; later stale reapers cannot rename a newly-acquired
  // active directory over that non-empty tombstone (closing the ABA race).
  const current = await readActiveLock(active);
  const sameGeneration = current
    && current !== undefined
    && (snapshot.owner
      ? current.owner?.token === snapshot.owner.token
      : !current.owner
        && current.raw === snapshot.raw
        && current.identity === snapshot.identity);
  if (!sameGeneration) return;
  try {
    await fs.rename(active, tombstone);
  } catch (error) {
    if (!transientRenameError(error) && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function acquireStoreFileLock(
  target: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<() => Promise<void>> {
  const root = lockRoot(target);
  const active = storeFileLockActivePath(target);
  const deadline = Date.now() + Math.max(1, timeoutMs);
  await ensureGenerationLockRoot(root, deadline, target);
  await cleanupAbandonedCandidates(root);
  const owner: StoreLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const candidate = await publishCandidate(root, owner);

  try {
    while (true) {
      try {
        await fs.rename(candidate, active);
        let released = false;
        return async () => {
          if (released) return;
          const releaseDeadline = Date.now() + DEFAULT_TIMEOUT_MS;
          const releasedGeneration = path.join(root, `released-${owner.token}`);
          while (true) {
            const current = await readActiveLock(active);
            if (current === null) {
              released = true;
              return;
            }
            if (current && current.owner && current.owner.token !== owner.token) {
              released = true;
              return;
            }

            if (current !== undefined) {
              try {
                // Renaming first releases the reusable `active` pathname
                // atomically. Cleanup of the generation can then tolerate a
                // Windows indexer holding a transient handle without blocking
                // the next owner.
                await fs.rename(active, releasedGeneration);
                released = true;
                await fs.rm(releasedGeneration, {
                  recursive: true,
                  force: true,
                  maxRetries: 10,
                  retryDelay: 20,
                }).catch(() => undefined);
                return;
              } catch (error) {
                const code = (error as NodeJS.ErrnoException)?.code;
                if (code === 'ENOENT') continue;
                if (!transientRenameError(error)) throw error;

                // Directory removal succeeds more reliably than rename on
                // some Windows filesystems. If it partially succeeds, the
                // next loop seals/removes the remaining malformed directory.
                try {
                  await fs.rm(active, {
                    recursive: true,
                    force: true,
                    maxRetries: 10,
                    retryDelay: 20,
                  });
                  released = true;
                  return;
                } catch (removeError) {
                  if (!transientWindowsError(removeError)
                    && (removeError as NodeJS.ErrnoException)?.code !== 'ENOTEMPTY') {
                    throw removeError;
                  }
                }
              }
            }

            if (Date.now() >= releaseDeadline) {
              throw new Error(`Timed out releasing the ${path.basename(target)} store lock`);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        };
      } catch (error) {
        if (!transientRenameError(error)) throw error;
      }

      const snapshot = await readActiveLock(active);
      if (snapshot && snapshot !== undefined) await tryReapAbandonedLock(root, active, snapshot);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the ${path.basename(target)} store lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
    }
  } finally {
    // After a successful rename the candidate path no longer exists. On
    // timeout/error this removes only our immutable unpublished generation.
    await fs.rm(candidate, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
      .catch(() => undefined);
  }
}

/**
 * Serialize a JSON store across every module graph and server process that
 * shares its data directory. The caller still owns its read-modify-write; this
 * helper supplies the exclusive process boundary around that operation.
 */
export function withStoreFileLock<T>(
  target: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const key = normalizedPath(target);
  const inheritedLocks = lockContext.getStore();
  const inheritedToken = inheritedLocks?.get(key);
  if (inheritedToken && activeContextTokens.has(inheritedToken)) {
    return Promise.resolve().then(operation);
  }
  const previous = lockChains.get(key) ?? Promise.resolve();
  const execute = async () => {
    const release = await acquireStoreFileLock(target, options.timeoutMs);
    const contextToken = randomUUID();
    activeContextTokens.add(contextToken);
    try {
      const heldLocks = new Map(inheritedLocks || []);
      heldLocks.set(key, contextToken);
      return await lockContext.run(heldLocks, operation);
    } finally {
      activeContextTokens.delete(contextToken);
      await release();
    }
  };
  const run = previous.then(execute, execute);
  const settled = run.then(() => undefined, () => undefined);
  lockChains.set(key, settled);
  void settled.finally(() => {
    if (lockChains.get(key) === settled) lockChains.delete(key);
  });
  return run;
}
