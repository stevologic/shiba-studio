'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  ShieldQuestion,
  X,
} from 'lucide-react';
import { subscribeLiveEvents } from '@/lib/live-events';
import type { AttentionItem } from '@/lib/task-types';

const PAGE_SIZE = 25;

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
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const pageRef = useRef(0);

  const loadItems = useCallback(async (requestedPage = pageRef.current) => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    const sequence = ++requestSequenceRef.current;
    requestControllerRef.current = controller;
    try {
      async function fetchPage(targetPage: number) {
        const query = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(targetPage * PAGE_SIZE),
        });
        const response = await fetch(`/api/attention?${query}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = await response.json() as {
          ok?: boolean;
          items?: AttentionItem[];
          total?: number;
          error?: string;
        };
        if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load attention items');
        return {
          items: data.items || [],
          total: Number.isFinite(data.total) ? Math.max(0, Math.trunc(data.total!)) : 0,
        };
      }

      let resolvedPage = Math.max(0, Math.trunc(requestedPage));
      let result = await fetchPage(resolvedPage);
      while (result.total > 0) {
        const lastPage = Math.ceil(result.total / PAGE_SIZE) - 1;
        if (resolvedPage <= lastPage) break;
        resolvedPage = lastPage;
        result = await fetchPage(resolvedPage);
      }
      if (result.total === 0) resolvedPage = 0;
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      pageRef.current = resolvedPage;
      setPage(resolvedPage);
      setItems(result.items);
      setTotal(result.total);
      setError(null);
    } catch (loadError) {
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      setItems((current) => current || []);
      setError(loadError instanceof Error ? loadError.message : 'Could not load attention items');
    } finally {
      if (sequence === requestSequenceRef.current) requestControllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadItems(); }, 0);
    return () => {
      window.clearTimeout(timer);
      requestControllerRef.current?.abort();
    };
  }, [loadItems]);

  useEffect(() => subscribeLiveEvents(['attention'], () => { void loadItems(); }), [loadItems]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstVisible = total === 0 ? 0 : (page * PAGE_SIZE) + 1;
  const lastVisible = Math.min(total, (page + 1) * PAGE_SIZE);

  function goToPage(nextPage: number) {
    const boundedPage = Math.max(0, Math.min(pageCount - 1, Math.trunc(nextPage)));
    if (boundedPage === pageRef.current || items === null) return;
    pageRef.current = boundedPage;
    setPage(boundedPage);
    setItems(null);
    void loadItems(boundedPage);
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
          <p className="text-sm text-muted mt-1">Only exact actions waiting for your approval appear here.</p>
        </div>
        <button type="button" className="grok-btn grok-btn-ghost" onClick={() => void loadItems()}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </header>

      <div className="flex justify-end">
        <span className="text-xs text-dim" aria-live="polite">
          {items === null
            ? 'Loading…'
            : total > PAGE_SIZE
              ? `${firstVisible}–${lastVisible} of ${total} pending approvals`
              : `${total} pending approval${total === 1 ? '' : 's'}`}
        </span>
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
          <div className="font-medium">No approvals are waiting</div>
          <p className="text-sm text-dim mt-1">An exact action will appear automatically when it needs your decision.</p>
        </div>
      ) : (
        <ul className="space-y-3" aria-label="Attention items">
          {items.map((item) => {
            const updating = updatingId === item.id;
            return (
              <li key={item.id} className="grok-card p-4">
                <div className="flex gap-3">
                  <ShieldQuestion size={19} className={`shrink-0 mt-0.5 ${severityClass(item.severity)}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">{item.title}</h2>
                      <span className={`status-pill ${severityClass(item.severity)}`}>{item.severity}</span>
                      <span className="status-pill text-dim">approval</span>
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
                      {typeof item.action.approvalId === 'string' && (
                        <>
                          <button type="button" className="grok-btn grok-btn-primary" disabled={Boolean(updatingId)} onClick={() => void decideApproval(item, true)}>
                            {updating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />} Approve exact action
                          </button>
                          <button type="button" className="grok-btn grok-btn-danger" disabled={Boolean(updatingId)} onClick={() => void decideApproval(item, false)}>
                            <X size={13} aria-hidden="true" /> Deny
                          </button>
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

      {pageCount > 1 && (
        <nav className="flex items-center justify-center gap-3" aria-label="Attention pages">
          <button
            type="button"
            className="grok-btn grok-btn-secondary"
            disabled={page === 0 || items === null}
            onClick={() => goToPage(page - 1)}
          >
            <ChevronLeft size={14} aria-hidden="true" /> Previous
          </button>
          <span className="min-w-24 text-center text-xs text-dim" aria-live="polite">
            Page {page + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="grok-btn grok-btn-secondary"
            disabled={page >= pageCount - 1 || items === null}
            onClick={() => goToPage(page + 1)}
          >
            Next <ChevronRight size={14} aria-hidden="true" />
          </button>
        </nav>
      )}
    </section>
  );
}

export default AttentionInbox;
