import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import { v4 as uuidv4 } from 'uuid';
import type { ChatSession } from './chat-session-types';

export type { ChatSession } from './chat-session-types';
export { deriveSessionTitle } from './chat-session-types';

const DATA_DIR = dataDir();
const SESSIONS_FILE = path.join(DATA_DIR, 'chat-sessions.json');
const SESSIONS_TMP = path.join(DATA_DIR, 'chat-sessions.json.tmp');

interface ChatSessionStore {
  sessions: ChatSession[];
}

/**
 * Serialize all read-modify-write operations. Concurrent live-run persists +
 * UI patches used to interleave writes and corrupt chat-sessions.json into
 * concatenated JSON — list then returned empty (parse failure).
 */
let chain: Promise<unknown> = Promise.resolve();

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the queue alive even if this op fails.
  chain = run.then(
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
    try {
      const parsed = JSON.parse(raw);
      return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch {
      // Concurrent writers used to leave two JSON blobs concatenated.
      const recovered = recoverFirstJsonObject(raw);
      if (!recovered) return { sessions: [] };
      try {
        const parsed = JSON.parse(recovered);
        const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
        // Persist the repair so the next read is clean.
        await saveStoreUnlocked(sessions);
        return { sessions };
      } catch {
        return { sessions: [] };
      }
    }
  } catch {
    return { sessions: [] };
  }
}

/** Atomic write: temp file + rename so readers never see a half-written blob. */
async function saveStoreUnlocked(sessions: ChatSession[]) {
  await ensureData();
  const payload = `${JSON.stringify({ sessions }, null, 2)}\n`;
  await fs.writeFile(SESSIONS_TMP, payload, 'utf8');
  await fs.rename(SESSIONS_TMP, SESSIONS_FILE);
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
  defaults: Partial<Pick<ChatSession, 'title' | 'chatTarget' | 'chatModel' | 'projectId' | 'useGrokCli' | 'reasoningEffort'>> = {},
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
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    const store = await loadStore();
    store.sessions.unshift(session);
    await saveStore(store.sessions);
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
    store.sessions[idx] = {
      ...store.sessions[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await saveStore(store.sessions);
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
    store.sessions[idx] = {
      ...store.sessions[idx],
      messages: [...(store.sessions[idx].messages || []), message],
      updatedAt: new Date().toISOString(),
    };
    await saveStore(store.sessions);
    return store.sessions[idx];
  });
}

export async function deleteChatSession(id: string): Promise<void> {
  return withStoreLock(async () => {
    const store = await loadStore();
    await saveStore(store.sessions.filter((s) => s.id !== id));
  });
}
