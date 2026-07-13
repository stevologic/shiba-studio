import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDir } from './data-paths';
import { getDb } from './db';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;
const execFileAsync = promisify(execFile);
const STORE = dataDir('worktree-resources.json');
const STORE_LOCK = `${STORE}.lock`;
const STORE_LOCK_TIMEOUT_MS = 30_000;
// A healthy writer fills the lock file immediately after exclusive creation.
// A still-malformed file after this window is a crash artifact.
const ABANDONED_MALFORMED_LOCK_MS = 5_000;
const storeGlobals = globalThis as typeof globalThis & { __shibaWorktreeResourceChain?: Promise<unknown> };

export interface WorktreeResourceRecord {
  id: string;
  baseWorkspace: string;
  agentId: string;
  worktreePath: string;
  taskId?: string;
  state: 'creating' | 'active' | 'delete_requested' | 'attention';
  createdAt: string;
  updatedAt: string;
  deleteRequestedAt?: string;
  attention?: string;
}

interface WorktreeResourceStore { resources: WorktreeResourceRecord[] }

export interface WorktreeIntegrityReport {
  tracked: number;
  discovered: number;
  removed: number;
  attention: number;
  errors: string[];
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

async function acquireStoreFileLock(): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(STORE_LOCK), { recursive: true });
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  const token = randomUUID();
  while (true) {
    try {
      const handle = await fs.open(STORE_LOCK, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.rm(STORE_LOCK, { force: true }).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        try {
          const current = JSON.parse(await fs.readFile(STORE_LOCK, 'utf8')) as { token?: string };
          if (current.token === token) await fs.rm(STORE_LOCK, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }

    let abandonedSnapshot: string | undefined;
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(STORE_LOCK, 'utf8'),
        fs.stat(STORE_LOCK),
      ]);
      try {
        const owner = JSON.parse(raw) as { pid?: number };
        if (typeof owner.pid === 'number' && !processIsAlive(owner.pid)) abandonedSnapshot = raw;
      } catch {
        if (Date.now() - stat.mtimeMs >= ABANDONED_MALFORMED_LOCK_MS) abandonedSnapshot = raw;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
    if (abandonedSnapshot !== undefined) {
      const current = await fs.readFile(STORE_LOCK, 'utf8').catch(() => undefined);
      if (current === abandonedSnapshot) {
        await fs.rm(STORE_LOCK, { force: true }).catch(() => undefined);
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the worktree resource registry lock');
    }
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
  }
}

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = storeGlobals.__shibaWorktreeResourceChain ?? Promise.resolve();
  const execute = async () => {
    const release = await acquireStoreFileLock();
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  const run = previous.then(execute, execute);
  storeGlobals.__shibaWorktreeResourceChain = run.then(() => undefined, () => undefined);
  return run;
}

function exactResource(baseWorkspace: string, agentId: string): { base: string; agentId: string; worktree: string } {
  const base = path.resolve(baseWorkspace);
  const id = agentId.trim();
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    || id === '.'
    || id === '..'
    || id.endsWith('.')
    || windowsReserved.test(id)) {
    throw new Error('Invalid worktree resource agent id');
  }
  const root = path.resolve(base, '.worktrees');
  const worktree = path.resolve(root, id);
  if (path.dirname(worktree) !== root) throw new Error('Worktree resource escapes its workspace');
  return { base, agentId: id, worktree };
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resourceKey(baseWorkspace: string, agentId: string): string {
  const exact = exactResource(baseWorkspace, agentId);
  const base = process.platform === 'win32' ? exact.base.toLowerCase() : exact.base;
  return `${base}\0${exact.agentId}`;
}

async function loadStore(): Promise<WorktreeResourceStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE, 'utf8')) as { resources?: unknown };
    if (!Array.isArray(parsed.resources)) throw new Error('Invalid worktree resource registry');
    const states = new Set<WorktreeResourceRecord['state']>([
      'creating', 'active', 'delete_requested', 'attention',
    ]);
    const keys = new Set<string>();
    const ids = new Set<string>();
    const resources = parsed.resources.map((value, index) => {
      const record = value as Partial<WorktreeResourceRecord>;
      if (!record || typeof record.id !== 'string' || !record.id
        || typeof record.baseWorkspace !== 'string'
        || typeof record.agentId !== 'string'
        || typeof record.worktreePath !== 'string'
        || typeof record.state !== 'string'
        || !states.has(record.state as WorktreeResourceRecord['state'])
        || typeof record.createdAt !== 'string'
        || typeof record.updatedAt !== 'string'
        || !Number.isFinite(Date.parse(record.createdAt))
        || !Number.isFinite(Date.parse(record.updatedAt))
        || (record.taskId !== undefined && typeof record.taskId !== 'string')
        || (record.deleteRequestedAt !== undefined && typeof record.deleteRequestedAt !== 'string')
        || (record.deleteRequestedAt !== undefined && !Number.isFinite(Date.parse(record.deleteRequestedAt)))
        || (record.attention !== undefined && typeof record.attention !== 'string')) {
        throw new Error(`Invalid worktree resource registry record at index ${index}`);
      }
      const exact = exactResource(record.baseWorkspace, record.agentId);
      if (!samePath(record.worktreePath, exact.worktree)) {
        throw new Error(`Worktree resource registry path mismatch at index ${index}`);
      }
      const key = resourceKey(exact.base, exact.agentId);
      if (keys.has(key) || ids.has(record.id)) {
        throw new Error(`Duplicate worktree resource registry record at index ${index}`);
      }
      keys.add(key);
      ids.add(record.id);
      return {
        id: record.id,
        baseWorkspace: exact.base,
        agentId: exact.agentId,
        worktreePath: exact.worktree,
        ...(record.taskId?.trim() ? { taskId: record.taskId.trim() } : {}),
        state: record.state as WorktreeResourceRecord['state'],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.deleteRequestedAt ? { deleteRequestedAt: record.deleteRequestedAt } : {}),
        ...(record.attention ? { attention: record.attention } : {}),
      } satisfies WorktreeResourceRecord;
    });
    return { resources };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { resources: [] };
    throw error;
  }
}

