import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { projectRoot } from './data-paths';

const execFileAsync = promisify(execFile);

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.worktrees',
]);

export const IDE_WORKSPACE_LIMITS = {
  maxDirectoryEntries: 2_000,
  maxTextFileBytes: 2 * 1024 * 1024,
  maxSearchMatches: 500,
  maxSearchQueryCharacters: 256,
  maxSearchFiles: 2_500,
  maxSearchBytes: 32 * 1024 * 1024,
  maxRelativePathCharacters: 4_096,
} as const;

const DEFAULT_SEARCH_MATCHES = 200;
const SEARCH_TIMEOUT_MS = 8_000;
const SEARCH_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_LINE_CHARACTERS = 1_000;

export type IdeWorkspaceErrorCode =
  | 'BINARY_FILE'
  | 'DIRECTORY_NOT_EMPTY'
  | 'FILE_CHANGED'
  | 'INVALID_PATH'
  | 'INVALID_REQUEST'
  | 'NOT_A_DIRECTORY'
  | 'NOT_A_FILE'
  | 'PATH_EXCLUDED'
  | 'PATH_NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'PATH_SYMLINK'
  | 'PERMISSION_DENIED'
  | 'TARGET_EXISTS'
  | 'TEXT_FILE_TOO_LARGE'
  | 'WORKSPACE_NOT_FOUND';

export class IdeWorkspaceError extends Error {
  readonly code: IdeWorkspaceErrorCode;
  readonly status: number;

  constructor(code: IdeWorkspaceErrorCode, message: string, status: number) {
    super(message);
    this.name = 'IdeWorkspaceError';
    this.code = code;
    this.status = status;
  }
}

export interface IdeWorkspaceEntry {
  name: string;
  /** Workspace-relative POSIX-style path. */
  path: string;
  kind: 'directory' | 'file';
  isDirectory: boolean;
  isSymlink: boolean;
  size?: number;
  mtimeMs: number;
}

export interface IdeDirectoryListing {
  workspace: string;
  path: string;
  entries: IdeWorkspaceEntry[];
  truncated: boolean;
}

export interface IdeTextFile {
  workspace: string;
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
  /** SHA-256 of the bytes read; pass back as expectedVersion when saving. */
  version: string;
}

export interface IdeSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface IdeSearchResult {
  workspace: string;
  query: string;
  matches: IdeSearchMatch[];
  truncated: boolean;
  engine: 'fallback' | 'rg';
}

export interface IdeSearchOptions {
  limit?: number;
  /**
   * Test/packaging override. The API never accepts this from clients.
   * A missing command exercises the bounded Node.js fallback.
   */
  ripgrepCommand?: string;
}

interface ResolvedExistingPath {
  workspace: string;
  relative: string;
  lexical: string;
  real: string;
}

interface ResolvedMutationPath {
  workspace: string;
  relative: string;
  absolute: string;
}

function isExcludedSegment(segment: string): boolean {
  return EXCLUDED_SEGMENTS.has(segment.toLowerCase());
}

function pathIsAtOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function assertAllowedSegments(relativePath: string): void {
  for (const segment of relativePath.split('/').filter(Boolean)) {
    if (isExcludedSegment(segment)) {
      throw new IdeWorkspaceError(
        'PATH_EXCLUDED',
        `The IDE does not expose "${segment}" directories.`,
        403,
      );
    }
  }
}

/**
 * Normalize the public API's workspace-relative path without ever allowing an
 * absolute path, drive-relative path, traversal segment, or excluded tree.
 */
