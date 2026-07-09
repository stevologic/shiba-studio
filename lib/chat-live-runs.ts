/**
 * In-browser background chat turns.
 *
 * Chat streams outlive the GrokChatPanel: navigate to Agents/Settings/etc. and
 * the model keeps working. Returning to the session reattaches to live state
 * (or loads the persisted partial/final messages from the server).
 *
 * Scope is the SPA lifetime (same tab). Closing the browser stops the fetch;
 * partial progress is still on disk via throttled session patches.
 */
'use client';

import { deriveSessionTitle } from './chat-session-types';
import type { ChatAttachment } from './chat-types';
import type { ProjectChatMessage } from './project-types';

export type LiveChatUiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  attachments?: ChatAttachment[];
  model?: string;
  agentId?: string;
  agentName?: string;
  perspectives?: Array<{ agentId: string; name: string; content: string }>;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  streaming?: boolean;
};

export type LiveChatRun = {
  sessionId: string;
  messages: LiveChatUiMessage[];
  streaming: boolean;
  abort: AbortController;
  error?: string;
  updatedAt: number;
};

type Listener = () => void;

const runs = new Map<string, LiveChatRun>();
const globalListeners = new Set<Listener>();
const sessionListeners = new Map<string, Set<Listener>>();

/** Throttle disk writes while tokens stream. */
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_MS = 700;

function emitGlobal() {
  for (const l of globalListeners) {
    try { l(); } catch { /* ignore */ }
  }
}

function emitSession(sessionId: string) {
  const set = sessionListeners.get(sessionId);
  if (!set) return;
  for (const l of set) {
    try { l(); } catch { /* ignore */ }
  }
}

/** Session listeners always fire; global only when the run set / streaming flag changes. */
function emit(sessionId: string, opts?: { global?: boolean }) {
  emitSession(sessionId);
  if (opts?.global !== false) emitGlobal();
}

function emitToken(sessionId: string) {
  // High-frequency stream deltas: only reattach subscribers for this session.
  emitSession(sessionId);
}

export function getLiveChatRun(sessionId: string): LiveChatRun | undefined {
  return runs.get(sessionId);
}

export function listLiveChatRuns(): LiveChatRun[] {
  return [...runs.values()];
}

export function listLiveChatSessionIds(): string[] {
  return [...runs.keys()];
}

export function hasLiveChatRuns(): boolean {
  return runs.size > 0;
}

/** Prefer a running session when keeping the chat shell mounted off-tab. */
export function primaryLiveChatSessionId(): string | null {
  for (const run of runs.values()) {
    if (run.streaming) return run.sessionId;
  }
  const first = runs.keys().next();
  return first.done ? null : first.value;
}

export function subscribeLiveChatRuns(listener: Listener): () => void {
  globalListeners.add(listener);
  return () => { globalListeners.delete(listener); };
}

export function subscribeLiveChatSession(sessionId: string, listener: Listener): () => void {
  let set = sessionListeners.get(sessionId);
  if (!set) {
    set = new Set();
    sessionListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) sessionListeners.delete(sessionId);
  };
}

export function liveMessagesToProject(messages: LiveChatUiMessage[]): ProjectChatMessage[] {
  return messages
    .filter((m) => m.id !== 'welcome' && (m.role === 'user' || m.role === 'assistant'))
    .filter((m) => m.streaming || (m.content && m.content.trim()) || m.attachments?.length)
    .map((m) => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content || '',
      thinking: m.thinking,
      attachments: m.attachments,
      model: m.model,
      agentId: m.agentId,
      agentName: m.agentName,
      perspectives: m.perspectives,
      usage: m.usage,
      streaming: !!m.streaming,
      createdAt: new Date().toISOString(),
    }));
}

