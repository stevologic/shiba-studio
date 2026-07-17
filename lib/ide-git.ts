import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveWorkspace } from './workspace';

const READ_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_GIT_BUFFER = 12 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_CHARS = 2 * 1024 * 1024;
const MAX_ACTION_PATHS = 500;

type GitCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type IdeGitChangeCode = 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export interface IdeGitStatusEntry {
  path: string;
  originalPath?: string;
  indexStatus: IdeGitChangeCode | null;
  workingTreeStatus: IdeGitChangeCode | null;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  renamed: boolean;
}

export interface IdeGitBranch {
  name: string;
  current: boolean;
  oid: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  lastCommitAt: string | null;
  subject: string;
}

export interface IdeGitCommit {
  oid: string;
  shortOid: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
}

export interface IdeGitRemote {
  name: string;
  fetchUrls: string[];
  pushUrls: string[];
}

export interface IdeGitHubRemote {
  remote: string;
  host: string;
  owner: string;
  repo: string;
  slug: string;
  webUrl: string;
}

export interface IdeGitSnapshot {
  workspace: string;
  repoRoot: string;
  head: {
    oid: string | null;
    branch: string | null;
    detached: boolean;
    unborn: boolean;
  };
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  status: IdeGitStatusEntry[];
  branches: IdeGitBranch[];
  commits: IdeGitCommit[];
  remotes: IdeGitRemote[];
  github: IdeGitHubRemote | null;
}

export type IdeGitDiffArea = 'working' | 'staged';
export type IdeGitFileSource = 'head' | 'index' | 'working';

export interface IdeGitFileVersion {
  source: IdeGitFileSource;
  path: string;
  content: string | null;
  size: number;
  binary: boolean;
  truncated: boolean;
}

export interface IdeGitFileDiff {
  path: string;
  area: IdeGitDiffArea;
  patch: string;
  original: IdeGitFileVersion | null;
  modified: IdeGitFileVersion | null;
  binary: boolean;
  truncated: boolean;
}

export type IdeGitAction =
  | { action: 'stage'; paths: string[] }
  | { action: 'unstage'; paths: string[] }
  | { action: 'discard'; paths: string[] }
  | { action: 'commit'; message: string }
  | { action: 'pull' }
  | { action: 'push' }
  | { action: 'fetch'; remote?: string }
  | { action: 'checkout'; branch: string }
  | { action: 'createBranch'; branch: string; startPoint?: string };

export interface IdeGitActionResult {
  action: IdeGitAction['action'];
  output: string;
  commitOid?: string;
  snapshot: IdeGitSnapshot;
}

export class IdeGitError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'IDE_GIT_FAILED', status = 409) {
    super(message);
    this.name = 'IdeGitError';
    this.code = code;
    this.status = status;
  }
}

const mutationState = globalThis as typeof globalThis & {
  __shibaIdeGitMutationLocks?: Map<string, Promise<void>>;
};

function mutationLocks(): Map<string, Promise<void>> {
  if (!mutationState.__shibaIdeGitMutationLocks) {
    mutationState.__shibaIdeGitMutationLocks = new Map();
  }
  return mutationState.__shibaIdeGitMutationLocks;
}

function redactGitOutput(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+(?::[^/@\s]*)?)@/gi, '$1[redacted]@')
    .slice(0, 20_000);
}

function publicGitFailure(result: GitCommandResult, fallback: string): string {
  const detail = redactGitOutput((result.stderr || result.stdout).trim());
  return detail || fallback;
}

function commandExitCode(error: Error | null): number {
  if (!error) return 0;
  const value = (error as Error & { code?: string | number }).code;
  return typeof value === 'number' ? value : 1;
}