export function normalizeIdeRelativePath(
  input: string,
  options: { allowRoot?: boolean } = {},
): string {
  if (typeof input !== 'string' || input.includes('\0')) {
    throw new IdeWorkspaceError('INVALID_PATH', 'A valid workspace-relative path is required.', 400);
  }
  if (input.length > IDE_WORKSPACE_LIMITS.maxRelativePathCharacters) {
    throw new IdeWorkspaceError('INVALID_PATH', 'The path is too long.', 400);
  }

  const forward = input.replace(/\\/g, '/');
  if (
    forward.startsWith('/')
    || /^[A-Za-z]:/.test(forward)
    || path.isAbsolute(input)
  ) {
    throw new IdeWorkspaceError('INVALID_PATH', 'Absolute paths are not accepted by the IDE API.', 400);
  }

  const segments: string[] = [];
  for (const segment of forward.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      throw new IdeWorkspaceError('PATH_OUTSIDE_WORKSPACE', 'Path traversal is not allowed.', 403);
    }
    if (process.platform === 'win32' && (segment.includes(':') || /[ .]$/.test(segment))) {
      throw new IdeWorkspaceError('INVALID_PATH', 'The path is not valid on Windows.', 400);
    }
    if (isExcludedSegment(segment)) {
      throw new IdeWorkspaceError(
        'PATH_EXCLUDED',
        `The IDE does not expose "${segment}" directories.`,
        403,
      );
    }
    segments.push(segment);
  }

  const normalized = segments.join('/');
  if (!normalized && !options.allowRoot) {
    throw new IdeWorkspaceError('INVALID_PATH', 'A workspace-relative path is required.', 400);
  }
  return normalized;
}

function lexicalPath(workspace: string, relativePath: string): string {
  const candidate = relativePath
    ? path.resolve(workspace, ...relativePath.split('/'))
    : workspace;
  if (!pathIsAtOrInside(candidate, workspace)) {
    throw new IdeWorkspaceError('PATH_OUTSIDE_WORKSPACE', 'The path leaves the workspace.', 403);
  }
  return candidate;
}

function assertCanonicalPathAllowed(workspace: string, realPath: string): void {
  if (!pathIsAtOrInside(realPath, workspace)) {
    throw new IdeWorkspaceError(
      'PATH_OUTSIDE_WORKSPACE',
      'A symbolic link points outside the workspace.',
      403,
    );
  }
  assertAllowedSegments(toPosixPath(path.relative(workspace, realPath)));
}

export async function resolveIdeWorkspaceRoot(input: string): Promise<string> {
  const requested = String(input || '').trim();
  if (!requested || requested.includes('\0')) {
    throw new IdeWorkspaceError('WORKSPACE_NOT_FOUND', 'No workspace is configured.', 400);
  }

  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(/* turbopackIgnore: true */ projectRoot(), requested);
  try {
    const real = await fs.realpath(resolved);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      throw new IdeWorkspaceError('NOT_A_DIRECTORY', 'The configured workspace is not a directory.', 400);
    }
    return real;
  } catch (error) {
    if (error instanceof IdeWorkspaceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new IdeWorkspaceError('WORKSPACE_NOT_FOUND', 'The configured workspace does not exist.', 404);
    }
    throw error;
  }
}

async function resolveExistingPath(
  workspaceInput: string,
  relativeInput: string,
  options: { allowRoot?: boolean } = {},
): Promise<ResolvedExistingPath> {
  const workspace = await resolveIdeWorkspaceRoot(workspaceInput);
  const relative = normalizeIdeRelativePath(relativeInput, options);
  const lexical = lexicalPath(workspace, relative);
  try {
    const real = await fs.realpath(lexical);
    assertCanonicalPathAllowed(workspace, real);
    return { workspace, relative, lexical, real };
  } catch (error) {
    if (error instanceof IdeWorkspaceError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IdeWorkspaceError('PATH_NOT_FOUND', `Path not found: ${relative || '.'}`, 404);
    }
    throw error;
  }
}

/**
 * Mutations intentionally reject symlink components, including safe internal
 * symlinks. This prevents confusing writes to link targets and closes the
 * common parent-symlink escape race on every supported platform.
 */
