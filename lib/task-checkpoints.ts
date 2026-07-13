// Durable, bounded file checkpoints for the universal task ledger. A caller
// declares the exact writable task paths before mutation; sealing records the
// resulting bytes. Restore preflights every path and refuses to overwrite any
// state that no longer matches either side of that immutable checkpoint.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { emitAppEvent } from './app-events';
import { getChatSession } from './chat-sessions';
import { getDb } from './db';
import { getTask } from './task-ledger';
import type {
  TaskCheckpoint,
  TaskCheckpointFile,
  TaskCheckpointRestore,
  TaskCheckpointSnapshot,
  TaskWorkspaceRoot,
} from './task-types';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_PATHS = 10_000;
const WORKSPACE_CHECKPOINT_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'out', '.turbo', 'coverage', '.cache',
]);

interface CheckpointRow {
  id: string;
  taskId: string;
  reason: string;
  state: string;
  taskSnapshot: string;
  context: string;
  createdAt: string;
  sealedAt: string | null;
}

interface CheckpointFileRow {
  checkpointId: string;
  workspaceRootId: string;
  workspacePath: string;
  relativePath: string;
  beforeExists: number;
  beforeHash: string | null;
  beforeMode: number | null;
  beforeContent?: Uint8Array | null;
  beforeBytes?: number;
  afterExists: number | null;
  afterHash: string | null;
  afterMode: number | null;
  afterContent?: Uint8Array | null;
  afterBytes?: number;
}

interface RestoreRow {
  id: string;
  checkpointId: string;
  taskId: string;
  status: string;
  restoredPaths: string;
  conflicts: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

interface FileState {
  exists: boolean;
  hash: string | null;
  mode: number | null;
  content: Buffer | null;
}

export interface CreateTaskCheckpointInput {
  taskId: string;
  reason: string;
  files: Array<{ workspaceRootId: string; path: string }>;
  /** Message/tool cursor, browser state, approval IDs, and artifact IDs only. */
  context?: Record<string, unknown>;
}

export interface TaskCheckpointMutationResult<T> {
  checkpoint: TaskCheckpoint;
  value: T;
}

export interface TaskWorkspaceCheckpointInput {
  taskId: string;
  workspaceRootIds: string[];
  reason: string;
  context?: Record<string, unknown>;
}

export class CheckpointConflictError extends Error {
  readonly restore: TaskCheckpointRestore;

  constructor(restore: TaskCheckpointRestore) {
    super(`Checkpoint restore refused because ${restore.conflicts.length} task-owned path(s) changed after the checkpoint`);
    this.name = 'CheckpointConflictError';
    this.restore = restore;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseObject<T>(raw: string, fallback: T): T {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as T : fallback;
  } catch {
    return fallback;
  }
}

function parseArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function checkedContext(context: Record<string, unknown> | undefined): { value: Record<string, unknown>; json: string } {
  const value = context ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Checkpoint context must be an object');
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error('Checkpoint context must be JSON serializable');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_CONTEXT_BYTES) {
    throw new Error(`Checkpoint context exceeds ${MAX_CONTEXT_BYTES} bytes`);
  }
  return { value, json };
}

function validCheckpointId(id: string): string {
  const value = String(id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value)) throw new Error('Invalid checkpoint id');
  return value;
}

function normalizeRelativePath(input: string): string {
  const raw = String(input || '').trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`Checkpoint path must be workspace-relative: ${raw || '(empty)'}`);
  }
  const segments = raw.split('/').filter((segment) => segment !== '.');
  if (!segments.length || segments.some((segment) => !segment || segment === '..')) {
    throw new Error(`Checkpoint path escapes its workspace: ${raw}`);
  }
  if (segments[0].toLowerCase() === '.git') throw new Error('Checkpoint paths cannot modify Git metadata');
  return segments.join('/');
}

