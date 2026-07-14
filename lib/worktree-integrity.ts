import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDir } from './data-paths';
import { getDb } from './db';
import { ownershipStoreFencePath, withStoreFileLock } from './store-file-lock';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;
const execFileAsync = promisify(execFile);
const STORE = dataDir('worktree-resources.json');
const AUTOMATIC_DELETE_GRACE_MS = 30_000;
const CREATION_LEASE_MS = 5 * 60_000;

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
  pending: number;
  projectMappingsDetached: number;
  attention: number;
  errors: string[];
}

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  return withStoreFileLock(
    ownershipStoreFencePath(path.dirname(STORE)),
    () => withStoreFileLock(STORE, fn),
  );
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

function normalizedPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathIsAtOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resourceKey(baseWorkspace: string, agentId: string): string {
  const exact = exactResource(baseWorkspace, agentId);
  return process.platform === 'win32' ? exact.worktree.toLowerCase() : exact.worktree;
}

/** No-follow existence check for API cleanup confirmation. */
export async function worktreeResourcePathExists(
  baseWorkspace: string,
  agentId: string,
): Promise<boolean> {
  const exact = exactResource(baseWorkspace, agentId);
  try {
    await fs.lstat(exact.worktree);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
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

/** Read-only snapshot for inventory/status surfaces. */
export async function listWorktreeResourceRecords(
  baseWorkspace: string,
): Promise<WorktreeResourceRecord[]> {
  const base = path.resolve(baseWorkspace);
  return withStoreLock(async () => {
    const store = await loadStore();
    return store.resources
      .filter((record) => samePath(record.baseWorkspace, base))
      .map((record) => ({ ...record }));
  });
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

function parseWorktreeList(output: string): Array<{ worktreePath: string; branch?: string }> {
  const worktrees: Array<{ worktreePath: string; branch?: string }> = [];
  let current: { worktreePath: string; branch?: string } | undefined;
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { worktreePath: field.slice('worktree '.length) };
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

async function safelyRemove(record: WorktreeResourceRecord): Promise<{ removed: boolean; attention?: string }> {
  const exact = exactResource(record.baseWorkspace, record.agentId);
  if (!samePath(exact.worktree, record.worktreePath)) {
    return { removed: false, attention: 'Stored worktree path failed ownership validation.' };
  }
  const root = path.dirname(exact.worktree);
  const rootStat = await fs.lstat(root).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootStat) {
    await git(['worktree', 'prune'], exact.base).catch(() => undefined);
    return { removed: true };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { removed: false, attention: 'Worktree root is not a real app-owned directory and was preserved.' };
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
  const dirty = await git([
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--ignored=matching',
    '--ignore-submodules=none',
  ], exact.worktree);
  if (!dirty.ok || dirty.stdout.trim()) {
    return {
      removed: false,
      attention: dirty.ok
        ? 'Worktree has uncommitted, untracked, or ignored files and was preserved.'
        : `Could not verify worktree cleanliness: ${dirty.error}`,
    };
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
  agents?: ReadonlyArray<{ id: string; workspace?: { path?: string; useWorktree?: boolean } }>;
  sessions?: ReadonlyArray<{ workspaceDir?: unknown; projectId?: unknown; archived?: unknown }>;
  projects?: ReadonlyArray<{ id: string; workspacePath?: unknown; updatedAt?: unknown }>;
  baseWorkspaces?: ReadonlyArray<string>;
} = {}): Promise<WorktreeIntegrityReport> {
  const report: WorktreeIntegrityReport = {
    tracked: 0,
    discovered: 0,
    removed: 0,
    pending: 0,
    projectMappingsDetached: 0,
    attention: 0,
    errors: [],
  };
  return withStoreLock(async () => {
    // Load the authoritative ownership stores while holding their shared
    // fence. A chat/agent attach cannot race the deletion decision in another
    // Next process, and tests may inject explicit snapshots in isolation.
    const agents: ReadonlyArray<{
      id: string;
      workspace?: { path?: string; useWorktree?: boolean };
    }> = input.agents ?? await import('./persistence').then((module) => module.loadAgents());
    const sessions: ReadonlyArray<{ workspaceDir?: unknown; projectId?: unknown; archived?: unknown }> = input.sessions
      ?? await import('./chat-sessions')
      .then((module) => module.listChatSessions({ includeArchived: true }));
    const projects: ReadonlyArray<{ id: string; workspacePath?: unknown; updatedAt?: unknown }> = input.projects
      ?? await import('./projects').then((module) => module.listProjects());
    const projectWorkspaces = new Map(projects.flatMap((project) => (
      typeof project.id === 'string'
      && typeof project.workspacePath === 'string'
      && project.workspacePath.trim()
        ? [[project.id, project.workspacePath.trim()] as const]
        : []
    )));
    const chatWorkspacePaths = sessions.flatMap((session) => {
      if (typeof session.workspaceDir === 'string' && session.workspaceDir.trim()) {
        return [session.workspaceDir.trim()];
      }
      return typeof session.projectId === 'string' && projectWorkspaces.has(session.projectId)
        ? [projectWorkspaces.get(session.projectId)!]
        : [];
    });
    const detachProjectMappings = async (record: WorktreeResourceRecord): Promise<void> => {
      // Injected snapshots are verifier-only and have no backing store to
      // mutate. Production snapshots are protected by the ownership fence.
      if (input.projects !== undefined) return;
      const references = projects.filter((project) => {
        if (typeof project.workspacePath !== 'string'
          || !project.workspacePath.trim()
          || typeof project.updatedAt !== 'string') return false;
        try {
          return pathIsAtOrInside(project.workspacePath.trim(), record.worktreePath);
        } catch {
          return false;
        }
      });
      if (!references.length) return;
      const { clearProjectWorkspaceIfMatches } = await import('./projects');
      for (const project of references) {
        if (await clearProjectWorkspaceIfMatches(
          project.id,
          String(project.workspacePath),
          String(project.updatedAt),
        )) report.projectMappingsDetached += 1;
      }
    };
    const store = await loadStore();
    const initialStore = JSON.stringify(store);
    const now = new Date().toISOString();
    const configuredOwners = new Set<string>();
    const activeTaskRows = getDb().prepare(`
      SELECT id, workspaceRoots FROM tasks
      WHERE status IN ('queued','running','paused','waiting_for_input','waiting_for_approval','blocked')
    `).all() as Array<{ id: string; workspaceRoots: string }>;
    const activeTasks = new Set(activeTaskRows.map((row) => row.id));
    // One agent worktree can be shared by overlapping tasks. The registry's
    // latest taskId is not enough, so retain any worktree explicitly present
    // in an active task's workspace roots without conflating equal agent IDs
    // across different repositories.
    const activeTaskWorkspacePaths = activeTaskRows.flatMap((row) => {
      try {
        const roots = JSON.parse(row.workspaceRoots) as Array<{ path?: unknown }>;
        return Array.isArray(roots)
          ? roots.flatMap((root) => typeof root?.path === 'string' && root.path.trim() ? [root.path.trim()] : [])
          : [];
      } catch {
        return [];
      }
    });

    // Older Shiba versions created agent worktrees without adding them to the
    // durable registry. Adopt only entries Git itself identifies as worktrees
    // and whose path + branch exactly match Shiba's ownership convention. All
    // other folders remain unowned and are intentionally left untouched.
    const baseWorkspaces = new Map<string, string>();
    const addBaseWorkspace = (value: unknown): void => {
      if (typeof value !== 'string' || !value.trim()) return;
      const resolved = path.resolve(value.trim());
      baseWorkspaces.set(normalizedPathKey(resolved), resolved);
    };
    for (const record of store.resources) addBaseWorkspace(record.baseWorkspace);
    for (const agent of agents) addBaseWorkspace(agent.workspace?.path);
    for (const workspace of input.baseWorkspaces ?? []) addBaseWorkspace(workspace);

    for (const base of baseWorkspaces.values()) {
      const listed = await git(['worktree', 'list', '--porcelain', '-z'], base);
      if (!listed.ok) continue;
      const root = path.resolve(base, '.worktrees');
      for (const candidate of parseWorktreeList(listed.stdout)) {
        const candidatePath = path.resolve(candidate.worktreePath);
        if (!samePath(path.dirname(candidatePath), root)) continue;
        const agentId = path.basename(candidatePath);
        let exact: ReturnType<typeof exactResource>;
        try {
          exact = exactResource(base, agentId);
        } catch {
          continue;
        }
        if (!samePath(candidatePath, exact.worktree)
          || candidate.branch !== `refs/heads/agent-${exact.agentId}`) continue;
        const stat = await fs.lstat(candidatePath).catch(() => null);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
        const key = resourceKey(exact.base, exact.agentId);
        if (store.resources.some((record) => (
          resourceKey(record.baseWorkspace, record.agentId) === key
        ))) continue;
        store.resources.push({
          id: randomUUID(),
          baseWorkspace: exact.base,
          agentId: exact.agentId,
          worktreePath: exact.worktree,
          state: 'delete_requested',
          createdAt: now,
          updatedAt: now,
          deleteRequestedAt: now,
        });
        report.discovered += 1;
      }
    }

    for (const agent of agents) {
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
      if (
        record.taskId
        && !activeTasks.has(record.taskId)
        && Date.parse(record.createdAt) > Date.now() - CREATION_LEASE_MS
      ) {
        // Agent runtime registers its task id before `git worktree add`, then
        // creates the durable task row. Preserve that handoff lease even if a
        // concurrent agent deletion has already requested cleanup.
        report.pending += 1;
        retained.push(record);
        continue;
      }
      if (!exists) {
        if (
          record.state === 'creating'
          && !record.deleteRequestedAt
          && Date.parse(record.createdAt) > Date.now() - CREATION_LEASE_MS
        ) {
          // ensureWorktree registers before `git worktree add`. Preserve that
          // live creation lease so a concurrent integrity pass cannot erase
          // the registry just before the directory becomes visible.
          report.pending += 1;
          retained.push(record);
          continue;
        }
        try {
          await safelyRemove(record);
          await detachProjectMappings(record);
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
      const chatOwner = chatWorkspacePaths.some((workspaceDir) => {
        try {
          return pathIsAtOrInside(workspaceDir, record.worktreePath);
        } catch {
          return false;
        }
      });
      const activeTaskOwner = Boolean(record.taskId && activeTasks.has(record.taskId))
        || activeTaskWorkspacePaths.some((workspacePath) => {
          try {
            return pathIsAtOrInside(workspacePath, record.worktreePath);
          } catch {
            return false;
          }
        });
      if (configuredOwner || chatOwner) {
        if (record.state !== 'active' || record.deleteRequestedAt || record.attention) {
          record.state = 'active';
          record.deleteRequestedAt = undefined;
          record.attention = undefined;
          record.updatedAt = now;
        }
        retained.push(record);
        continue;
      }
      if (activeTaskOwner) {
        if (!record.deleteRequestedAt) {
          record.deleteRequestedAt = now;
          record.state = 'delete_requested';
          record.updatedAt = now;
        }
        report.pending += 1;
        retained.push(record);
        continue;
      }
      if (!record.deleteRequestedAt && Date.parse(record.createdAt) > Date.now() - CREATION_LEASE_MS) {
        // A worktree can register just after the coordinator's agent snapshot.
        // Give that creator one pass to become visible; explicit deletion
        // tombstones bypass the grace period.
        report.pending += 1;
        retained.push(record);
        continue;
      }
      if (!record.deleteRequestedAt) {
        record.deleteRequestedAt = now;
        record.state = 'delete_requested';
        record.updatedAt = now;
        report.pending += 1;
        retained.push(record);
        continue;
      }
      if (!record.attention
        && Date.parse(record.deleteRequestedAt) > Date.now() - AUTOMATIC_DELETE_GRACE_MS) {
        // Automatic ownership loss is two-phase. This gives a project-save →
        // chat-create sequence (and any concurrent attach) time to publish its
        // new owner before irreversible cleanup.
        report.pending += 1;
        retained.push(record);
        continue;
      }
      try {
        const outcome = await safelyRemove(record);
        if (outcome.removed) {
          await detachProjectMappings(record);
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
