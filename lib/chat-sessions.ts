import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { dataDir } from './data-paths';
import { v4 as uuidv4 } from 'uuid';
import type { ChatSession } from './chat-session-types';
import { compactContextScope, deleteContextScope, indexSessionContext } from './context-engine';

export type { ChatSession } from './chat-session-types';
export { deriveSessionTitle } from './chat-session-types';
export { groupChatSessionsByProject } from './chat-session-types';

const DATA_DIR = dataDir();
const SESSIONS_FILE = path.join(DATA_DIR, 'chat-sessions.json');

interface ChatSessionStore {
  sessions: ChatSession[];
}

/**
 * Serialize all read-modify-write operations. Concurrent live-run persists +
 * UI patches used to interleave writes and corrupt chat-sessions.json into
 * concatenated JSON — list then returned empty (parse failure).
 */
const chatStoreLockGlobal = globalThis as typeof globalThis & { __shibaChatStoreChain?: Promise<unknown> };

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = chatStoreLockGlobal.__shibaChatStoreChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Keep the queue alive even if this op fails.
  chatStoreLockGlobal.__shibaChatStoreChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/** Pull the first complete top-level `{...}` if the file was partially overwritten. */
export function recoverFirstJsonObject(text: string): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

async function loadStore(): Promise<ChatSessionStore> {
  await ensureData();
  try {
    const raw = await fs.readFile(SESSIONS_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ChatSessionStore).sessions)) {
      throw new Error('Invalid chat session store: expected an object with a sessions array');
    }
    return { sessions: (parsed as ChatSessionStore).sessions };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return { sessions: [] };
  }
}

