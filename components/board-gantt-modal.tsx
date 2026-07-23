'use client';

/**
 * Delivery timeline (Gantt) for the Board — every delivered (done) card in the
 * active project filter, bars spanning created → done dates.
 */

import React, { useMemo } from 'react';
import { BarChart3, X } from 'lucide-react';
import type { BoardTask } from '@/lib/board-types';

interface DeliveredRow {
  task: BoardTask;
  start: number;
  done: number;
}

/** Timestamp of the last activity event that moved the card to done. */
function doneDateOf(task: BoardTask): number | null {
  for (let index = task.activity.length - 1; index >= 0; index--) {
    const entry = task.activity[index];
    if (/(?:→|moved to)\s+done\s*$/i.test(entry.text.trim())) {
      const at = Date.parse(entry.ts);
      if (Number.isFinite(at)) return at;
    }
  }
  // Imported/synced cards may land in done without a move event — use the
  // newest activity we have rather than dropping the delivery.
  const last = task.activity[task.activity.length - 1];
  const fallback = last ? Date.parse(last.ts) : Date.parse(task.createdAt);
  return Number.isFinite(fallback) ? fallback : null;
}

function dayLabel(at: number, withYear: boolean): string {
  return new Date(at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

export default function BoardGanttModal({ open, tasks, filterLabel, onClose }: {
  open: boolean;
  /** Cards already narrowed to the active project filter. */
  tasks: BoardTask[];
  filterLabel: string | null;
  onClose: () => void;
}) {
  const rows = useMemo<DeliveredRow[]>(() => {
    if (!open) return [];
    return tasks
      .filter((task) => task.status === 'done')
      .flatMap((task) => {
        const done = doneDateOf(task);
        const created = Date.parse(task.createdAt);
        if (done == null || !Number.isFinite(created)) return [];
        return [{ task, start: Math.min(created, done), done }];
      })
      .sort((a, b) => a.done - b.done);
  }, [open, tasks]);

  const range = useMemo(() => {
    if (!rows.length) return null;
    const t0 = Math.min(...rows.map((row) => row.start));
    const t1 = Math.max(...rows.map((row) => row.done));
    const span = Math.max(t1 - t0, 24 * 60 * 60_000);
    const withYear = span > 300 * 24 * 60 * 60_000;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
      leftPct: fraction * 100,
      label: dayLabel(t0 + span * fraction, withYear),
    }));
    return { t0, span, ticks };
  }, [rows]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[75] p-4" onClick={onClose}>
      <div
        className="modal modal-pop w-full max-w-4xl p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Delivery timeline"
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-lg font-semibold flex items-center gap-2">
              <BarChart3 size={17} className="opacity-70" aria-hidden /> Delivery timeline
            </div>
            <div className="text-xs text-dim mt-0.5">
              {rows.length} delivered card(s){filterLabel ? ` in ${filterLabel}` : ' across all projects'} · bars span created → done
            </div>
          </div>
          <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={onClose} title="Close" aria-label="Close timeline">
            <X size={16} />
          </button>
        </div>

        {rows.length === 0 && (
          <div className="text-sm text-dim py-10 text-center">
            Nothing delivered yet{filterLabel ? ` for ${filterLabel}` : ''} — cards appear here once they reach Done.
          </div>
        )}

        {range && (
          <div>
            {/* Time axis */}
            <div className="relative h-5 ml-[236px] mr-1 text-[10px] text-dim select-none" aria-hidden>
              {range.ticks.map((tick, index) => (
                <span
                  key={index}
                  className="absolute -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${tick.leftPct}%`, ...(index === 0 ? { translate: '0' } : {}), ...(index === range.ticks.length - 1 ? { translate: '-100%' } : {}) }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
            <div className="max-h-[55vh] overflow-y-auto pr-1" role="list" aria-label="Delivered cards by completion date">
              {rows.map(({ task, start, done }) => {
                const leftPct = ((start - range.t0) / range.span) * 100;
                const widthPct = Math.max(((done - start) / range.span) * 100, 0.8);
                return (
                  <div key={task.id} role="listitem" className="grid items-center gap-2 py-1" style={{ gridTemplateColumns: '228px 1fr' }}>
                    <div className="min-w-0 flex items-baseline gap-1.5">
                      <span className="text-[10px] font-mono text-dim flex-shrink-0">{task.key}</span>
                      <span className="text-xs text-primary truncate" title={task.title}>{task.title}</span>
                    </div>
                    <div className="relative h-5" title={`${task.key} · started ${dayLabel(start, true)} · delivered ${dayLabel(done, true)}`}>
                      <div className="absolute inset-y-1/2 left-0 right-0 border-t border-default" aria-hidden />
                      <div
                        className="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-full"
                        style={{
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          background: 'color-mix(in srgb, var(--accent-3) 55%, var(--bg-hover))',
                        }}
                        aria-hidden
                      />
                      <div
                        className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full -translate-x-1/2"
                        style={{ left: `${leftPct + widthPct}%`, background: 'var(--success)' }}
                        aria-hidden
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