function pathKey(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveRoot(root: TaskWorkspaceRoot): Promise<string> {
  if (root.permission !== 'write') throw new Error(`Workspace root ${root.id} is read-only`);
  const absolute = path.resolve(root.path);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Workspace root does not exist: ${root.path}`);
  return fs.realpath(absolute);
}

/** Resolve a path while rejecting symlink traversal and directory snapshots. */
async function safeOwnedPath(rootReal: string, relativePath: string): Promise<string> {
  const full = path.resolve(rootReal, ...relativePath.split('/'));
  if (!isInside(pathKey(rootReal), pathKey(full))) throw new Error(`Checkpoint path escapes its workspace: ${relativePath}`);

  let existing = full;
  while (true) {
    try {
      await fs.lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`Cannot resolve checkpoint path: ${relativePath}`);
      existing = parent;
    }
  }
  const existingReal = await fs.realpath(existing);
  if (!isInside(pathKey(rootReal), pathKey(existingReal))) {
    throw new Error(`Checkpoint path traverses outside its workspace: ${relativePath}`);
  }
  if (existing === full) {
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Checkpoint path cannot be a symbolic link: ${relativePath}`);
    if (!stat.isFile()) throw new Error(`Checkpoint path must be a file: ${relativePath}`);
  }
  return full;
}