function runGitRaw(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
        },
        maxBuffer: options.maxBuffer ?? MAX_GIT_BUFFER,
        timeout: options.timeoutMs ?? READ_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const systemCode = (error as NodeJS.ErrnoException | null)?.code;
        if (typeof systemCode === 'string' && systemCode !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new IdeGitError(
            systemCode === 'ENOENT' ? 'Git is not installed or is not available on PATH.' : error?.message || 'Could not start Git.',
            systemCode === 'ENOENT' ? 'GIT_NOT_INSTALLED' : 'GIT_PROCESS_FAILED',
            systemCode === 'ENOENT' ? 503 : 500,
          ));
          return;
        }
        const timedOut = Boolean((error as Error & { killed?: boolean } | null)?.killed);
        resolve({
          code: commandExitCode(error),
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut,
        });
      },
    );
  });
}

async function runGit(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBuffer?: number; errorMessage?: string } = {},
): Promise<string> {
  const result = await runGitRaw(cwd, args, options);
  if (result.timedOut) {
    throw new IdeGitError('Git operation timed out.', 'GIT_TIMEOUT', 504);
  }
  if (result.code !== 0) {
    throw new IdeGitError(
      publicGitFailure(result, options.errorMessage || 'Git operation failed.'),
      'GIT_COMMAND_FAILED',
      409,
    );
  }
  return result.stdout;
}

function stripOneLineEnding(value: string): string {
  return value.replace(/\r?\n$/, '');
}

async function resolveRepository(workspaceInput: string): Promise<{ workspace: string; repoRoot: string }> {
  const workspace = resolveWorkspace(workspaceInput);
  const stat = await fs.stat(workspace).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new IdeGitError('Workspace folder was not found.', 'WORKSPACE_NOT_FOUND', 404);
  }
  const result = await runGitRaw(workspace, ['rev-parse', '--show-toplevel']);
  if (result.timedOut) throw new IdeGitError('Git repository detection timed out.', 'GIT_TIMEOUT', 504);
  if (result.code !== 0) {
    throw new IdeGitError('The selected workspace is not inside a Git repository.', 'NOT_A_GIT_REPOSITORY', 400);
  }
  const rawRoot = stripOneLineEnding(result.stdout);
  if (!rawRoot) {
    throw new IdeGitError('Git did not return a repository root.', 'NOT_A_GIT_REPOSITORY', 400);
  }
  return { workspace, repoRoot: path.resolve(rawRoot) };
}

function normalizeChangeCode(value: string): IdeGitChangeCode | null {
  if (value === '.' || value === ' ') return null;
  if (['M', 'T', 'A', 'D', 'R', 'C', 'U', '?'].includes(value)) {
    return value as IdeGitChangeCode;
  }
  return null;
}

function splitFixedFields(value: string, fieldCount: number): { fields: string[]; remainder: string } | null {
  const fields: string[] = [];
  let cursor = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = value.indexOf(' ', cursor);
    if (separator < 0) return null;
    fields.push(value.slice(cursor, separator));
    cursor = separator + 1;
  }
  return { fields, remainder: value.slice(cursor) };
}

function statusEntry(input: {
  path: string;
  originalPath?: string;
  xy: string;
  untracked?: boolean;
  unmerged?: boolean;
}): IdeGitStatusEntry {
  const indexStatus = input.untracked ? null : normalizeChangeCode(input.xy[0] || '.');
  const workingTreeStatus = input.untracked ? '?' : normalizeChangeCode(input.xy[1] || '.');
  const conflicted = Boolean(
    input.unmerged
    || indexStatus === 'U'
    || workingTreeStatus === 'U'
    || input.xy === 'AA'
    || input.xy === 'DD',
  );
  return {
    path: input.path,
    ...(input.originalPath ? { originalPath: input.originalPath } : {}),
    indexStatus,
    workingTreeStatus,
    staged: indexStatus !== null,
    unstaged: workingTreeStatus !== null,
    untracked: Boolean(input.untracked),
    conflicted,
    renamed: Boolean(input.originalPath || indexStatus === 'R' || workingTreeStatus === 'R'),
  };
}

