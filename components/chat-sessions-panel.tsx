'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsLeft, ChevronsRight, EyeOff, GitBranch, Plus, Search } from 'lucide-react';
import { toast } from '@/lib/toast';
import { confirmDialog, promptDialog } from '@/components/confirm-dialog';
import GrokChatPanel from '@/components/grok-chat-panel';
import { groupChatSessionsByProject, type ChatSession } from '@/lib/chat-session-types';
import type { Project } from '@/lib/project-types';
import type { Agent } from '@/lib/types';
import { writeLastChatSessionId } from '@/lib/app-navigation';
import { endVoiceIfSessionChanges } from '@/lib/voice-agent-ui-store';
import {
  abortLiveChatRun,
  getLiveChatRun,
  listLiveChatSessionIds,
  subscribeLiveChatRuns,
} from '@/lib/chat-live-runs';
import InfoHint from '@/components/info-hint';
import { ChatSessionRailItem } from '@/components/chat-session-rail-item';
import { ContextInspector } from '@/components/context-inspector';
import {
  registerBrowserEphemeralSession,
  unregisterBrowserEphemeralSession,
} from '@/lib/ephemeral-chat-lifecycle';
import { invalidateClientJson, loadClientJson } from '@/lib/client-json';

type ModelOption = { id: string; label: string; provider?: 'cloud' | 'local' | 'cli' };

const CHAT_READ_REUSE_MS = 10_000;

function chatSessionsUrl(query: string | undefined, showArchived: boolean): string {
  const params = new URLSearchParams();
  if (query?.trim()) params.set('q', query.trim());
  if (showArchived) params.set('archived', '1');
  const qs = params.toString();
  return `/api/chat-sessions${qs ? `?${qs}` : ''}`;
}

function chatSessionUrl(id: string): string {
  return `/api/chat-sessions?id=${encodeURIComponent(id)}`;
}

function projectUrl(id?: string | null): string {
  return id ? `/api/projects?id=${encodeURIComponent(id)}` : '/api/projects';
}

function invalidateChatSessionReads(id?: string): void {
  invalidateClientJson(chatSessionsUrl(undefined, false));
  invalidateClientJson(chatSessionsUrl(undefined, true));
  if (id) invalidateClientJson(chatSessionUrl(id));
}

/**
 * Survives catch-all route remounts when the URL rewrites `/chat` → `/chat/:id`.
 * Without this, every soft navigation wiped component refs and re-fetched.
 */
const sessionCache: {
  listKey: string | null;
  sessions: ChatSession[];
  active: ChatSession | null;
  loadedId: string | null;
} = {
  listKey: null,
  sessions: [],
  active: null,
  loadedId: null,
};

interface ChatSessionsPanelProps {
  sessionId: string | null;
  onSessionChange: (id: string) => void;
  onStatsChange?: () => void;
  agents: Agent[];
  availableModels: ModelOption[];
  modelsLoading: boolean;
  modelsError: string | null;
  onRefreshModels: () => void;
  defaultChatModel: string;
  /** Settings default workspace for the chat workspace picker. */
  defaultWorkspace?: string;
}

