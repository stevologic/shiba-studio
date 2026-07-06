'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { FolderKanban, MessageSquare, Clock, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog, promptDialog } from '@/components/confirm-dialog';
import type { AppTab } from '@/lib/app-navigation';
import type { Agent } from '@/lib/types';

interface MultitaskSidebarProps {
  agents: Agent[];
  onNavigate: (tab: AppTab, extra?: { sessionId?: string; projectId?: string }) => void;
  onAgentsChanged?: () => void;
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

export default function MultitaskSidebar({ agents, onNavigate, onAgentsChanged }: MultitaskSidebarProps) {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [pRes, sRes] = await Promise.all([
        fetch('/api/projects').then((r) => r.json()),
        fetch('/api/chat-sessions').then((r) => r.json()),
      ]);
      if (pRes.ok) setProjects((pRes.projects || []).slice(0, 5).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
      if (sRes.ok) setSessions((sRes.sessions || []).slice(0, 5).map((s: { id: string; title: string }) => ({ id: s.id, title: s.title || 'Chat' })));
      setLoaded(true);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 30000);
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
    await load();
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
    await load();
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
    await load();
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
    await load();
    toast.success('Chat deleted');
  }

  async function renameAutomation(agent: Agent) {
    const name = await promptDialog({ title: 'Rename agent', defaultValue: agent.name, confirmLabel: 'Rename' });
    if (!name || name === agent.name) return;
    await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', agent: { ...agent, name } }),
    });
    onAgentsChanged?.();
    toast.success('Agent renamed');
  }

  async function deleteAutomation(agent: Agent) {
    const ok = await confirmDialog({
      title: `Remove automations for ${agent.name}?`,
      message: 'All schedules are deleted. The agent itself is kept.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', agent: { ...agent, schedules: [], schedule: undefined } }),
    });
    onAgentsChanged?.();
    toast.success('Automations removed');
  }

  const scheduled = agents.filter((a) => {
    const scheds = a.schedules?.length ? a.schedules : a.schedule ? [{ enabled: a.schedule.enabled }] : [];
    return scheds.some((s) => s.enabled);
  }).slice(0, 5);

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
        ) : sessions.map((s) => (
          <QuickItem
            key={s.id}
            label={s.title}
            onOpen={() => onNavigate('chat', { sessionId: s.id })}
            onRename={() => void renameChat(s.id, s.title)}
            onDelete={() => void deleteChat(s.id, s.title)}
            deleteTitle="Delete chat"
          />
        ))}
      </div>

      <div>
        <button type="button" onClick={() => onNavigate('automations')} className="multitask-section-head">
          <Clock size={12} /> Automations <ChevronRight size={12} className="ml-auto opacity-40" />
        </button>
        {scheduled.length === 0 ? (
          <div className="text-[10px] text-dim px-3 py-1">None scheduled</div>
        ) : scheduled.map((a) => (
          <QuickItem
            key={a.id}
            label={a.name}
            onOpen={() => onNavigate('automations')}
            onRename={() => void renameAutomation(a)}
            onDelete={() => void deleteAutomation(a)}
            deleteTitle="Remove automations"
          />
        ))}
      </div>
    </div>
  );
}