async function captureFile(fullPath: string, label: string): Promise<FileState> {
  let stat;
  try {
    stat = await fs.lstat(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, hash: null, mode: null, content: null };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Checkpoint path cannot be a symbolic link: ${label}`);
  if (!stat.isFile()) throw new Error(`Checkpoint path must be a file: ${label}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Checkpoint file exceeds ${MAX_FILE_BYTES} bytes: ${label}`);
  const content = await fs.readFile(fullPath);
  if (content.byteLength > MAX_FILE_BYTES) throw new Error(`Checkpoint file exceeds ${MAX_FILE_BYTES} bytes: ${label}`);
  return { exists: true, hash: hash(content), mode: stat.mode, content };
}

async function listWorkspaceCheckpointPaths(rootReal: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (paths.length >= MAX_PATHS) throw new Error(`Workspace checkpoint exceeds ${MAX_PATHS} paths`);
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!WORKSPACE_CHECKPOINT_SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        paths.push(path.relative(rootReal, full).replace(/\\/g, '/'));
      }
    }
  };
  await walk(rootReal);
  return paths;
}

function appendAbsentCheckpointPaths(
  checkpointId: string,
  rootId: string,
  workspacePath: string,
  relativePaths: string[],
): void {
  if (!relativePaths.length) return;
  const checkpoint = getDb().prepare("SELECT state FROM task_checkpoints WHERE id = ?").get(checkpointId) as { state: string } | undefined;
  if (checkpoint?.state !== 'open') throw new Error('Workspace checkpoint is no longer open');
  const insert = getDb().prepare(`
    INSERT INTO task_checkpoint_files (
      checkpointId, workspaceRootId, workspacePath, relativePath,
      beforeExists, beforeHash, beforeMode, beforeContent,
      afterExists, afterHash, afterMode, afterContent
    ) VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
  `);
  for (const relativePath of relativePaths) {
    insert.run(checkpointId, rootId, workspacePath, normalizeRelativePath(relativePath));
  }
}

function bytes(content: Uint8Array | null): number {
  return content?.byteLength ?? 0;
}

function rowToFile(row: CheckpointFileRow): TaskCheckpointFile {
  return {
    workspaceRootId: row.workspaceRootId,
    workspacePath: row.workspacePath,
    relativePath: row.relativePath,
    beforeExists: row.beforeExists === 1,
    ...(row.beforeHash ? { beforeHash: row.beforeHash } : {}),
    beforeBytes: row.beforeBytes ?? bytes(row.beforeContent ?? null),
    ...(row.afterExists == null ? {} : { afterExists: row.afterExists === 1 }),
    ...(row.afterHash ? { afterHash: row.afterHash } : {}),
    ...(row.afterExists == null ? {} : { afterBytes: row.afterBytes ?? bytes(row.afterContent ?? null) }),
  };
}

function rowToCheckpoint(row: CheckpointRow, files: CheckpointFileRow[]): TaskCheckpoint {
  return {
    id: row.id,
    taskId: row.taskId,
    reason: row.reason,
    state: row.state === 'ready' ? 'ready' : 'open',
    taskSnapshot: parseObject<TaskCheckpointSnapshot>(row.taskSnapshot, {
      status: 'queued', plan: [], progress: 0, taskVersion: 1,
    }),
    context: parseObject<Record<string, unknown>>(row.context, {}),
    files: files.map(rowToFile),
    createdAt: row.createdAt,
    ...(row.sealedAt ? { sealedAt: row.sealedAt } : {}),
  };
}

function rowToRestore(row: RestoreRow): TaskCheckpointRestore {
  const status = row.status === 'restored' || row.status === 'conflict' ? row.status : 'failed';
  return {
    id: row.id,
    checkpointId: row.checkpointId,
    taskId: row.taskId,
    status,
    restoredPaths: parseArray(row.restoredPaths),
    conflicts: parseArray(row.conflicts),
    startedAt: row.startedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function checkpointFiles(id: string): CheckpointFileRow[] {
  return getDb().prepare(`
    SELECT * FROM task_checkpoint_files
    WHERE checkpointId = ? ORDER BY workspaceRootId, relativePath
  `).all(id) as unknown as CheckpointFileRow[];
}

/** Metadata-only read: API/list pages must never hydrate checkpoint blobs. */
function checkpointFileMetadata(ids: string[]): CheckpointFileRow[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return getDb().prepare(`
    SELECT
      checkpointId, workspaceRootId, workspacePath, relativePath,
      beforeExists, beforeHash, beforeMode, length(beforeContent) AS beforeBytes,
      afterExists, afterHash, afterMode, length(afterContent) AS afterBytes
    FROM task_checkpoint_files
    WHERE checkpointId IN (${placeholders})
    ORDER BY workspaceRootId, relativePath
  `).all(...ids) as unknown as CheckpointFileRow[];
}

function insertEvent(taskId: string, type: string, data: Record<string, unknown>): void {
  getDb().prepare('INSERT INTO task_events (taskId, type, ts, data) VALUES (?, ?, ?, ?)')
    .run(taskId, type, nowIso(), JSON.stringify(data));
}

export function getTaskCheckpoint(id: string, taskId?: string): TaskCheckpoint | null {
  const checkpointId = validCheckpointId(id);
  const row = getDb().prepare(`SELECT * FROM task_checkpoints WHERE id = ?${taskId ? ' AND taskId = ?' : ''}`)
    .get(...(taskId ? [checkpointId, taskId] : [checkpointId])) as unknown as CheckpointRow | undefined;
  return row ? rowToCheckpoint(row, checkpointFileMetadata([row.id])) : null;
}

export function listTaskCheckpoints(taskId: string, limit = 100): TaskCheckpoint[] {
  if (!getTask(taskId)) throw new Error('Task not found');
  const capped = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = getDb().prepare(`
    SELECT * FROM task_checkpoints WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?
  `).all(taskId, capped) as unknown as CheckpointRow[];
  if (!rows.length) return [];
  const allFiles = checkpointFileMetadata(rows.map((row) => row.id));
  const byCheckpoint = new Map<string, CheckpointFileRow[]>();
  for (const file of allFiles) {
    const group = byCheckpoint.get(file.checkpointId) ?? [];
    group.push(file);
    byCheckpoint.set(file.checkpointId, group);
  }
  return rows.map((row) => rowToCheckpoint(row, byCheckpoint.get(row.id) ?? []));
}

/** Capture every declared path before the caller performs any mutation. */
export async function createTaskCheckpoint(input: CreateTaskCheckpointInput): Promise<TaskCheckpoint> {
  const task = getTask(input.taskId);
  if (!task) throw new Error('Task not found');
  const reason = String(input.reason || '').trim().slice(0, 1_000);
  if (!reason) throw new Error('Checkpoint reason is required');
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > MAX_PATHS) {
    throw new Error(`Checkpoint must declare between 1 and ${MAX_PATHS} files`);
  }
  const durableContext: Record<string, unknown> = { ...checkedContext(input.context).value };
  if (task.sessionId && !('conversationCursor' in durableContext)) {
    const session = await getChatSession(task.sessionId);
    if (session) {
      const lastMessage = session.messages.at(-1);
      durableContext.conversationCursor = {
        sessionId: session.id,
        messageCount: session.messages.length,
        ...(lastMessage ? { lastMessageId: lastMessage.id } : {}),
      };
    }
  }
  if (!('activeApprovalIds' in durableContext)) {
    durableContext.activeApprovalIds = (getDb().prepare(`
      SELECT id FROM task_attention
      WHERE taskId = ? AND kind = 'approval' AND status = 'open'
      ORDER BY createdAt ASC
    `).all(task.id) as Array<{ id: string }>).map((row) => row.id);
  }
  if (!('artifactEvidenceIds' in durableContext)) {
    durableContext.artifactEvidenceIds = (getDb().prepare(`
      SELECT id FROM task_evidence WHERE taskId = ? AND kind = 'artifact' ORDER BY recordedAt ASC
    `).all(task.id) as Array<{ id: string }>).map((row) => row.id);
  }
  const context = checkedContext(durableContext);
  const roots = new Map(task.workspaceRoots.map((root) => [root.id, root]));
  const seen = new Set<string>();
  const captured: Array<{
    workspaceRootId: string;
    workspacePath: string;
    relativePath: string;
    state: FileState;
  }> = [];
  let totalBytes = 0;
  for (const requested of input.files) {
    const root = roots.get(String(requested.workspaceRootId || '').trim());
    if (!root) throw new Error(`Task does not own workspace root: ${requested.workspaceRootId}`);
    const workspacePath = await resolveRoot(root);
    const relativePath = normalizeRelativePath(requested.path);
    const key = `${root.id}\0${process.platform === 'win32' ? relativePath.toLowerCase() : relativePath}`;
    if (seen.has(key)) throw new Error(`Duplicate checkpoint path: ${root.id}/${relativePath}`);
    seen.add(key);
    const fullPath = await safeOwnedPath(workspacePath, relativePath);
    const state = await captureFile(fullPath, `${root.id}/${relativePath}`);
    totalBytes += state.content?.byteLength ?? 0;
    if (totalBytes > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
    captured.push({ workspaceRootId: root.id, workspacePath, relativePath, state });
  }

  const id = randomUUID();
  const createdAt = nowIso();
  const snapshot: TaskCheckpointSnapshot = {
    status: task.status,
    plan: task.plan,
    progress: task.progress,
    ...(task.currentStep ? { currentStep: task.currentStep } : {}),
    ...(task.nextAction ? { nextAction: task.nextAction } : {}),
    taskVersion: task.version,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
  };
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO task_checkpoints
        (id, taskId, reason, state, taskSnapshot, context, createdAt, sealedAt)
      VALUES (?, ?, ?, 'open', ?, ?, ?, NULL)
    `).run(id, task.id, reason, JSON.stringify(snapshot), context.json, createdAt);
    const insert = db.prepare(`
      INSERT INTO task_checkpoint_files (
        checkpointId, workspaceRootId, workspacePath, relativePath,
        beforeExists, beforeHash, beforeMode, beforeContent,
        afterExists, afterHash, afterMode, afterContent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
    `);
    for (const file of captured) {
      insert.run(
        id, file.workspaceRootId, file.workspacePath, file.relativePath,
        file.state.exists ? 1 : 0, file.state.hash, file.state.mode, file.state.content,
      );
    }
    db.prepare(`
      UPDATE tasks SET checkpointId = ?, version = version + 1, updatedAt = ? WHERE id = ?
    `).run(id, createdAt, task.id);
    insertEvent(task.id, 'checkpoint_created', { checkpointId: id, paths: captured.length, reason });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  emitAppEvent('tasks');
  return getTaskCheckpoint(id, task.id)!;
}