export default function ChatSessionsPanel({
  sessionId,
  onSessionChange,
  onStatsChange,
  agents,
  availableModels,
  modelsLoading,
  modelsError,
  onRefreshModels,
  defaultChatModel,
  defaultWorkspace = '',
}: ChatSessionsPanelProps) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => sessionCache.sessions);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(() => sessionCache.active);
  const [linkedProject, setLinkedProject] = useState<Project | null>(null);
  const linkedProjectRequestRef = useRef(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const sessionGroups = useMemo(() => {
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return groupChatSessionsByProject(sessions)
      .map((group) => ({
        ...group,
        label: group.projectId ? (names.get(group.projectId) || 'Missing project') : 'Standalone chats',
      }))
      .sort((left, right) => {
        if (left.projectId === null) return 1;
        if (right.projectId === null) return -1;
        return left.label.localeCompare(right.label);
      });
  }, [projects, sessions]);
  const [bootstrapping, setBootstrapping] = useState(() => {
    // Warm start from module cache after a `/chat` → `/chat/:id` remount.
    if (sessionId && sessionCache.loadedId === sessionId && sessionCache.active?.id === sessionId) {
      return false;
    }
    return true;
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const listRequestRef = useRef(0);
  // Session rail collapse — SSR default open; restore preference after mount.
  const [railOpen, setRailOpen] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem('shiba-chat-rail') === 'closed') setRailOpen(false);
    } catch { /* private mode */ }
  }, []);

  // Background turns: pulse rail rows while a session is still generating.
  const [liveRunIds, setLiveRunIds] = useState<string[]>(() => listLiveChatSessionIds());
  const prevLiveCountRef = useRef(liveRunIds.length);
  const prevLiveIdsRef = useRef<string[]>(liveRunIds);
  useEffect(() => {
    const sync = () => {
      const next = listLiveChatSessionIds();
      setLiveRunIds((prev) => {
        if (prev.length === next.length && prev.every((id, i) => id === next[i])) return prev;
        return next;
      });
    };
    sync();
    return subscribeLiveChatRuns(sync);
  }, []);

  // Parent callbacks via refs — never put them in effect deps (identity churn
  // used to re-bootstrap /chat on every parent render).
  const onSessionChangeRef = useRef(onSessionChange);
  const onStatsChangeRef = useRef(onStatsChange);
  useEffect(() => { onSessionChangeRef.current = onSessionChange; }, [onSessionChange]);
  useEffect(() => { onStatsChangeRef.current = onStatsChange; }, [onStatsChange]);

  const defaultChatModelRef = useRef(defaultChatModel);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => { defaultChatModelRef.current = defaultChatModel; }, [defaultChatModel]);

  /**
   * Stable agent label under each chat title in the left rail.
   * Captured once per session when the list first loads; NOT recomputed when
   * you click another session. Only updates when that session's chatTarget
   * changes (user picked a new agent in the dropdown and sent a message).
   */
  const railAgentLabelRef = useRef<Map<string, string | null>>(new Map());
  const agentsByIdRef = useRef<Map<string, string>>(new Map());
  const [railLabelTick, setRailLabelTick] = useState(0);

  function agentLabelForTarget(chatTarget: string | undefined | null): string | null {
    const t = (chatTarget || 'grok').trim();
    if (!t || t === 'grok') return null;
    if (t === 'all') return 'All agents';
    return agentsByIdRef.current.get(t) || null;
  }

  useEffect(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.id, a.name);
    agentsByIdRef.current = map;
    // Agents often arrive after the session list — fill in null labels once.
    const labels = railAgentLabelRef.current;
    let filled = false;
    for (const s of sessionsRef.current) {
      const current = labels.get(s.id);
      if (current) continue;
      const next = agentLabelForTarget(s.chatTarget);
      if (next) {
        labels.set(s.id, next);
        filled = true;
      } else if (!labels.has(s.id) && (!s.chatTarget || s.chatTarget === 'grok')) {
        labels.set(s.id, null);
      }
    }
    if (filled) setRailLabelTick((n) => n + 1);
  }, [agents]);

  /** Merge sessions into state without wiping frozen rail agent labels. */
  function commitSessions(next: ChatSession[]) {
    const labels = railAgentLabelRef.current;
    for (const s of next) {
      const prev = sessionCache.sessions.find((x) => x.id === s.id)
        || sessionsRef.current.find((x) => x.id === s.id);
      // First time we see this session → capture label once.
      if (!labels.has(s.id)) {
        labels.set(s.id, agentLabelForTarget(s.chatTarget));
        continue;
      }
      // Only refresh label when chatTarget actually changed (send with new agent).
      if (prev && prev.chatTarget !== s.chatTarget) {
        labels.set(s.id, agentLabelForTarget(s.chatTarget));
        setRailLabelTick((n) => n + 1);
      }
    }
    // Drop labels for deleted sessions.
    for (const id of [...labels.keys()]) {
      if (!next.some((s) => s.id === id)) labels.delete(id);
    }
    sessionCache.sessions = next;
    setSessions(next);
  }

  /**
   * Last session the user explicitly picked. Bootstrap/load races must not
   * commit a different session over this (classic “click B, still stuck on A”).
   */
  const preferredSessionIdRef = useRef<string | null>(sessionId);
  const markedReadCursorRef = useRef(new Map<string, string>());
  // External navigations (Quick access, New Chat, URL) update the prop — mirror that.
  useEffect(() => {
    if (sessionId) preferredSessionIdRef.current = sessionId;
  }, [sessionId]);

  function commitActive(session: ChatSession | null) {
    // Switching chats ends Grok Voice; same session keep-alive is a no-op.
    endVoiceIfSessionChanges(session?.id ?? null);
    const lastMessageId = session?.messages.at(-1)?.id || '';
    const viewed = session ? { ...session, unreadCount: 0 } : null;
    sessionCache.active = viewed;
    sessionCache.loadedId = viewed?.id ?? null;
    setActiveSession(viewed);
    if (viewed?.id) {
      if (sessionsRef.current.some((item) => item.id === viewed.id && (item.unreadCount || 0) > 0)) {
        const nextSessions = sessionsRef.current.map((item) =>
          item.id === viewed.id ? { ...item, unreadCount: 0 } : item);
        sessionsRef.current = nextSessions;
        sessionCache.sessions = nextSessions;
        setSessions(nextSessions);
      }
      writeLastChatSessionId(viewed.id);
      const alreadyMarked = markedReadCursorRef.current.get(viewed.id) === lastMessageId;
      const serverCursorMatches = !lastMessageId || viewed.lastReadMessageId === lastMessageId;
      if (!alreadyMarked && !serverCursorMatches) {
        markedReadCursorRef.current.set(viewed.id, lastMessageId);
        void fetch('/api/chat-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'markRead', id: viewed.id, throughMessageId: lastMessageId || undefined }),
        }).then((response) => {
          if (!response.ok) return;
          invalidateChatSessionReads(viewed.id);
        }).catch(() => { /* read receipts are best-effort */ });
      }
    }
  }

  /** True when an async bootstrap/load is still allowed to apply this id. */
  function mayApplySession(id: string | null | undefined): boolean {
    if (!id) return true;
    const pref = preferredSessionIdRef.current;
    if (pref && pref !== id) return false;
    return true;
  }

  /** Navigate to another chat — ends voice when the bound session changes. */
  function selectSession(id: string) {
    if (!id) return;
    preferredSessionIdRef.current = id;
    if (id === activeSession?.id) {
      // Same chat: still ensure URL/sessionId stay in sync (e.g. bare `/chat`).
      if (id !== sessionId) onSessionChange(id);
      return;
    }
    endVoiceIfSessionChanges(id);
    // Optimistic switch from the already-loaded list — no network for the rail.
    // Messages come from the cached session object (list entries include history).
    const cached =
      sessionsRef.current.find((s) => s.id === id)
      || sessionCache.sessions.find((s) => s.id === id)
      || null;
    if (cached) {
      commitActive(cached);
      // Project link is rare; only fetch when this session actually has one.
      void loadLinkedProject(cached.projectId, cached.id);
    } else {
      sessionCache.loadedId = id;
      void loadLinkedProject(null, id);
      void loadSession(id).then((session) => {
        if (session && preferredSessionIdRef.current === id) {
          void loadLinkedProject(session.projectId, id);
        }
      });
    }
    // URL sync only — must not trigger loadNavStats / loadAll.
    onSessionChange(id);
  }

  function toggleRail() {
    setRailOpen((open) => {
      try { window.localStorage.setItem('shiba-chat-rail', open ? 'closed' : 'open'); } catch { /* private mode */ }
      return !open;
    });
  }

  const loadSessions = useCallback(async (query?: string, options?: { force?: boolean }) => {
    const filter = showArchived ? 'archived' : 'active';
    const normalizedQuery = query?.trim() || '';
    const requestKey = normalizedQuery ? `${filter}:${normalizedQuery}` : filter;
    const url = chatSessionsUrl(query, showArchived);
    if (options?.force) invalidateClientJson(url);
    const requestId = ++listRequestRef.current;
    try {
      const data = await loadClientJson<{ ok?: boolean; sessions?: ChatSession[] }>(url, {
        // Search is an explicit user action and should always read fresh data.
        maxAgeMs: normalizedQuery ? 0 : CHAT_READ_REUSE_MS,
      });
      if (data.ok) {
        const list = Array.isArray(data.sessions) ? data.sessions : [];
        if (requestId !== listRequestRef.current) return list;
        sessionCache.listKey = requestKey;
        commitSessions(list);
        return list;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }, [showArchived]);

  const loadSession = useCallback(async (id: string, options?: { force?: boolean }) => {
    const url = chatSessionUrl(id);
    if (options?.force) invalidateClientJson(url);
    try {
      const data = await loadClientJson<{ ok?: boolean; session?: ChatSession }>(url, {
        maxAgeMs: CHAT_READ_REUSE_MS,
      });
      if (data.ok && data.session) {
        const session = data.session as ChatSession;
        // Always refresh the rail/cache row, including for a background chat
        // that finished after the user switched elsewhere. Only the active
        // panel swap is guarded; otherwise a stale `running: true` row can
        // survive forever after its live-run entry disappears.
        if (
          mayApplySession(id)
          && (preferredSessionIdRef.current === id || sessionCache.active?.id === id)
        ) {
          commitActive(session);
        }
        // Patch a visible row. Only prepend into the canonical unfiltered
        // active rail; an absent background session must not contaminate an
        // archived/search result that intentionally excluded it.
        if (sessionsRef.current.some((s) => s.id === id)) {
          commitSessions(sessionsRef.current.map((s) => (s.id === id ? session : s)));
        } else if (sessionCache.listKey === 'active' && !session.archived) {
          commitSessions([session, ...sessionsRef.current]);
        }
        return session;
      }
    } catch {
      /* ignore */
    }
    return null;
  }, []);

  // When a background turn finishes, refresh only that session (title/running),
  // not the whole rail — full reloads made agent labels under titles flicker.
  useEffect(() => {
    const prev = prevLiveCountRef.current;
    const prevIds = prevLiveIdsRef.current;
    const nextIds = liveRunIds;
    prevLiveCountRef.current = nextIds.length;
    prevLiveIdsRef.current = nextIds;
    if (prev <= 0 || nextIds.length >= prev) return;
    const finished = prevIds.filter((id) => !nextIds.includes(id));
    for (const id of finished) {
      void loadSession(id, { force: true });
    }
  }, [liveRunIds, loadSession]);

  const loadProjects = useCallback(async () => {
    try {
      const data = await loadClientJson<{ ok?: boolean; projects?: Project[] }>('/api/projects', {
        maxAgeMs: CHAT_READ_REUSE_MS,
      });
      if (data.ok) setProjects(data.projects || []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadLinkedProject = useCallback(async (projectId: string | null, forSessionId?: string) => {
    const requestId = ++linkedProjectRequestRef.current;
    // Never render session A's context while session B's project is loading.
    setLinkedProject(null);
    if (!projectId) {
      return;
    }
    try {
      const data = await loadClientJson<{ ok?: boolean; project?: Project }>(projectUrl(projectId), {
        maxAgeMs: CHAT_READ_REUSE_MS,
      });
      if (
        requestId !== linkedProjectRequestRef.current
        || (forSessionId && sessionCache.active?.id !== forSessionId)
      ) return;
      if (data.ok && data.project) setLinkedProject(data.project);
      else setLinkedProject(null);
    } catch {
      if (
        requestId !== linkedProjectRequestRef.current
        || (forSessionId && sessionCache.active?.id !== forSessionId)
      ) return;
      setLinkedProject(null);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Single bootstrap path (avoids the old double-load):
  //  1) Fetch the session list once per archive filter — entries already include
  //     full message history, so no follow-up GET is needed for the active chat.
  //  2) If the URL has no session id, pick/create one, hydrate from the list,
  //     then navigate. Module cache survives the remount so step 3 is free.
  //  3) If the URL session changes (user clicks another chat), hydrate from
  //     cache/list or GET once.
  useEffect(() => {
    let cancelled = false;
    const listKey = showArchived ? 'archived' : 'active';
    // Track the sessionId this effect instance is responsible for.
    const effectSessionId = sessionId;

    (async () => {
      let list: ChatSession[] | undefined;

      // Warm path after `/chat` → `/chat/:id` remount — no network.
      // Require a non-empty list cache; empty means a prior failed load (or
      // corrupt store) and must hit the network again.
      if (
        effectSessionId
        && sessionCache.loadedId === effectSessionId
        && sessionCache.active?.id === effectSessionId
        && sessionCache.listKey === listKey
      ) {
        if (sessionsRef.current.length === 0) {
          setSessions(sessionCache.sessions);
        }
        await loadLinkedProject(sessionCache.active.projectId, effectSessionId);
        if (!cancelled) setBootstrapping(false);
        return;
      }

      // A successful empty list is a valid cache entry. `listKey` remains null
      // on failures, so the next mount still retries instead of double-loading now.
      const cacheMiss = sessionCache.listKey !== listKey;
      if (cacheMiss) {
        setBootstrapping(true);
        list = await loadSessions();
        if (cancelled) return;
        if (list !== undefined) sessionCache.listKey = listKey;
      } else {
        list = sessionCache.sessions;
      }

      // --- no URL session: pick/create, hydrate, navigate ---
      if (!effectSessionId) {
        // User already picked a chat while we were loading — don't hijack,
        // but still keep the rail list if we just loaded it.
        if (preferredSessionIdRef.current) {
          if (!cancelled) setBootstrapping(false);
          return;
        }
        setBootstrapping(true);
        if (list === undefined) {
          list = await loadSessions();
          if (cancelled) return;
          if (list !== undefined) sessionCache.listKey = listKey;
        }

        let chosen: ChatSession | null = null;
        if (list?.length) {
          chosen = list[0];
        } else {
          try {
            const res = await fetch('/api/chat-sessions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'create',
                defaults: { chatModel: defaultChatModelRef.current },
              }),
            });
            const data = await res.json();
            if (data.ok && data.session) {
              chosen = data.session as ChatSession;
              commitSessions([chosen]);
              invalidateChatSessionReads(chosen.id);
              onStatsChangeRef.current?.();
            }
          } catch {
            /* ignore */
          }
        }

        if (!chosen || cancelled) {
          if (!cancelled) setBootstrapping(false);
          return;
        }
        if (!mayApplySession(chosen.id)) {
          if (!cancelled) setBootstrapping(false);
          return;
        }

        preferredSessionIdRef.current = chosen.id;
        commitActive(chosen);
        await loadLinkedProject(chosen.projectId, chosen.id);
        if (cancelled) return;
        setBootstrapping(false);
        // Navigate last — remount reuses sessionCache (no second fetch).
        onSessionChangeRef.current(chosen.id);
        return;
      }

      // User clicked a different chat while this effect was in flight for an older id.
      if (!mayApplySession(effectSessionId)) {
        if (!cancelled) setBootstrapping(false);
        return;
      }

      // --- URL has sessionId ---
      if (sessionCache.loadedId === effectSessionId && sessionCache.active?.id === effectSessionId) {
        // Keep the rail populated even on the warm path.
        if (sessionCache.sessions.length && sessionsRef.current.length === 0) {
          setSessions(sessionCache.sessions);
        }
        setActiveSession(sessionCache.active);
        await loadLinkedProject(sessionCache.active.projectId, effectSessionId);
        if (!cancelled) setBootstrapping(false);
        return;
      }

      setBootstrapping(true);
      const cached =
        list?.find((s) => s.id === effectSessionId)
        || sessionCache.sessions.find((s) => s.id === effectSessionId)
        || sessionsRef.current.find((s) => s.id === effectSessionId);
      if (cached) {
        if (!mayApplySession(cached.id)) {
          if (!cancelled) setBootstrapping(false);
          return;
        }
        commitActive(cached);
        await loadLinkedProject(cached.projectId, cached.id);
        if (!cancelled) setBootstrapping(false);
        return;
      }

      const session = await loadSession(effectSessionId);
      if (cancelled) return;
      if (session && mayApplySession(session.id)) await loadLinkedProject(session.projectId, session.id);
      if (!cancelled) setBootstrapping(false);
    })();

    return () => { cancelled = true; };
  }, [sessionId, showArchived, loadSessions, loadSession, loadLinkedProject]);

  async function createSession(ephemeral = false) {
    try {
      const res = await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          defaults: { chatModel: defaultChatModel, ephemeral },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const created = data.session as ChatSession;
      invalidateChatSessionReads(created.id);
      if (created.ephemeral) registerBrowserEphemeralSession(created.id);
      commitSessions([created, ...sessionsRef.current.filter((s) => s.id !== created.id)]);
      preferredSessionIdRef.current = created.id;
      endVoiceIfSessionChanges(created.id);
      commitActive(created);
      await loadLinkedProject(null, created.id);
      onStatsChange?.();
      onSessionChange(created.id);
      toast.success(ephemeral ? 'New ephemeral chat' : 'New chat session');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to create session');
    }
  }

  async function archiveSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive', id, archived: true }),
      });
      invalidateChatSessionReads(id);
      await loadSessions(searchQuery, { force: true });
      onStatsChange?.();
      if (sessionId === id) {
        const remaining = sessions.filter((s) => s.id !== id);
        if (remaining.length > 0) onSessionChange(remaining[0].id);
        else await createSession();
      }
      toast.success('Session archived');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Archive failed');
    }
  }

  async function restoreSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive', id, archived: false }),
      });
      invalidateChatSessionReads(id);
      await loadSessions(searchQuery, { force: true });
      onStatsChange?.();
      toast.success('Session restored');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Restore failed');
    }
  }

  async function renameSession(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    const current = sessions.find((s) => s.id === id);
    const name = await promptDialog({
      title: 'Rename chat',
      defaultValue: current?.title || 'New chat',
      placeholder: 'Chat name',
      confirmLabel: 'Rename',
    });
    if (!name || name === current?.title) return;
    try {
      await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id, patch: { title: name } }),
      });
      invalidateChatSessionReads(id);
      await loadSessions(searchQuery, { force: true });
      onStatsChange?.();
      if (activeSession?.id === id && sessionCache.active) {
        commitActive({ ...sessionCache.active, title: name });
      }
      toast.success('Chat renamed');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Rename failed');
    }
  }

  async function closeSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: 'Delete this chat session?',
      message: 'The full message history for this session is permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      abortLiveChatRun(id);
      await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      invalidateChatSessionReads(id);
      invalidateClientJson(chatSessionsUrl(searchQuery, showArchived));
      const remaining = sessions.filter((s) => s.id !== id);
      unregisterBrowserEphemeralSession(id);
      commitSessions(remaining);
      onStatsChange?.();
      if (sessionId === id) {
        if (remaining.length > 0) {
          preferredSessionIdRef.current = remaining[0].id;
          commitActive(remaining[0]);
          await loadLinkedProject(remaining[0].projectId, remaining[0].id);
          onSessionChange(remaining[0].id);
        } else {
          commitActive(null);
          await loadLinkedProject(null);
          await createSession();
        }
      } else if (activeSession?.id === id) {
        commitActive(null);
        await loadLinkedProject(null);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to close session');
    }
  }

  async function onSessionUpdated() {
    // Prefer the chat the user is actually viewing (optimistic), not a stale URL.
    const id = activeSession?.id || sessionId;
    if (!id) return;
    if (!mayApplySession(id)) return;
    // Patch only this session into the rail — never re-fetch the full list
    // and never refresh left-nav badges (counts didn't change).
    await loadSession(id, { force: true });
  }

  async function onProjectLinkChange(projectId: string | null) {
    if (!activeSession) return;
    const targetSessionId = activeSession.id;
    try {
      const res = await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id: targetSessionId,
          patch: { projectId },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to link project');
      const updated = data.session as ChatSession;
      invalidateChatSessionReads(targetSessionId);
      commitSessions(sessionsRef.current.map((item) => item.id === targetSessionId ? updated : item));
      if (sessionCache.active?.id === targetSessionId && preferredSessionIdRef.current === targetSessionId) {
        commitActive(updated);
        await loadLinkedProject(projectId, targetSessionId);
      }
      toast.success(projectId ? 'Project context linked' : 'Project context detached');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to link project');
    }
  }

  if (bootstrapping && !activeSession) {
    return (
      <div className="chat-sessions-page page-content">
        <div className="chat-sessions-page-head">
          <div className="page-title">
            Grok Chat
            <InfoHint text="Talk to Grok, route to agents, or run a multi-agent group chat. Sessions, tools, voice, and project context all live here." />
          </div>
          <div className="page-subtitle">
            Sessions with tools, voice, and project context — Grok, a single agent, or the whole team.
          </div>
        </div>
        <div className="flex items-center justify-center gap-3 flex-1 min-h-0 text-dim text-sm">
          <span className="data-spinner data-spinner-lg" />
          Loading chat sessions…
        </div>
      </div>
    );
  }

  return (
    <div className="chat-sessions-page page-content">
      <div className="chat-sessions-page-head">
        <div className="page-title">
          Grok Chat
          <InfoHint text="Talk to Grok, route to agents, or run a multi-agent group chat. Sessions, tools, voice, and project context all live here." />
        </div>
        <div className="page-subtitle">
          Sessions with tools, voice, and project context — Grok, a single agent, or the whole team.
        </div>
      </div>

      <div className="chat-sessions-layout flex flex-1 min-h-0 w-full gap-3">
      {/* Session rail — expandable pane; scales to hundreds of chats */}
      {railOpen ? (
        <div className="chat-session-rail" data-testid="chat-session-rail">
          <div className="chat-session-rail-head">
            <span className="chat-session-rail-title">Chats</span>
            <span className="chat-session-rail-count">{sessions.length}</span>
            <button
              type="button"
              onClick={() => void createSession(false)}
              className="chat-session-rail-btn"
              title="New chat session"
              aria-label="New chat session"
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              onClick={() => void createSession(true)}
              className="chat-session-rail-btn"
              title="New ephemeral chat — no memory, deleted when this browser page closes"
              aria-label="New ephemeral chat"
            >
              <EyeOff size={14} />
            </button>
            <button
              type="button"
              onClick={toggleRail}
              className="chat-session-rail-btn"
              title="Collapse the chat list"
              aria-label="Collapse chat list"
            >
              <ChevronsLeft size={14} />
            </button>
          </div>
          <div className="chat-session-rail-search">
            <Search size={13} className="text-dim shrink-0" />
            <input
              className="grok-input text-xs flex-1 min-w-0"
              placeholder="Search sessions… (Enter)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadSessions(searchQuery, { force: true });
              }}
            />
          </div>
          <label className="chat-session-rail-archived">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <div className="chat-session-rail-list">
            {/* railLabelTick: re-paint when a frozen label is filled or chatTarget changes */}
            {sessionGroups.map((group) => (
              <section key={group.projectId || 'standalone'} aria-label={group.label} className="mb-2">
                <div className="flex items-center gap-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-dim">
                  <span className="truncate">{group.label}</span>
                  <span className="ml-auto font-mono">{group.sessions.length}</span>
                  {group.unreadCount > 0 && <span className="text-accent">{group.unreadCount} unread</span>}
                </div>
                {group.sessions.map((chatSession) => {
                  void railLabelTick;
                  if (!railAgentLabelRef.current.has(chatSession.id)) {
                    railAgentLabelRef.current.set(chatSession.id, agentLabelForTarget(chatSession.chatTarget));
                  }
                  return (
                    <ChatSessionRailItem
                      key={chatSession.id}
                      session={chatSession}
                      active={chatSession.id === (activeSession?.id ?? sessionId)}
                      isRunning={liveRunIds.includes(chatSession.id)
                        || !!getLiveChatRun(chatSession.id)?.streaming
                        || !!chatSession.running}
                      agentName={railAgentLabelRef.current.get(chatSession.id) ?? null}
                      onSelect={selectSession}
                      onRename={(id, event) => void renameSession(id, event)}
                      onArchive={(id, event) => void archiveSession(id, event)}
                      onRestore={(id, event) => void restoreSession(id, event)}
                      onDelete={(id, event) => void closeSession(id, event)}
                    />
                  );
                })}
              </section>
            ))}
            {sessions.length === 0 && (
              <div className="text-xs text-dim px-2 py-4 text-center">No chats{searchQuery ? ' match your search' : ' yet'}.</div>
            )}
          </div>
        </div>
      ) : (
        <div className="chat-session-rail chat-session-rail-collapsed">
          <button
            type="button"
            onClick={toggleRail}
            className="chat-session-rail-btn"
            title="Expand the chat list"
            aria-label="Expand chat list"
          >
            <ChevronsRight size={15} />
          </button>
          <button
            type="button"
            onClick={() => void createSession(false)}
            className="chat-session-rail-btn"
            title="New chat session"
            aria-label="New chat session"
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={() => void createSession(true)}
            className="chat-session-rail-btn"
            title="New ephemeral chat"
            aria-label="New ephemeral chat"
          >
            <EyeOff size={15} />
          </button>
          <span className="chat-session-rail-count-collapsed" title={`${sessions.length} chat session(s)`}>{sessions.length}</span>
        </div>
      )}

      <div className="chat-sessions-main flex flex-col flex-1 min-w-0">
      {activeSession && (
        <div className="mb-2 flex min-h-8 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1 text-xs">
          {activeSession.ephemeral && (
            <span className="inline-flex items-center gap-1 text-accent" title="No memories are read or written; deleted when this page closes">
              <EyeOff size={13} /> Ephemeral
            </span>
          )}
          {activeSession.branch && (
            <button
              type="button"
              className="grok-btn grok-btn-ghost text-xs py-1"
              onClick={() => selectSession(activeSession.branch!.parentSessionId)}
              title={`Return to parent at message ${activeSession.branch.sourceMessageId}`}
            >
              <GitBranch size={13} /> Fork {activeSession.branch.depth}
            </button>
          )}
          <span className="min-w-0 truncate text-dim">
            {linkedProject ? linkedProject.name : 'Standalone'} · {activeSession.messages.length} messages
          </span>
          <div className="ml-auto">
            <ContextInspector
              key={`${activeSession.id}:${activeSession.chatModel}`}
              sessionId={activeSession.id}
              model={activeSession.chatModel}
            />
          </div>
        </div>
      )}
      {activeSession && (
        <GrokChatPanel
          key={activeSession.id}
          session={activeSession}
          onSessionUpdated={onSessionUpdated}
          project={linkedProject}
          projects={projects}
          onProjectLinkChange={onProjectLinkChange}
          chatModel={activeSession.chatModel}
          onChatModelChange={async (model) => {
            const targetSessionId = activeSession.id;
            try {
              const res = await fetch('/api/chat-sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'update',
                  id: targetSessionId,
                  patch: { chatModel: model },
                }),
              });
              const data = await res.json();
              if (!res.ok || !data.ok) throw new Error(data.error || 'Could not change model');
              invalidateChatSessionReads(targetSessionId);
              if (sessionCache.active?.id === targetSessionId) {
                commitActive({ ...sessionCache.active, chatModel: model });
              }
              commitSessions(sessionsRef.current.map((item) =>
                item.id === targetSessionId ? { ...item, chatModel: model } : item,
              ));
              toast.success('Chat model updated');
            } catch (error: unknown) {
              toast.error(error instanceof Error ? error.message : 'Could not change model');
            }
          }}
          availableModels={availableModels}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          onRefreshModels={onRefreshModels}
          agents={agents}
          defaultWorkspace={defaultWorkspace}
        />
      )}
      </div>
      </div>
    </div>
  );
}
