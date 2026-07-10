import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { FileEntry } from './types';
import { dataDir, projectRoot } from './data-paths';

const execAsync = promisify(exec);

const DATA_DIR = dataDir();
export const GLOBAL_UPLOADS_SUBDIR = 'uploads';
const UPLOADS_META_FILE = path.join(DATA_DIR, 'uploads-meta.json');
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024; // xAI per-file limit

export interface UploadFileMeta {
  uploadedAt: string;
  checksum: string;
}

type UploadsMetaStore = Record<string, UploadFileMeta>;

export function sha256Checksum(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function loadUploadsMeta(): Promise<UploadsMetaStore> {
  try {
    const raw = await fs.readFile(UPLOADS_META_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveUploadsMeta(store: UploadsMetaStore): Promise<void> {
  await ensureDir(DATA_DIR);
  await fs.writeFile(UPLOADS_META_FILE, JSON.stringify(store, null, 2));
}

export async function recordUploadMeta(
  name: string,
  checksum: string,
  uploadedAt = new Date().toISOString(),
): Promise<UploadFileMeta> {
  const store = await loadUploadsMeta();
  const entry: UploadFileMeta = { uploadedAt, checksum };
  store[name] = entry;
  await saveUploadsMeta(store);
  return entry;
}

export async function removeUploadMeta(name: string): Promise<void> {
  const store = await loadUploadsMeta();
  if (!(name in store)) return;
  delete store[name];
  await saveUploadsMeta(store);
}

async function enrichUploadFile(
  file: Omit<GlobalUploadFile, 'uploadedAt' | 'checksum'> & Partial<Pick<GlobalUploadFile, 'uploadedAt' | 'checksum'>>,
): Promise<GlobalUploadFile> {
  const store = await loadUploadsMeta();
  const stored = store[file.name];
  const buf = await fs.readFile(file.path);
  const checksum = sha256Checksum(buf);

  if (stored?.uploadedAt && stored.checksum === checksum) {
    return { ...file, uploadedAt: stored.uploadedAt, checksum: stored.checksum };
  }

  const uploadedAt = stored?.uploadedAt || file.modifiedAt;
  await recordUploadMeta(file.name, checksum, uploadedAt);
  return { ...file, uploadedAt, checksum };
}

export function resolveWorkspace(base: string, sub?: string): string {
  // Support relative to cwd or absolute. Default to project root if empty.
  let p = base && base.trim() ? base.trim() : projectRoot();
  if (!path.isAbsolute(p)) p = path.resolve(projectRoot(), p);
  if (sub) p = path.join(p, sub);
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
      const full = path.join(resolved, e.name);
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
  const dir = path.join(resolveWorkspace(base), GLOBAL_UPLOADS_SUBDIR);
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
      const full = path.join(dir, e.name);
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
    const enriched = await Promise.all(out.map((f) => enrichUploadFile(f)));
    return enriched.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  } catch {
    return [];
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
  await fs.writeFile(p, content);
}

export async function deleteGlobalUploadFile(filename: string): Promise<void> {
  const safe = sanitizeUploadName(filename);
  const dir = await getGlobalUploadsDir();
  const filePath = path.join(dir, safe);
  try {
    await fs.unlink(filePath);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
  }
  await removeUploadMeta(safe);
}

export async function saveUploadFromBuffer(filename: string, content: Buffer): Promise<GlobalUploadFile> {
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`);
  }
  const dir = await getGlobalUploadsDir();
  const safe = sanitizeUploadName(filename);
  const dest = path.join(dir, safe);
  await fs.writeFile(dest, content);
  const st = await fs.stat(dest);
  const checksum = sha256Checksum(content);
  const uploadedAt = new Date().toISOString();
  await recordUploadMeta(safe, checksum, uploadedAt);
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

export async function shellExec(cmd: string, cwd?: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string; code: number }> {
  const work = cwd ? resolveWorkspace(cwd) : projectRoot();
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: work, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 2 });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; code?: number };
    return { stdout: err.stdout || '', stderr: err.stderr || err.message || String(e), code: err.code || 1 };
  }
}

// Git worktree helpers — scoped to agent's workspace
export async function ensureWorktree(baseWorkspace: string, agentId: string, branch = 'main'): Promise<{ worktreePath: string; created: boolean }> {
  const base = resolveWorkspace(baseWorkspace);
  const wtRoot = path.join(base, '.worktrees');
  await ensureDir(wtRoot);
  const wtPath = path.join(wtRoot, agentId);
  const gitDir = path.join(base, '.git');

  // If worktree already exists reuse
  try {
    const st = await fs.stat(wtPath);
    if (st.isDirectory()) {
      return { worktreePath: wtPath, created: false };
    }
  } catch {}

  // Create the worktree if the base has a git repo
  try {
    await fs.stat(gitDir);
    // ensure branch
    await shellExec(`git worktree add "${wtPath}" ${branch} || git worktree add "${wtPath}" -b agent-${agentId}`, base);
    return { worktreePath: wtPath, created: true };
  } catch {
    // No git repo — fall back to just copying structure or plain dir
    await ensureDir(wtPath);
    return { worktreePath: wtPath, created: true };
  }
}

export async function getWorktreePath(baseWorkspace: string, agentId: string): Promise<string | null> {
  const base = resolveWorkspace(baseWorkspace);
  const wt = path.join(base, '.worktrees', agentId);
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
  const wtRoot = path.join(workspace, '.worktrees');
  let isGit = false;
  try {
    await fs.stat(path.join(workspace, '.git'));
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
    const wtPath = path.join(wtRoot, agentId);
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
  const wtPath = path.join(base, '.worktrees', agentId);
  try {
    await fs.stat(wtPath);
  } catch {
    return { ok: false, error: 'Worktree not found' };
  }
  const gitCheck = await shellExec('git rev-parse --is-inside-work-tree', base);
  if (gitCheck.code === 0) {
    await shellExec(`git worktree remove --force "${wtPath}"`, base);
  } else {
    await fs.rm(wtPath, { recursive: true, force: true });
  }
  return { ok: true };
}
