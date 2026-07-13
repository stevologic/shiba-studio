import path from 'path';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { FileEntry } from './types';
import { dataDir, projectRoot } from './data-paths';
import { terminateProcessTree } from './process-control';
import { quarantineManagedPath } from './managed-storage-quarantine';

// Workspace paths are selected at runtime and may live anywhere on disk.
// Keeping fs runtime-only prevents Next's file tracer from treating that as a
// request to package the entire source tree into every API route.
const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

const execFileAsync = promisify(execFile);

const DATA_DIR = dataDir();
export const GLOBAL_UPLOADS_SUBDIR = 'uploads';
const UPLOADS_META_FILE = path.join(DATA_DIR, 'uploads-meta.json');
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024; // xAI per-file limit
const uploadsLockGlobal = globalThis as typeof globalThis & { __shibaUploadsMetaWriteChain?: Promise<unknown> };

export interface UploadFileMeta {
  uploadedAt: string;
  checksum: string;
  size?: number;
  modifiedAt?: string;
}

type UploadsMetaStore = Record<string, UploadFileMeta>;

export function sha256Checksum(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function loadUploadsMeta(): Promise<UploadsMetaStore> {
  try {
    const raw = await fs.readFile(UPLOADS_META_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid uploads metadata store: expected an object');
    }
    return parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw error;
  }
}

async function saveUploadsMeta(store: UploadsMetaStore): Promise<void> {
  await ensureDir(DATA_DIR);
  const temporary = `${UPLOADS_META_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, UPLOADS_META_FILE);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function withUploadsMetaWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = uploadsLockGlobal.__shibaUploadsMetaWriteChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  uploadsLockGlobal.__shibaUploadsMetaWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

export async function recordUploadMeta(
  name: string,
  checksum: string,
  uploadedAt = new Date().toISOString(),
  size?: number,
  modifiedAt?: string,
): Promise<UploadFileMeta> {
  return withUploadsMetaWriteLock(async () => {
    const store = await loadUploadsMeta();
    const entry: UploadFileMeta = { uploadedAt, checksum, size, modifiedAt };
    store[name] = entry;
    await saveUploadsMeta(store);
    return entry;
  });
}

export async function removeUploadMeta(name: string): Promise<void> {
  await withUploadsMetaWriteLock(async () => {
    const store = await loadUploadsMeta();
    if (!(name in store)) return;
    delete store[name];
    await saveUploadsMeta(store);
  });
}

/** Remove legacy project-upload cache rows when their owning project is deleted. */
export async function removeProjectUploadMetadata(projectId: string): Promise<number> {
  const prefix = `project:${projectId}:`;
  return withUploadsMetaWriteLock(async () => {
    const store = await loadUploadsMeta();
    const matches = Object.keys(store).filter((key) => key.startsWith(prefix));
    if (!matches.length) return 0;
    for (const key of matches) delete store[key];
    await saveUploadsMeta(store);
    return matches.length;
  });
}

export interface UploadMetadataReconcileReport {
  projectEntriesRemoved: number;
  globalEntriesRemoved: number;
  corruptStoreQuarantined: number;
}

/**
 * Reconcile derived upload metadata only. This never deletes workspace files:
 * global uploads are user-controlled bytes and an absent cache row is rebuilt
 * by listGlobalUploadFiles on its next read.
 */
export async function reconcileUploadMetadata(input: {
  validProjectFileKeys: ReadonlySet<string>;
  defaultWorkspace?: string;
  nowMs?: number;
}): Promise<UploadMetadataReconcileReport> {
  return withUploadsMetaWriteLock(async () => {
    const report: UploadMetadataReconcileReport = {
      projectEntriesRemoved: 0,
      globalEntriesRemoved: 0,
      corruptStoreQuarantined: 0,
    };
    let store: UploadsMetaStore;
    try {
      store = await loadUploadsMeta();
    } catch (error) {
      const exists = await fs.lstat(UPLOADS_META_FILE).catch(() => null);
      if (!exists) throw error;
      await quarantineManagedPath(UPLOADS_META_FILE, 'corrupt_upload_metadata', {
        error: error instanceof Error ? error.message : String(error),
      }, input.nowMs);
      store = {};
      report.corruptStoreQuarantined = 1;
    }

    const base = input.defaultWorkspace?.trim() || projectRoot();
    const globalDir = path.join(/* turbopackIgnore: true */ resolveWorkspace(base), GLOBAL_UPLOADS_SUBDIR);
    let changed = report.corruptStoreQuarantined > 0;
    for (const key of Object.keys(store)) {
      if (key.startsWith('project:')) {
        if (!input.validProjectFileKeys.has(key)) {
          delete store[key];
          report.projectEntriesRemoved += 1;
          changed = true;
        }
        continue;
      }
      const validName = key === path.basename(key) && sanitizeUploadName(key) === key;
      const stat = validName
        ? await fs.lstat(path.join(/* turbopackIgnore: true */ globalDir, key)).catch(() => null)
        : null;
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        delete store[key];
        report.globalEntriesRemoved += 1;
        changed = true;
      }
    }
    if (changed) await saveUploadsMeta(store);
    return report;
  });
}

async function enrichUploadFile(
  file: Omit<GlobalUploadFile, 'uploadedAt' | 'checksum'> & Partial<Pick<GlobalUploadFile, 'uploadedAt' | 'checksum'>>,
): Promise<GlobalUploadFile> {
  const store = await loadUploadsMeta();
  const stored = store[file.name];
  if (
    stored?.uploadedAt
    && stored.checksum
    && stored.size === file.size
    && stored.modifiedAt === file.modifiedAt
  ) {
    return { ...file, uploadedAt: stored.uploadedAt, checksum: stored.checksum };
  }
  const buf = await fs.readFile(file.path);
  const checksum = sha256Checksum(buf);

  if (stored?.uploadedAt && stored.checksum === checksum) {
    await recordUploadMeta(file.name, checksum, stored.uploadedAt, file.size, file.modifiedAt);
    return { ...file, uploadedAt: stored.uploadedAt, checksum: stored.checksum };
  }

  const uploadedAt = stored?.uploadedAt || file.modifiedAt;
  await recordUploadMeta(file.name, checksum, uploadedAt, file.size, file.modifiedAt);
  return { ...file, uploadedAt, checksum };
}

export function resolveWorkspace(base: string, sub?: string): string {
  // Support relative to cwd or absolute. Default to project root if empty.
  let p = base && base.trim() ? base.trim() : projectRoot();
  if (!path.isAbsolute(p)) p = path.resolve(/* turbopackIgnore: true */ projectRoot(), p);
  if (sub) p = path.join(/* turbopackIgnore: true */ p, sub);
  return p;
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function listFiles(dirPath: string, maxDepth = 2, currentDepth = 0): Promise<FileEntry[]> {
  const resolved = resolveWorkspace(dirPath);
  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const out: FileEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // skip dots by default
      const full = path.join(/* turbopackIgnore: true */ resolved, e.name);
      const isDir = e.isDirectory();
      let size: number | undefined;
      if (!isDir) {
        try { const st = await fs.stat(full); size = st.size; } catch {}
      }
      out.push({ name: e.name, path: full, isDir, size });
      if (isDir && currentDepth < maxDepth - 1) {
        try {
          const kids = await listFiles(full, maxDepth, currentDepth + 1);
          out.push(...kids);
        } catch {}
      }
    }
    return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  } catch {
    return [];
  }
}

export function sanitizeUploadName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-()+ ]/g, '_').slice(0, 180);
  return base || 'upload.bin';
}

export async function getGlobalUploadsDir(): Promise<string> {
  const { loadConfig } = await import('./persistence');
  const cfg = await loadConfig();
  const base = cfg.defaultWorkspace?.trim() || projectRoot();
  const dir = path.join(/* turbopackIgnore: true */ resolveWorkspace(base), GLOBAL_UPLOADS_SUBDIR);
  await ensureDir(dir);
  return dir;
}

export interface GlobalUploadFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  uploadedAt: string;
  checksum: string;
}

export async function listGlobalUploadFiles(): Promise<GlobalUploadFile[]> {
  const dir = await getGlobalUploadsDir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: GlobalUploadFile[] = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const full = path.join(/* turbopackIgnore: true */ dir, e.name);
      const st = await fs.stat(full);
      out.push({
        name: e.name,
        path: full,
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        uploadedAt: st.mtime.toISOString(),
        checksum: '',
      });
    }
    const enriched: GlobalUploadFile[] = [];
    for (const file of out) enriched.push(await enrichUploadFile(file));
    return enriched.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  } catch {
    return [];
  }
}

/** Count uploads without statting or hashing every file. */
export async function countGlobalUploadFiles(defaultWorkspace?: string): Promise<number> {
  const base = defaultWorkspace?.trim() || projectRoot();
  const dir = path.join(/* turbopackIgnore: true */ resolveWorkspace(base), GLOBAL_UPLOADS_SUBDIR);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.')).length;
  } catch {
    return 0;
  }
}

export async function buildGlobalUploadsChatContext(): Promise<string> {
  const files = await listGlobalUploadFiles();
  const uploadsPath = await getGlobalUploadsDir();

  const lines: string[] = [
    'You are assisting within Shiba Studio. Workspace global uploads are shared across all chats and agents.',
    `Global uploads directory: ${uploadsPath}`,
  ];

  if (files.length === 0) {
    lines.push('No global uploads yet.');
  } else {
    lines.push('Global uploads (available for this entire conversation):');
    for (const f of files) {
      lines.push(
        `- ${f.name} (${Math.round(f.size / 1024)} KB, uploaded ${new Date(f.uploadedAt).toLocaleString()}, sha256:${f.checksum.slice(0, 12)}…)`,
      );
    }

    const textLike = files.filter((f) =>
      /\.(md|txt|json|csv|ts|tsx|js|jsx|py|html|xml|yaml|yml|toml)$/i.test(f.name),
    );
    if (textLike.length) {
      lines.push('', 'Excerpts from text global uploads:');
      for (const f of textLike.slice(0, 6)) {
        try {
          const result = await readFileSmart(f.path);
          if (result.binary) continue;
          const excerpt = result.content.slice(0, 3500);
          lines.push(
            `\n--- ${f.name} ---\n${excerpt}${result.content.length > 3500 ? '\n…(truncated)' : ''}`,
          );
        } catch {
          /* skip */
        }
      }
    }
  }

  lines.push('', 'Ground answers in these workspace materials when relevant.');
  return lines.join('\n');
}

export async function writeBinaryFile(filePath: string, content: Buffer): Promise<void> {
  const p = resolveWorkspace(filePath);
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`);
  }
  await ensureDir(path.dirname(p));
  const operationId = crypto.randomUUID();
  const staged = `${p}.${process.pid}.${operationId}.shiba-write.tmp`;
  const rollback = `${p}.${process.pid}.${operationId}.shiba-write.rollback`;
  let hadPrevious = false;
  let installed = false;
  await fs.writeFile(staged, content, { flag: 'wx' });
  try {
    try {
      await fs.rename(p, rollback);
      hadPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await fs.rename(staged, p);
    installed = true;
  } catch (error) {
    let restoreError: unknown;
    try {
      if (installed) await fs.rm(p, { force: true });
      if (hadPrevious) await fs.rename(rollback, p);
    } catch (caught) {
      restoreError = caught;
    }
    if (restoreError) {
      throw new AggregateError([error, restoreError], 'Binary write failed and previous bytes could not be restored');
    }
    throw error;
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
  if (hadPrevious) await fs.rm(rollback, { force: true }).catch(() => undefined);
}

export async function deleteGlobalUploadFile(filename: string): Promise<void> {
  const safe = sanitizeUploadName(filename);
  const dir = await getGlobalUploadsDir();
  const filePath = path.join(/* turbopackIgnore: true */ dir, safe);
  const staged = `${filePath}.${process.pid}.${crypto.randomUUID()}.upload-delete.tmp`;
  let moved = false;
  try {
    try {
      await fs.rename(filePath, staged);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await removeUploadMeta(safe);
  } catch (error) {
    if (moved) {
      try { await fs.rename(staged, filePath); }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Upload deletion failed and its bytes could not be restored');
      }
    }
    throw error;
  }
  if (moved) await fs.rm(staged, { force: true }).catch(() => undefined);
}

export async function saveUploadFromBuffer(filename: string, content: Buffer): Promise<GlobalUploadFile> {
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`);
  }
  const dir = await getGlobalUploadsDir();
  const safe = sanitizeUploadName(filename);
  const dest = path.join(/* turbopackIgnore: true */ dir, safe);
  const operationId = crypto.randomUUID();
  const staged = `${dest}.${process.pid}.${operationId}.upload.tmp`;
  const rollback = `${dest}.${process.pid}.${operationId}.upload.rollback`;
  const checksum = sha256Checksum(content);
  const uploadedAt = new Date().toISOString();
  let hadPrevious = false;
  let installed = false;
  let st: Awaited<ReturnType<typeof fs.stat>>;
  await fs.writeFile(staged, content, { flag: 'wx' });
  try {
    try {
      await fs.rename(dest, rollback);
      hadPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await fs.rename(staged, dest);
    installed = true;
    st = await fs.stat(dest);
    await recordUploadMeta(safe, checksum, uploadedAt, st.size, st.mtime.toISOString());
  } catch (error) {
    let restoreError: unknown;
    try {
      if (installed) await fs.rm(dest, { force: true });
      if (hadPrevious) await fs.rename(rollback, dest);
    } catch (caught) {
      restoreError = caught;
    }
    if (restoreError) {
      throw new AggregateError([error, restoreError], 'Upload failed and previous bytes could not be restored');
    }
    throw error;
  } finally {
    await fs.rm(staged, { force: true }).catch(() => undefined);
  }
  if (hadPrevious) await fs.rm(rollback, { force: true }).catch(() => undefined);
  return {
    name: safe,
    path: dest,
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
    uploadedAt,
    checksum,
  };
}

export async function readFileSmart(filePath: string): Promise<{ content: string; binary: boolean; size: number }> {
  const p = resolveWorkspace(filePath);
  const buf = await fs.readFile(p);
  const hasNull = buf.includes(0);
  if (hasNull || buf.length > 2_000_000) {
    return { content: `(Binary file — ${buf.length} bytes. Download or use in agents via fs_read on text exports.)`, binary: true, size: buf.length };
  }
  const text = buf.toString('utf8');
  const replacementRatio = (text.match(/\uFFFD/g) || []).length / Math.max(text.length, 1);
  if (replacementRatio > 0.02) {
    return { content: `(Binary file — ${buf.length} bytes)`, binary: true, size: buf.length };
  }
  return { content: text, binary: false, size: buf.length };
}

export async function readFile(filePath: string): Promise<string> {
  const r = await readFileSmart(filePath);
  return r.content;
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  const p = resolveWorkspace(filePath);
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, content, 'utf8');
}

export async function appendFile(filePath: string, content: string): Promise<void> {
  const p = resolveWorkspace(filePath);
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, content, 'utf8');
}

export async function shellExec(
  cmd: string,
  cwd?: string,
  timeoutMs = 30000,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const work = cwd ? resolveWorkspace(cwd) : projectRoot();
  if (signal?.aborted) return { stdout: '', stderr: 'Aborted', code: -1 };

  return new Promise((resolve) => {
    const outputCap = 2 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopping = false;
    let stopCode = -1;
    let stopMessage = 'Aborted';
    const child = spawn(cmd, [], {
      cwd: work,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const finish = (code: number, message?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (message) stderr = `${stderr}\n${message}`.trim();
      resolve({ stdout, stderr, code });
    };
    const stop = (code: number, message: string) => {
      if (settled || stopping) return;
      stopping = true;
      stopCode = code;
      stopMessage = message;
      void terminateProcessTree(child).finally(() => finish(stopCode, stopMessage));
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString();
      if (target === 'stdout') stdout = (stdout + text).slice(-outputCap);
      else stderr = (stderr + text).slice(-outputCap);
      if (stdout.length + stderr.length >= outputCap) stop(1, `Command output exceeded ${outputCap} bytes`);
    };
    const onAbort = () => stop(-1, 'Aborted');
    const timer = setTimeout(() => stop(-1, `Command timed out after ${timeoutMs}ms`), timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (code) => {
      if (stopping) finish(stopCode, stopMessage);
      else finish(code ?? 1);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

// Git worktree helpers — scoped to agent's workspace
function safeWorktreePath(base: string, agentId: string): string {
  const id = agentId.trim();
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    || id === '.'
    || id === '..'
    || id.endsWith('.')
    || windowsReserved.test(id)
  ) {
    throw new Error('Invalid agent id for worktree');
  }
  const root = path.resolve(/* turbopackIgnore: true */ base, '.worktrees');
  const candidate = path.resolve(/* turbopackIgnore: true */ root, id);
  if (path.dirname(candidate) !== root) throw new Error('Worktree path escapes its workspace');
  return candidate;
}

async function gitExec(args: string[], cwd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr, code: 0 };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string; code?: number };
    return { stdout: err.stdout || '', stderr: err.stderr || err.message || String(error), code: Number(err.code) || 1 };
  }
}

export async function ensureWorktree(
  baseWorkspace: string,
  agentId: string,
  branch = 'main',
  owner: { taskId?: string } = {},
): Promise<{ worktreePath: string; created: boolean }> {
  const base = resolveWorkspace(baseWorkspace);
  const normalizedAgentId = agentId.trim();
  const wtRoot = path.join(/* turbopackIgnore: true */ base, '.worktrees');
  await ensureDir(wtRoot);
  const rootStat = await fs.lstat(wtRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Worktree root must be a real directory');
  }
  const wtPath = safeWorktreePath(base, normalizedAgentId);
  const gitDir = path.join(/* turbopackIgnore: true */ base, '.git');
  const resources = await import('./worktree-integrity');
  await resources.registerWorktreeResource({ baseWorkspace: base, agentId: normalizedAgentId, taskId: owner.taskId });

  try {
    // If worktree already exists, reuse it.
    try {
      const st = await fs.lstat(wtPath);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        throw new Error('Worktree path exists but is not a real directory');
      }
        await resources.registerWorktreeResource({ baseWorkspace: base, agentId: normalizedAgentId, taskId: owner.taskId, active: true });
      return { worktreePath: wtPath, created: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }

    // Create the worktree if the base has a git repo.
    let hasGitRepository = true;
    try {
      await fs.stat(gitDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      hasGitRepository = false;
    }
    if (!hasGitRepository) {
      await ensureDir(wtPath);
      await resources.registerWorktreeResource({ baseWorkspace: base, agentId: normalizedAgentId, taskId: owner.taskId, active: true });
      return { worktreePath: wtPath, created: true };
    }

    const branchName = String(branch || 'main').trim();
    const branchCheck = await gitExec(['check-ref-format', '--branch', branchName], base);
    if (branchCheck.code !== 0) throw new Error(`Invalid git branch: ${branchName}`);

    const added = await gitExec(['worktree', 'add', wtPath, branchName], base);
    if (added.code !== 0) {
      const preferredFallback = `agent-${normalizedAgentId}`;
      const fallbackNameCheck = await gitExec(['check-ref-format', '--branch', preferredFallback], base);
      const fallbackBranch = fallbackNameCheck.code === 0
        ? preferredFallback
        : `agent-${crypto.createHash('sha256').update(normalizedAgentId).digest('hex').slice(0, 16)}`;
      const fallbackExists = await gitExec(
        ['show-ref', '--verify', '--quiet', `refs/heads/${fallbackBranch}`],
        base,
      );
      const fallback = fallbackExists.code === 0
        ? await gitExec(['worktree', 'add', wtPath, fallbackBranch], base)
        : await gitExec(['worktree', 'add', '-b', fallbackBranch, wtPath, 'HEAD'], base);
      if (fallback.code !== 0) throw new Error(fallback.stderr || added.stderr || 'Could not create worktree');
    }
    await resources.registerWorktreeResource({ baseWorkspace: base, agentId: normalizedAgentId, taskId: owner.taskId, active: true });
    return { worktreePath: wtPath, created: true };
  } catch (error) {
    await resources.requestWorktreeResourceDeletion(base, normalizedAgentId, 'Worktree creation was interrupted.').catch(() => undefined);
    throw error;
  }
}

export async function getWorktreePath(baseWorkspace: string, agentId: string): Promise<string | null> {
  const base = resolveWorkspace(baseWorkspace);
  const wt = safeWorktreePath(base, agentId);
  try {
    const st = await fs.stat(wt);
    return st.isDirectory() ? wt : null;
  } catch {
    return null;
  }
}

export interface WorktreeEntry {
  agentId: string;
  path: string;
  branch?: string;
  exists: boolean;
}

export async function listWorktrees(baseWorkspace: string, knownAgentIds: string[] = []): Promise<{
  isGitRepo: boolean;
  workspace: string;
  worktrees: WorktreeEntry[];
}> {
  const workspace = resolveWorkspace(baseWorkspace);
  const wtRoot = path.join(/* turbopackIgnore: true */ workspace, '.worktrees');
  let isGit = false;
  try {
    await fs.stat(path.join(/* turbopackIgnore: true */ workspace, '.git'));
    isGit = true;
  } catch {
    const check = await shellExec('git rev-parse --is-inside-work-tree', workspace);
    isGit = check.code === 0 && check.stdout.trim() === 'true';
  }

  const ids = new Set<string>(knownAgentIds);
  try {
    const entries = await fs.readdir(wtRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) ids.add(e.name);
    }
  } catch {
    /* no worktrees dir */
  }

  const worktrees: WorktreeEntry[] = [];
  for (const agentId of ids) {
    let wtPath: string;
    try { wtPath = safeWorktreePath(workspace, agentId); } catch { continue; }
    let exists = false;
    let branch: string | undefined;
    try {
      const st = await fs.stat(wtPath);
      exists = st.isDirectory();
    } catch {
      exists = false;
    }
    if (exists && isGit) {
      const br = await shellExec('git branch --show-current', wtPath);
      if (br.code === 0 && br.stdout.trim()) branch = br.stdout.trim();
    }
    worktrees.push({ agentId, path: wtPath, branch, exists });
  }

  return { isGitRepo: isGit, workspace, worktrees: worktrees.sort((a, b) => a.agentId.localeCompare(b.agentId)) };
}

export async function removeWorktree(baseWorkspace: string, agentId: string): Promise<{ ok: boolean; error?: string }> {
  const base = resolveWorkspace(baseWorkspace);
  const wtPath = safeWorktreePath(base, agentId);
  try {
    await fs.stat(wtPath);
  } catch {
    return { ok: false, error: 'Worktree not found' };
  }
  const gitCheck = await shellExec('git rev-parse --is-inside-work-tree', base);
  if (gitCheck.code === 0) {
    const removed = await gitExec(['worktree', 'remove', '--force', wtPath], base);
    if (removed.code !== 0) return { ok: false, error: removed.stderr || 'Could not remove worktree' };
  } else {
    await fs.rm(wtPath, { recursive: true, force: true });
  }
  return { ok: true };
}
