'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { FolderKanban, MessageSquare, Clock, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { confirmDialog, promptDialog } from '@/components/confirm-dialog';
import type { AppTab } from '@/lib/app-navigation';
import type { Agent } from '@/lib/types';
import { getLiveChatRun, listLiveChatSessionIds, subscribeLiveChatRuns } from '@/lib/chat-live-runs';
import { invalidateClientJson, loadClientJson } from '@/lib/client-json';

interface MultitaskSidebarProps {
  agents: Agent[];
  onNavigate: (tab: AppTab, extra?: { sessionId?: string; projectId?: string }) => void;
  onDataChanged?: () => void;
}

function QuickItem({
  label,
  onOpen,
  onRename,
  onDelete,
  deleteTitle,
}: {
  label: string;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  deleteTitle: string;
}) {
  return (
    <div className="multitask-item-row">
      <button type="button" onClick={onOpen} className="multitask-item" title={label}>
        {label}
      </button>
      <span className="multitask-item-actions">
        <button type="button" className="multitask-item-action" onClick={onRename} title="Rename">
          <Pencil size={11} />
        </button>
        <button type="button" className="multitask-item-action multitask-item-action-danger" onClick={onDelete} title={deleteTitle}>
          <Trash2 size={11} />
        </button>
      </span>
    </div>
  );
}

/** Module cache so catch-all remounts (`/chat` → `/chat/:id`) don't re-hit the APIs. */
const multitaskCache: {
  at: number;
  projects: Array<{ id: string; name: string }>;
  sessions: Array<{ id: string; title: string }>;
  inflight: Promise<void> | null;
} = { at: 0, projects: [], sessions: [], inflight: null };
const MULTITASK_TTL_MS = 15_000;

export default function MultitaskSidebar({ onNavigate, onDataChanged }: MultitaskSidebarProps) {
  const [projects, setProjects] = useState(() => multitaskCache.projects);
  const [sessions, setSessions] = useState(() => multitaskCache.sessions);
  const [loaded, setLoaded] = useState(() => multitaskCache.at > 0);
  const [liveChatIds, setLiveChatIds] = useState<string[]>(() => listLiveChatSessionIds());
  useEffect(() => subscribeLiveChatRuns(() => setLiveChatIds(listLiveChatSessionIds())), []);

  const load = useCallback(async (force = false) => {
    if (!force && multitaskCache.at && Date.now() - multitaskCache.at < MULTITASK_TTL_MS) {
      setProjects(multitaskCache.projects);
      setSessions(multitaskCache.sessions);
      setLoaded(true);
      return;
    }
    if (force) {
      invalidateClientJson('/api/projects');
      invalidateClientJson('/api/chat-sessions');
    }
    if (multitaskCache.inflight) {
      await multitaskCache.inflight;
      setProjects(multitaskCache.projects);
      setSessions(multitaskCache.sessions);
      setLoaded(true);
      return;
    }
    const run = (async () => {
      try {
        const [pRes, sRes] = await Promise.all([
          loadClientJson<any>('/api/projects', { maxAgeMs: MULTITASK_TTL_MS }),
          loadClientJson<any>('/api/chat-sessions', { maxAgeMs: MULTITASK_TTL_MS }),
        ]);
        if (pRes.ok) {
          multitaskCache.projects = (pRes.projects || []).slice(0, 5).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }));
        }
        if (sRes.ok) {
          multitaskCache.sessions = (sRes.sessions || []).slice(0, 5).map((s: { id: string; title: string }) => ({ id: s.id, title: s.title || 'Chat' }));
        }
        multitaskCache.at = Date.now();
      } catch {
        /* ignore */
      }
    })();
    multitaskCache.inflight = run;
    try {
      await run;
      setProjects(multitaskCache.projects);
      setSessions(multitaskCache.sessions);
      setLoaded(true);
    } finally {
      if (multitaskCache.inflight === run) multitaskCache.inflight = null;
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(false), 0);
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 120_000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(t);
    };
  }, [load]);

  async function renameProject(id: string, current: string) {
    const name = await promptDialog({ title: 'Rename project', defaultValue: current, confirmLabel: 'Rename' });
    if (!name || name === current) return;
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id, name }),
    });
    await load(true);
    toast.success('Project renamed');
  }

  async function deleteProject(id: string, name: string) {
    const ok = await confirmDialog({
      title: `Delete ${name}?`,
      message: 'All project files and chat history are permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    });
    await load(true);
    onDataChanged?.();
    toast.success('Project deleted');
  }

  async function renameChat(id: string, current: string) {
    const title = await promptDialog({ title: 'Rename chat', defaultValue: current, confirmLabel: 'Rename' });
    if (!title || title === current) return;
    await fetch('/api/chat-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id, patch: { title } }),
    });
    await load(true);
    toast.success('Chat renamed');
  }

  async function deleteChat(id: string, title: string) {
    const ok = await confirmDialog({
      title: `Delete "${title}"?`,
      message: 'The full message history for this chat is permanently deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await fetch('/api/chat-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    });
    await load(true);
    onDataChanged?.();
    toast.success('Chat deleted');
  }

  return (
    // Quick access owns the sidebar's leftover height and scrolls internally.
    <div className="multitask-sidebar px-2 py-3 border-t border-default flex-1 min-h-0 overflow-y-auto">
      <div className="text-[10px] uppercase tracking-wider text-dim px-2 mb-2">Quick access</div>

      <div className="mb-3">
        <button type="button" onClick={() => onNavigate('projects')} className="multitask-section-head">
          <FolderKanban size={12} /> Projects <ChevronRight size={12} className="ml-auto opacity-40" />
        </button>
        {!loaded ? (
          <div className="data-loading-row px-3 py-1"><span className="data-spinner" /> Loading…</div>
        ) : projects.length === 0 ? (
          <div className="text-[10px] text-dim px-3 py-1">No projects</div>
        ) : projects.map((p) => (
          <QuickItem
            key={p.id}
            label={p.name}
            onOpen={() => onNavigate('projects', { projectId: p.id })}
            onRename={() => void renameProject(p.id, p.name)}
            onDelete={() => void deleteProject(p.id, p.name)}
            deleteTitle="Delete project"
          />
        ))}
      </div>

      <div className="mb-3">
        <button type="button" onClick={() => onNavigate('chat')} className="multitask-section-head">
          <MessageSquare size={12} /> Chats <ChevronRight size={12} className="ml-auto opacity-40" />
        </button>
        {!loaded ? (
          <div className="data-loading-row px-3 py-1"><span className="data-spinner" /> Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="text-[10px] text-dim px-3 py-1">No sessions</div>
        ) : sessions.map((s) => {
          const running = liveChatIds.includes(s.id) || !!getLiveChatRun(s.id)?.streaming;
          return (
            <QuickItem
              key={s.id}
              label={running ? `${s.title} · working` : s.title}
              onOpen={() => onNavigate('chat', { sessionId: s.id })}
              onRename={() => void renameChat(s.id, s.title)}
              onDelete={() => void deleteChat(s.id, s.title)}
              deleteTitle="Delete chat"
            />
          );
        })}
      </div>

      <div>
        <button type="button" onClick={() => onNavigate('automations')} className="multitask-section-head">
          <Clock size={12} /> Automations <ChevronRight size={12} className="ml-auto opacity-40" />
        </button>
        <button type="button" className="text-[10px] text-dim hover:text-primary px-3 py-1 text-left w-full" onClick={() => onNavigate('automations')}>
          View and manage durable automations
        </button>
      </div>
    </div>
  );
}