/** Atomic write: temp file + rename so readers never see a half-written blob. */
async function saveStoreUnlocked(sessions: ChatSession[]) {
  await ensureData();
  const payload = `${JSON.stringify({ sessions }, null, 2)}\n`;
  const tmp = `${SESSIONS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, SESSIONS_FILE);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  // Live UI: session lists + nav badge refresh without a page reload.
  const { emitAppEvent } = await import('./app-events');
  emitAppEvent('chats');
}

async function saveStore(sessions: ChatSession[]) {
  await saveStoreUnlocked(sessions);
}

export async function listChatSessions(opts?: { includeArchived?: boolean }): Promise<ChatSession[]> {
  return withStoreLock(async () => {
    const store = await loadStore();
    let sessions = store.sessions;
    if (!opts?.includeArchived) {
      sessions = sessions.filter((s) => !s.archived);
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
}

export async function searchChatSessions(query: string, opts?: { includeArchived?: boolean }): Promise<ChatSession[]> {
  const q = query.trim().toLowerCase();
  if (!q) return listChatSessions(opts);
  const sessions = await listChatSessions({ includeArchived: opts?.includeArchived });
  return sessions.filter((s) => {
    if ((s.title || '').toLowerCase().includes(q)) return true;
    return (s.messages || []).some((m) => m?.content?.toLowerCase().includes(q));
  });
}

export async function archiveChatSession(id: string, archived = true): Promise<ChatSession> {
  const session = await getChatSession(id);
  if (session?.ephemeral && archived) throw new Error('Ephemeral sessions cannot be archived; delete them instead');
  return updateChatSession(id, {
    archived,
    archivedAt: archived ? new Date().toISOString() : undefined,
  });
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
  return withStoreLock(async () => {
    const store = await loadStore();
    return store.sessions.find((s) => s.id === id) || null;
  });
}

export async function createChatSession(
  defaults: Partial<Pick<ChatSession, 'title' | 'chatTarget' | 'chatModel' | 'projectId' | 'useGrokCli' | 'reasoningEffort' | 'ephemeral'>> = {},
): Promise<ChatSession> {
  return withStoreLock(async () => {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: uuidv4(),
      title: defaults.title?.trim() || 'New chat',
      chatTarget: defaults.chatTarget || 'grok',
      chatModel: defaults.chatModel || 'cloud:grok-4',
      projectId: defaults.projectId ?? null,
      useGrokCli: !!defaults.useGrokCli,
      reasoningEffort: defaults.reasoningEffort || 'low',
      ephemeral: !!defaults.ephemeral,
      unreadCount: 0,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    const store = await loadStore();
    store.sessions.unshift(session);
    await saveStore(store.sessions);
    indexSessionContext(session);
    return session;
  });
}

export async function updateChatSession(
  id: string,
  patch: Partial<Omit<ChatSession, 'id' | 'createdAt'>>,
): Promise<ChatSession> {
  return withStoreLock(async () => {
    const store = await loadStore();
    const idx = store.sessions.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error('Chat session not found');
    const current = store.sessions[idx];
    const mutablePatch = { ...patch } as Partial<ChatSession>;
    // Lifecycle and branch ancestry are server-owned. Ordinary PATCH calls
    // cannot rewrite the cursor, turn a durable chat ephemeral, or forge read state.
    delete mutablePatch.branch;
    delete mutablePatch.ephemeral;
    delete mutablePatch.unreadCount;
    delete mutablePatch.lastReadMessageId;
    delete mutablePatch.lastReadAt;
    if (Array.isArray(mutablePatch.messages)) {
      const incomingIds = new Set(mutablePatch.messages.map((message) => message.id));
      const serverDelivered = (current.messages || []).filter((message) =>
        message.agentName === 'Shiba Task System' && !incomingIds.has(message.id));
      // Background outbox messages are server-owned. A browser can PATCH a
      // stale conversation snapshot after exact-once delivery; preserve those
      // stable-id messages instead of acknowledging delivery and then losing
      // the visible result.
      mutablePatch.messages = [...mutablePatch.messages, ...serverDelivered];
    }
    let unreadCount = Math.max(0, Number(current.unreadCount) || 0);
    if (Array.isArray(mutablePatch.messages)) {
      const prior = new Map((current.messages || []).map((message) => [message.id, message]));
      unreadCount += mutablePatch.messages.filter((message) => {
        if (message.role !== 'assistant' || message.streaming) return false;
        const previous = prior.get(message.id);
        return !previous || !!previous.streaming;
      }).length;
    }
    store.sessions[idx] = {
      ...current,
      ...mutablePatch,
      unreadCount,
      updatedAt: new Date().toISOString(),
    };
    await saveStore(store.sessions);
    indexSessionContext(store.sessions[idx]);
    return store.sessions[idx];
  });
}

/**
 * Append one message to a session under the store lock — used by background
 * tasks delivering results, so a full-array client save can't drop it mid-write.
 * (A client PATCH built from a stale view can still supersede it later; the
 * result also lives in run history, so nothing is ever lost.)
 */
export async function appendChatMessage(
  id: string,
  message: import('./project-types').ProjectChatMessage,
): Promise<ChatSession | null> {
  return withStoreLock(async () => {
    const store = await loadStore();
    const idx = store.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return null;
    // Outbox delivery retries reuse a stable message id. If the process dies
    // after this JSON write but before acknowledging SQLite, the next attempt
    // observes the message and becomes a no-op instead of duplicating it.
    if ((store.sessions[idx].messages || []).some((existing) => existing.id === message.id)) {
      return store.sessions[idx];
    }
    store.sessions[idx] = {
      ...store.sessions[idx],
      messages: [...(store.sessions[idx].messages || []), message],
      unreadCount: Math.max(0, Number(store.sessions[idx].unreadCount) || 0)
        + (message.role === 'assistant' && !message.streaming ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    await saveStore(store.sessions);
    indexSessionContext(store.sessions[idx]);
    return store.sessions[idx];
  });
}

export async function deleteChatSession(id: string): Promise<void> {
  return withStoreLock(async () => {
    const store = await loadStore();
    await saveStore(store.sessions.filter((s) => s.id !== id));
    deleteContextScope('session', id);
  });
}

function cloneMessages(messages: import('./project-types').ProjectChatMessage[]) {
  return structuredClone(messages);
}

/** Non-destructive branch from an exact immutable message cursor. */
export async function forkChatSession(
  parentSessionId: string,
  sourceMessageId: string,
  options: { title?: string } = {},
): Promise<ChatSession> {
  return withStoreLock(async () => {
    const store = await loadStore();
    const parent = store.sessions.find((session) => session.id === parentSessionId);
    if (!parent) throw new Error('Parent chat session not found');
    const ordinal = parent.messages.findIndex((message) => message.id === sourceMessageId);
    if (ordinal < 0) throw new Error('Fork source message not found in parent session');
    const now = new Date().toISOString();
    const messages = cloneMessages(parent.messages.slice(0, ordinal + 1));
    const child: ChatSession = {
      id: uuidv4(),
      title: options.title?.trim().slice(0, 120) || `${parent.title || 'Chat'} · fork`,
      chatTarget: parent.chatTarget,
      chatModel: parent.chatModel,
      projectId: parent.projectId,
      useGrokCli: parent.useGrokCli,
      cliModel: parent.cliModel,
      reasoningEffort: parent.reasoningEffort,
      workspaceDir: parent.workspaceDir,
      messages,
      ephemeral: !!parent.ephemeral,
      unreadCount: 0,
      lastReadMessageId: sourceMessageId,
      lastReadAt: now,
      branch: {
        kind: 'checkpoint-branch-v1',
        parentSessionId: parent.id,
        rootSessionId: parent.branch?.rootSessionId || parent.id,
        sourceMessageId,
        sourceMessageOrdinal: ordinal,
        depth: (parent.branch?.depth || 0) + 1,
        createdAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    store.sessions.unshift(child);
    await saveStore(store.sessions);
    indexSessionContext(child);
    return child;
  });
}

export async function markChatSessionRead(id: string, throughMessageId?: string): Promise<ChatSession> {
  return withStoreLock(async () => {
    const store = await loadStore();
    const idx = store.sessions.findIndex((session) => session.id === id);
    if (idx < 0) throw new Error('Chat session not found');
    const session = store.sessions[idx];
    const cursor = throughMessageId
      ? session.messages.find((message) => message.id === throughMessageId)
      : session.messages.at(-1);
    if (throughMessageId && !cursor) throw new Error('Read cursor message not found');
    store.sessions[idx] = {
      ...session,
      unreadCount: 0,
      ...(cursor ? { lastReadMessageId: cursor.id } : {}),
      lastReadAt: new Date().toISOString(),
    };
    await saveStore(store.sessions);
    return store.sessions[idx];
  });
}

export interface RewindChatSessionInput {
  sessionId: string;
  sourceMessageId: string;
  /** Destructive confirmation must bind to the same immutable message cursor. */
  confirmSourceMessageId: string;
  /** Optional optimistic guard supplied by a checkpoint restore preflight. */
  expectedCurrentLastMessageId?: string;
}

/**
 * Server-only destructive companion to forkChatSession. Browser routes do not
 * expose this; task checkpoint restore calls it after its own confirmation and
 * preflight. Branch ancestry and lifecycle flags remain immutable.
 */
export async function rewindChatSessionToMessage(input: RewindChatSessionInput): Promise<ChatSession> {
  return withStoreLock(async () => {
    const sessionId = String(input.sessionId || '').trim();
    const sourceMessageId = String(input.sourceMessageId || '').trim();
    if (!sessionId || !sourceMessageId) throw new Error('Session and source message are required');
    if (String(input.confirmSourceMessageId || '') !== sourceMessageId) {
      throw new Error('confirmSourceMessageId must exactly match the rewind cursor');
    }
    const store = await loadStore();
    const idx = store.sessions.findIndex((session) => session.id === sessionId);
    if (idx < 0) throw new Error('Chat session not found');
    const current = store.sessions[idx];
    const currentLastMessageId = current.messages.at(-1)?.id || '';
    if (
      input.expectedCurrentLastMessageId !== undefined
      && input.expectedCurrentLastMessageId !== currentLastMessageId
    ) {
      throw new Error('Chat session changed after rewind preflight');
    }
    const ordinal = current.messages.findIndex((message) => message.id === sourceMessageId);
    if (ordinal < 0) throw new Error('Rewind source message not found in chat session');
    const now = new Date().toISOString();
    const rewound: ChatSession = {
      ...current,
      messages: cloneMessages(current.messages.slice(0, ordinal + 1)),
      running: false,
      unreadCount: 0,
      lastReadMessageId: sourceMessageId,
      lastReadAt: now,
      updatedAt: now,
    };
    store.sessions[idx] = rewound;
    await saveStore(store.sessions);
    indexSessionContext(rewound);
    compactContextScope('session', rewound.id);
    return rewound;
  });
}

/** Internal compensation hook used only when a checkpoint restore fails after chat rewind. */
export async function restoreChatSessionSnapshot(snapshot: ChatSession): Promise<ChatSession> {
  return withStoreLock(async () => {
    const store = await loadStore();
    const idx = store.sessions.findIndex((session) => session.id === snapshot.id);
    if (idx < 0) throw new Error('Chat session disappeared during checkpoint compensation');
    const snapshotIds = new Set(snapshot.messages.map((message) => message.id));
    const newlyDelivered = store.sessions[idx].messages.filter((message) =>
      message.agentName === 'Shiba Task System' && !snapshotIds.has(message.id));
    const restored: ChatSession = {
      ...snapshot,
      messages: cloneMessages([...snapshot.messages, ...newlyDelivered]),
    };
    store.sessions[idx] = restored;
    await saveStore(store.sessions);
    indexSessionContext(restored);
    compactContextScope('session', restored.id);
    return restored;
  });
}
