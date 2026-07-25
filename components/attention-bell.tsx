'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  Loader2,
  ShieldQuestion,
  X,
} from 'lucide-react';
import { subscribeLiveEvents } from '@/lib/live-events';
import type { AttentionItem } from '@/lib/task-types';

/** Approvals are exceptions, not a feed — the popover never paginates. */
const MAX_VISIBLE = 25;

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

/**
 * Top-bar approvals alert. Replaces the retired Attention tab: the badge counts
 * exact actions waiting for a decision, and the popover approves or denies them
 * in place through the same bound task commands the tab used.
 */
export function AttentionBell({ count }: { count: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  const loadItems = useCallback(async () => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    const sequence = ++requestSequenceRef.current;
    requestControllerRef.current = controller;
    try {
      const response = await fetch(`/api/attention?limit=${MAX_VISIBLE}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await response.json() as { ok?: boolean; items?: AttentionItem[]; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load approvals');
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      setItems(data.items || []);
      setError(null);
    } catch (loadError) {
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      setItems((current) => current || []);
      setError(loadError instanceof Error ? loadError.message : 'Could not load approvals');
    } finally {
      if (sequence === requestSequenceRef.current) requestControllerRef.current = null;
    }
  }, []);

  // Load on open; stay fresh while open (approvals resolve from other surfaces).
  useEffect(() => {
    if (!open) return;
    // Microtask deferral keeps setState out of the synchronous effect body.
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) void loadItems(); });
    const unsubscribe = subscribeLiveEvents(['attention'], () => { void loadItems(); });
    return () => {
      cancelled = true;
      unsubscribe();
      requestControllerRef.current?.abort();
    };
  }, [open, loadItems]);

  // Light dismissal: outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

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
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className={`grok-btn grok-btn-ghost relative p-1.5 ${open ? 'ring-1 ring-border-light' : ''}`}
        title={count > 0 ? `${count} pending approval${count === 1 ? '' : 's'}` : 'Approvals'}
        aria-label={count > 0 ? `Approvals — ${count} pending` : 'Approvals — none pending'}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell size={15} aria-hidden />
        {count > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[var(--fun-orange)] text-black text-[10px] font-semibold leading-4 text-center"
            aria-hidden
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Pending approvals"
          className="absolute right-0 top-full mt-2 w-[380px] max-w-[calc(100vw-2rem)] z-50 grok-card p-0 shadow-xl"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-default">
            <div className="text-sm font-semibold">Approvals</div>
            <div className="text-[11px] text-dim">Exceptions, not noise</div>
          </div>

          {error && <div className="px-4 py-2 text-xs text-error border-b border-default" role="alert">{error}</div>}

          {items === null ? (
            <div className="p-6 text-center text-sm text-dim" aria-busy="true">
              <Loader2 size={16} className="animate-spin mx-auto mb-2" aria-hidden />
              Loading approvals…
            </div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center">
              <CheckCircle2 size={22} className="mx-auto text-success mb-2" aria-hidden />
              <div className="text-sm font-medium">No approvals are waiting</div>
              <p className="text-xs text-dim mt-1">An exact action will appear here when it needs your decision.</p>
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto divide-y divide-[var(--border)]" aria-label="Pending approvals">
              {items.map((item) => {
                const updating = updatingId === item.id;
                return (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex gap-2.5">
                      <ShieldQuestion size={16} className={`shrink-0 mt-0.5 ${severityClass(item.severity)}`} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{item.title}</div>
                        <p className="text-xs text-muted mt-1 whitespace-pre-wrap line-clamp-4">{item.body}</p>
                        <div className="text-[11px] text-dim mt-1.5">{dateLabel(item.createdAt)}</div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          {typeof item.action.approvalId === 'string' && (
                            <>
                              <button
                                type="button"
                                className="grok-btn grok-btn-primary text-xs px-2 py-1"
                                disabled={Boolean(updatingId)}
                                onClick={() => void decideApproval(item, true)}
                              >
                                {updating ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Check size={12} aria-hidden />} Approve
                              </button>
                              <button
                                type="button"
                                className="grok-btn grok-btn-danger text-xs px-2 py-1"
                                disabled={Boolean(updatingId)}
                                onClick={() => void decideApproval(item, false)}
                              >
                                <X size={12} aria-hidden /> Deny
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            className="grok-btn grok-btn-ghost text-xs px-2 py-1"
                            onClick={() => {
                              setOpen(false);
                              router.push(`/tasks/${encodeURIComponent(item.taskId)}`);
                            }}
                          >
                            View task <ChevronRight size={12} aria-hidden />
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default AttentionBell;