/** Seal the exact post-mutation bytes used by future conflict checks. */
export async function sealTaskCheckpoint(taskId: string, checkpointId: string): Promise<TaskCheckpoint> {
  const checkpoint = getTaskCheckpoint(checkpointId, taskId);
  if (!checkpoint) throw new Error('Checkpoint not found');
  if (checkpoint.state === 'ready') return checkpoint;
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const roots = new Map(task.workspaceRoots.map((root) => [root.id, root]));
  const rows = checkpointFiles(checkpoint.id);
  const captured: Array<{ row: CheckpointFileRow; state: FileState }> = [];
  let totalBytes = rows.reduce((sum, row) => sum + bytes(row.beforeContent ?? null), 0);
  for (const row of rows) {
    const root = roots.get(row.workspaceRootId);
    if (!root) throw new Error(`Task no longer owns workspace root: ${row.workspaceRootId}`);
    const rootReal = await resolveRoot(root);
    if (pathKey(rootReal) !== pathKey(row.workspacePath)) {
      throw new Error(`Workspace root moved since checkpoint creation: ${row.workspaceRootId}`);
    }
    const fullPath = await safeOwnedPath(rootReal, row.relativePath);
    const state = await captureFile(fullPath, `${row.workspaceRootId}/${row.relativePath}`);
    totalBytes += state.content?.byteLength ?? 0;
    if (totalBytes > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
    captured.push({ row, state });
  }
  const sealedAt = nowIso();
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare(`
      UPDATE task_checkpoint_files SET
        afterExists = ?, afterHash = ?, afterMode = ?, afterContent = ?
      WHERE checkpointId = ? AND workspaceRootId = ? AND relativePath = ?
    `);
    for (const file of captured) {
      update.run(
        file.state.exists ? 1 : 0, file.state.hash, file.state.mode, file.state.content,
        checkpoint.id, file.row.workspaceRootId, file.row.relativePath,
      );
    }
    const result = db.prepare(`
      UPDATE task_checkpoints SET state = 'ready', sealedAt = ? WHERE id = ? AND state = 'open'
    `).run(sealedAt, checkpoint.id);
    if (Number(result.changes) !== 1) throw new Error('Checkpoint changed concurrently');
    insertEvent(task.id, 'checkpoint_sealed', { checkpointId: checkpoint.id, paths: rows.length });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  emitAppEvent('tasks');
  return getTaskCheckpoint(checkpoint.id, task.id)!;
}

/**
 * The normal mutation primitive: pre-state is durable before `mutate` starts,
 * and partial changes are sealed even when the callback throws so they remain
 * safely rewindable.
 */
export async function withTaskCheckpoint<T>(
  input: CreateTaskCheckpointInput,
  mutate: () => Promise<T>,
): Promise<TaskCheckpointMutationResult<T>> {
  const open = await createTaskCheckpoint(input);
  try {
    const value = await mutate();
    return { checkpoint: await sealTaskCheckpoint(input.taskId, open.id), value };
  } catch (mutationError) {
    try {
      await sealTaskCheckpoint(input.taskId, open.id);
    } catch (sealError) {
      throw new AggregateError([mutationError, sealError], 'Mutation failed and its checkpoint could not be sealed');
    }
    throw mutationError;
  }
}

/**
 * Checkpoint the complete task-owned source tree around a host-shell command.
 * Dependency/build/cache directories are intentionally excluded because they
 * are reproducible rather than user artifacts. Any new source path discovered
 * after the command is added with an explicit `beforeExists = false` record,
 * so a rewind also removes files created by the command.
 */
export async function withTaskWorkspaceCheckpoint<T>(
  input: TaskWorkspaceCheckpointInput,
  mutate: () => Promise<T>,
): Promise<TaskCheckpointMutationResult<T>> {
  const task = getTask(input.taskId);
  if (!task) throw new Error('Task not found');
  const requestedRootIds = [...new Set(input.workspaceRootIds.map(String))];
  if (!requestedRootIds.length) throw new Error('A workspace checkpoint requires at least one root');
  const rootsById = new Map(task.workspaceRoots.map((root) => [root.id, root]));
  const roots: Array<{ id: string; real: string; before: Set<string> }> = [];
  const files: Array<{ workspaceRootId: string; path: string }> = [];
  for (const id of requestedRootIds) {
    const root = rootsById.get(id);
    if (!root) throw new Error(`Task does not own workspace root: ${id}`);
    const real = await resolveRoot(root);
    const beforePaths = await listWorkspaceCheckpointPaths(real);
    const before = new Set(beforePaths);
    roots.push({ id, real, before });
    for (const relativePath of beforePaths) files.push({ workspaceRootId: id, path: relativePath });
  }
  if (files.length > MAX_PATHS) throw new Error(`Workspace checkpoint exceeds ${MAX_PATHS} paths`);
  // The checkpoint format requires a declared path. This reserved absent path
  // provides a safe no-op boundary for a genuinely empty workspace.
  if (!files.length) files.push({ workspaceRootId: roots[0].id, path: '.shiba-shell-checkpoint-boundary' });

  const open = await createTaskCheckpoint({
    taskId: input.taskId,
    reason: input.reason,
    files,
    context: input.context,
  });
  let value: T | undefined;
  let mutationError: unknown;
  try {
    value = await mutate();
  } catch (error) {
    mutationError = error;
  }

  try {
    for (const root of roots) {
      const after = await listWorkspaceCheckpointPaths(root.real);
      const added = after.filter((relativePath) => !root.before.has(relativePath));
      appendAbsentCheckpointPaths(open.id, root.id, root.real, added);
    }
    const checkpoint = await sealTaskCheckpoint(input.taskId, open.id);
    if (mutationError) throw mutationError;
    return { checkpoint, value: value as T };
  } catch (sealOrMutationError) {
    if (mutationError && sealOrMutationError !== mutationError) {
      throw new AggregateError([mutationError, sealOrMutationError], 'Shell mutation failed and its workspace checkpoint could not be sealed');
    }
    throw sealOrMutationError;
  }
}

function matches(state: FileState, expectedExists: boolean, expectedHash: string | null): boolean {
  return state.exists === expectedExists && (!expectedExists || state.hash === expectedHash);
}

async function writeState(fullPath: string, state: FileState): Promise<void> {
  if (!state.exists) {
    await fs.rm(fullPath, { force: true });
    return;
  }
  if (!state.content) throw new Error(`Checkpoint content is missing for ${fullPath}`);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const temp = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.${randomUUID()}.checkpoint-tmp`);
  await fs.writeFile(temp, state.content, { mode: state.mode ?? undefined });
  try {
    await fs.rename(temp, fullPath);
  } catch (error) {
    if (process.platform !== 'win32') {
      await fs.rm(temp, { force: true });
      throw error;
    }
    // Windows rename cannot replace an existing target. Removing only this
    // already-conflict-checked task-owned path avoids writing through hardlinks.
    await fs.rm(fullPath, { force: true });
    await fs.rename(temp, fullPath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
  if (state.mode != null && process.platform !== 'win32') await fs.chmod(fullPath, state.mode);
}

function fileLabel(row: CheckpointFileRow): string {
  return `${row.workspaceRootId}/${row.relativePath}`;
}

function stateFromRow(row: CheckpointFileRow, side: 'before' | 'after'): FileState {
  const before = side === 'before';
  const existsRaw = before ? row.beforeExists : row.afterExists;
  return {
    exists: existsRaw === 1,
    hash: before ? row.beforeHash : row.afterHash,
    mode: before ? row.beforeMode : row.afterMode,
    content: Buffer.from((before ? row.beforeContent : row.afterContent) ?? []),
  };
}

/** Restore only declared task-owned paths after an all-path conflict preflight. */
export async function restoreTaskCheckpoint(taskId: string, checkpointId: string): Promise<TaskCheckpointRestore> {
  const checkpoint = getTaskCheckpoint(checkpointId, taskId);
  if (!checkpoint) throw new Error('Checkpoint not found');
  if (checkpoint.state !== 'ready') throw new Error('Checkpoint is not sealed and cannot be restored');
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const roots = new Map(task.workspaceRoots.map((root) => [root.id, root]));
  const rows = checkpointFiles(checkpoint.id);
  const current = new Map<string, { fullPath: string; state: FileState; alreadyRestored: boolean }>();
  const conflicts: string[] = [];
  for (const row of rows) {
    const label = fileLabel(row);
    const root = roots.get(row.workspaceRootId);
    if (!root || root.permission !== 'write') {
      conflicts.push(`${label}: task no longer has write ownership`);
      continue;
    }
    const rootReal = await resolveRoot(root).catch(() => null);
    if (!rootReal || pathKey(rootReal) !== pathKey(row.workspacePath)) {
      conflicts.push(`${label}: workspace root changed`);
      continue;
    }
    const fullPath = await safeOwnedPath(rootReal, row.relativePath).catch(() => null);
    if (!fullPath) {
      conflicts.push(`${label}: path is no longer safely addressable`);
      continue;
    }
    const state = await captureFile(fullPath, label);
    const before = stateFromRow(row, 'before');
    const after = stateFromRow(row, 'after');
    const alreadyRestored = matches(state, before.exists, before.hash);
    if (!alreadyRestored && !matches(state, after.exists, after.hash)) {
      conflicts.push(`${label}: current bytes differ from the sealed task mutation`);
    }
    current.set(label, { fullPath, state, alreadyRestored });
  }

  const restoreId = randomUUID();
  const startedAt = nowIso();
  if (conflicts.length) {
    const completedAt = nowIso();
    getDb().prepare(`
      INSERT INTO task_checkpoint_restores
        (id, checkpointId, taskId, status, restoredPaths, conflicts, startedAt, completedAt, error)
      VALUES (?, ?, ?, 'conflict', '[]', ?, ?, ?, ?)
    `).run(restoreId, checkpoint.id, task.id, JSON.stringify(conflicts), startedAt, completedAt, 'Restore conflict');
    insertEvent(task.id, 'checkpoint_restore_refused', { checkpointId: checkpoint.id, conflicts });
    const restore = getTaskCheckpointRestore(restoreId)!;
    emitAppEvent('tasks');
    throw new CheckpointConflictError(restore);
  }

  const restoredPaths: string[] = [];
  const applied: Array<{ row: CheckpointFileRow; fullPath: string }> = [];
  let conversationSnapshot: Awaited<ReturnType<typeof getChatSession>> = null;
  try {
    for (const row of rows) {
      const label = fileLabel(row);
      const live = current.get(label)!;
      if (live.alreadyRestored) continue;
      // Close the preflight-to-write race. Any divergence aborts and rolls
      // already restored paths back to the sealed post-mutation bytes.
      const latest = await captureFile(live.fullPath, label);
      const after = stateFromRow(row, 'after');
      if (!matches(latest, after.exists, after.hash)) {
        throw new Error(`Concurrent checkpoint conflict: ${label}`);
      }
      await writeState(live.fullPath, stateFromRow(row, 'before'));
      applied.push({ row, fullPath: live.fullPath });
      restoredPaths.push(label);
    }
    const conversationCursor = checkpoint.context.conversationCursor as {
      sessionId?: string;
      lastMessageId?: string;
    } | undefined;
    if (
      conversationCursor?.sessionId
      && conversationCursor.lastMessageId
      && task.sessionId === conversationCursor.sessionId
    ) {
      const { rewindChatSessionToMessage } = await import('./chat-sessions');
      conversationSnapshot = await getChatSession(conversationCursor.sessionId);
      if (!conversationSnapshot) throw new Error('Checkpoint chat session no longer exists');
      await rewindChatSessionToMessage({
        sessionId: conversationCursor.sessionId,
        sourceMessageId: conversationCursor.lastMessageId,
        confirmSourceMessageId: conversationCursor.lastMessageId,
        expectedCurrentLastMessageId: conversationSnapshot.messages.at(-1)?.id || '',
      });
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const appliedFile of applied.reverse()) {
      try {
        await writeState(appliedFile.fullPath, stateFromRow(appliedFile.row, 'after'));
      } catch (rollbackError) {
        rollbackErrors.push(`${fileLabel(appliedFile.row)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const completedAt = nowIso();
    const message = `${error instanceof Error ? error.message : String(error)}${rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join(', ')}` : ''}`;
    getDb().prepare(`
      INSERT INTO task_checkpoint_restores
        (id, checkpointId, taskId, status, restoredPaths, conflicts, startedAt, completedAt, error)
      VALUES (?, ?, ?, 'failed', ?, '[]', ?, ?, ?)
    `).run(restoreId, checkpoint.id, task.id, JSON.stringify(restoredPaths), startedAt, completedAt, message.slice(0, 4_000));
    insertEvent(task.id, 'checkpoint_restore_failed', { checkpointId: checkpoint.id, error: message.slice(0, 1_000) });
    emitAppEvent('tasks');
    throw new Error(`Checkpoint restore failed: ${message}`);
  }

  const completedAt = nowIso();
  const db = getDb();
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      INSERT INTO task_checkpoint_restores
        (id, checkpointId, taskId, status, restoredPaths, conflicts, startedAt, completedAt, error)
      VALUES (?, ?, ?, 'restored', ?, '[]', ?, ?, NULL)
    `).run(restoreId, checkpoint.id, task.id, JSON.stringify(restoredPaths), startedAt, completedAt);
    db.prepare(`
      INSERT INTO task_evidence (
        id, taskId, requirementId, kind, status, label, summary, uri,
        command, exitCode, scope, recordedAt, metadata
      ) VALUES (?, ?, NULL, 'diff', 'passed', ?, ?, NULL, NULL, NULL, ?, ?, ?)
    `).run(
      randomUUID(), task.id, 'Checkpoint restored',
      `Restored ${restoredPaths.length} task-owned path(s) from ${checkpoint.id}.`,
      `checkpoint:${checkpoint.id}`, completedAt,
      JSON.stringify({ checkpointId: checkpoint.id, restoredPaths }),
    );
    db.prepare(`
      UPDATE tasks SET
        status = 'queued', plan = ?, progress = ?, currentStep = ?, nextAction = ?,
        result = NULL, error = NULL, completion = NULL, completedAt = NULL,
        heartbeatAt = ?, checkpointId = ?, metadata = ?, version = version + 1, updatedAt = ?
      WHERE id = ?
    `).run(
      JSON.stringify(checkpoint.taskSnapshot.plan),
      checkpoint.taskSnapshot.progress,
      checkpoint.taskSnapshot.currentStep || 'Checkpoint restored',
      'Review the restored state, then explicitly dispatch a new attempt.',
      completedAt,
      checkpoint.id,
      JSON.stringify({
        ...task.metadata,
        rewoundAt: completedAt,
        rewoundCheckpointId: checkpoint.id,
        statusBeforeRewind: task.status,
      }),
      completedAt,
      task.id,
    );
    insertEvent(task.id, 'checkpoint_restored', { checkpointId: checkpoint.id, restoredPaths });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    const compensationErrors: string[] = [];
    for (const appliedFile of [...applied].reverse()) {
      try {
        await writeState(appliedFile.fullPath, stateFromRow(appliedFile.row, 'after'));
      } catch (compensationError) {
        compensationErrors.push(`${fileLabel(appliedFile.row)}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`);
      }
    }
    if (conversationSnapshot) {
      try {
        const { restoreChatSessionSnapshot } = await import('./chat-sessions');
        await restoreChatSessionSnapshot(conversationSnapshot);
      } catch (compensationError) {
        compensationErrors.push(`chat:${conversationSnapshot.id}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      db.prepare(`
        INSERT INTO task_checkpoint_restores
          (id, checkpointId, taskId, status, restoredPaths, conflicts, startedAt, completedAt, error)
        VALUES (?, ?, ?, 'failed', ?, '[]', ?, ?, ?)
      `).run(restoreId, checkpoint.id, task.id, JSON.stringify(restoredPaths), startedAt, nowIso(), `Database commit failed; compensated: ${message}`.slice(0, 4_000));
      insertEvent(task.id, 'checkpoint_restore_failed', { checkpointId: checkpoint.id, error: message.slice(0, 1_000), compensated: compensationErrors.length === 0 });
    } catch { /* the database failure itself may prevent durable failure recording */ }
    if (compensationErrors.length) {
      throw new AggregateError([error, ...compensationErrors.map((item) => new Error(item))], `Checkpoint database commit failed and compensation was incomplete: ${message}`);
    }
    throw new Error(`Checkpoint database commit failed; file and chat state were compensated: ${message}`);
  }
  emitAppEvent('tasks');
  return getTaskCheckpointRestore(restoreId)!;
}

export function getTaskCheckpointRestore(id: string): TaskCheckpointRestore | null {
  const row = getDb().prepare('SELECT * FROM task_checkpoint_restores WHERE id = ?')
    .get(validCheckpointId(id)) as unknown as RestoreRow | undefined;
  return row ? rowToRestore(row) : null;
}

export function listTaskCheckpointRestores(taskId: string, checkpointId?: string): TaskCheckpointRestore[] {
  const rows = getDb().prepare(`
    SELECT * FROM task_checkpoint_restores
    WHERE taskId = ?${checkpointId ? ' AND checkpointId = ?' : ''}
    ORDER BY startedAt DESC
  `).all(...(checkpointId ? [taskId, validCheckpointId(checkpointId)] : [taskId])) as unknown as RestoreRow[];
  return rows.map(rowToRestore);
}
