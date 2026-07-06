'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Pencil, Plus, X, Search, Archive, ArchiveRestore } from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog, promptDialog } from '@/components/confirm-dialog';
import GrokChatPanel from '@/components/grok-chat-panel';
import type { ChatSession } from '@/lib/chat-session-types';
import type { Project } from '@/lib/project-types';
import type { Agent } from '@/lib/types';

type ModelOption = { id: string; label: string; provider?: 'cloud' | 'local' };

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
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [linkedProject, setLinkedProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const loadSessions = useCallback(async (query?: string) => {
    try {
      const params = new URLSearchParams();
      if (query?.trim()) params.set('q', query.trim());
      if (showArchived) params.set('archived', '1');
      const qs = params.toString();
      const res = await fetch(`/api/chat-sessions${qs ? `?${qs}` : ''}`);
      const data = await res.json();
      if (data.ok) setSessions(data.sessions || []);
      return data.sessions as ChatSession[] | undefined;
    } catch {
      return undefined;
    }
  }, [showArchived]);

  const loadSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat-sessions?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (data.ok && data.session) {
        setActiveSession(data.session);
        setSessions((prev) => prev.map((s) => (s.id === id ? data.session : s)));
        return data.session as ChatSession;
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
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBootstrapping(true);
      const list = await loadSessions();
      if (cancelled) return;

      let targetId = sessionId;
      if (!targetId) {
        if (list?.length) {
          targetId = list[0].id;
        } else {
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
            if (data.ok && data.session) {
              targetId = data.session.id;
              setSessions([data.session]);
              onStatsChange?.();
            }
          } catch {
            /* ignore */
          }
        }
        if (targetId) onSessionChange(targetId);
      }

      if (targetId) {
        const session = await loadSession(targetId);
        if (!cancelled && session) {
          await loadLinkedProject(session.projectId);
        }
      }
      if (!cancelled) setBootstrapping(false);
    })();
    return () => { cancelled = true; };
  }, [sessionId, defaultChatModel, loadSessions, loadSession, loadLinkedProject, onSessionChange, onStatsChange]);

  useEffect(() => {
    if (!sessionId || bootstrapping) return;
    loadSession(sessionId).then((session) => {
      if (session) loadLinkedProject(session.projectId);
    });
  }, [sessionId, bootstrapping, loadSession, loadLinkedProject]);

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
      await loadSessions();
      onStatsChange?.();
      onSessionChange(data.session.id);
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
      if (activeSession?.id === id) setActiveSession((s) => (s ? { ...s, title: name } : s));
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
      setSessions(remaining);
      onStatsChange?.();
      if (sessionId === id) {
        if (remaining.length > 0) onSessionChange(remaining[0].id);
        else await createSession();
      }
      if (activeSession?.id === id) setActiveSession(null);
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
      setActiveSession(data.session);
      await loadLinkedProject(projectId);
      await loadSessions();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to link project');
    }
  }

  if (bootstrapping && !activeSession) {
    return (
      <div className="flex items-center justify-center gap-3 h-[calc(100vh-120px)] text-dim text-sm">
        <span className="data-spinner data-spinner-lg" />
        Loading chat sessions…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] max-w-4xl mx-auto w-full">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search size={14} className="text-dim shrink-0" />
          <input
            className="grok-input text-xs flex-1"
            placeholder="Search sessions…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void loadSessions(searchQuery);
            }}
          />
          <button type="button" onClick={() => void loadSessions(searchQuery)} className="grok-btn grok-btn-secondary text-xs">
            Search
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-dim cursor-pointer">
          <input type="checkbox" checked={showArchived} onChange={(e) => { setShowArchived(e.target.checked); void loadSessions(searchQuery); }} />
          Archived
        </label>
      </div>
      <div className="chat-session-tabs flex items-center gap-1 mb-3 overflow-x-auto pb-1">
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
              onClick={() => onSessionChange(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSessionChange(s.id);
                }
              }}
              className={`chat-session-tab ${active ? 'chat-session-tab-active' : ''}`}
              title={agentName ? `${label} · ${agentName}` : label}
            >
              <MessageSquare size={12} className="shrink-0 opacity-60" />
              <span className="chat-session-tab-label">{label}</span>
              {agentName && <span className="chat-session-tab-meta">{agentName}</span>}
              <button
                type="button"
                className="chat-session-tab-close"
                onClick={(e) => void renameSession(s.id, e)}
                title="Rename chat"
              >
                <Pencil size={12} />
              </button>
              {s.archived ? (
                <button
                  type="button"
                  className="chat-session-tab-close"
                  onClick={(e) => restoreSession(s.id, e)}
                  title="Restore session"
                >
                  <ArchiveRestore size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  className="chat-session-tab-close"
                  onClick={(e) => archiveSession(s.id, e)}
                  title="Archive session"
                >
                  <Archive size={12} />
                </button>
              )}
              <button
                type="button"
                className="chat-session-tab-close"
                onClick={(e) => closeSession(s.id, e)}
                title="Delete session"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={createSession}
          className="chat-session-tab chat-session-tab-new"
          title="New chat session"
        >
          <Plus size={14} />
        </button>
      </div>

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
              setActiveSession((s) => (s ? { ...s, chatModel: model } : s));
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
  );
}