async function persistSessionNow(sessionId: string, messages: LiveChatUiMessage[], running: boolean) {
  const saved = liveMessagesToProject(messages);
  try {
    await fetch('/api/chat-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update',
        id: sessionId,
        patch: {
          messages: saved,
          running,
          title: deriveSessionTitle(saved, 'New chat'),
        },
      }),
    });
  } catch {
    /* best-effort — stream continues either way */
  }
}

function schedulePersist(sessionId: string) {
  const existing = persistTimers.get(sessionId);
  if (existing) return;
  const t = setTimeout(() => {
    persistTimers.delete(sessionId);
    const run = runs.get(sessionId);
    if (!run) return;
    void persistSessionNow(sessionId, run.messages, run.streaming);
  }, PERSIST_MS);
  persistTimers.set(sessionId, t);
}

export async function flushLiveChatPersist(sessionId: string) {
  const t = persistTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    persistTimers.delete(sessionId);
  }
  const run = runs.get(sessionId);
  if (!run) return;
  await persistSessionNow(sessionId, run.messages, run.streaming);
}

/**
 * Start (or replace) a background turn for a session.
 * Returns the AbortController signal used by the fetch.
 */
export function beginLiveChatRun(
  sessionId: string,
  messages: LiveChatUiMessage[],
): AbortController {
  const prev = runs.get(sessionId);
  if (prev) {
    try { prev.abort.abort(); } catch { /* ignore */ }
  }
  const abort = new AbortController();
  runs.set(sessionId, {
    sessionId,
    messages,
    streaming: true,
    abort,
    updatedAt: Date.now(),
  });
  emit(sessionId, { global: true });
  void persistSessionNow(sessionId, messages, true);
  return abort;
}

export function updateLiveChatRun(
  sessionId: string,
  messages: LiveChatUiMessage[],
  opts?: { streaming?: boolean; error?: string; persist?: boolean },
) {
  const run = runs.get(sessionId);
  if (!run) return;
  const wasStreaming = run.streaming;
  run.messages = messages;
  if (typeof opts?.streaming === 'boolean') run.streaming = opts.streaming;
  if (opts?.error !== undefined) run.error = opts.error;
  run.updatedAt = Date.now();
  // Token deltas: session listeners only. Global (rail · working) when status flips.
  if (wasStreaming !== run.streaming) emit(sessionId, { global: true });
  else emitToken(sessionId);
  if (opts?.persist === false) return;
  if (run.streaming) schedulePersist(sessionId);
  else void persistSessionNow(sessionId, run.messages, false);
}

export async function finishLiveChatRun(
  sessionId: string,
  messages: LiveChatUiMessage[],
  opts?: { error?: string; keepEntryMs?: number },
) {
  const run = runs.get(sessionId);
  if (run) {
    run.messages = messages;
    run.streaming = false;
    run.error = opts?.error;
    run.updatedAt = Date.now();
  }
  await persistSessionNow(sessionId, messages, false);

  // Auto-title after first completed exchange (same as panel used to do).
  try {
    const saved = liveMessagesToProject(messages);
    const userCount = saved.filter((m) => m.role === 'user').length;
    const hasAssistant = saved.some((m) => m.role === 'assistant' && !m.streaming && m.content);
    if (userCount >= 1 && hasAssistant) {
      await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'autotitle', id: sessionId }),
      });
    }
  } catch {
    /* ignore */
  }

  emit(sessionId, { global: true });

  const keepMs = opts?.keepEntryMs ?? 8_000;
  setTimeout(() => {
    const cur = runs.get(sessionId);
    if (cur && !cur.streaming) {
      runs.delete(sessionId);
      emit(sessionId, { global: true });
    }
  }, keepMs);
}

export function abortLiveChatRun(sessionId: string) {
  const run = runs.get(sessionId);
  if (!run) return;
  try { run.abort.abort(); } catch { /* ignore */ }
  run.streaming = false;
  run.updatedAt = Date.now();
  // Leave partial messages in place; finish path or panel will persist.
  emit(sessionId, { global: true });
}
