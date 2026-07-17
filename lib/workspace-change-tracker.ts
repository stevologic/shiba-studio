import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_HASH_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_HASH_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_PATHS = 1_000;

interface FileFingerprint {
  exists: boolean;
  size: number;
  mtimeMs: number;
  hash?: string;
}

export interface GitWorkspaceSnapshot {
  workDir: string;
  gitRoot: string | null;
  head: string | null;
  dirtyPaths: string[];
  fingerprints: Record<string, FileFingerprint>;
}

export interface WorkspaceChange {
  path: string;
  absPath: string;
  kind: 'changed' | 'deleted';
}

async function git(
  workDir: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workDir, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return String(stdout || '');
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parsePorcelainPaths(raw: string): string[] {
  const records = raw.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (filePath) paths.push(filePath);
    // In porcelain v1 -z, rename/copy records carry the original path as the
    // next NUL record. The first path is the current destination.
    if (status[0] === 'R' || status[0] === 'C') index += 1;
  }
  return paths;
}

async function fingerprint(absPath: string, hashBudget: number): Promise<FileFingerprint> {
  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat?.isFile()) return { exists: false, size: 0, mtimeMs: 0 };
  const result: FileFingerprint = {
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  if (stat.size <= MAX_HASH_BYTES && stat.size <= hashBudget) {
    const contents = await fs.readFile(absPath).catch(() => null);
    if (contents) result.hash = createHash('sha256').update(contents).digest('hex');
  }
  return result;
}

function sameFingerprint(
  before: FileFingerprint | undefined,
  after: FileFingerprint,
): boolean {
  if (!before) return false;
  if (before.exists !== after.exists || before.size !== after.size) return false;
  if (before.hash && after.hash) return before.hash === after.hash;
  return before.mtimeMs === after.mtimeMs;
}

/**
 * Capture enough Git state to attribute files changed by an opaque external
 * harness without treating files that were already dirty as new work.
 */
export async function captureGitWorkspaceSnapshot(
  workDir: string,
): Promise<GitWorkspaceSnapshot> {
  const resolvedWorkDir = path.resolve(workDir);
  const rootRaw = await git(resolvedWorkDir, ['rev-parse', '--show-toplevel']);
  const gitRoot = rootRaw?.trim() ? path.resolve(rootRaw.trim()) : null;
  if (!gitRoot) {
    return {
      workDir: resolvedWorkDir,
      gitRoot: null,
      head: null,
      dirtyPaths: [],
      fingerprints: {},
    };
  }

  const [headRaw, statusRaw] = await Promise.all([
    git(resolvedWorkDir, ['rev-parse', '--verify', 'HEAD']),
    git(resolvedWorkDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  const dirtyPaths = [...new Set(parsePorcelainPaths(statusRaw || ''))]
    .filter((relPath) => isInside(resolvedWorkDir, path.resolve(gitRoot, relPath)))
    .slice(0, MAX_TRACKED_PATHS);
  const fingerprints: Record<string, FileFingerprint> = {};
  let remainingHashBytes = MAX_TOTAL_HASH_BYTES;
  // Sequential hashing keeps peak memory bounded even in very dirty repos.
  for (const relPath of dirtyPaths) {
    const fileFingerprint = await fingerprint(path.resolve(gitRoot, relPath), remainingHashBytes);
    fingerprints[relPath] = fileFingerprint;
    if (fileFingerprint.hash) remainingHashBytes -= fileFingerprint.size;
  }

  return {
    workDir: resolvedWorkDir,
    gitRoot,
    head: headRaw?.trim() || null,
    dirtyPaths,
    fingerprints,
  };
}

/**
 * Return files whose contents changed during the run. This includes committed
 * changes (HEAD moved) and filters every result back to the granted workDir.
 */
export async function collectGitWorkspaceChanges(
  before: GitWorkspaceSnapshot,
): Promise<WorkspaceChange[]> {
  if (!before.gitRoot) return [];
  const [headRaw, statusRaw] = await Promise.all([
    git(before.workDir, ['rev-parse', '--verify', 'HEAD']),
    git(before.workDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  const afterHead = headRaw?.trim() || null;
  const afterDirty = parsePorcelainPaths(statusRaw || '');
  let committed: string[] = [];
  if (before.head && afterHead && before.head !== afterHead) {
    const committedRaw = await git(before.workDir, [
      'diff', '--name-only', '-z', `${before.head}..${afterHead}`, '--',
    ]);
    committed = (committedRaw || '').split('\0').filter(Boolean);
  }

  const candidates = [...new Set([...afterDirty, ...committed])]
    .filter((relPath) => {
      const absPath = path.resolve(before.gitRoot!, relPath);
      return isInside(before.workDir, absPath);
    })
    .slice(0, MAX_TRACKED_PATHS);
  const beforeDirty = new Set(before.dirtyPaths);
  const changes: WorkspaceChange[] = [];
  let remainingHashBytes = MAX_TOTAL_HASH_BYTES;
  for (const relPath of candidates) {
    const absPath = path.resolve(before.gitRoot, relPath);
    const beforeFingerprint = before.fingerprints[relPath];
    const after = await fingerprint(
      absPath,
      beforeDirty.has(relPath) && beforeFingerprint?.hash ? remainingHashBytes : 0,
    );
    if (after.hash) remainingHashBytes -= after.size;
    if (beforeDirty.has(relPath) && sameFingerprint(beforeFingerprint, after)) continue;
    changes.push({
      path: path.relative(before.workDir, absPath) || path.basename(absPath),
      absPath,
      kind: after.exists ? 'changed' : 'deleted',
    });
  }
  return changes;
}
