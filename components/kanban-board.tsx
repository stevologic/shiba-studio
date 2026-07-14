'use client';

// Shared Kanban board — a Linear-style view every agent can work from.
// Cards are assignable to agents; "Start work" dispatches a real agent run
// that posts progress into the card's activity feed and lands in In Review.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Plus, Trash2, X, Loader2, ExternalLink, CircleDashed, RefreshCw, Check, RotateCcw,
  FileText, Image as ImageIcon, File, Copy, PackageOpen, FolderKanban,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import BoardSyncModal from '@/components/board-sync-modal';
import { invalidateClientJson, loadClientJson } from '@/lib/client-json';
import { toast } from '@/lib/toast';
import { subscribeLiveEvents } from '@/lib/live-events';
import type { BoardStatus, BoardTask } from '@/lib/board-types';
import { BOARD_PRIORITY_LABELS, BOARD_STATUS_LABELS } from '@/lib/board-types';
import type { CardWork, WorkFile } from '@/lib/board-work';
import type { Agent } from '@/lib/types';

// Markdown pipeline is heavy — load it only when a work modal opens.
const ChatMarkdown = dynamic(() => import('@/components/chat-markdown-lazy'));

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function FileKindIcon({ kind }: { kind: WorkFile['kind'] }) {
  if (kind === 'image') return <ImageIcon size={14} className="kb-file-icon" />;
  if (kind === 'text') return <FileText size={14} className="kb-file-icon" />;
  return <File size={14} className="kb-file-icon" />;
}

const COLUMNS: BoardStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];

/** Columns render at most this many cards; beyond it, a "View all" link opens
 *  the full column as a table (dragging 200 cards in a column helps nobody). */
const COLUMN_RENDER_CAP = 25;

