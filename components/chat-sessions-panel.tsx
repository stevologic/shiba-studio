'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Pencil, Plus, X, Search, Archive, ArchiveRestore, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog, promptDialog } from '@/components/confirm-dialog';
import GrokChatPanel from '@/components/grok-chat-panel';
import type { ChatSession } from '@/lib/chat-session-types';
import type { Project } from '@/lib/project-types';
import type { Agent } from '@/lib/types';
import { writeLastChatSessionId } from '@/lib/app-navigation';
import { endVoiceIfSessionChanges } from '@/lib/voice-agent-ui-store';
import InfoHint from '@/components/info-hint';

type ModelOption = { id: string; label: string; provider?: 'cloud' | 'local' | 'cli' };

/**
 * Survives catch-all route remounts when the URL rewrites `/chat` → `/chat/:id`.
 * Without this, every soft navigation wiped component refs and re-fetched.
 */
const sessionCache: {
  listKey: string | null;
  sessions: ChatSession[];
  active: ChatSession | null;
  loadedId: string | null;
  listInflight: Promise<ChatSession[] | undefined> | null;
} = {
  listKey: null,
  sessions: [],
  active: null,
  loadedId: null,
  listInflight: null,
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
}: ChatSessionsPanelProps) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => sessionCache.sessions);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(() => sessionCache.active);
  const [linkedProject, setLinkedProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [bootstrapping, setBootstrapping] = useState(() => {
    // Warm start from module cache after a `/chat` → `/chat/:id` remount.
    if (sessionId && sessionCache.loadedId === sessionId && sessionCache.active?.id === sessionId) {
      return false;
    }
    return true;
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // Session rail collapse — SSR default open; restore preference after mount.
  const [railOpen, setRailOpen] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem('shiba-chat-rail') === 'closed') setRailOpen(false);
    } catch { /* private mode */ }
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

  function commitSessions(next: ChatSession[]) {
    sessionCache.sessions = next;
    setSessions(next);
  }

  function commitActive(session: ChatSession | null) {
    // Switching chats ends Grok Voice; same session keep-alive is a no-op.
    endVoiceIfSessionChanges(session?.id ?? null);
    sessionCache.active = session;
    sessionCache.loadedId = session?.id ?? null;
    setActiveSession(session);
    if (session?.id) writeLastChatSessionId(session.id);
  }

  /** Navigate to another chat — ends voice when the bound session changes. */
  function selectSession(id: string) {
    endVoiceIfSessionChanges(id);
    onSessionChange(id);
  }

  function toggleRail() {
    setRailOpen((open) => {
      try { window.localStorage.setItem('shiba-chat-rail', open ? 'closed' : 'open'); } catch { /* private mode */ }
      return !open;
    });
  }

  const loadSessions = useCallback(async (query?: string) => {
    // Dedupe concurrent list fetches (Strict Mode / remount races).
    if (!query?.trim() && sessionCache.listInflight) {
      return sessionCache.listInflight;
    }
    const run = (async () => {
      try {
        const params = new URLSearchParams();
        if (query?.trim()) params.set('q', query.trim());
        if (showArchived) params.set('archived', '1');
        const qs = params.toString();
        const res = await fetch(`/api/chat-sessions${qs ? `?${qs}` : ''}`);
        const data = await res.json();
        if (data.ok) {
          const list = (data.sessions || []) as ChatSession[];
          commitSessions(list);
          return list;
        }
        return undefined;
      } catch {
        return undefined;
      }
    })();
    if (!query?.trim()) {
      sessionCache.listInflight = run;
      try {
        return await run;
      } finally {
        if (sessionCache.listInflight === run) sessionCache.listInflight = null;
      }
    }
    return run;
  }, [showArchived]);

  const loadSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat-sessions?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (data.ok && data.session) {
        const session = data.session as ChatSession;
        commitActive(session);
        commitSessions(
          sessionsRef.current.some((s) => s.id === id)
            ? sessionsRef.current.map((s) => (s.id === id ? session : s))
            : [session, ...sessionsRef.current],
        );
        return session;
      }
    } catch {
      /* ignore */
    }
    return null;
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (data.ok) setProjects(data.projects || []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadLinkedProject = useCallback(async (projectId: string | null) => {
    if (!projectId) {
      setLinkedProject(null);
      return;
    }
    try {
      const res = await fetch(`/api/projects?id=${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (data.ok && data.project) setLinkedProject(data.project);
      else setLinkedProject(null);
    } catch {
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

    (async () => {
      let list: ChatSession[] | undefined;

      // Warm path after `/chat` → `/chat/:id` remount — no network.
      if (
        sessionId
        && sessionCache.loadedId === sessionId
        && sessionCache.active?.id === sessionId
        && sessionCache.listKey === listKey
      ) {
        if (sessionCache.sessions.length && sessionsRef.current.length === 0) {
          setSessions(sessionCache.sessions);
        }
        if (!cancelled) setBootstrapping(false);
        return;
      }

      if (sessionCache.listKey !== listKey) {
        setBootstrapping(true);
        list = await loadSessions();
        if (cancelled) return;
        sessionCache.listKey = listKey;
      } else {
        list = sessionCache.sessions.length ? sessionCache.sessions : sessionsRef.current;
      }

      // --- no URL session: pick/create, hydrate, navigate ---
      if (!sessionId) {
        setBootstrapping(true);
        if (!list?.length) {
          list = await loadSessions();
          if (cancelled) return;
          sessionCache.listKey = listKey;
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

        commitActive(chosen);
        await loadLinkedProject(chosen.projectId);
        if (cancelled) return;
        setBootstrapping(false);
        // Navigate last — remount reuses sessionCache (no second fetch).
        onSessionChangeRef.current(chosen.id);
        return;
      }

      // --- URL has sessionId ---
      if (sessionCache.loadedId === sessionId && sessionCache.active?.id === sessionId) {
        setActiveSession(sessionCache.active);
        if (!cancelled) setBootstrapping(false);
        return;
      }

      setBootstrapping(true);
      const cached =
        list?.find((s) => s.id === sessionId)
        || sessionCache.sessions.find((s) => s.id === sessionId)
        || sessionsRef.current.find((s) => s.id === sessionId);
      if (cached) {
        commitActive(cached);
        await loadLinkedProject(cached.projectId);
        if (!cancelled) setBootstrapping(false);
        return;
      }

      const session = await loadSession(sessionId);
      if (cancelled) return;
      if (session) await loadLinkedProject(session.projectId);
      if (!cancelled) setBootstrapping(false);
    })();

    return () => { cancelled = true; };
  }, [sessionId, showArchived, loadSessions, loadSession, loadLinkedProject]);

  async function createSession() {
    try {
      const res = await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          defaults: { chatModel: defaultChatModel },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const created = data.session as ChatSession;
      commitSessions([created, ...sessionsRef.current.filter((s) => s.id !== created.id)]);
      endVoiceIfSessionChanges(created.id);
      commitActive(created);
      setLinkedProject(null);
      onStatsChange?.();
      onSessionChange(created.id);
      toast.success('New chat session');
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
      await loadSessions(searchQuery);
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
      await loadSessions(searchQuery);
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
      await loadSessions(searchQuery);
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
      await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      const remaining = sessions.filter((s) => s.id !== id);
      commitSessions(remaining);
      onStatsChange?.();
      if (sessionId === id) {
        if (remaining.length > 0) {
          commitActive(remaining[0]);
          onSessionChange(remaining[0].id);
        } else {
          commitActive(null);
          await createSession();
        }
      } else if (activeSession?.id === id) {
        commitActive(null);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to close session');
    }
  }

  async function onSessionUpdated() {
    if (!sessionId) return;
    await loadSession(sessionId);
    await loadSessions();
    onStatsChange?.();
  }

  async function onProjectLinkChange(projectId: string | null) {
    if (!activeSession) return;
    try {
      const res = await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id: activeSession.id,
          patch: { projectId },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      commitActive(data.session);
      await loadLinkedProject(projectId);
      await loadSessions();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to link project');
    }
  }

  if (bootstrapping && !activeSession) {
    return (
      <div className="chat-sessions-page">
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
    <div className="chat-sessions-page">
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
        <div className="chat-session-rail">
          <div className="chat-session-rail-head">
            <span className="chat-session-rail-title">Chats</span>
            <span className="chat-session-rail-count">{sessions.length}</span>
            <button
              type="button"
              onClick={createSession}
              className="chat-session-rail-btn"
              title="New chat session"
            >
              <Plus size={14} />
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
                if (e.key === 'Enter') void loadSessions(searchQuery);
              }}
            />
          </div>
          <label className="chat-session-rail-archived">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <div className="chat-session-rail-list">
            {sessions.map((s) => {
              const active = s.id === sessionId;
              const agentName = s.chatTarget !== 'grok' && s.chatTarget !== 'all'
                ? agents.find((a) => a.id === s.chatTarget)?.name
                : null;
              const label = s.title || 'New chat';
              return (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectSession(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectSession(s.id);
                    }
                  }}
                  className={`chat-session-item ${active ? 'chat-session-item-active' : ''}`}
                  title={agentName ? `${label} · ${agentName}` : label}
                >
                  <MessageSquare size={13} className="shrink-0 opacity-50" />
                  <span className="chat-session-item-body">
                    <span className="chat-session-item-title">{label}</span>
                    {agentName && <span className="chat-session-item-meta">{agentName}</span>}
                  </span>
                  <span className="chat-session-item-actions">
                    <button
                      type="button"
                      className="chat-session-item-action"
                      onClick={(e) => void renameSession(s.id, e)}
                      title="Rename chat"
                    >
                      <Pencil size={12} />
                    </button>
                    {s.archived ? (
                      <button
                        type="button"
                        className="chat-session-item-action"
                        onClick={(e) => restoreSession(s.id, e)}
                        title="Restore session"
                      >
                        <ArchiveRestore size={12} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="chat-session-item-action"
                        onClick={(e) => archiveSession(s.id, e)}
                        title="Archive session"
                      >
                        <Archive size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="chat-session-item-action chat-session-item-action-danger"
                      onClick={(e) => closeSession(s.id, e)}
                      title="Delete session"
                    >
                      <X size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
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
            onClick={createSession}
            className="chat-session-rail-btn"
            title="New chat session"
          >
            <Plus size={15} />
          </button>
          <span className="chat-session-rail-count-collapsed" title={`${sessions.length} chat session(s)`}>{sessions.length}</span>
        </div>
      )}

      <div className="chat-sessions-main flex flex-col flex-1 min-w-0 w-full">
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
            try {
              await fetch('/api/chat-sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'update',
                  id: activeSession.id,
                  patch: { chatModel: model },
                }),
              });
              if (sessionCache.active) {
                commitActive({ ...sessionCache.active, chatModel: model });
              }
            } catch {
              /* ignore */
            }
          }}
          availableModels={availableModels}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          onRefreshModels={onRefreshModels}
          agents={agents}
        />
      )}
      </div>
      </div>
    </div>
  );
}