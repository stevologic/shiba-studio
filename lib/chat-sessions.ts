import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import { v4 as uuidv4 } from 'uuid';
import type { ChatSession } from './chat-session-types';

export type { ChatSession } from './chat-session-types';
export { deriveSessionTitle } from './chat-session-types';

const DATA_DIR = dataDir();
const SESSIONS_FILE = path.join(DATA_DIR, 'chat-sessions.json');

interface ChatSessionStore {
  sessions: ChatSession[];
}

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadStore(): Promise<ChatSessionStore> {
  await ensureData();
  try {
    const raw = await fs.readFile(SESSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
  } catch {
    return { sessions: [] };
  }
}

async function saveStore(sessions: ChatSession[]) {
  await ensureData();
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({ sessions }, null, 2));
}

export async function listChatSessions(opts?: { includeArchived?: boolean }): Promise<ChatSession[]> {
  const store = await loadStore();
  let sessions = store.sessions;
  if (!opts?.includeArchived) {
    sessions = sessions.filter((s) => !s.archived);
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function searchChatSessions(query: string, opts?: { includeArchived?: boolean }): Promise<ChatSession[]> {
  const q = query.trim().toLowerCase();
  if (!q) return listChatSessions(opts);
  const sessions = await listChatSessions({ includeArchived: opts?.includeArchived });
  return sessions.filter((s) => {
    if (s.title.toLowerCase().includes(q)) return true;
    return s.messages.some((m) => m.content?.toLowerCase().includes(q));
  });
}

export async function archiveChatSession(id: string, archived = true): Promise<ChatSession> {
  return updateChatSession(id, {
    archived,
    archivedAt: archived ? new Date().toISOString() : undefined,
  });
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
  const store = await loadStore();
  return store.sessions.find((s) => s.id === id) || null;
}

export async function createChatSession(
  defaults: Partial<Pick<ChatSession, 'title' | 'chatTarget' | 'chatModel' | 'projectId' | 'useGrokCli' | 'reasoningEffort'>> = {},
): Promise<ChatSession> {
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
}

export async function updateChatSession(
  id: string,
  patch: Partial<Omit<ChatSession, 'id' | 'createdAt'>>,
): Promise<ChatSession> {
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
}

export async function deleteChatSession(id: string): Promise<void> {
  const store = await loadStore();
  await saveStore(store.sessions.filter((s) => s.id !== id));
}