async function assertNoSymlinkComponents(
  workspace: string,
  relativePath: string,
  includeTarget: boolean,
): Promise<void> {
  const segments = relativePath.split('/').filter(Boolean);
  let current = workspace;
  const count = includeTarget ? segments.length : Math.max(0, segments.length - 1);
  for (let index = 0; index < count; index += 1) {
    current = path.join(/* turbopackIgnore: true */ current, segments[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new IdeWorkspaceError(
          'PATH_SYMLINK',
          'IDE file mutations do not follow symbolic links.',
          403,
        );
      }
    } catch (error) {
      if (error instanceof IdeWorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

async function resolveExistingMutationPath(
  workspaceInput: string,
  relativeInput: string,
): Promise<ResolvedMutationPath> {
  const workspace = await resolveIdeWorkspaceRoot(workspaceInput);
  const relative = normalizeIdeRelativePath(relativeInput);
  const absolute = lexicalPath(workspace, relative);
  await assertNoSymlinkComponents(workspace, relative, true);
  try {
    const real = await fs.realpath(absolute);
    assertCanonicalPathAllowed(workspace, real);
  } catch (error) {
    if (error instanceof IdeWorkspaceError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IdeWorkspaceError('PATH_NOT_FOUND', `Path not found: ${relative}`, 404);
    }
    throw error;
  }
  return { workspace, relative, absolute };
}

async function resolveNewMutationPath(
  workspaceInput: string,
  relativeInput: string,
): Promise<ResolvedMutationPath> {
  const workspace = await resolveIdeWorkspaceRoot(workspaceInput);
  const relative = normalizeIdeRelativePath(relativeInput);
  const absolute = lexicalPath(workspace, relative);
  await assertNoSymlinkComponents(workspace, relative, false);

  const parent = path.dirname(absolute);
  try {
    const realParent = await fs.realpath(parent);
    assertCanonicalPathAllowed(workspace, realParent);
    const parentStat = await fs.stat(realParent);
    if (!parentStat.isDirectory()) {
      throw new IdeWorkspaceError('NOT_A_DIRECTORY', 'The destination parent is not a directory.', 400);
    }
  } catch (error) {
    if (error instanceof IdeWorkspaceError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IdeWorkspaceError('PATH_NOT_FOUND', 'The destination parent does not exist.', 404);
    }
    throw error;
  }

  try {
    await fs.lstat(absolute);
    throw new IdeWorkspaceError('TARGET_EXISTS', `A path already exists at ${relative}.`, 409);
  } catch (error) {
    if (error instanceof IdeWorkspaceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { workspace, relative, absolute };
}

async function describeEntry(
  workspace: string,
  parentRelative: string,
  name: string,
): Promise<IdeWorkspaceEntry | null> {
  if (isExcludedSegment(name)) return null;
  const relative = parentRelative ? `${parentRelative}/${name}` : name;
  const absolute = lexicalPath(workspace, relative);
  try {
    const linkStat = await fs.lstat(absolute);
    const isSymlink = linkStat.isSymbolicLink();
    let effectiveStat = linkStat;
    if (isSymlink) {
      const real = await fs.realpath(absolute);
      assertCanonicalPathAllowed(workspace, real);
      effectiveStat = await fs.stat(real);
    }
    if (!effectiveStat.isDirectory() && !effectiveStat.isFile()) return null;
    const isDirectory = effectiveStat.isDirectory();
    return {
      name,
      path: relative,
      kind: isDirectory ? 'directory' : 'file',
      isDirectory,
      isSymlink,
      ...(isDirectory ? {} : { size: effectiveStat.size }),
      mtimeMs: effectiveStat.mtimeMs,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Broken and out-of-workspace symlinks are not exposed as navigable items.
    if (
      code === 'ENOENT'
      || (error instanceof IdeWorkspaceError
        && (error.code === 'PATH_OUTSIDE_WORKSPACE' || error.code === 'PATH_EXCLUDED'))
    ) {
      return null;
    }
    throw error;
  }
}

export async function listIdeDirectory(
  workspaceInput: string,
  relativeInput = '',
): Promise<IdeDirectoryListing> {
  const resolved = await resolveExistingPath(workspaceInput, relativeInput, { allowRoot: true });
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) {
    throw new IdeWorkspaceError('NOT_A_DIRECTORY', `${resolved.relative || '.'} is not a directory.`, 400);
  }

  const names: string[] = [];
  let truncated = false;
  const directory = await fs.opendir(resolved.real);
  for await (const entry of directory) {
    if (isExcludedSegment(entry.name)) continue;
    if (names.length >= IDE_WORKSPACE_LIMITS.maxDirectoryEntries) {
      truncated = true;
      break;
    }
    names.push(entry.name);
  }

  const described = await Promise.all(
    names.map((name) => describeEntry(resolved.workspace, resolved.relative, name)),
  );
  const entries = described
    .filter((entry): entry is IdeWorkspaceEntry => entry !== null)
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });

  return {
    workspace: resolved.workspace,
    path: resolved.relative,
    entries,
    truncated,
  };
}

function textFileVersion(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function decodeTextFile(content: Buffer, relativePath: string): string {
  if (content.includes(0)) {
    throw new IdeWorkspaceError('BINARY_FILE', `${relativePath} is a binary file.`, 415);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new IdeWorkspaceError('BINARY_FILE', `${relativePath} is not valid UTF-8 text.`, 415);
  }
}

function assertTextSize(size: number, relativePath: string): void {
  if (size > IDE_WORKSPACE_LIMITS.maxTextFileBytes) {
    throw new IdeWorkspaceError(
      'TEXT_FILE_TOO_LARGE',
      `${relativePath} exceeds the ${IDE_WORKSPACE_LIMITS.maxTextFileBytes}-byte editor limit.`,
      413,
    );
  }
}

export async function readIdeTextFile(
  workspaceInput: string,
  relativeInput: string,
): Promise<IdeTextFile> {
  const resolved = await resolveExistingPath(workspaceInput, relativeInput);
  const stat = await fs.stat(resolved.real);
  if (!stat.isFile()) {
    throw new IdeWorkspaceError('NOT_A_FILE', `${resolved.relative} is not a file.`, 400);
  }
  assertTextSize(stat.size, resolved.relative);
  const bytes = await fs.readFile(resolved.real);
  assertTextSize(bytes.length, resolved.relative);
  const content = decodeTextFile(bytes, resolved.relative);
  return {
    workspace: resolved.workspace,
    path: resolved.relative,
    content,
    size: bytes.length,
    mtimeMs: stat.mtimeMs,
    version: textFileVersion(bytes),
  };
}

function contentBuffer(content: string, relativePath: string): Buffer {
  if (typeof content !== 'string') {
    throw new IdeWorkspaceError('INVALID_REQUEST', 'File content must be text.', 400);
  }
  const bytes = Buffer.from(content, 'utf8');
  assertTextSize(bytes.length, relativePath);
  return bytes;
}

async function writeStagedFile(
  destination: string,
  bytes: Buffer,
  mode: number,
  beforeCommit: () => Promise<void>,
): Promise<void> {
  const temporary = path.join(
    /* turbopackIgnore: true */
    path.dirname(destination),
    `.shiba-ide-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporary, 'wx', mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await beforeCommit();
    await fs.rename(temporary, destination);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function saveIdeTextFile(
  workspaceInput: string,
  relativeInput: string,
  content: string,
  expectedVersion?: string,
): Promise<IdeTextFile> {
  const resolved = await resolveExistingMutationPath(workspaceInput, relativeInput);
  const stat = await fs.stat(resolved.absolute);
  if (!stat.isFile()) {
    throw new IdeWorkspaceError('NOT_A_FILE', `${resolved.relative} is not a file.`, 400);
  }
  assertTextSize(stat.size, resolved.relative);
  const existing = await fs.readFile(resolved.absolute);
  assertTextSize(existing.length, resolved.relative);
  decodeTextFile(existing, resolved.relative);
  if (expectedVersion && textFileVersion(existing) !== expectedVersion) {
    throw new IdeWorkspaceError(
      'FILE_CHANGED',
      `${resolved.relative} changed on disk. Reload or explicitly overwrite it.`,
      409,
    );
  }

  const bytes = contentBuffer(content, resolved.relative);
  await writeStagedFile(resolved.absolute, bytes, stat.mode, async () => {
    // Re-check containment/symlinks immediately before the atomic replace.
    await resolveExistingMutationPath(resolved.workspace, resolved.relative);
    if (expectedVersion) {
      const latest = await fs.readFile(resolved.absolute);
      if (textFileVersion(latest) !== expectedVersion) {
        throw new IdeWorkspaceError(
          'FILE_CHANGED',
          `${resolved.relative} changed on disk. Reload or explicitly overwrite it.`,
          409,
        );
      }
    }
  });
  return readIdeTextFile(resolved.workspace, resolved.relative);
}

async function entryAtPath(workspace: string, relative: string): Promise<IdeWorkspaceEntry> {
  const name = relative.split('/').pop() || relative;
  const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
  const entry = await describeEntry(workspace, parent, name);
  if (!entry) {
    throw new IdeWorkspaceError('PATH_NOT_FOUND', `Path not found: ${relative}`, 404);
  }
  return entry;
}

export async function createIdeEntry(
  workspaceInput: string,
  relativeInput: string,
  kind: 'directory' | 'file',
  content = '',
): Promise<IdeWorkspaceEntry> {
  const resolved = await resolveNewMutationPath(workspaceInput, relativeInput);
  if (kind === 'directory') {
    await fs.mkdir(resolved.absolute);
  } else if (kind === 'file') {
    const bytes = contentBuffer(content, resolved.relative);
    const handle = await fs.open(resolved.absolute, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    throw new IdeWorkspaceError('INVALID_REQUEST', 'Entry kind must be "file" or "directory".', 400);
  }
  return entryAtPath(resolved.workspace, resolved.relative);
}

export async function renameIdeEntry(
  workspaceInput: string,
  relativeInput: string,
  newRelativeInput: string,
): Promise<IdeWorkspaceEntry> {
  const source = await resolveExistingMutationPath(workspaceInput, relativeInput);
  const destination = await resolveNewMutationPath(source.workspace, newRelativeInput);
  const sourceStat = await fs.lstat(source.absolute);
  if (
    sourceStat.isDirectory()
    && pathIsAtOrInside(destination.absolute, source.absolute)
  ) {
    throw new IdeWorkspaceError(
      'INVALID_PATH',
      'A directory cannot be moved inside itself.',
      400,
    );
  }
  await fs.rename(source.absolute, destination.absolute);
  return entryAtPath(source.workspace, destination.relative);
}

export async function deleteIdeEntry(
  workspaceInput: string,
  relativeInput: string,
  options: { recursive?: boolean } = {},
): Promise<{ workspace: string; path: string; kind: 'directory' | 'file' }> {
  const resolved = await resolveExistingMutationPath(workspaceInput, relativeInput);
  const stat = await fs.lstat(resolved.absolute);
  const kind = stat.isDirectory() ? 'directory' : 'file';
  try {
    if (stat.isDirectory()) {
      if (options.recursive) {
        await fs.rm(resolved.absolute, { recursive: true, force: false, maxRetries: 1, retryDelay: 50 });
      } else {
        await fs.rmdir(resolved.absolute);
      }
    } else {
      await fs.unlink(resolved.absolute);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
      throw new IdeWorkspaceError(
        'DIRECTORY_NOT_EMPTY',
        `${resolved.relative} is not empty; recursive deletion must be confirmed.`,
        409,
      );
    }
    throw error;
  }
  return { workspace: resolved.workspace, path: resolved.relative, kind };
}

function searchLimit(requested?: number): number {
  const parsed = Number.isFinite(requested) ? Math.floor(requested as number) : DEFAULT_SEARCH_MATCHES;
  return Math.max(1, Math.min(IDE_WORKSPACE_LIMITS.maxSearchMatches, parsed));
}

function normalizedSearchQuery(query: string): string {
  if (
    typeof query !== 'string'
    || !query.trim()
    || query.includes('\0')
    || query.includes('\n')
    || query.includes('\r')
  ) {
    throw new IdeWorkspaceError('INVALID_REQUEST', 'A single-line text search query is required.', 400);
  }
  if (Array.from(query).length > IDE_WORKSPACE_LIMITS.maxSearchQueryCharacters) {
    throw new IdeWorkspaceError('INVALID_REQUEST', 'The search query is too long.', 400);
  }
  return query;
}

interface RipgrepJsonMatch {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number }>;
  };
}

function parseRipgrepOutput(output: string, limit: number): IdeSearchMatch[] {
  const matches: IdeSearchMatch[] = [];
  for (const jsonLine of output.split(/\r?\n/)) {
    if (!jsonLine || matches.length >= limit) break;
    let event: RipgrepJsonMatch;
    try {
      event = JSON.parse(jsonLine) as RipgrepJsonMatch;
    } catch {
      continue;
    }
    if (event.type !== 'match') continue;
    const rawPath = event.data?.path?.text;
    const rawLine = event.data?.lines?.text;
    const lineNumber = event.data?.line_number;
    if (!rawPath || typeof rawLine !== 'string' || !Number.isFinite(lineNumber)) continue;
    let relative: string;
    try {
      relative = normalizeIdeRelativePath(rawPath.replace(/^\.[\\/]/, ''));
    } catch {
      continue;
    }
    const cleanLine = rawLine.replace(/\r?\n$/, '');
    const submatches = event.data?.submatches?.length ? event.data.submatches : [{ start: 0 }];
    for (const submatch of submatches) {
      if (matches.length >= limit) break;
      const byteOffset = Math.max(0, Number(submatch.start) || 0);
      const column = Buffer.from(cleanLine, 'utf8')
        .subarray(0, byteOffset)
        .toString('utf8').length + 1;
      matches.push({
        path: relative,
        line: Math.max(1, Math.floor(lineNumber as number)),
        column,
        text: cleanLine.slice(0, MAX_SEARCH_LINE_CHARACTERS),
      });
    }
  }
  return matches;
}

async function searchWithRipgrep(
  workspace: string,
  query: string,
  limit: number,
  command: string,
): Promise<{ matches: IdeSearchMatch[]; truncated: boolean } | null> {
  const exclusionArgs = [...EXCLUDED_SEGMENTS].flatMap((segment) => [
    '--glob',
    `!${segment}/**`,
    '--glob',
    `!**/${segment}/**`,
  ]);
  const args = [
    '--json',
    '--fixed-strings',
    '--smart-case',
    '--hidden',
    '--no-ignore',
    '--line-number',
    '--column',
    `--max-count=${limit + 1}`,
    `--max-filesize=${IDE_WORKSPACE_LIMITS.maxTextFileBytes}`,
    ...exclusionArgs,
    '--',
    query,
    '.',
  ];

  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: SEARCH_OUTPUT_BYTES,
      timeout: SEARCH_TIMEOUT_MS,
      windowsHide: true,
    });
    const parsed = parseRipgrepOutput(String(stdout), limit);
    return { matches: parsed, truncated: parsed.length >= limit };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      killed?: boolean;
      stdout?: string | Buffer;
    };
    if (failure.code === 1) return { matches: [], truncated: false };
    const partial = failure.stdout ? String(failure.stdout) : '';
    if (partial && (failure.killed || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
      return { matches: parseRipgrepOutput(partial, limit), truncated: true };
    }
    // rg is optional. Missing binaries, unsupported builds, and execution
    // failures all fall back to a bounded fs traversal with no shell.
    return null;
  }
}

async function searchWithFallback(
  workspace: string,
  query: string,
  limit: number,
): Promise<{ matches: IdeSearchMatch[]; truncated: boolean }> {
  const matches: IdeSearchMatch[] = [];
  const directories = [''];
  const startedAt = Date.now();
  let filesScanned = 0;
  let bytesScanned = 0;
  let truncated = false;
  const caseSensitive = /[A-Z]/.test(query);
  const needle = caseSensitive ? query : query.toLocaleLowerCase();

  while (directories.length > 0 && matches.length < limit) {
    if (Date.now() - startedAt > SEARCH_TIMEOUT_MS) {
      truncated = true;
      break;
    }
    const current = directories.shift()!;
    const listing = await listIdeDirectory(workspace, current);
    if (listing.truncated) truncated = true;
    for (const entry of listing.entries) {
      if (entry.isSymlink) continue;
      if (entry.isDirectory) {
        directories.push(entry.path);
        continue;
      }
      if (filesScanned >= IDE_WORKSPACE_LIMITS.maxSearchFiles) {
        truncated = true;
        break;
      }
      const size = entry.size || 0;
      if (size > IDE_WORKSPACE_LIMITS.maxTextFileBytes) continue;
      if (bytesScanned + size > IDE_WORKSPACE_LIMITS.maxSearchBytes) {
        truncated = true;
        break;
      }
      filesScanned += 1;
      bytesScanned += size;

      let file: IdeTextFile;
      try {
        file = await readIdeTextFile(workspace, entry.path);
      } catch (error) {
        if (
          error instanceof IdeWorkspaceError
          && (error.code === 'BINARY_FILE' || error.code === 'TEXT_FILE_TOO_LARGE')
        ) {
          continue;
        }
        throw error;
      }

      const lines = file.content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length && matches.length < limit; lineIndex += 1) {
        const line = lines[lineIndex];
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        let from = 0;
        while (matches.length < limit) {
          const index = haystack.indexOf(needle, from);
          if (index < 0) break;
          matches.push({
            path: entry.path,
            line: lineIndex + 1,
            column: index + 1,
            text: line.slice(0, MAX_SEARCH_LINE_CHARACTERS),
          });
          from = index + Math.max(needle.length, 1);
        }
      }
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (truncated && (
      filesScanned >= IDE_WORKSPACE_LIMITS.maxSearchFiles
      || bytesScanned >= IDE_WORKSPACE_LIMITS.maxSearchBytes
    )) {
      break;
    }
  }
  return { matches, truncated };
}

export async function searchIdeWorkspace(
  workspaceInput: string,
  queryInput: string,
  options: IdeSearchOptions = {},
): Promise<IdeSearchResult> {
  const workspace = await resolveIdeWorkspaceRoot(workspaceInput);
  const query = normalizedSearchQuery(queryInput);
  const limit = searchLimit(options.limit);
  const ripgrep = await searchWithRipgrep(
    workspace,
    query,
    limit,
    options.ripgrepCommand || 'rg',
  );
  if (ripgrep) {
    return { workspace, query, ...ripgrep, engine: 'rg' };
  }
  const fallback = await searchWithFallback(workspace, query, limit);
  return { workspace, query, ...fallback, engine: 'fallback' };
}

export function normalizeIdeWorkspaceError(error: unknown): IdeWorkspaceError {
  if (error instanceof IdeWorkspaceError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    return new IdeWorkspaceError('PATH_NOT_FOUND', 'The requested path no longer exists.', 404);
  }
  if (code === 'EEXIST') {
    return new IdeWorkspaceError('TARGET_EXISTS', 'The destination already exists.', 409);
  }
  if (code === 'ENOTEMPTY') {
    return new IdeWorkspaceError('DIRECTORY_NOT_EMPTY', 'The directory is not empty.', 409);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new IdeWorkspaceError('PERMISSION_DENIED', 'The operating system denied this file operation.', 403);
  }
  return new IdeWorkspaceError('INVALID_REQUEST', 'The IDE file operation failed.', 500);
}
