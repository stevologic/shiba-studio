'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Loader2,
  RefreshCw,
  ShieldQuestion,
  TriangleAlert,
  X,
} from 'lucide-react';
import { subscribeLiveEvents } from '@/lib/live-events';
import type { AttentionItem, AttentionStatus } from '@/lib/task-types';

type AttentionFilter = AttentionStatus | 'all';

const FILTERS: Array<{ value: AttentionFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' },
];

function itemIcon(item: AttentionItem) {
  if (item.kind === 'approval') return ShieldQuestion;
  if (item.kind === 'question') return CircleHelp;
  if (item.kind === 'completion') return CheckCircle2;
  if (item.kind === 'failure') return AlertCircle;
  return TriangleAlert;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function severityClass(severity: AttentionItem['severity']): string {
  if (severity === 'critical') return 'text-error';
  if (severity === 'warning') return 'text-warning';
  return 'text-muted';
}

export function AttentionInbox() {
  const router = useRouter();
  const filterLabelId = useId();
  const [filter, setFilter] = useState<AttentionFilter>('open');
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const loadItems = useCallback(async (signal?: AbortSignal) => {
    try {
      const query = filter === 'all' ? '' : `?status=${encodeURIComponent(filter)}`;
      const response = await fetch(`/api/attention${query}`, { cache: 'no-store', signal });
      const data = await response.json() as {
        ok?: boolean;
        items?: AttentionItem[];
        total?: number;
        error?: string;
      };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load attention items');
      setItems(data.items || []);
      setTotal(data.total || 0);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      setItems([]);
      setError(loadError instanceof Error ? loadError.message : 'Could not load attention items');
    }
  }, [filter]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void loadItems(controller.signal); }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadItems]);

  useEffect(() => subscribeLiveEvents(['attention', 'tasks'], () => { void loadItems(); }), [loadItems]);

  async function updateItem(item: AttentionItem, status: 'resolved' | 'dismissed') {
    if (updatingId) return;
    setUpdatingId(item.id);
    setError(null);
    try {
      const response = await fetch(`/api/attention/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not update the attention item');
      await loadItems();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update the attention item');
    } finally {
      setUpdatingId(null);
    }
  }

  async function decideApproval(item: AttentionItem, approved: boolean) {
    const approvalId = typeof item.action.approvalId === 'string' ? item.action.approvalId : '';
    if (!approvalId || updatingId) return;
    setUpdatingId(item.id);
    setError(null);
    try {
      const taskResponse = await fetch(`/api/tasks/${encodeURIComponent(item.taskId)}`, { cache: 'no-store' });
      const taskData = await taskResponse.json() as { ok?: boolean; task?: { version: number }; error?: string };
      if (!taskResponse.ok || !taskData.ok || !taskData.task) throw new Error(taskData.error || 'Could not load the approval task');
      const response = await fetch(`/api/tasks/${encodeURIComponent(item.taskId)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: approved ? 'approve' : 'deny',
          payload: { approvalId },
          idempotencyKey: `attention:${item.id}:${approved ? 'approve' : 'deny'}`,
          expectedVersion: taskData.task.version,
        }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'The approval could not be applied');
      await loadItems();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'The approval could not be applied');
      await loadItems();
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <section className="attention-inbox space-y-5" aria-labelledby="attention-heading">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-dim mb-1">Exceptions, not noise</div>
          <h1 id="attention-heading" className="text-2xl font-semibold">Attention</h1>
          <p className="text-sm text-muted mt-1">Questions, approvals, failures, and completed work that need a decision.</p>
        </div>
        <button type="button" className="grok-btn grok-btn-ghost" onClick={() => void loadItems()}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-labelledby={filterLabelId} className="flex flex-wrap gap-1 grok-card p-1">
          <span id={filterLabelId} className="sr-only">Filter attention items</span>
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`grok-btn ${filter === option.value ? 'grok-btn-secondary' : 'grok-btn-ghost'}`}
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-dim" aria-live="polite">{items === null ? 'Loading…' : `${total} ${filter === 'all' ? '' : filter} item${total === 1 ? '' : 's'}`}</span>
      </div>

      {error && <div className="grok-card p-3 text-sm text-error" role="alert">{error}</div>}

      {items === null ? (
        <div className="grok-card p-8 text-center text-sm text-dim" aria-busy="true">
          <Loader2 size={18} className="animate-spin mx-auto mb-2" aria-hidden="true" />
          Loading attention inbox…
        </div>
      ) : items.length === 0 ? (
        <div className="grok-card p-10 text-center">
          <CheckCircle2 size={28} className="mx-auto text-success mb-3" aria-hidden="true" />
          <div className="font-medium">Nothing needs you here</div>
          <p className="text-sm text-dim mt-1">New task exceptions and decisions will appear automatically.</p>
        </div>
      ) : (
        <ul className="space-y-3" aria-label="Attention items">
          {items.map((item) => {
            const Icon = itemIcon(item);
            const updating = updatingId === item.id;
            return (
              <li key={item.id} className="grok-card p-4">
                <div className="flex gap-3">
                  <Icon size={19} className={`shrink-0 mt-0.5 ${severityClass(item.severity)}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">{item.title}</h2>
                      <span className={`status-pill ${severityClass(item.severity)}`}>{item.severity}</span>
                      <span className="status-pill text-dim">{item.kind}</span>
                      {item.status !== 'open' && <span className="status-pill text-dim">{item.status}</span>}
                    </div>
                    <p className="text-sm text-muted mt-2 whitespace-pre-wrap">{item.body}</p>
                    <div className="text-[11px] text-dim mt-3">
                      Created {dateLabel(item.createdAt)} · task <span className="font-mono">{item.taskId}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-4">
                      <button
                        type="button"
                        className="grok-btn grok-btn-secondary"
                        onClick={() => router.push(`/tasks/${encodeURIComponent(item.taskId)}`)}
                      >
                        View task <ChevronRight size={13} aria-hidden="true" />
                      </button>
                      {item.status === 'open' && (
                        <>
                          {item.kind === 'approval' && typeof item.action.approvalId === 'string' && (
                            <>
                              <button type="button" className="grok-btn grok-btn-primary" disabled={Boolean(updatingId)} onClick={() => void decideApproval(item, true)}>
                                {updating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} Approve exact action
                              </button>
                              <button type="button" className="grok-btn grok-btn-danger" disabled={Boolean(updatingId)} onClick={() => void decideApproval(item, false)}>
                                <X size={13} aria-hidden="true" /> Deny
                              </button>
                            </>
                          )}
                          {!(item.kind === 'approval' && typeof item.action.approvalId === 'string') && (
                            <>
                              <button
                                type="button"
                                className="grok-btn grok-btn-primary"
                                disabled={Boolean(updatingId)}
                                onClick={() => void updateItem(item, 'resolved')}
                              >
                                {updating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                                Resolve
                              </button>
                              <button
                                type="button"
                                className="grok-btn grok-btn-ghost"
                                disabled={Boolean(updatingId)}
                                onClick={() => void updateItem(item, 'dismissed')}
                              >
                                <X size={13} aria-hidden="true" /> Dismiss
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default AttentionInbox;