function parseStatus(output: string): {
  oid: string | null;
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: IdeGitStatusEntry[];
} {
  const headers = new Map<string, string>();
  const entries: IdeGitStatusEntry[] = [];
  const records = output.split('\0');

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const separator = record.indexOf(' ', 2);
      if (separator > 2) headers.set(record.slice(2, separator), record.slice(separator + 1));
      continue;
    }
    if (record.startsWith('1 ')) {
      const parsed = splitFixedFields(record.slice(2), 7);
      if (!parsed || parsed.fields[0].length !== 2) {
        throw new IdeGitError('Could not parse Git status output.', 'GIT_STATUS_PARSE_FAILED', 500);
      }
      entries.push(statusEntry({ xy: parsed.fields[0], path: parsed.remainder }));
      continue;
    }
    if (record.startsWith('2 ')) {
      const parsed = splitFixedFields(record.slice(2), 8);
      const originalPath = records[index + 1];
      if (!parsed || parsed.fields[0].length !== 2 || originalPath === undefined) {
        throw new IdeGitError('Could not parse a renamed Git status entry.', 'GIT_STATUS_PARSE_FAILED', 500);
      }
      entries.push(statusEntry({
        xy: parsed.fields[0],
        path: parsed.remainder,
        originalPath,
      }));
      index += 1;
      continue;
    }
    if (record.startsWith('u ')) {
      const parsed = splitFixedFields(record.slice(2), 9);
      if (!parsed || parsed.fields[0].length !== 2) {
        throw new IdeGitError('Could not parse a conflicted Git status entry.', 'GIT_STATUS_PARSE_FAILED', 500);
      }
      entries.push(statusEntry({ xy: parsed.fields[0], path: parsed.remainder, unmerged: true }));
      continue;
    }
    if (record.startsWith('? ')) {
      entries.push(statusEntry({ xy: '??', path: record.slice(2), untracked: true }));
    }
  }

  const branchOid = headers.get('branch.oid') || '';
  const branchHead = headers.get('branch.head') || '';
  const ab = headers.get('branch.ab') || '';
  const ahead = Number(ab.match(/\+(\d+)/)?.[1] || 0);
  const behind = Number(ab.match(/-(\d+)/)?.[1] || 0);
  const unborn = branchOid === '(initial)' || !branchOid;
  const detached = branchHead === '(detached)';
  return {
    oid: unborn ? null : branchOid,
    branch: detached || !branchHead ? null : branchHead,
    detached,
    unborn,
    upstream: headers.get('branch.upstream') || null,
    ahead,
    behind,
    entries,
  };
}

function parseTracking(value: string): { ahead: number; behind: number; gone: boolean } {
  return {
    ahead: Number(value.match(/ahead (\d+)/)?.[1] || 0),
    behind: Number(value.match(/behind (\d+)/)?.[1] || 0),
    gone: /\bgone\b/.test(value),
  };
}

function parseBranches(output: string): IdeGitBranch[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((record) => {
      const [name = '', oid = '', upstream = '', track = '', marker = '', lastCommitAt = '', subject = ''] = record.split('\x1f');
      const tracking = parseTracking(track);
      return {
        name,
        current: marker.trim() === '*',
        oid,
        upstream: upstream || null,
        ...tracking,
        lastCommitAt: lastCommitAt || null,
        subject,
      };
    });
}

function parseCommits(output: string): IdeGitCommit[] {
  return output
    .split('\x1e')
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [oid = '', shortOid = '', authorName = '', authorEmail = '', authoredAt = '', subject = ''] = record.split('\x1f');
      return { oid, shortOid, authorName, authorEmail, authoredAt, subject };
    });
}

function sanitizeRemoteUrl(raw: string): string {
  const value = stripOneLineEnding(raw);
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
  } catch {
    // SCP-style SSH URLs are not URL-parseable and contain no HTTP userinfo.
  }
  return value;
}

