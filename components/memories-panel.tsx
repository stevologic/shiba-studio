'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Archive,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Edit2,
  Lightbulb,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import InfoHint from '@/components/info-hint';
import { confirmDialog } from '@/components/confirm-dialog';
import { toast } from '@/lib/toast';
import type { AgentMemoryEntry, MemoryKind, MemorySource, MemoryStatus } from '@/lib/agent-memory';

type ScopeOption = { id: string; label: string; kind: 'chat' | 'agent' };
type Stats = { total: number; active: number; pending: number; learned: number; pinned: number };

const EMPTY_STATS: Stats = { total: 0, active: 0, pending: 0, learned: 0, pinned: 0 };
const PAGE_SIZE = 100;
const KINDS: Array<{ id: MemoryKind; label: string }> = [
  { id: 'fact', label: 'Fact' },
  { id: 'preference', label: 'Preference' },
  { id: 'decision', label: 'Decision' },
  { id: 'procedure', label: 'Procedure' },
  { id: 'lesson', label: 'Lesson' },
];

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function sourceLabel(source: MemorySource): string {
  if (source === 'learned') return 'Learned automatically';
  if (source === 'tool') return 'Saved by agent';
  return 'Saved manually';
}

export default function MemoriesPanel({ onDataChanged }: { onDataChanged?: () => void } = {}) {
  const searchParams = useSearchParams();
  const [entries, setEntries] = useState<AgentMemoryEntry[]>([]);
  const [scopes, setScopes] = useState<ScopeOption[]>([]);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [matchingTotal, setMatchingTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState(() => searchParams.get('q') || '');
  const [scope, setScope] = useState('');
  const [status, setStatus] = useState<MemoryStatus | 'all'>('all');
  const [source, setSource] = useState<MemorySource | 'all'>('all');
  const [editing, setEditing] = useState<AgentMemoryEntry | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  /** Rows opened to full text + metadata (long memories stay 2-line clamped otherwise). */
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ agentId: '__chat__', key: '', content: '', kind: 'fact' as MemoryKind, pinned: false });
  const memoryModalRef = useRef<HTMLDivElement>(null);
  const memoryReturnFocusRef = useRef<HTMLElement | null>(null);
  const memoryModalOpen = showCreate || !!editing;
  const filterKey = `${query}\u0000${scope}\u0000${status}\u0000${source}`;
  const latestFilterKey = useRef(filterKey);

  useEffect(() => {
    latestFilterKey.current = filterKey;
  }, [filterKey]);

  useEffect(() => {
    if (!memoryModalOpen) return;
    memoryReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) {
        event.preventDefault();
        setShowCreate(false);
        setEditing(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = memoryModalRef.current?.querySelectorAll<HTMLElement>('input, textarea, select, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      memoryReturnFocusRef.current?.focus();
    };
  }, [memoryModalOpen, saving]);

  const load = useCallback(async (signal?: AbortSignal, offset = 0, append = false) => {
    const requestFilterKey = `${query}\u0000${scope}\u0000${status}\u0000${source}`;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (query.trim()) params.set('q', query.trim());
      if (scope) params.set('agentId', scope);
      if (status !== 'all') params.set('status', status);
      if (source !== 'all') params.set('source', source);
      const response = await fetch(`/api/memories?${params}`, { signal });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not load memories');
      if (requestFilterKey !== latestFilterKey.current) return;
      const page = Array.isArray(data.entries) ? data.entries as AgentMemoryEntry[] : [];
      setEntries((current) => {
        if (!append) return page;
        const seen = new Set(current.map((entry) => entry.id));
        return [...current, ...page.filter((entry) => !seen.has(entry.id))];
      });
      setMatchingTotal(Number(data.total) || 0);
      setNextOffset(offset + page.length);
      setScopes(data.scopes || []);
      setStats(data.stats || EMPTY_STATS);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      toast.error(error instanceof Error ? error.message : 'Could not load memories');
    } finally {
      if (!signal?.aborted) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  }, [query, scope, source, status]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void load(controller.signal); }, query ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, query]);

  const scopeNames = useMemo(() => new Map(scopes.map((item) => [item.id, item.label])), [scopes]);
  const hasMore = nextOffset < matchingTotal;

  function toggleExpanded(id: number) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function mutate(body: Record<string, unknown>, success: string): Promise<boolean> {
    setSaving(true);
    try {
      const response = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Memory action failed');
      toast.success(success);
      await load();
      onDataChanged?.();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Memory action failed');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function createMemory() {
    const ok = await mutate({ action: 'create', ...form }, 'Memory saved');
    if (ok) {
      setShowCreate(false);
      setForm((current) => ({ ...current, key: '', content: '', kind: 'fact', pinned: false }));
    }
  }

  async function saveEdit() {
    if (!editing) return;
    const ok = await mutate({
      action: 'update', id: editing.id, agentId: editing.agentId, key: editing.key,
      content: editing.content, kind: editing.kind, status: editing.status, pinned: editing.pinned,
    }, 'Memory updated');
    if (ok) setEditing(null);
  }

  async function remove(entry: AgentMemoryEntry) {
    const ok = await confirmDialog({
      title: 'Delete this memory?',
      message: `“${entry.key}” will stop being recalled by ${scopeNames.get(entry.agentId) || 'this agent'}.`,
      confirmLabel: 'Delete memory',
      danger: true,
    });
    if (ok) await mutate({ action: 'delete', id: entry.id }, 'Memory deleted');
  }

  async function clearPending() {
    const ok = await confirmDialog({
      title: 'Delete pending suggestions?',
      message: 'All automatically learned memories awaiting review in the current scope will be removed.',
      confirmLabel: 'Delete suggestions',
      danger: true,
    });
    if (ok) await mutate({ action: 'clear', status: 'pending', source: 'learned', ...(scope ? { agentId: scope } : {}) }, 'Pending suggestions cleared');
  }

  return (
    <div className="page-content memory-page">
      <div className="page-head-row mb-4">
        <div className="min-w-0">
          <div className="page-title flex items-center gap-2">
            Memories
            <InfoHint text="Memories are local SQLite facts agents can recall across runs. Automatic learning can save candidates after successful runs; Review mode holds them here until you approve them." />
          </div>
          <div className="page-subtitle">
            Inspect what agents know, approve learned suggestions, and edit, pin, archive, move, or delete anything.
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" className="grok-btn grok-btn-ghost text-xs" onClick={() => void load()} disabled={loading || loadingMore}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button type="button" className="grok-btn grok-btn-primary text-xs" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> Add memory
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
        {([
          ['Total', stats.total, Brain], ['Active', stats.active, Check], ['Review', stats.pending, Lightbulb],
          ['Learned', stats.learned, Sparkles], ['Pinned', stats.pinned, Pin],
        ] as const).map(([label, value, Icon]) => (
          <div key={label} className="grok-card px-3 py-2 flex items-center gap-2">
            <Icon size={14} className="text-dim" />
            <div><div className="text-[10px] text-dim uppercase tracking-wide">{label}</div><div className="font-mono text-sm">{value}</div></div>
          </div>
        ))}
      </div>

      <div className="grok-card p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input className="grok-input input-icon-pad" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search keys and memory content…" />
        </div>
        <select className="grok-select text-xs" value={scope} onChange={(event) => setScope(event.target.value)} aria-label="Memory scope">
          <option value="">All scopes</option>
          {scopes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <select className="grok-select text-xs" value={status} onChange={(event) => setStatus(event.target.value as MemoryStatus | 'all')} aria-label="Memory status">
          <option value="all">All states</option><option value="active">Active</option><option value="pending">Needs review</option><option value="archived">Archived</option>
        </select>
        <select className="grok-select text-xs" value={source} onChange={(event) => setSource(event.target.value as MemorySource | 'all')} aria-label="Memory source">
          <option value="all">All sources</option><option value="manual">Manual</option><option value="tool">Agent-saved</option><option value="learned">Auto-learned</option>
        </select>
        {stats.pending > 0 && (
          <button type="button" className="grok-btn grok-btn-ghost text-xs text-error" onClick={() => void clearPending()}>Clear review queue</button>
        )}
      </div>

      {loading && entries.length === 0 ? (
        <div className="data-loading-row py-10"><span className="data-spinner" /> Loading memories…</div>
      ) : entries.length === 0 ? (
        <div className="grok-card p-10 text-center text-dim">
          <Brain size={30} className="mx-auto mb-3 opacity-40" />
          <div className="text-sm font-medium text-primary">No memories match these filters</div>
          <div className="text-xs mt-1">Add one manually, use <code>/remember</code> in chat, or enable learning in an agent’s editor.</div>
        </div>
      ) : (
        <>
          <div id="memory-list" className="grok-card memory-table-wrap" aria-busy={loading || loadingMore}>
            <table className="memory-table data-table w-full">
              <thead>
                <tr>
                  <th className="memory-col-pin" aria-label="Pinned" />
                  <th className="memory-col-key">Key</th>
                  <th>Memory</th>
                  <th className="memory-col-kind">Kind</th>
                  <th className="memory-col-scope">Scope</th>
                  <th className="memory-col-status">Status</th>
                  <th className="memory-col-updated">Updated</th>
                  <th className="memory-col-actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const expanded = expandedIds.has(entry.id);
                  return (
                  <Fragment key={entry.id}>
                  <tr
                    className={`memory-row ${entry.status === 'pending' ? 'memory-row-pending' : ''} ${expanded ? 'memory-row-open' : ''}`}
                    onClick={() => toggleExpanded(entry.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleExpanded(entry.id);
                      }
                    }}
                    tabIndex={0}
                    aria-expanded={expanded}
                    title={expanded ? 'Collapse' : 'Show the full memory and details'}
                  >
                    <td className="memory-col-pin" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className={`memory-icon-btn ${entry.pinned ? 'text-warning' : 'text-dim'}`}
                        title={entry.pinned ? 'Unpin memory' : 'Pin memory so it is always recalled'}
                        aria-label={entry.pinned ? 'Unpin memory' : 'Pin memory'}
                        onClick={() => void mutate({ action: 'update', id: entry.id, pinned: !entry.pinned }, entry.pinned ? 'Memory unpinned' : 'Memory pinned')}
                      >
                        <Pin size={13} fill={entry.pinned ? 'currentColor' : 'none'} />
                      </button>
                    </td>
                    <td className="memory-col-key">
                      <code className="memory-key" title={entry.key}>{entry.key}</code>
                    </td>
                    <td>
                      <div className="memory-content-cell">
                        <span className="memory-expand-caret" aria-hidden>
                          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                        <span className="memory-content-clamp">
                          {entry.content}
                        </span>
                      </div>
                    </td>
                    <td className="memory-col-kind"><span className="tool-chip text-[10px]">{entry.kind}</span></td>
                    <td className="memory-col-scope">
                      <span className="memory-dim-ellipsis" title={scopeNames.get(entry.agentId) || 'Deleted agent'}>
                        {scopeNames.get(entry.agentId) || 'Deleted agent'}
                      </span>
                    </td>
                    <td className="memory-col-status" onClick={(event) => event.stopPropagation()}>
                      {entry.status === 'pending' ? (
                        <span className="tool-chip text-[10px] text-warning">needs review</span>
                      ) : (
                        // Click toggles active ⇄ inactive (archived memories are
                        // never injected into prompts).
                        <button
                          type="button"
                          className={`tool-chip text-[10px] memory-status-toggle ${entry.status === 'archived' ? 'memory-status-inactive' : 'memory-status-active'}`}
                          title={entry.status === 'archived' ? 'Inactive — click to activate' : 'Active — click to deactivate'}
                          aria-label={`Toggle memory status (currently ${entry.status === 'archived' ? 'inactive' : 'active'})`}
                          onClick={() => void mutate(
                            { action: 'update', id: entry.id, status: entry.status === 'archived' ? 'active' : 'archived' },
                            entry.status === 'archived' ? 'Memory activated' : 'Memory deactivated',
                          )}
                        >
                          {entry.status === 'archived' ? 'inactive' : 'active'}
                        </button>
                      )}
                    </td>
                    <td className="memory-col-updated">
                      <span className="memory-updated" title={`${formatDate(entry.updatedAt)} · ${Math.round(entry.confidence * 100)}% confidence`}>
                        {formatDate(entry.updatedAt)}
                      </span>
                    </td>
                    <td className="memory-col-actions" onClick={(event) => event.stopPropagation()}>
                      <div className="memory-row-actions">
                        {entry.status === 'pending' && (
                          <button type="button" className="grok-btn grok-btn-primary memory-approve-btn" onClick={() => void mutate({ action: 'update', id: entry.id, status: 'active' }, 'Memory approved')}>
                            <Check size={12} /> Approve
                          </button>
                        )}
                        {entry.status === 'archived' ? (
                          <button type="button" className="memory-icon-btn" title="Restore to active" aria-label="Restore memory" onClick={() => void mutate({ action: 'update', id: entry.id, status: 'active' }, 'Memory restored')}>
                            <RefreshCw size={13} />
                          </button>
                        ) : (
                          <button type="button" className="memory-icon-btn" title="Archive instead of deleting" aria-label="Archive memory" onClick={() => void mutate({ action: 'update', id: entry.id, status: 'archived' }, 'Memory archived')}>
                            <Archive size={13} />
                          </button>
                        )}
                        <button type="button" className="memory-icon-btn" title="Edit" aria-label="Edit memory" onClick={() => setEditing({ ...entry })}><Edit2 size={13} /></button>
                        <button type="button" className="memory-icon-btn memory-icon-danger" title="Delete permanently" aria-label="Delete memory" onClick={() => void remove(entry)}><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className={`memory-detail-row ${entry.status === 'pending' ? 'memory-row-pending' : ''}`}>
                      <td />
                      <td colSpan={7}>
                        <div className="memory-detail">
                          <div className="memory-detail-text">{entry.content}</div>
                          <div className="memory-detail-meta">
                            <span>{sourceLabel(entry.source)}</span>
                            <span>{Math.round(entry.confidence * 100)}% confidence</span>
                            {entry.useCount > 0 && <span>recalled {entry.useCount}×</span>}
                            {entry.source === 'learned' && entry.sourceId && (
                              <Link className="link-accent" href={`/automations?run=${encodeURIComponent(entry.sourceId)}`} onClick={(event) => event.stopPropagation()}>
                                source run
                              </Link>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-col items-center gap-2" aria-live="polite" aria-atomic="true">
            <div className="text-xs text-dim">
              Showing {entries.length} of {matchingTotal} matching {matchingTotal === 1 ? 'memory' : 'memories'}
            </div>
            {hasMore && (
              <button
                type="button"
                className="grok-btn grok-btn-secondary text-xs"
                onClick={() => void load(undefined, nextOffset, true)}
                disabled={loading || loadingMore}
                aria-controls="memory-list"
              >
                {loadingMore ? <><span className="data-spinner" /> Loading moreâ€¦</> : `Load ${Math.min(PAGE_SIZE, matchingTotal - nextOffset)} more`}
              </button>
            )}
          </div>
        </>
      )}

      {(showCreate || editing) && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4" onClick={() => { if (!saving) { setShowCreate(false); setEditing(null); } }}>
          <div ref={memoryModalRef} className="modal modal-pop w-full max-w-xl p-5" role="dialog" aria-modal="true" aria-label={editing ? 'Edit memory' : 'Add memory'} onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 mb-4">
              <div className="text-lg font-semibold">{editing ? 'Edit memory' : 'Add memory'}</div>
              <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={() => { setShowCreate(false); setEditing(null); }} aria-label="Close">×</button>
            </div>
            <div className="space-y-3">
              <div>
                <div className="grok-label">Scope</div>
                <select className="grok-select w-full" value={editing ? editing.agentId : form.agentId} onChange={(event) => editing ? setEditing({ ...editing, agentId: event.target.value }) : setForm({ ...form, agentId: event.target.value })}>
                  {scopes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </div>
              <div>
                <div className="grok-label">Key</div>
                <input autoFocus className="grok-input" value={editing ? editing.key : form.key} onChange={(event) => editing ? setEditing({ ...editing, key: event.target.value }) : setForm({ ...form, key: event.target.value })} placeholder="e.g. deploy-command" />
              </div>
              <div>
                <div className="grok-label">Memory</div>
                <textarea className="grok-input min-h-28" value={editing ? editing.content : form.content} onChange={(event) => editing ? setEditing({ ...editing, content: event.target.value }) : setForm({ ...form, content: event.target.value })} placeholder="The durable fact, preference, decision, procedure, or lesson…" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="grok-label">Kind</div>
                  <select className="grok-select w-full" value={editing ? editing.kind : form.kind} onChange={(event) => editing ? setEditing({ ...editing, kind: event.target.value as MemoryKind }) : setForm({ ...form, kind: event.target.value as MemoryKind })}>
                    {KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm self-end h-10">
                  <input type="checkbox" checked={editing?.pinned ?? form.pinned} onChange={(event) => editing ? setEditing({ ...editing, pinned: event.target.checked }) : setForm({ ...form, pinned: event.target.checked })} /> Always recall (pinned)
                </label>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="grok-btn grok-btn-ghost" onClick={() => { setShowCreate(false); setEditing(null); }} disabled={saving}>Cancel</button>
              <button type="button" className="grok-btn grok-btn-primary" onClick={() => void (editing ? saveEdit() : createMemory())} disabled={saving || !(editing ? editing.key : form.key).trim() || !(editing ? editing.content : form.content).trim()}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Add memory'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
