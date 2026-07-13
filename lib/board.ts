// Kanban board store — one shared board all agents and the user work from.
// Same locked atomic-write JSON pattern as chat-sessions.ts: every
// read-modify-write is serialized, writes go through temp-file + rename.

import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { dataDir } from './data-paths';
import {
  type BoardActivity,
  type BoardExternalProvider,
  type BoardExternalRef,
  type BoardSyncState,
  type BoardStatus,
  type BoardStore,
  type BoardTask,
  clampPriority,
  isBoardStatus,
} from './board-types';

export type {
  BoardTask,
  BoardStatus,
  BoardActivity,
  BoardExternalProvider,
  BoardExternalRef,
  BoardSyncField,
  BoardSyncState,
} from './board-types';

const DATA_DIR = dataDir();
const BOARD_FILE = path.join(DATA_DIR, 'board.json');

/** Key prefix for card identifiers (SHIB-1, SHIB-2, …). */
const KEY_PREFIX = 'SHIB';

const boardLockGlobal = globalThis as typeof globalThis & { __shibaBoardStoreChain?: Promise<unknown> };

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = boardLockGlobal.__shibaBoardStoreChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  boardLockGlobal.__shibaBoardStoreChain = run.then(() => undefined, () => undefined);
  return run;
}

async function loadStore(): Promise<BoardStore> {
  try {
    const raw = await fs.readFile(BOARD_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
      throw new Error('Invalid board store: expected an object with a tasks array');
    }
    const tasks = parsed.tasks;
    return {
      nextNumber: Number.isInteger(parsed.nextNumber) && parsed.nextNumber > 0 ? parsed.nextNumber : 1,
      tasks: tasks.map((task: BoardTask) => ({
        ...task,
        projectId: task.projectId || null,
        syncUpdatedAt: task.syncUpdatedAt || task.updatedAt || task.createdAt,
        externalRefs: Array.isArray(task.externalRefs) ? task.externalRefs : [],
      })),
      syncState: parsed.syncState && typeof parsed.syncState === 'object' ? parsed.syncState : {},
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return { nextNumber: 1, tasks: [], syncState: {} };
  }
}

async function saveStore(store: BoardStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${BOARD_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, BOARD_FILE);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  // Live UI: every open board (and the nav open-count badge) hears the change.
  const { emitAppEvent } = await import('./app-events');
  emitAppEvent('board');
}

function now(): string {
  return new Date().toISOString();
}

function systemEvent(text: string, extra?: Partial<BoardActivity>): BoardActivity {
  return { ts: now(), kind: 'system', text, ...extra };
}

/** Next `order` value at the end of a column. */
function endOrder(tasks: BoardTask[], status: BoardStatus): number {
  const inCol = tasks.filter((t) => t.status === status);
  return inCol.length ? Math.max(...inCol.map((t) => t.order)) + 100 : 100;
}

export async function listBoardTasks(): Promise<BoardTask[]> {
  return withStoreLock(async () => {
    const store = await loadStore();
    return [...store.tasks].sort((a, b) => a.order - b.order);
  });
}

export async function getBoardTask(idOrKey: string): Promise<BoardTask | null> {
  const needle = idOrKey.trim().toUpperCase();
  return withStoreLock(async () => {
    const store = await loadStore();
    return (
      store.tasks.find((t) => t.id === idOrKey || t.key.toUpperCase() === needle) || null
    );
  });
}

export interface CreateBoardTaskInput {
  /** Optional internal idempotency identity (not exposed by the public route). */
  id?: string;
  title: string;
  description?: string;
  status?: BoardStatus;
  priority?: number;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  labels?: string[];
  /** Who created it — shows in the activity feed. */
  createdBy?: string;
  /** Internal provider-sync metadata. */
  externalRef?: BoardExternalRef;
  createdAt?: string;
  syncUpdatedAt?: string;
}

export async function createBoardTask(input: CreateBoardTaskInput): Promise<BoardTask> {
  const title = input.title.trim();
  if (!title) throw new Error('Task title is required');
  const internalId = input.id?.trim();
  if (internalId && !/^[A-Za-z0-9:._-]{1,200}$/.test(internalId)) throw new Error('Invalid internal Board task id');
  return withStoreLock(async () => {
    const store = await loadStore();
    if (internalId) {
      const existing = store.tasks.find((task) => task.id === internalId);
      if (existing) return existing;
    }
    const status: BoardStatus = isBoardStatus(input.status) ? input.status : 'backlog';
    const createdAt = input.createdAt || now();
    const task: BoardTask = {
      id: internalId || uuidv4(),
      key: `${KEY_PREFIX}-${store.nextNumber}`,
      title: title.slice(0, 300),
      description: String(input.description || '').slice(0, 20_000),
      status,
      priority: clampPriority(input.priority),
      assigneeAgentId: input.assigneeAgentId || null,
      projectId: input.projectId || null,
      labels: Array.isArray(input.labels)
        ? input.labels.map((l) => String(l).trim()).filter(Boolean).slice(0, 10)
        : [],
      order: endOrder(store.tasks, status),
      activity: [systemEvent(`Created by ${input.createdBy || 'user'}`)],
      runIds: [],
      syncUpdatedAt: input.syncUpdatedAt || createdAt,
      externalRefs: input.externalRef ? [input.externalRef] : [],
      createdAt,
      updatedAt: createdAt,
    };
    store.nextNumber += 1;
    store.tasks.push(task);
    await saveStore(store);
    return task;
  });
}

export interface UpdateBoardTaskInput {
  title?: string;
  description?: string;
  status?: BoardStatus;
  priority?: number;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  labels?: string[];
  working?: boolean;
  /** Appended to the activity feed (with attribution). */
  note?: { kind: BoardActivity['kind']; text: string; runId?: string; agentName?: string };
  /** Record a dispatched run id. */
  addRunId?: string;
  /** Activity line describing the change (auto-generated when omitted). */
  actor?: string;
  /** Internal provider-sync metadata. */
  externalRef?: BoardExternalRef;
  syncUpdatedAt?: string;
  /** Internal optimistic guard used before a pull overwrites syncable fields. */
  expectedSyncUpdatedAt?: string;
}

export async function updateBoardTask(idOrKey: string, patch: UpdateBoardTaskInput): Promise<BoardTask> {
  const needle = idOrKey.trim().toUpperCase();
  return withStoreLock(async () => {
    const store = await loadStore();
    const task = store.tasks.find((t) => t.id === idOrKey || t.key.toUpperCase() === needle);
    if (!task) throw new Error(`Board task not found: ${idOrKey}`);
    if (
      patch.expectedSyncUpdatedAt !== undefined
      && (task.syncUpdatedAt || task.updatedAt) !== patch.expectedSyncUpdatedAt
    ) {
      throw new Error('This Board card changed while sync was running. Run sync again to resolve it safely.');
    }
    const actor = patch.actor || 'user';
    let syncChanged = false;

    if (patch.title !== undefined && patch.title.trim()) {
      const value = patch.title.trim().slice(0, 300);
      if (value !== task.title) { task.title = value; syncChanged = true; }
    }
    if (patch.description !== undefined) {
      const value = String(patch.description).slice(0, 20_000);
      if (value !== task.description) { task.description = value; syncChanged = true; }
    }
    if (patch.priority !== undefined) {
      const value = clampPriority(patch.priority);
      if (value !== task.priority) { task.priority = value; syncChanged = true; }
    }
    if (patch.labels !== undefined) {
      const value = patch.labels.map((l) => String(l).trim()).filter(Boolean).slice(0, 10);
      if (JSON.stringify(value) !== JSON.stringify(task.labels)) {
        task.labels = value;
        syncChanged = true;
      }
    }
    if (patch.assigneeAgentId !== undefined && patch.assigneeAgentId !== task.assigneeAgentId) {
      task.assigneeAgentId = patch.assigneeAgentId || null;
      task.activity.push(systemEvent(
        task.assigneeAgentId ? `Assigned by ${actor}` : `Unassigned by ${actor}`,
      ));
    }
    if (patch.projectId !== undefined && (patch.projectId || null) !== (task.projectId || null)) {
      task.projectId = patch.projectId || null;
      task.activity.push(systemEvent(
        task.projectId ? `Linked to a project by ${actor}` : `Project removed by ${actor}`,
      ));
    }
    if (patch.status !== undefined && isBoardStatus(patch.status) && patch.status !== task.status) {
      const from = task.status;
      task.status = patch.status;
      syncChanged = true;
      task.order = endOrder(store.tasks.filter((t) => t.id !== task.id), patch.status);
      task.activity.push(systemEvent(`${actor} moved ${from} → ${patch.status}`));
    }
    if (patch.working !== undefined) task.working = patch.working;
    if (patch.addRunId && !task.runIds.includes(patch.addRunId)) task.runIds.push(patch.addRunId);
    if (patch.externalRef) {
      const refs = Array.isArray(task.externalRefs) ? task.externalRefs : [];
      // A card has at most one link per provider. Pulling an overlapping Jira
      // board/project can therefore rebind the same remote issue without
      // leaving an ambiguous second Jira link behind.
      task.externalRefs = [
        ...refs.filter((ref) => ref.provider !== patch.externalRef?.provider),
        patch.externalRef,
      ];
    }
    if (patch.note?.text) {
      task.activity.push({
        ts: now(),
        kind: patch.note.kind,
        text: String(patch.note.text).slice(0, 4000),
        runId: patch.note.runId,
        agentName: patch.note.agentName,
      });
    }
    // Bound the feed so a chatty agent can't bloat the store.
    if (task.activity.length > 200) task.activity = task.activity.slice(-200);

    const updatedAt = now();
    task.updatedAt = updatedAt;
    if (syncChanged) task.syncUpdatedAt = patch.syncUpdatedAt || updatedAt;
    await saveStore(store);
    return task;
  });
}

/** Reorder within (or move across) columns: place before/after neighbors. */
export async function moveBoardTask(
  idOrKey: string,
  status: BoardStatus,
  beforeId?: string | null,
  afterId?: string | null,
  actor = 'user',
): Promise<BoardTask> {
  const needle = idOrKey.trim().toUpperCase();
  return withStoreLock(async () => {
    const store = await loadStore();
    const task = store.tasks.find((t) => t.id === idOrKey || t.key.toUpperCase() === needle);
    if (!task) throw new Error(`Board task not found: ${idOrKey}`);
    if (!isBoardStatus(status)) throw new Error(`Invalid status: ${status}`);

    const statusChanged = task.status !== status;
    task.status = status;

    const col = store.tasks
      .filter((t) => t.status === status && t.id !== task.id)
      .sort((a, b) => a.order - b.order);
    const before = beforeId ? col.find((t) => t.id === beforeId) : undefined;
    const after = afterId ? col.find((t) => t.id === afterId) : undefined;
    if (before && after) task.order = (before.order + after.order) / 2;
    else if (after) task.order = after.order - 100; // dropped at top
    else if (before) task.order = before.order + 100; // dropped at bottom
    else task.order = endOrder(store.tasks.filter((t) => t.id !== task.id), status);

    if (statusChanged) task.activity.push(systemEvent(`${actor} moved to ${status}`));
    task.updatedAt = now();
    if (statusChanged) task.syncUpdatedAt = task.updatedAt;

    // Re-pack the column if fractional orders got too dense.
    const packed = [...col, task].sort((a, b) => a.order - b.order);
    for (let i = 1; i < packed.length; i++) {
      if (packed[i].order - packed[i - 1].order < 1e-6) {
        packed.forEach((t, idx) => { t.order = (idx + 1) * 100; });
        break;
      }
    }

    await saveStore(store);
    return task;
  });
}

export async function deleteBoardTask(idOrKey: string): Promise<void> {
  const needle = idOrKey.trim().toUpperCase();
  const { withIntegrityMutation } = await import('./integrity-coordinator');
  await withIntegrityMutation(`board deletion:${idOrKey}`, () => withStoreLock(async () => {
      const store = await loadStore();
      const idx = store.tasks.findIndex((t) => t.id === idOrKey || t.key.toUpperCase() === needle);
      if (idx < 0) throw new Error(`Board task not found: ${idOrKey}`);
      const task = store.tasks[idx];
      store.tasks.splice(idx, 1);
      await saveStore(store);
      try {
        const { detachTasksFromDeletedOrigin } = await import('./task-ledger');
        detachTasksFromDeletedOrigin('board', task.id, { key: task.key, title: task.title });
      } catch (error) {
        // The owner deletion is already durable and its repair request is
        // committed by withIntegrityMutation. Let the immediate/queued generic
        // sweep settle the tasks without turning a successful delete into a
        // false API failure.
        console.error(`[board] task-origin detach deferred for ${task.id}`, error);
      }
    }));
}

/**
 * Wipe every card and start the board fresh (keys reset to SHIB-1). External
 * sync state is cleared too, so a re-linked provider starts clean. Irreversible
 * — the caller (Settings) gates this behind an explicit confirm.
 */
export async function clearBoard(): Promise<{ removed: number }> {
  const { withIntegrityMutation } = await import('./integrity-coordinator');
  const { result } = await withIntegrityMutation('board cleared', () => withStoreLock(async () => {
      const store = await loadStore();
      const removedTasks = [...store.tasks];
      const removed = store.tasks.length;
      const { detachTasksFromDeletedOrigin } = await import('./task-ledger');
      await saveStore({ nextNumber: 1, tasks: [], syncState: {} });
      for (const task of removedTasks) {
        try {
          detachTasksFromDeletedOrigin('board', task.id, { key: task.key, title: task.title });
        } catch (error) {
          console.error(`[board] task-origin detach deferred for ${task.id}`, error);
        }
      }
      return { removed };
    }));
  return result;
}

export async function findBoardTaskByExternalRef(
  provider: BoardExternalProvider,
  connectionId: string | undefined,
  containerId: string,
  remoteId: string,
): Promise<BoardTask | null> {
  return withStoreLock(async () => {
    const store = await loadStore();
    return store.tasks.find((task) => task.externalRefs?.some((ref) =>
      ref.provider === provider
      && ref.connectionId === connectionId
      && ref.containerId === containerId
      && ref.remoteId === remoteId,
    )) || null;
  });
}

export async function getBoardSyncState(): Promise<BoardStore['syncState']> {
  return withStoreLock(async () => (await loadStore()).syncState || {});
}

export async function recordBoardSyncState(state: BoardSyncState): Promise<void> {
  return withStoreLock(async () => {
    const store = await loadStore();
    store.syncState = { ...(store.syncState || {}), [state.provider]: state };
    await saveStore(store);
  });
}

export interface BoardReferenceIntegrityInput {
  agentIds: ReadonlySet<string>;
  projectIds: ReadonlySet<string>;
  runIds: ReadonlySet<string>;
  /** Board ids that still own a non-terminal task, including its start gap. */
  activeOriginIds: ReadonlySet<string>;
  /** Avoid racing a card whose durable task is about to be created. */
  staleWorkingBefore?: string;
}

export interface BoardReferenceIntegrityReport {
  assigneesDetached: number;
  projectsDetached: number;
  staleRunLinksRemoved: number;
  staleActivityRunLinksRemoved: number;
  workingFlagsCleared: number;
}

/**
 * Reconcile live Board pointers without erasing the card or its human-readable
 * history. This is deliberately store-locked and idempotent so startup and the
 * periodic integrity janitor can safely call it after any interrupted delete.
 */
export async function reconcileBoardReferences(
  input: BoardReferenceIntegrityInput,
): Promise<BoardReferenceIntegrityReport> {
  return withStoreLock(async () => {
    const report: BoardReferenceIntegrityReport = {
      assigneesDetached: 0,
      projectsDetached: 0,
      staleRunLinksRemoved: 0,
      staleActivityRunLinksRemoved: 0,
      workingFlagsCleared: 0,
    };
    const store = await loadStore();
    for (const task of store.tasks) {
      const repairs: string[] = [];
      if (task.assigneeAgentId && !input.agentIds.has(task.assigneeAgentId)) {
        task.assigneeAgentId = null;
        report.assigneesDetached += 1;
        repairs.push('Removed a reference to a deleted agent');
      }
      if (task.projectId && !input.projectIds.has(task.projectId)) {
        task.projectId = null;
        report.projectsDetached += 1;
        repairs.push('Removed a reference to a deleted project');
      }
      const retainedRunIds = task.runIds.filter((runId) => input.runIds.has(runId));
      report.staleRunLinksRemoved += task.runIds.length - retainedRunIds.length;
      if (retainedRunIds.length !== task.runIds.length) task.runIds = retainedRunIds;
      for (let index = 0; index < task.activity.length; index += 1) {
        const activity = task.activity[index];
        if (!activity.runId || input.runIds.has(activity.runId)) continue;
        // The prose remains useful history; only its now-unresolvable live link
        // is removed.
        const { runId: _runId, ...withoutRunId } = activity;
        task.activity[index] = withoutRunId;
        report.staleActivityRunLinksRemoved += 1;
      }
      if (
        task.working
        && !input.activeOriginIds.has(task.id)
        && (!input.staleWorkingBefore || task.updatedAt < input.staleWorkingBefore)
      ) {
        task.working = false;
        report.workingFlagsCleared += 1;
        repairs.push('Cleared an interrupted working state');
      }
      if (repairs.length) {
        task.activity.push(systemEvent(`Integrity repair: ${repairs.join('; ')}`));
        if (task.activity.length > 200) task.activity = task.activity.slice(-200);
        task.updatedAt = now();
      }
    }
    const total = Object.values(report).reduce((sum, count) => sum + count, 0);
    if (total > 0) await saveStore(store);
    return report;
  });
}