/** Linear-style status glyphs (SVG, colored per status). */
function StatusIcon({ status, size = 14 }: { status: BoardStatus; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 14 14', fill: 'none' as const };
  switch (status) {
    case 'backlog':
      return <CircleDashed size={size} className="kb-status-glyph kb-status-backlog" strokeWidth={2} />;
    case 'todo':
      return (
        <svg {...common} className="kb-status-glyph kb-status-todo" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      );
    case 'in_progress':
      return (
        <svg {...common} className="kb-status-glyph kb-status-progress" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7 7 L7 2.2 A4.8 4.8 0 0 1 11.8 7 Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'in_review':
      return (
        <svg {...common} className="kb-status-glyph kb-status-review" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="7" cy="7" r="2.4" fill="currentColor" />
        </svg>
      );
    case 'done':
      return (
        <svg {...common} className="kb-status-glyph kb-status-done" aria-hidden>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4.4 7.2 L6.2 9 L9.6 5.4" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'cancelled':
      return (
        <svg {...common} className="kb-status-glyph kb-status-cancelled" aria-hidden>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4.8 4.8 L9.2 9.2 M9.2 4.8 L4.8 9.2" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
  }
}

/** Linear-style priority glyphs: urgent box, then 3/2/1 signal bars. */
function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  // Hover tooltip names the level — the glyph alone is too esoteric.
  const label = BOARD_PRIORITY_LABELS[priority as keyof typeof BOARD_PRIORITY_LABELS] || 'No priority';
  const tip = label === 'No priority' ? label : `${label} priority`;
  if (priority === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="kb-prio kb-prio-urgent" role="img" aria-label={tip}>
        <title>{tip}</title>
        <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="currentColor" />
        <path d="M7 3.4 L7 7.8 M7 10.2 L7 10.3" stroke="var(--bg)" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  const filled = priority === 2 ? 3 : priority === 3 ? 2 : priority === 4 ? 1 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="kb-prio" role="img" aria-label={tip}>
      <title>{tip}</title>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 4.5}
          y={9 - i * 3.5}
          width="3"
          height={3.5 + i * 3.5}
          rx="1"
          fill="currentColor"
          opacity={i < filled ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

/** Deterministic accent for an agent avatar. */
function agentHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function AgentAvatar({ agent, size = 18 }: { agent: Agent | undefined; size?: number }) {
  if (!agent) return null;
  const hue = agentHue(agent.name);
  return (
    <span
      className="kb-avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.52,
        background: `hsl(${hue} 45% 24%)`,
        color: `hsl(${hue} 70% 78%)`,
        borderColor: `hsl(${hue} 45% 38%)`,
      }}
      title={agent.name}
    >
      {agent.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface KanbanBoardProps {
  agents: Agent[];
  /** Navigate to an Automations run trace. */
  onOpenRun?: (runId: string) => void;
  /** Fires when the open-card count changes (drives the nav badge). */
  onOpenCountChanged?: () => void;
}

export default function KanbanBoard({ agents, onOpenRun, onOpenCountChanged }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composerCol, setComposerCol] = useState<BoardStatus | null>(null);
  const [composerTitle, setComposerTitle] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ col: BoardStatus; beforeId: string | null } | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [reviewFeedback, setReviewFeedback] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [work, setWork] = useState<CardWork | null>(null);
  const [workLoading, setWorkLoading] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  /** Column opened as a full tabular list (crowded columns past the render cap). */
  const [tableView, setTableView] = useState<BoardStatus | null>(null);
  /** Projects a card can be linked to (loaded once; refreshed with the board). */
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  /** Draft title/description for the open card — an explicit Save persists them.
   *  Held locally so a live board refresh can't wipe an in-progress edit. */
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const lastOpenCountRef = useRef<number | null>(null);
  const onOpenCountChangedRef = useRef(onOpenCountChanged);

  useEffect(() => {
    onOpenCountChangedRef.current = onOpenCountChanged;
  }, [onOpenCountChanged]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const selected = useMemo(
    () => (selectedId ? tasks.find((t) => t.id === selectedId) || null : null),
    [selectedId, tasks],
  );
  /** Open = work still ahead of review: backlog + todo + in progress. */
  const openCount = useMemo(
    () => tasks.filter((t) => t.status === 'backlog' || t.status === 'todo' || t.status === 'in_progress').length,
    [tasks],
  );

  /** Select a card (or close with null) — review feedback never leaks across cards. */
  function openCard(id: string | null, focusFeedback = false) {
    setSelectedId(id);
    setReviewFeedback('');
    // Seed the title/description drafts from the card being opened.
    const card = id ? tasks.find((t) => t.id === id) : null;
    setDraftTitle(card?.title ?? '');
    setDraftDesc(card?.description ?? '');
    if (id && focusFeedback) {
      setTimeout(() => feedbackRef.current?.focus(), 60);
    }
  }

  /** True when the open card's title/description drafts differ from what's saved. */
  const detailsDirty = !!selected
    && (draftTitle.trim() !== selected.title || draftDesc !== selected.description);

  /** Explicit Save: persist title + description and update the board card. */
  async function saveCardDetails() {
    if (!selected) return;
    const title = draftTitle.trim();
    if (!title) { toast.error('Title cannot be empty'); return; }
    setSavingDetails(true);
    const task = await patchCard(selected.id, { title, description: draftDesc });
    setSavingDetails(false);
    if (task) {
      setDraftTitle(task.title);
      setDraftDesc(task.description);
      toast.success(`${task.key} saved`);
    }
  }

  const refresh = useCallback(async (ensureLatest = true) => {
    if (ensureLatest) invalidateClientJson('/api/board');
    try {
      const data = await loadClientJson<{ ok?: boolean; tasks?: BoardTask[] }>('/api/board');
      if (data.ok && Array.isArray(data.tasks)) {
        setTasks(data.tasks);
        // Nav badge shows the open count — nudge the shell only when it moves
        // (covers agent-driven changes surfacing through the poll, too).
        const open = (data.tasks as BoardTask[]).filter(
          (t) => t.status === 'backlog' || t.status === 'todo' || t.status === 'in_progress',
        ).length;
        if (lastOpenCountRef.current !== null && lastOpenCountRef.current !== open) {
          onOpenCountChangedRef.current?.();
        }
        lastOpenCountRef.current = open;
      }
    } catch { /* keep last board */ }
    setLoaded(true);
  }, []);

  // Projects (for the card → project link). Loaded once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadClientJson<{
          ok?: boolean;
          projects?: Array<{ id: string; name: string }>;
        }>('/api/projects');
        if (!cancelled && data.ok && Array.isArray(data.projects)) {
          setProjects(data.projects.map((p) => ({ id: p.id, name: p.name })));
        }
      } catch { /* project link is optional */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live board: SSE change events drive refreshes the moment anything writes
  // to the board (agent notes, moves from other tabs); the slow poll is only
  // a fallback for a dropped stream. First load goes through a 0ms timer —
  // the compiler lint forbids synchronous state work directly in the effect.
  useEffect(() => {
    const first = setTimeout(() => void refresh(false), 0);
    let burst: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeLiveEvents(['board'], () => {
      if (burst) clearTimeout(burst);
      burst = setTimeout(() => { burst = null; void refresh(); }, 250);
    });
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 120_000);
    return () => {
      clearTimeout(first);
      if (burst) clearTimeout(burst);
      unsubscribe();
      clearInterval(t);
    };
  }, [refresh]);

  useEffect(() => {
    if (composerCol) composerRef.current?.focus();
  }, [composerCol]);

  async function post(body: Record<string, unknown>): Promise<BoardTask | null> {
    try {
      const res = await fetch('/api/board', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        toast.error(data.error || 'Board action failed');
        return null;
      }
      return data.task ?? null;
    } catch {
      toast.error('Board action failed');
      return null;
    }
  }

  async function createCard(status: BoardStatus) {
    const title = composerTitle.trim();
    if (!title) { setComposerCol(null); return; }
    setComposerTitle('');
    const task = await post({ action: 'create', title, status });
    if (task) {
      setTasks((prev) => [...prev, task]);
      composerRef.current?.focus();
    }
  }

  async function patchCard(id: string, patch: Record<string, unknown>) {
    const task = await post({ action: 'update', id, ...patch });
    if (task) setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
    return task;
  }

  async function removeCard(id: string) {
    const ok = await post({ action: 'delete', id });
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (selectedId === id) setSelectedId(null);
    return ok;
  }

  async function startWork(task: BoardTask) {
    const accepted = await post({ action: 'startWork', id: task.id });
    if (accepted) {
      setTasks((prev) => prev.map((candidate) => candidate.id === task.id ? accepted : candidate));
    }
  }

  /** Review approved: push the card to Done. */
  async function validateCard(task: BoardTask) {
    setReviewBusy(true);
    const updated = await post({ action: 'validate', id: task.id });
    setReviewBusy(false);
    if (updated) {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
      toast.success(`${task.key} validated — moved to Done`);
    }
  }

  /** Open the delivered-work modal: answer + files the runs created. */
  async function viewWork(task: BoardTask) {
    setWorkOpen(true);
    setWorkLoading(true);
    setWork(null);
    try {
      const res = await fetch(`/api/board/work?id=${encodeURIComponent(task.id)}`);
      const data = await res.json();
      if (data.ok) setWork(data.work);
      else toast.error(data.error || 'Could not load the delivered work');
    } catch {
      toast.error('Could not load the delivered work');
    }
    setWorkLoading(false);
  }

  function deliverableHref(file: WorkFile): string {
    if (!work) return '#';
    return `/api/board/work?id=${encodeURIComponent(work.id)}&file=${encodeURIComponent(file.absPath)}`;
  }

  // In-app file reader: clicking a deliverable opens its text in a modal
  // instead of navigating away; binary files get a verdict, not garbage.
  const [fileView, setFileView] = useState<{
    relPath: string;
    href: string;
    loading: boolean;
    size?: number;
    binary?: boolean;
    truncated?: boolean;
    content?: string;
    error?: string;
  } | null>(null);

  async function openFileView(file: WorkFile) {
    const href = deliverableHref(file);
    setFileView({ relPath: file.relPath, href, loading: true });
    try {
      const res = await fetch(`${href}&inspect=1`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Could not read the file');
      setFileView({
        relPath: file.relPath,
        href,
        loading: false,
        size: data.size,
        binary: data.binary,
        truncated: data.truncated,
        content: data.content,
      });
    } catch (e: unknown) {
      setFileView({
        relPath: file.relPath,
        href,
        loading: false,
        error: e instanceof Error ? e.message : 'Could not read the file',
      });
    }
  }

  async function copyPath(p: string) {
    try {
      await navigator.clipboard.writeText(p);
      toast.success('Path copied');
    } catch {
      toast.error('Could not copy the path');
    }
  }

  /** A link in the answer that points to one of this card's deliverables opens
   *  the in-app file viewer instead of navigating away. External links (http…)
   *  are left alone. */
  function openAnswerFileLink(e: React.MouseEvent) {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = (anchor.getAttribute('href') || '').trim();
    if (!href || /^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith('#')) return;
    const norm = href.replace(/^\.?\//, '').toLowerCase();
    const file = work?.files.find((f) =>
      f.exists && (
        f.relPath.toLowerCase() === norm ||
        f.relPath.toLowerCase().endsWith(`/${norm}`) ||
        norm.endsWith(f.relPath.toLowerCase()) ||
        f.name.toLowerCase() === norm
      ),
    );
    if (file) {
      e.preventDefault();
      void openFileView(file);
    }
  }

  /** Review needs changes: send feedback back and re-dispatch the agent. */
  async function refineCard(task: BoardTask) {
    const feedback = reviewFeedback.trim();
    if (!feedback) {
      feedbackRef.current?.focus();
      return;
    }
    setReviewBusy(true);
    let ok = false;
    try {
      const res = await fetch('/api/board', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refine', id: task.id, feedback }),
      });
      const data = await res.json();
      ok = !!data.ok;
      if (!ok) toast.error(data.error || 'Could not send the card back');
    } catch {
      toast.error('Could not send the card back');
    }
    setReviewBusy(false);
    if (ok) {
      // Keep the typed feedback if the request failed; clear it on success.
      setReviewFeedback('');
      toast.success(`${task.key} sent back — ${agentById.get(task.assigneeAgentId || '')?.name || 'the agent'} is refining`);
      await refresh();
    }
  }

  // ---- Drag & drop (native HTML5) ----
  function handleDrop(col: BoardStatus) {
    const id = dragId;
    const hint = dropHint;
    setDragId(null);
    setDropHint(null);
    if (!id) return;
    const beforeId = hint && hint.col === col ? hint.beforeId : null;
    // beforeId = card the dragged one is dropped ABOVE (i.e. dragged sits before it).
    const colTasks = tasks.filter((t) => t.status === col && t.id !== id).sort((a, b) => a.order - b.order);
    const beforeIdx = beforeId ? colTasks.findIndex((t) => t.id === beforeId) : -1;
    const afterTask = beforeId ? colTasks[beforeIdx] : undefined; // dragged goes above this
    const beforeTask = beforeId
      ? (beforeIdx > 0 ? colTasks[beforeIdx - 1] : undefined)
      : colTasks[colTasks.length - 1];
    // Optimistic local move.
    setTasks((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      const newOrder = beforeTask && afterTask
        ? (beforeTask.order + afterTask.order) / 2
        : afterTask
          ? afterTask.order - 100
          : beforeTask
            ? beforeTask.order + 100
            : 100;
      return { ...t, status: col, order: newOrder };
    }));
    void post({
      action: 'move',
      id,
      status: col,
      beforeId: beforeTask?.id ?? null,
      afterId: afterTask?.id ?? null,
    });
  }

  const byColumn = useMemo(() => {
    const map = new Map<BoardStatus, BoardTask[]>();
    for (const col of COLUMNS) {
      map.set(col, tasks.filter((t) => t.status === col).sort((a, b) => a.order - b.order));
    }
    return map;
  }, [tasks]);

  const doneish = (c: BoardStatus) => c === 'done' || c === 'cancelled';
  /** Cards of the column currently opened as a table. */
  const tableTasks = tableView ? (byColumn.get(tableView) ?? []) : [];

  return (
    <div className="kb-root">
      <div className="kb-head">
        <div>
          <div className="page-title kb-title-row">
            Board
            <span
              className="kb-open-pill"
              title="Open cards — Backlog, Todo, and In Progress combined"
            >
              {openCount} open
            </span>
          </div>
          <div className="page-subtitle">
            Assign a card and start it manually, or let an opted-in agent accept it automatically. Successful work lands in Review for you to validate or send back with feedback. <Link href="/agents" className="kb-subtitle-link">Configure agents</Link>
          </div>
        </div>
        <div className="kb-head-actions">
          <button
            type="button"
            className="grok-btn grok-btn-secondary text-sm inline-flex items-center gap-1.5"
            onClick={() => setSyncOpen(true)}
          >
            <RefreshCw size={14} /> Sync
          </button>
          <button
            type="button"
            className="grok-btn grok-btn-primary text-sm inline-flex items-center gap-1.5"
            onClick={() => { setComposerCol('todo'); setComposerTitle(''); }}
          >
            <Plus size={14} /> New card
          </button>
        </div>
      </div>

      <div className="kb-columns" role="list" aria-label="Kanban board columns">
        {COLUMNS.map((col) => {
          const colTasks = byColumn.get(col) || [];
          return (
            <div
              key={col}
              role="listitem"
              className={`kb-col ${doneish(col) ? 'kb-col-terminal' : ''} ${dropHint?.col === col ? 'kb-col-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (dropHint?.col !== col || dropHint?.beforeId !== null) {
                  if (!(e.target as HTMLElement).closest('.kb-card')) setDropHint({ col, beforeId: null });
                }
              }}
              onDragLeave={(e) => {
                if (!(e.relatedTarget as HTMLElement | null)?.closest?.('.kb-col')) setDropHint(null);
              }}
              onDrop={(e) => { e.preventDefault(); handleDrop(col); }}
            >
              <div className="kb-col-head">
                <StatusIcon status={col} />
                <span className="kb-col-name">{BOARD_STATUS_LABELS[col]}</span>
                <span className="kb-col-count">{colTasks.length}</span>
                <button
                  type="button"
                  className="kb-col-add"
                  title={`Add card to ${BOARD_STATUS_LABELS[col]}`}
                  aria-label={`Add card to ${BOARD_STATUS_LABELS[col]}`}
                  onClick={() => { setComposerCol(col); setComposerTitle(''); }}
                >
                  <Plus size={13} />
                </button>
              </div>

              <div className="kb-col-cards">
                {composerCol === col && (
                  <div className="kb-card kb-composer">
                    <input
                      ref={composerRef}
                      className="kb-composer-input"
                      placeholder="Card title — Enter to add"
                      value={composerTitle}
                      onChange={(e) => setComposerTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createCard(col);
                        if (e.key === 'Escape') { setComposerCol(null); setComposerTitle(''); }
                      }}
                      onBlur={() => { if (!composerTitle.trim()) setComposerCol(null); }}
                    />
                  </div>
                )}
                {colTasks.slice(0, COLUMN_RENDER_CAP).map((task) => {
                  const agent = task.assigneeAgentId ? agentById.get(task.assigneeAgentId) : undefined;
                  return (
                    <div
                      key={task.id}
                      className={`kb-card ${dragId === task.id ? 'kb-card-dragging' : ''} ${dropHint?.col === col && dropHint?.beforeId === task.id ? 'kb-card-drop-above' : ''}`}
                      draggable
                      onDragStart={(e) => { setDragId(task.id); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragEnd={() => { setDragId(null); setDropHint(null); }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDropHint({ col, beforeId: task.id });
                      }}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(col); }}
                      onClick={() => openCard(task.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') openCard(task.id); }}
                    >
                      <div className="kb-card-top">
                        <span className="kb-card-key">{task.key}</span>
                        {task.externalRefs?.map((ref) => (
                          <span
                            key={`${ref.provider}-${ref.containerId}-${ref.remoteId}`}
                            className={`kb-external-badge kb-external-${ref.provider}`}
                            title={`Synced with ${ref.provider === 'linear' ? 'Linear' : 'Jira'} ${ref.remoteKey}`}
                          >
                            {ref.provider === 'linear' ? 'L' : 'J'} · {ref.remoteKey}
                          </span>
                        ))}
                        {task.working && (
                          <span className="kb-working" title={`${agent?.name || 'Agent'} is working this card`}>
                            <Loader2 size={11} className="kb-spin" /> working
                          </span>
                        )}
                      </div>
                      <div className="kb-card-title">{task.title}</div>
                      {task.projectId && (
                        <div className="kb-card-project" title="Linked project">
                          <FolderKanban size={11} />
                          {projectById.get(task.projectId)?.name || 'Project'}
                        </div>
                      )}
                      {(task.labels.length > 0 || agent || task.priority > 0) && (
                        <div className="kb-card-meta">
                          <PriorityIcon priority={task.priority} />
                          {task.labels.map((l) => (
                            <span key={l} className="kb-label" style={{ ['--label-hue' as never]: agentHue(l) }}>{l}</span>
                          ))}
                          <span className="kb-card-spacer" />
                          <AgentAvatar agent={agent} />
                        </div>
                      )}
                      {task.status === 'in_review' && !task.working && (
                        <div className="kb-card-review-row kb-review-row-3">
                          {task.runIds.length > 0 && (
                            <button
                              type="button"
                              className="kb-review-btn"
                              title="See the answer, output, and files delivered so far"
                              onClick={(e) => { e.stopPropagation(); void viewWork(task); }}
                            >
                              <PackageOpen size={12} /> View work
                            </button>
                          )}
                          <button
                            type="button"
                            className="kb-review-btn kb-review-approve"
                            title="Validate — approve the work and move to Done"
                            disabled={reviewBusy}
                            onClick={(e) => { e.stopPropagation(); void validateCard(task); }}
                          >
                            <Check size={12} /> Validate
                          </button>
                          <button
                            type="button"
                            className="kb-review-btn"
                            title="Needs changes — open the card and write feedback for the agent"
                            onClick={(e) => { e.stopPropagation(); openCard(task.id, true); }}
                          >
                            <RotateCcw size={11} /> Refine
                          </button>
                        </div>
                      )}
                      {task.status === 'done' && task.runIds.length > 0 && (
                        <div className="kb-card-review-row">
                          <button
                            type="button"
                            className="kb-review-btn"
                            title="See the answer, output, and files this card delivered"
                            onClick={(e) => { e.stopPropagation(); void viewWork(task); }}
                          >
                            <PackageOpen size={12} /> View work
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {colTasks.length > COLUMN_RENDER_CAP && (
                  <button
                    type="button"
                    className="kb-col-more"
                    title={`This column has ${colTasks.length} cards — open the full list as a table`}
                    onClick={() => setTableView(col)}
                  >
                    View all {colTasks.length} cards
                  </button>
                )}
                {colTasks.length === 0 && composerCol !== col && (
                  <div className="kb-col-empty">{loaded ? 'No cards' : '…'}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <>
          <div className="kb-panel-backdrop" onClick={() => openCard(null)} aria-hidden />
          <aside className="kb-panel" role="dialog" aria-label={`Card ${selected.key}`}>
            <div className="kb-panel-head">
              <span className="kb-card-key">{selected.key}</span>
              <span className="kb-panel-status">
                <StatusIcon status={selected.status} />
                {BOARD_STATUS_LABELS[selected.status]}
              </span>
              <span className="kb-card-spacer" />
              <button
                type="button"
                className="kb-icon-btn kb-icon-danger"
                title="Delete card"
                aria-label="Delete card"
                onClick={() => { if (window.confirm(`Delete ${selected.key}?`)) void removeCard(selected.id); }}
              >
                <Trash2 size={14} />
              </button>
              <button type="button" className="kb-icon-btn" title="Close" aria-label="Close panel" onClick={() => openCard(null)}>
                <X size={15} />
              </button>
            </div>

            <input
              className="kb-panel-title"
              value={draftTitle}
              aria-label="Card title"
              placeholder="Card title"
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveCardDetails(); } }}
            />

            {!!selected.externalRefs?.length && (
              <div className="kb-external-links" aria-label="External issue links">
                {selected.externalRefs.map((ref) => (
                  <a
                    key={`${ref.provider}-${ref.containerId}-${ref.remoteId}`}
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`kb-external-link kb-external-${ref.provider}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/integrations/${ref.provider}.svg`} width={14} height={14} alt="" />
                    {ref.provider === 'linear' ? 'Linear' : 'Jira'} {ref.remoteKey}
                    <ExternalLink size={11} />
                  </a>
                ))}
              </div>
            )}

            <div className="kb-panel-props">
              <label className="kb-prop">
                <span className="kb-prop-name">Status</span>
                <select
                  className="grok-select kb-prop-input"
                  value={selected.status}
                  onChange={(e) => void patchCard(selected.id, { status: e.target.value })}
                >
                  {COLUMNS.map((c) => <option key={c} value={c}>{BOARD_STATUS_LABELS[c]}</option>)}
                </select>
              </label>
              <label className="kb-prop">
                <span className="kb-prop-name">Priority</span>
                <select
                  className="grok-select kb-prop-input"
                  value={String(selected.priority)}
                  onChange={(e) => void patchCard(selected.id, { priority: Number(e.target.value) })}
                >
                  {[0, 1, 2, 3, 4].map((p) => (
                    <option key={p} value={String(p)}>{BOARD_PRIORITY_LABELS[p as 0 | 1 | 2 | 3 | 4]}</option>
                  ))}
                </select>
              </label>
              <label className="kb-prop">
                <span className="kb-prop-name">Assignee</span>
                <select
                  className="grok-select kb-prop-input"
                  value={selected.assigneeAgentId || ''}
                  onChange={(e) => void patchCard(selected.id, { assigneeAgentId: e.target.value || null })}
                  disabled={!!selected.working}
                  title={selected.working ? 'Cancel active work before changing the assignee' : 'Assign this card to an agent'}
                >
                  <option value="">Unassigned</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}{a.autoAcceptBoardAssignments ? ' · auto-start' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="kb-prop">
                <span className="kb-prop-name">Project</span>
                <select
                  className="grok-select kb-prop-input"
                  value={selected.projectId || ''}
                  onChange={(e) => void patchCard(selected.id, { projectId: e.target.value || null })}
                  title="Link this card to a project — the assigned agent then runs in the project's workspace with its context"
                >
                  <option value="">No project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  {selected.projectId && !projects.some((p) => p.id === selected.projectId) && (
                    <option value={selected.projectId}>(project removed)</option>
                  )}
                </select>
              </label>
              <label className="kb-prop">
                <span className="kb-prop-name">Labels</span>
                <input
                  className="grok-input kb-prop-input"
                  placeholder="comma, separated"
                  defaultValue={selected.labels.join(', ')}
                  key={`${selected.id}-labels`}
                  onBlur={(e) => {
                    const labels = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                    void patchCard(selected.id, { labels });
                  }}
                />
              </label>
            </div>

            <div className="kb-panel-workrow">
              <button
                type="button"
                className="grok-btn grok-btn-primary text-sm inline-flex items-center gap-1.5"
                disabled={!selected.assigneeAgentId || !!selected.working}
                title={!selected.assigneeAgentId ? 'Assign an agent first' : 'Start the assigned agent on this card'}
                onClick={() => void startWork(selected)}
              >
                {selected.working
                  ? <><Loader2 size={13} className="kb-spin" /> Agent working…</>
                  : <><Play size={13} /> Start work</>}
              </button>
              {selected.assigneeAgentId && (
                <span className="kb-workrow-hint">
                  <AgentAvatar agent={agentById.get(selected.assigneeAgentId)} size={16} />
                  {agentById.get(selected.assigneeAgentId)?.autoAcceptBoardAssignments
                    ? `${agentById.get(selected.assigneeAgentId)?.name || 'This agent'} automatically accepts newly assigned cards.`
                    : `${agentById.get(selected.assigneeAgentId)?.name || 'Unknown agent'} runs this card as a traced agent run.`}
                </span>
              )}
            </div>

            {selected.status === 'done' && selected.runIds.length > 0 && (
              <button
                type="button"
                className="grok-btn grok-btn-secondary text-sm inline-flex items-center gap-1.5 self-start"
                title="See the answer, output, and files this card delivered"
                onClick={() => void viewWork(selected)}
              >
                <PackageOpen size={13} /> View work
              </button>
            )}

            {selected.status === 'in_review' && !selected.working && (
              <div className="kb-review">
                <div className="kb-review-head">
                  <StatusIcon status="in_review" />
                  Ready for your review
                </div>
                <p className="kb-review-hint">
                  The work is done — check the latest activity below. Validate to move it to Done, or describe what to change and send it back.
                </p>
                <div className="kb-review-actions">
                  <button
                    type="button"
                    className="grok-btn grok-btn-primary text-sm inline-flex items-center gap-1.5 kb-review-validate"
                    disabled={reviewBusy}
                    onClick={() => void validateCard(selected)}
                  >
                    <Check size={14} /> Validate — move to Done
                  </button>
                  {selected.runIds.length > 0 && (
                    <button
                      type="button"
                      className="grok-btn grok-btn-secondary text-sm inline-flex items-center gap-1.5"
                      title="See the answer, output, and files delivered so far"
                      onClick={() => void viewWork(selected)}
                    >
                      <PackageOpen size={13} /> View work
                    </button>
                  )}
                </div>
                <textarea
                  ref={feedbackRef}
                  className="grok-input kb-review-feedback"
                  placeholder="What needs to change? Be specific — the agent gets exactly this, alongside its previous work."
                  value={reviewFeedback}
                  rows={3}
                  onChange={(e) => setReviewFeedback(e.target.value)}
                />
                <button
                  type="button"
                  className="grok-btn grok-btn-secondary text-sm inline-flex items-center gap-1.5"
                  disabled={reviewBusy || !reviewFeedback.trim() || !selected.assigneeAgentId}
                  title={!selected.assigneeAgentId
                    ? 'Assign an agent first — refinement restarts the assignee'
                    : 'Send the card back: the agent reruns with your feedback'}
                  onClick={() => void refineCard(selected)}
                >
                  {reviewBusy
                    ? <><Loader2 size={13} className="kb-spin" /> Working…</>
                    : <><RotateCcw size={13} /> Send back for refinement</>}
                </button>
              </div>
            )}

            <div className="kb-prop-name kb-desc-label">Description</div>
            <textarea
              className="grok-input kb-panel-desc"
              placeholder="Write a complete brief: goal, constraints, definition of done — the agent works from exactly this."
              value={draftDesc}
              rows={8}
              onChange={(e) => setDraftDesc(e.target.value)}
            />
            <div className="kb-details-save-row">
              <button
                type="button"
                className="grok-btn grok-btn-primary text-sm"
                disabled={!detailsDirty || savingDetails}
                onClick={() => void saveCardDetails()}
                title={detailsDirty ? 'Save title & description changes' : 'No unsaved changes'}
              >
                {savingDetails
                  ? <><Loader2 size={13} className="kb-spin" /> Saving…</>
                  : detailsDirty ? <><Check size={13} /> Save changes</> : <><Check size={13} /> Saved</>}
              </button>
              {detailsDirty && <span className="kb-details-dirty">Unsaved changes</span>}
            </div>

            <div className="kb-prop-name kb-desc-label">Activity</div>
            <div className="kb-activity">
              {[...selected.activity].reverse().map((a, i) => (
                <div key={`${a.ts}-${i}`} className={`kb-activity-item kb-activity-${a.kind}`}>
                  <div className="kb-activity-meta">
                    <span className="kb-activity-who">
                      {a.kind === 'agent' ? (a.agentName || 'Agent') : a.kind === 'user' ? 'You' : 'System'}
                    </span>
                    <span className="kb-activity-ts" title={a.ts}>{timeAgo(a.ts)}</span>
                    {a.runId && (
                      <button
                        type="button"
                        className="kb-run-link"
                        title="Open the run trace"
                        onClick={() => onOpenRun?.(a.runId as string)}
                      >
                        <ExternalLink size={11} /> trace
                      </button>
                    )}
                  </div>
                  <div className="kb-activity-text">{a.text}</div>
                </div>
              ))}
              {selected.activity.length === 0 && <div className="kb-col-empty">No activity yet</div>}
            </div>
          </aside>
        </>
      )}
      <BoardSyncModal
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        onSynced={() => void refresh()}
      />

      {tableView && (
        <div className="kb-work-overlay" onClick={() => setTableView(null)} role="presentation">
          <div
            className="kb-work-modal kb-table-modal"
            role="dialog"
            aria-label={`All ${BOARD_STATUS_LABELS[tableView]} cards`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="kb-work-head">
              <StatusIcon status={tableView} />
              <div className="kb-work-title min-w-0">
                <span className="kb-work-title-text">{BOARD_STATUS_LABELS[tableView]} — all {tableTasks.length} cards</span>
              </div>
              <button type="button" className="kb-icon-btn" title="Close" aria-label="Close" onClick={() => setTableView(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="kb-work-body kb-table-body">
              <table className="kb-cards-table data-table w-full">
                <thead>
                  <tr>
                    <th className="kbt-col-key">Key</th>
                    <th>Title</th>
                    <th className="kbt-col-prio">Priority</th>
                    <th className="kbt-col-labels">Labels</th>
                    <th className="kbt-col-assignee">Assignee</th>
                    <th className="kbt-col-updated">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {tableTasks.map((task) => {
                    const agent = task.assigneeAgentId ? agentById.get(task.assigneeAgentId) : undefined;
                    return (
                      <tr
                        key={task.id}
                        className="kbt-row"
                        title="Open this card"
                        onClick={() => { setTableView(null); openCard(task.id); }}
                      >
                        <td className="kbt-col-key"><span className="kb-card-key">{task.key}</span></td>
                        <td><span className="kbt-title">{task.title}</span></td>
                        <td className="kbt-col-prio">
                          <span className="kbt-prio-cell">
                            <PriorityIcon priority={task.priority} />
                            <span className="kbt-dim">{BOARD_PRIORITY_LABELS[task.priority]}</span>
                          </span>
                        </td>
                        <td className="kbt-col-labels">
                          <span className="kbt-labels">
                            {task.labels.map((l) => (
                              <span key={l} className="kb-label" style={{ ['--label-hue' as never]: agentHue(l) }}>{l}</span>
                            ))}
                          </span>
                        </td>
                        <td className="kbt-col-assignee">
                          <span className="kbt-assignee">
                            <AgentAvatar agent={agent} size={16} />
                            <span className="kbt-dim">{agent?.name || '—'}</span>
                          </span>
                        </td>
                        <td className="kbt-col-updated"><span className="kbt-dim kbt-mono" title={task.updatedAt}>{timeAgo(task.updatedAt)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {workOpen && (
        <div className="kb-work-overlay" onClick={() => setWorkOpen(false)} role="presentation">
          <div
            className="kb-work-modal"
            role="dialog"
            aria-label={work ? `Delivered work for ${work.key}` : 'Delivered work'}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="kb-work-head">
              <PackageOpen size={16} className="opacity-70" />
              <div className="kb-work-title min-w-0">
                {work ? (
                  <>
                    <span className="kb-card-key">{work.key}</span>
                    <span className="kb-work-title-text">{work.title}</span>
                  </>
                ) : 'Delivered work'}
              </div>
              <button type="button" className="kb-icon-btn" title="Close" aria-label="Close" onClick={() => setWorkOpen(false)}>
                <X size={15} />
              </button>
            </div>

            <div className="kb-work-body">
              {workLoading && (
                <div className="kb-col-empty"><Loader2 size={14} className="kb-spin" /> Loading the delivered work…</div>
              )}

              {!workLoading && work && work.runs.length === 0 && (
                <div className="kb-col-empty">No agent runs are linked to this card yet.</div>
              )}

              {!workLoading && work && work.runs.map((run, i) => (
                <section key={run.runId} className="kb-work-run">
                  <div className="kb-work-run-head">
                    <span className="kb-work-run-label">
                      {i === 0 ? 'Answer' : 'Earlier pass'} — {run.agentName}
                    </span>
                    {run.completedAt && (
                      <span className="kb-activity-ts" title={run.completedAt}>{timeAgo(run.completedAt)}</span>
                    )}
                    <button
                      type="button"
                      className="kb-run-link"
                      title="Open the full execution trace"
                      onClick={() => onOpenRun?.(run.runId)}
                    >
                      <ExternalLink size={11} /> trace
                    </button>
                  </div>
                  <div className="kb-work-answer" onClick={openAnswerFileLink}>
                    <ChatMarkdown content={run.finalOutput || '_(no output recorded)_'} />
                  </div>
                </section>
              ))}

              {!workLoading && work && (
                <section className="kb-work-files">
                  <div className="kb-work-run-label">
                    Files created {work.files.length > 0 ? `(${work.files.length})` : ''}
                  </div>
                  {work.files.length === 0 && (
                    <div className="kb-work-nofiles">No files were written by this card&apos;s runs.</div>
                  )}
                  {work.files.map((f) => (
                    <div key={f.absPath} className={`kb-file-row kb-file-row-stacked ${f.exists ? '' : 'kb-file-missing'}`}>
                      <div className="kb-file-main">
                        <FileKindIcon kind={f.kind} />
                        {f.exists ? (
                          <button
                            type="button"
                            className="kb-file-link kb-file-link-btn"
                            title={`Read ${f.absPath}`}
                            onClick={() => void openFileView(f)}
                          >
                            {f.relPath}
                          </button>
                        ) : (
                          <span className="kb-file-link kb-file-gone" title={`${f.absPath} (deleted or moved)`}>
                            {f.relPath}
                          </span>
                        )}
                        <span className="kb-file-meta">
                          {f.exists ? formatBytes(f.size) : 'missing'}
                        </span>
                        <button
                          type="button"
                          className="kb-icon-btn"
                          title={`Copy full path\n${f.absPath}`}
                          aria-label={`Copy path of ${f.name}`}
                          onClick={() => void copyPath(f.absPath)}
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                      {f.preview && (
                        <div className="kb-file-preview" title="Opening line of this document">{f.preview}</div>
                      )}
                    </div>
                  ))}
                </section>
              )}
            </div>
          </div>
        </div>
      )}

      {fileView && (
        <div className="kb-work-overlay kb-file-view-overlay" onClick={() => setFileView(null)} role="presentation">
          <div
            className="kb-work-modal kb-file-view-modal"
            role="dialog"
            aria-label={`File ${fileView.relPath}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="kb-work-head">
              <FileText size={15} className="opacity-70 shrink-0" />
              <div className="kb-work-title min-w-0">
                <span className="kb-work-title-text kb-file-view-name" title={fileView.relPath}>{fileView.relPath}</span>
                {fileView.size != null && <span className="kb-file-meta">{formatBytes(fileView.size)}</span>}
              </div>
              <a
                className="kb-icon-btn"
                href={fileView.href}
                target="_blank"
                rel="noopener noreferrer"
                title="Open raw / download"
                aria-label="Open raw file"
              >
                <ExternalLink size={13} />
              </a>
              <button type="button" className="kb-icon-btn" title="Close" aria-label="Close" onClick={() => setFileView(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="kb-work-body kb-file-view-body">
              {fileView.loading && (
                <div className="kb-col-empty"><Loader2 size={14} className="kb-spin" /> Reading the file…</div>
              )}
              {!fileView.loading && fileView.error && (
                <div className="kb-col-empty">{fileView.error}</div>
              )}
              {!fileView.loading && !fileView.error && fileView.binary && (
                <div className="kb-col-empty">
                  This is a binary file — no text preview. Use the raw link above to download it.
                </div>
              )}
              {!fileView.loading && !fileView.error && !fileView.binary && (
                <>
                  {(() => {
                    // Markdown deliverables render as markdown; any other text
                    // renders as a highlighted code fence keyed to its extension
                    // (4 backticks so any ``` inside the file survive intact).
                    const ext = fileView.relPath.includes('.') ? fileView.relPath.split('.').pop()!.toLowerCase() : '';
                    const body = fileView.content || '';
                    const rendered = ext === 'md' || ext === 'markdown'
                      ? body
                      : `\`\`\`\`${ext}\n${body}\n\`\`\`\``;
                    return <ChatMarkdown content={rendered} className="kb-file-view-md" />;
                  })()}
                  {fileView.truncated && (
                    <div className="kb-file-view-note">Preview truncated at 512 KB — the raw link has the full file.</div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