function parseGitHubRemote(remote: string, rawUrl: string): IdeGitHubRemote | null {
  let host = '';
  let pathname = '';
  try {
    const parsed = new URL(rawUrl);
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } catch {
    const scp = rawUrl.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (!scp) return null;
    host = scp[1].toLowerCase();
    pathname = scp[2];
  }
  if (host !== 'github.com') return null;
  const parts = pathname
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (!owner || !repo) return null;
  return {
    remote,
    host,
    owner,
    repo,
    slug: `${owner}/${repo}`,
    webUrl: `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  };
}

async function listRemotes(repoRoot: string): Promise<{ remotes: IdeGitRemote[]; github: IdeGitHubRemote | null }> {
  const names = (await runGit(repoRoot, ['remote']))
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  const collected = await Promise.all(names.map(async (name) => {
    const [fetchResult, pushResult] = await Promise.all([
      runGitRaw(repoRoot, ['remote', 'get-url', '--all', name]),
      runGitRaw(repoRoot, ['remote', 'get-url', '--push', '--all', name]),
    ]);
    const fetchRaw = fetchResult.code === 0
      ? fetchResult.stdout.split(/\r?\n/).filter(Boolean)
      : [];
    const pushRaw = pushResult.code === 0
      ? pushResult.stdout.split(/\r?\n/).filter(Boolean)
      : [];
    const remote: IdeGitRemote = {
      name,
      fetchUrls: fetchRaw.map(sanitizeRemoteUrl),
      pushUrls: pushRaw.map(sanitizeRemoteUrl),
    };
    const github = [...fetchRaw, ...pushRaw]
      .map((url) => parseGitHubRemote(name, url))
      .find((candidate): candidate is IdeGitHubRemote => candidate !== null) || null;
    return { remote, github };
  }));
  collected.sort((left, right) => left.remote.name.localeCompare(right.remote.name));
  const preferred = collected.find((entry) => entry.remote.name === 'origin' && entry.github)
    || collected.find((entry) => entry.github);
  return {
    remotes: collected.map((entry) => entry.remote),
    github: preferred?.github || null,
  };
}

async function snapshotFromRepository(
  workspace: string,
  repoRoot: string,
  recentCommitCount = 25,
): Promise<IdeGitSnapshot> {
  const statusOutput = await runGit(repoRoot, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
  ]);
  const status = parseStatus(statusOutput);
  const [branchOutput, commitOutput, remoteData] = await Promise.all([
    runGit(repoRoot, [
      'for-each-ref',
      '--format=%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(committerdate:iso-strict)%1f%(subject)',
      'refs/heads',
    ]),
    status.unborn
      ? Promise.resolve('')
      : runGit(repoRoot, [
        'log',
        `-n${Math.max(1, Math.min(50, recentCommitCount))}`,
        '--date=iso-strict',
        '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e',
      ]),
    listRemotes(repoRoot),
  ]);
  return {
    workspace,
    repoRoot,
    head: {
      oid: status.oid,
      branch: status.branch,
      detached: status.detached,
      unborn: status.unborn,
    },
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    clean: status.entries.length === 0,
    status: status.entries,
    branches: parseBranches(branchOutput),
    commits: parseCommits(commitOutput),
    ...remoteData,
  };
}

export async function getIdeGitSnapshot(
  workspaceInput: string,
  options: { recentCommitCount?: number } = {},
): Promise<IdeGitSnapshot> {
  const { workspace, repoRoot } = await resolveRepository(workspaceInput);
  return snapshotFromRepository(workspace, repoRoot, options.recentCommitCount);
}

function validateRepoPath(repoRoot: string, rawPath: string): string {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) {
    throw new IdeGitError('A repository-relative file path is required.', 'INVALID_GIT_PATH', 400);
  }
  if (path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
    throw new IdeGitError('Git file paths must be relative to the repository root.', 'INVALID_GIT_PATH', 400);
  }
  const absolute = path.resolve(repoRoot, rawPath);
  const relative = path.relative(repoRoot, absolute);
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new IdeGitError('Git file path escapes the repository root.', 'INVALID_GIT_PATH', 400);
  }
  const normalized = relative.split(path.sep).join('/');
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    throw new IdeGitError('The Git metadata directory cannot be modified from the IDE.', 'INVALID_GIT_PATH', 400);
  }
  return normalized;
}

function validatePaths(repoRoot: string, values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1) {
    throw new IdeGitError('At least one file path is required.', 'PATHS_REQUIRED', 400);
  }
  if (values.length > MAX_ACTION_PATHS) {
    throw new IdeGitError(`A maximum of ${MAX_ACTION_PATHS} paths can be changed at once.`, 'TOO_MANY_PATHS', 400);
  }
  return [...new Set(values.map((value) => validateRepoPath(repoRoot, value)))];
}

function literalPathspec(relativePath: string): string {
  return `:(literal)${relativePath}`;
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  const text = buffer.toString('utf8');
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  return replacementCount / Math.max(text.length, 1) > 0.02;
}

function versionFromBuffer(source: IdeGitFileSource, relativePath: string, buffer: Buffer): IdeGitFileVersion {
  const truncated = buffer.length > MAX_TEXT_FILE_BYTES;
  const sample = truncated ? buffer.subarray(0, MAX_TEXT_FILE_BYTES) : buffer;
  const binary = looksBinary(sample);
  return {
    source,
    path: relativePath,
    content: binary ? null : sample.toString('utf8'),
    size: buffer.length,
    binary,
    truncated,
  };
}

async function readWorkingVersion(repoRoot: string, relativePath: string): Promise<IdeGitFileVersion | null> {
  const absolute = path.resolve(repoRoot, relativePath);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    return {
      source: 'working',
      path: relativePath,
      content: null,
      size: stat.size,
      binary: true,
      truncated: true,
    };
  }
  const buffer = await fs.readFile(absolute);
  return versionFromBuffer('working', relativePath, buffer);
}

async function readGitVersion(
  repoRoot: string,
  relativePath: string,
  source: 'head' | 'index',
): Promise<IdeGitFileVersion | null> {
  const objectSpec = source === 'head' ? `HEAD:${relativePath}` : `:${relativePath}`;
  const exists = await runGitRaw(repoRoot, ['cat-file', '-e', objectSpec]);
  if (exists.code !== 0) return null;
  const sizeResult = await runGitRaw(repoRoot, ['cat-file', '-s', objectSpec]);
  if (sizeResult.code !== 0) return null;
  const size = Number(sizeResult.stdout.trim());
  if (Number.isFinite(size) && size > MAX_TEXT_FILE_BYTES) {
    return {
      source,
      path: relativePath,
      content: null,
      size,
      binary: true,
      truncated: true,
    };
  }
  const content = await runGitRaw(repoRoot, ['cat-file', 'blob', objectSpec], {
    maxBuffer: MAX_TEXT_FILE_BYTES + 1024,
  });
  if (content.code !== 0) return null;
  return versionFromBuffer(source, relativePath, Buffer.from(content.stdout, 'utf8'));
}

export async function getIdeGitFileDiff(
  workspaceInput: string,
  rawPath: string,
  area: IdeGitDiffArea = 'working',
): Promise<IdeGitFileDiff> {
  if (area !== 'working' && area !== 'staged') {
    throw new IdeGitError('Diff area must be "working" or "staged".', 'INVALID_DIFF_AREA', 400);
  }
  const { repoRoot } = await resolveRepository(workspaceInput);
  const relativePath = validateRepoPath(repoRoot, rawPath);
  const statusOutput = await runGit(repoRoot, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--',
    literalPathspec(relativePath),
  ]);
  const entry = parseStatus(statusOutput).entries.find((candidate) => candidate.path === relativePath);
  const originalPath = entry?.originalPath || relativePath;
  const [patchOutput, original, modified] = await Promise.all([
    runGit(repoRoot, [
      'diff',
      ...(area === 'staged' ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-color',
      '--full-index',
      '--unified=3',
      '--',
      literalPathspec(relativePath),
    ], { maxBuffer: MAX_GIT_BUFFER }),
    area === 'staged'
      ? readGitVersion(repoRoot, originalPath, 'head')
      : readGitVersion(repoRoot, originalPath, 'index'),
    area === 'staged'
      ? readGitVersion(repoRoot, relativePath, 'index')
      : readWorkingVersion(repoRoot, relativePath),
  ]);
  const patchTruncated = patchOutput.length > MAX_PATCH_CHARS;
  return {
    path: relativePath,
    area,
    patch: patchTruncated ? patchOutput.slice(0, MAX_PATCH_CHARS) : patchOutput,
    original,
    modified,
    binary: Boolean(original?.binary || modified?.binary),
    truncated: Boolean(patchTruncated || original?.truncated || modified?.truncated),
  };
}

async function withMutationLock<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? repoRoot.toLowerCase() : repoRoot;
  const locks = mutationLocks();
  const previous = locks.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

async function hasHead(repoRoot: string): Promise<boolean> {
  const result = await runGitRaw(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  return result.code === 0;
}

async function deleteExactUntrackedFile(repoRoot: string, relativePath: string): Promise<void> {
  const absolute = path.resolve(repoRoot, relativePath);
  const repoReal = await fs.realpath(repoRoot);
  const parentReal = await fs.realpath(path.dirname(absolute)).catch(() => null);
  if (!parentReal) {
    throw new IdeGitError(`Could not verify the parent folder for "${relativePath}".`, 'UNSAFE_UNTRACKED_DELETE', 409);
  }
  const relation = path.relative(repoReal, parentReal);
  if (
    relation === '..'
    || relation.startsWith(`..${path.sep}`)
    || path.isAbsolute(relation)
  ) {
    throw new IdeGitError(`Refusing to delete "${relativePath}" through a symlink outside the repository.`, 'UNSAFE_UNTRACKED_DELETE', 409);
  }
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) {
    throw new IdeGitError(
      `Refusing to recursively delete untracked directory "${relativePath}". Select its files explicitly.`,
      'UNTRACKED_DIRECTORY_REFUSED',
      409,
    );
  }
  await fs.rm(absolute, { force: true });
}

async function discardPaths(repoRoot: string, requestedPaths: readonly string[]): Promise<string> {
  const paths = validatePaths(repoRoot, requestedPaths);
  const status = parseStatus(await runGit(repoRoot, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ])).entries;
  const byPath = new Map(status.map((entry) => [entry.path, entry]));
  const tracked: string[] = [];
  const untracked: string[] = [];

  for (const relativePath of paths) {
    const entry = byPath.get(relativePath);
    if (!entry) {
      throw new IdeGitError(`"${relativePath}" has no working-tree change to discard.`, 'NO_DISCARDABLE_CHANGE', 409);
    }
    if (entry.conflicted) {
      throw new IdeGitError(`Resolve the conflict in "${relativePath}" before discarding it.`, 'CONFLICTED_PATH', 409);
    }
    if (entry.untracked) {
      untracked.push(relativePath);
      continue;
    }
    if (!entry.unstaged) {
      throw new IdeGitError(
        `"${relativePath}" only has staged changes. Unstage it before discarding.`,
        'STAGED_CHANGE_NOT_DISCARDED',
        409,
      );
    }
    tracked.push(relativePath);
    if (entry.originalPath) tracked.push(validateRepoPath(repoRoot, entry.originalPath));
  }

  if (tracked.length) {
    await runGit(repoRoot, [
      'restore',
      '--worktree',
      '--',
      ...[...new Set(tracked)].map(literalPathspec),
    ], { errorMessage: 'Could not discard tracked file changes.' });
  }
  for (const relativePath of untracked) {
    await deleteExactUntrackedFile(repoRoot, relativePath);
  }
  return `Discarded working-tree changes in ${paths.length} file${paths.length === 1 ? '' : 's'}.`;
}

async function validateBranchName(repoRoot: string, raw: string): Promise<string> {
  const branch = String(raw || '').trim();
  if (!branch || branch.length > 250 || branch.startsWith('-') || branch.includes('\0')) {
    throw new IdeGitError('Invalid branch name.', 'INVALID_BRANCH', 400);
  }
  const valid = await runGitRaw(repoRoot, ['check-ref-format', '--branch', branch]);
  if (valid.code !== 0) throw new IdeGitError('Invalid branch name.', 'INVALID_BRANCH', 400);
  return branch;
}

async function validateRemote(repoRoot: string, raw: string): Promise<string> {
  const remote = String(raw || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(remote)) {
    throw new IdeGitError('Invalid Git remote name.', 'INVALID_REMOTE', 400);
  }
  const names = (await runGit(repoRoot, ['remote'])).split(/\r?\n/).filter(Boolean);
  if (!names.includes(remote)) {
    throw new IdeGitError(`Git remote "${remote}" does not exist.`, 'REMOTE_NOT_FOUND', 404);
  }
  return remote;
}

async function executeAction(repoRoot: string, action: IdeGitAction): Promise<{ output: string; commitOid?: string }> {
  switch (action.action) {
    case 'stage': {
      const paths = validatePaths(repoRoot, action.paths);
      await runGit(repoRoot, ['add', '--', ...paths.map(literalPathspec)], {
        errorMessage: 'Could not stage the selected files.',
      });
      return { output: `Staged ${paths.length} file${paths.length === 1 ? '' : 's'}.` };
    }
    case 'unstage': {
      const paths = validatePaths(repoRoot, action.paths);
      if (await hasHead(repoRoot)) {
        await runGit(repoRoot, ['restore', '--staged', '--', ...paths.map(literalPathspec)], {
          errorMessage: 'Could not unstage the selected files.',
        });
      } else {
        await runGit(repoRoot, ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...paths.map(literalPathspec)], {
          errorMessage: 'Could not unstage files in the new repository.',
        });
      }
      return { output: `Unstaged ${paths.length} file${paths.length === 1 ? '' : 's'}.` };
    }
    case 'discard':
      return { output: await discardPaths(repoRoot, action.paths) };
    case 'commit': {
      const message = String(action.message || '').trim();
      if (!message) throw new IdeGitError('Commit message is required.', 'COMMIT_MESSAGE_REQUIRED', 400);
      if (message.length > 10_000 || message.includes('\0')) {
        throw new IdeGitError('Commit message is too long or contains invalid characters.', 'INVALID_COMMIT_MESSAGE', 400);
      }
      const staged = parseStatus(await runGit(repoRoot, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
      ])).entries.filter((entry) => entry.staged);
      if (!staged.length) throw new IdeGitError('There are no staged changes to commit.', 'NOTHING_STAGED', 409);
      if (staged.some((entry) => entry.conflicted)) {
        throw new IdeGitError('Resolve all conflicts before committing.', 'UNRESOLVED_CONFLICTS', 409);
      }
      const output = await runGit(repoRoot, ['commit', '-m', message], {
        timeoutMs: NETWORK_TIMEOUT_MS,
        errorMessage: 'Git commit failed.',
      });
      const commitOid = stripOneLineEnding(await runGit(repoRoot, ['rev-parse', 'HEAD']));
      return { output: redactGitOutput(output.trim()) || `Created commit ${commitOid.slice(0, 12)}.`, commitOid };
    }
    case 'pull': {
      const output = await runGit(repoRoot, ['pull', '--ff-only'], {
        timeoutMs: NETWORK_TIMEOUT_MS,
        errorMessage: 'Fast-forward pull failed.',
      });
      return { output: redactGitOutput(output.trim()) || 'Repository is up to date.' };
    }
    case 'push': {
      const status = parseStatus(await runGit(repoRoot, [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=no',
      ]));
      if (status.detached || !status.branch) {
        throw new IdeGitError('Checkout a local branch before pushing.', 'DETACHED_HEAD_PUSH', 409);
      }
      const args = ['push', '--porcelain'];
      if (!status.upstream) {
        const remotes = (await runGit(repoRoot, ['remote']))
          .split(/\r?\n/)
          .map((remote) => remote.trim())
          .filter(Boolean);
        const candidate = remotes.includes('origin')
          ? 'origin'
          : remotes.length === 1
            ? remotes[0]
            : '';
        if (!candidate) {
          throw new IdeGitError(
            'This branch has no upstream. Add an origin remote or configure an upstream before pushing.',
            'PUSH_UPSTREAM_REQUIRED',
            409,
          );
        }
        args.push('--set-upstream', await validateRemote(repoRoot, candidate), status.branch);
      }
      const output = await runGit(repoRoot, args, {
        timeoutMs: NETWORK_TIMEOUT_MS,
        errorMessage: 'Git push failed.',
      });
      return { output: redactGitOutput(output.trim()) || 'Push completed.' };
    }
    case 'fetch': {
      const args = ['fetch', '--prune'];
      if (action.remote) args.push(await validateRemote(repoRoot, action.remote));
      else args.push('--all');
      const output = await runGit(repoRoot, args, {
        timeoutMs: NETWORK_TIMEOUT_MS,
        errorMessage: 'Git fetch failed.',
      });
      return { output: redactGitOutput(output.trim()) || 'Fetch completed.' };
    }
    case 'checkout': {
      const branch = await validateBranchName(repoRoot, action.branch);
      const branches = parseBranches(await runGit(repoRoot, [
        'for-each-ref',
        '--format=%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(committerdate:iso-strict)%1f%(subject)',
        'refs/heads',
      ]));
      if (!branches.some((candidate) => candidate.name === branch)) {
        throw new IdeGitError(`Local branch "${branch}" does not exist.`, 'BRANCH_NOT_FOUND', 404);
      }
      const output = await runGit(repoRoot, ['switch', branch], {
        errorMessage: `Could not switch to branch "${branch}".`,
      });
      return { output: output.trim() || `Switched to ${branch}.` };
    }
    case 'createBranch': {
      const branch = await validateBranchName(repoRoot, action.branch);
      const args = ['switch', '-c', branch];
      if (action.startPoint) {
        const startPoint = String(action.startPoint).trim();
        if (!startPoint || startPoint.length > 500 || startPoint.includes('\0') || startPoint.startsWith('-')) {
          throw new IdeGitError('Invalid branch start point.', 'INVALID_START_POINT', 400);
        }
        const resolved = await runGitRaw(repoRoot, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${startPoint}^{commit}`,
        ]);
        if (resolved.code !== 0) {
          throw new IdeGitError(`Branch start point "${startPoint}" was not found.`, 'START_POINT_NOT_FOUND', 404);
        }
        args.push(stripOneLineEnding(resolved.stdout));
      }
      const output = await runGit(repoRoot, args, {
        errorMessage: `Could not create branch "${branch}".`,
      });
      return { output: output.trim() || `Created and switched to ${branch}.` };
    }
  }
}

export async function applyIdeGitAction(
  workspaceInput: string,
  action: IdeGitAction,
): Promise<IdeGitActionResult> {
  const { workspace, repoRoot } = await resolveRepository(workspaceInput);
  return withMutationLock(repoRoot, async () => {
    const result = await executeAction(repoRoot, action);
    const snapshot = await snapshotFromRepository(workspace, repoRoot);
    return {
      action: action.action,
      ...result,
      snapshot,
    };
  });
}
