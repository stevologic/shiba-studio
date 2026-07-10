'use client';

// Shared Kanban board — a Linear-style view every agent can work from.
// Cards are assignable to agents; "Start work" dispatches a real agent run
// that posts progress into the card's activity feed and lands in In Review.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Plus, Trash2, X, Loader2, ExternalLink, CircleDashed,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import type { BoardStatus, BoardTask } from '@/lib/board-types';
import { BOARD_PRIORITY_LABELS, BOARD_STATUS_LABELS } from '@/lib/board-types';
import type { Agent } from '@/lib/types';

const COLUMNS: BoardStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];

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
  if (priority === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="kb-prio kb-prio-urgent" aria-hidden>
        <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="currentColor" />
        <path d="M7 3.4 L7 7.8 M7 10.2 L7 10.3" stroke="var(--bg)" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  const filled = priority === 2 ? 3 : priority === 3 ? 2 : priority === 4 ? 1 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="kb-prio" aria-hidden>
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
}

export default function KanbanBoard({ agents, onOpenRun }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composerCol, setComposerCol] = useState<BoardStatus | null>(null);
  const [composerTitle, setComposerTitle] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ col: BoardStatus; beforeId: string | null } | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const selected = useMemo(
    () => (selectedId ? tasks.find((t) => t.id === selectedId) || null : null),
    [selectedId, tasks],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/board');
      const data = await res.json();
      if (data.ok && Array.isArray(data.tasks)) {
        setTasks(data.tasks);
      }
    } catch { /* keep last board */ }
    setLoaded(true);
  }, []);

  // Live board: agents post progress while runs execute, so poll briskly.
  // First load also goes through the timer (0ms) — the compiler lint forbids
  // synchronous state work directly in the effect body.
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 4000);
    return () => { clearTimeout(first); clearInterval(t); };
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
    const res = await post({ action: 'startWork', id: task.id });
    if (res !== null || true) {
      // Optimistic: the server moved it to in_progress + working.
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

  return (
    <div className="kb-root">
      <div className="kb-head">
        <div>
          <div className="page-title">Board</div>
          <div className="page-subtitle">
            Shared Kanban every agent can work from — assign a card, hit <span className="kb-inline-key">▶ Start work</span>, and watch progress land in the activity feed.
          </div>
        </div>
        <button
          type="button"
          className="grok-btn grok-btn-primary text-sm inline-flex items-center gap-1.5"
          onClick={() => { setComposerCol('todo'); setComposerTitle(''); }}
        >
          <Plus size={14} /> New card
        </button>
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
                {colTasks.map((task) => {
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
                      onClick={() => setSelectedId(task.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(task.id); }}
                    >
                      <div className="kb-card-top">
                        <span className="kb-card-key">{task.key}</span>
                        {task.working && (
                          <span className="kb-working" title={`${agent?.name || 'Agent'} is working this card`}>
                            <Loader2 size={11} className="kb-spin" /> working
                          </span>
                        )}
                      </div>
                      <div className="kb-card-title">{task.title}</div>
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
                    </div>
                  );
                })}
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
          <div className="kb-panel-backdrop" onClick={() => setSelectedId(null)} aria-hidden />
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
              <button type="button" className="kb-icon-btn" title="Close" aria-label="Close panel" onClick={() => setSelectedId(null)}>
                <X size={15} />
              </button>
            </div>

            <input
              className="kb-panel-title"
              value={selected.title}
              aria-label="Card title"
              onChange={(e) => setTasks((prev) => prev.map((t) => (t.id === selected.id ? { ...t, title: e.target.value } : t)))}
              onBlur={(e) => { void patchCard(selected.id, { title: e.target.value }); }}
            />

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
                >
                  <option value="">Unassigned</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
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
                title={!selected.assigneeAgentId ? 'Assign an agent first' : 'Dispatch the assigned agent on this card'}
                onClick={() => void startWork(selected)}
              >
                {selected.working
                  ? <><Loader2 size={13} className="kb-spin" /> Agent working…</>
                  : <><Play size={13} /> Start work</>}
              </button>
              {selected.assigneeAgentId && (
                <span className="kb-workrow-hint">
                  <AgentAvatar agent={agentById.get(selected.assigneeAgentId)} size={16} />
                  {agentById.get(selected.assigneeAgentId)?.name || 'Unknown agent'} runs this card as a traced agent run.
                </span>
              )}
            </div>

            <div className="kb-prop-name kb-desc-label">Description</div>
            <textarea
              className="grok-input kb-panel-desc"
              placeholder="Write a complete brief: goal, constraints, definition of done — the agent works from exactly this."
              defaultValue={selected.description}
              key={`${selected.id}-desc`}
              rows={5}
              onBlur={(e) => { void patchCard(selected.id, { description: e.target.value }); }}
            />

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
    </div>
  );
}