async function saveStore(store: WorktreeResourceStore): Promise<void> {
  await fs.mkdir(path.dirname(STORE), { recursive: true });
  const temporary = `${STORE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, STORE);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function registerWorktreeResource(input: {
  baseWorkspace: string;
  agentId: string;
  taskId?: string;
  active?: boolean;
}): Promise<WorktreeResourceRecord> {
  const exact = exactResource(input.baseWorkspace, input.agentId);
  const taskId = input.taskId?.trim() || undefined;
  return withStoreLock(async () => {
    const store = await loadStore();
    const now = new Date().toISOString();
    const key = resourceKey(exact.base, exact.agentId);
    let record = store.resources.find((item) => resourceKey(item.baseWorkspace, item.agentId) === key);
    if (!record) {
      record = {
        id: randomUUID(),
        baseWorkspace: exact.base,
        agentId: exact.agentId,
        worktreePath: exact.worktree,
        ...(taskId ? { taskId } : {}),
        state: input.active ? 'active' : 'creating',
        createdAt: now,
        updatedAt: now,
      };
      store.resources.push(record);
    } else {
      record.taskId = taskId;
      record.state = input.active ? 'active' : 'creating';
      record.updatedAt = now;
      record.attention = undefined;
      record.deleteRequestedAt = undefined;
    }
    await saveStore(store);
    return { ...record };
  });
}

export async function requestWorktreeResourceDeletion(
  baseWorkspace: string,
  agentId: string,
  reason = 'Owner no longer needs this worktree.',
): Promise<void> {
  const exact = exactResource(baseWorkspace, agentId);
  await withStoreLock(async () => {
    const store = await loadStore();
    const now = new Date().toISOString();
    const key = resourceKey(exact.base, exact.agentId);
    let record = store.resources.find((item) => resourceKey(item.baseWorkspace, item.agentId) === key);
    if (!record) {
      record = {
        id: randomUUID(), baseWorkspace: exact.base, agentId: exact.agentId, worktreePath: exact.worktree,
        state: 'delete_requested', createdAt: now, updatedAt: now,
      };
      store.resources.push(record);
    }
    record.state = 'delete_requested';
    record.deleteRequestedAt ||= now;
    record.attention = reason;
    record.updatedAt = now;
    await saveStore(store);
  });
}

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; error: string }> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout || '', error: '' };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: value.stdout || '', error: value.stderr || value.message || String(error) };
  }
}

async function safelyRemove(record: WorktreeResourceRecord): Promise<{ removed: boolean; attention?: string }> {
  const exact = exactResource(record.baseWorkspace, record.agentId);
  if (!samePath(exact.worktree, record.worktreePath)) {
    return { removed: false, attention: 'Stored worktree path failed ownership validation.' };
  }
  let stat: Awaited<ReturnType<typeof fs.lstat>> | null;
  try {
    stat = await fs.lstat(exact.worktree);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    stat = null;
  }
  if (!stat) {
    await git(['worktree', 'prune'], exact.base).catch(() => undefined);
    return { removed: true };
  }
  if (stat.isSymbolicLink()) {
    return { removed: false, attention: 'Worktree path is a symbolic link or junction and was preserved.' };
  }
  if (!stat.isDirectory()) return { removed: false, attention: 'Owned worktree path is not a directory.' };

  const isGit = (await git(['rev-parse', '--is-inside-work-tree'], exact.worktree)).ok;
  if (!isGit) {
    const entries = await fs.readdir(exact.worktree);
    if (entries.length) return { removed: false, attention: 'Non-git worktree contains user files and was preserved.' };
    // Non-recursive removal is the race-safe primitive here: if a user file
    // appears after readdir, rmdir fails with ENOTEMPTY instead of deleting it.
    await fs.rmdir(exact.worktree);
    return { removed: true };
  }
  const dirty = await git(['status', '--porcelain', '--untracked-files=all'], exact.worktree);
  if (!dirty.ok || dirty.stdout.trim()) {
    return { removed: false, attention: dirty.ok ? 'Worktree has uncommitted files and was preserved.' : `Could not verify worktree cleanliness: ${dirty.error}` };
  }
  const upstream = await git(['rev-list', '--count', '@{u}..HEAD'], exact.worktree);
  if (upstream.ok) {
    if (Number(upstream.stdout.trim()) > 0) return { removed: false, attention: 'Worktree has unpushed commits and was preserved.' };
  } else {
    const unpushed = await git(['rev-list', 'HEAD', '--not', '--remotes'], exact.worktree);
    if (!unpushed.ok || unpushed.stdout.trim()) {
      return { removed: false, attention: unpushed.ok ? 'Worktree has commits not present on a remote and was preserved.' : 'Could not prove all worktree commits are pushed; it was preserved.' };
    }
  }
  const removed = await git(['worktree', 'remove', exact.worktree], exact.base);
  if (!removed.ok) return { removed: false, attention: `Git refused safe worktree removal: ${removed.error}` };
  await git(['worktree', 'prune'], exact.base);
  return { removed: true };
}

export async function reconcileWorktreeResources(input: {
  agents: ReadonlyArray<{ id: string; workspace?: { path?: string; useWorktree?: boolean } }>;
}): Promise<WorktreeIntegrityReport> {
  const report: WorktreeIntegrityReport = { tracked: 0, discovered: 0, removed: 0, attention: 0, errors: [] };
  return withStoreLock(async () => {
    const store = await loadStore();
    const initialStore = JSON.stringify(store);
    const now = new Date().toISOString();
    const configuredOwners = new Set<string>();
    const activeTaskRows = getDb().prepare(`
      SELECT id, agentId FROM tasks
      WHERE status IN ('queued','running','paused','waiting_for_input','waiting_for_approval','blocked')
    `).all() as Array<{ id: string; agentId: string | null }>;
    const activeTasks = new Set(activeTaskRows.map((row) => row.id));
    // One agent worktree can be shared by overlapping tasks. The most recent
    // registration stores one task id, so preserve conservatively for any
    // active task assigned to that agent as well.
    const agentsWithActiveTasks = new Set(activeTaskRows.flatMap((row) => row.agentId ? [row.agentId] : []));

    for (const agent of input.agents) {
      if (!agent.workspace?.useWorktree || !agent.workspace.path) continue;
      try {
        const exact = exactResource(agent.workspace.path, agent.id);
        const key = resourceKey(exact.base, exact.agentId);
        configuredOwners.add(key);
        let stat: Awaited<ReturnType<typeof fs.lstat>> | null;
        try {
          stat = await fs.lstat(exact.worktree);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
          stat = null;
        }
        if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
        if (!store.resources.some((record) => resourceKey(record.baseWorkspace, record.agentId) === key)) {
          store.resources.push({
            id: randomUUID(), baseWorkspace: exact.base, agentId: exact.agentId, worktreePath: exact.worktree,
            state: 'active', createdAt: now, updatedAt: now,
          });
          report.discovered += 1;
        }
      } catch (error) {
        report.errors.push(`agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const retained: WorktreeResourceRecord[] = [];
    for (const record of store.resources) {
      report.tracked += 1;
      let exists = false;
      try {
        exists = Boolean(await fs.lstat(record.worktreePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          const attention = error instanceof Error ? error.message : String(error);
          if (record.state !== 'attention' || record.attention !== attention) {
            record.state = 'attention';
            record.attention = attention;
            record.updatedAt = now;
          }
          report.errors.push(`${record.agentId}: ${attention}`);
          report.attention += 1;
          retained.push(record);
          continue;
        }
      }
      if (!exists) {
        try {
          await safelyRemove(record);
          report.removed += 1;
          continue;
        } catch (error) {
          const attention = error instanceof Error ? error.message : String(error);
          if (record.state !== 'attention' || record.attention !== attention) {
            record.state = 'attention';
            record.attention = attention;
            record.updatedAt = now;
          }
          report.errors.push(`${record.agentId}: ${attention}`);
          report.attention += 1;
          retained.push(record);
          continue;
        }
      }

      const configuredOwner = configuredOwners.has(resourceKey(record.baseWorkspace, record.agentId));
      const activeTaskOwner = agentsWithActiveTasks.has(record.agentId)
        || Boolean(record.taskId && activeTasks.has(record.taskId));
      if (activeTaskOwner || configuredOwner) {
        retained.push(record);
        continue;
      }
      if (!record.deleteRequestedAt && Date.parse(record.createdAt) > Date.now() - 5 * 60_000) {
        // A worktree can register just after the coordinator's agent snapshot.
        // Give that creator one pass to become visible; explicit deletion
        // tombstones bypass the grace period.
        retained.push(record);
        continue;
      }
      if (!record.deleteRequestedAt) {
        record.deleteRequestedAt = now;
        record.updatedAt = now;
      }
      try {
        const outcome = await safelyRemove(record);
        if (outcome.removed) {
          report.removed += 1;
          continue;
        }
        const attention = outcome.attention || 'Worktree cleanup needs attention.';
        if (record.state !== 'attention' || record.attention !== attention) {
          record.state = 'attention';
          record.attention = attention;
          record.updatedAt = now;
        }
        report.attention += 1;
      } catch (error) {
        const attention = error instanceof Error ? error.message : String(error);
        if (record.state !== 'attention' || record.attention !== attention) {
          record.state = 'attention';
          record.attention = attention;
          record.updatedAt = now;
        }
        report.errors.push(`${record.agentId}: ${attention}`);
        report.attention += 1;
      }
      retained.push(record);
    }
    store.resources = retained;
    if (JSON.stringify(store) !== initialStore) await saveStore(store);
    return report;
  });
}
