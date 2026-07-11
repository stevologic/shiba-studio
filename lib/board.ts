// Kanban board store — one shared board all agents and the user work from.
// Same locked atomic-write JSON pattern as chat-sessions.ts: every
// read-modify-write is serialized, writes go through temp-file + rename.

import { promises as fs } from 'fs';
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
const BOARD_TMP = path.join(DATA_DIR, 'board.json.tmp');

/** Key prefix for card identifiers (SHIB-1, SHIB-2, …). */
const KEY_PREFIX = 'SHIB';

let chain: Promise<unknown> = Promise.resolve();

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function loadStore(): Promise<BoardStore> {
  try {
    const raw = await fs.readFile(BOARD_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    return {
      nextNumber: Number.isInteger(parsed.nextNumber) && parsed.nextNumber > 0 ? parsed.nextNumber : 1,
      tasks: tasks.map((task: BoardTask) => ({
        ...task,
        syncUpdatedAt: task.syncUpdatedAt || task.updatedAt || task.createdAt,
        externalRefs: Array.isArray(task.externalRefs) ? task.externalRefs : [],
      })),
      syncState: parsed.syncState && typeof parsed.syncState === 'object' ? parsed.syncState : {},
    };
  } catch {
    return { nextNumber: 1, tasks: [], syncState: {} };
  }
}

async function saveStore(store: BoardStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(BOARD_TMP, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fs.rename(BOARD_TMP, BOARD_FILE);
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
  title: string;
  description?: string;
  status?: BoardStatus;
  priority?: number;
  assigneeAgentId?: string | null;
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
  return withStoreLock(async () => {
    const store = await loadStore();
    const status: BoardStatus = isBoardStatus(input.status) ? input.status : 'backlog';
    const createdAt = input.createdAt || now();
    const task: BoardTask = {
      id: uuidv4(),
      key: `${KEY_PREFIX}-${store.nextNumber}`,
      title: title.slice(0, 300),
      description: String(input.description || '').slice(0, 20_000),
      status,
      priority: clampPriority(input.priority),
      assigneeAgentId: input.assigneeAgentId || null,
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
  return withStoreLock(async () => {
    const store = await loadStore();
    const idx = store.tasks.findIndex((t) => t.id === idOrKey || t.key.toUpperCase() === needle);
    if (idx < 0) throw new Error(`Board task not found: ${idOrKey}`);
    store.tasks.splice(idx, 1);
    await saveStore(store);
  });
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
