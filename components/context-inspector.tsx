'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Pin, PinOff, RefreshCw } from 'lucide-react';
import type { ContextScopeInspection, ContextWindowMeter } from '@/lib/context-types';
import { toast } from '@/lib/toast';

interface ContextInspectorProps {
  sessionId: string;
  model: string;
}

export function ContextInspector({ sessionId, model }: ContextInspectorProps) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<ContextScopeInspection | null>(null);
  const [previewMeter, setPreviewMeter] = useState<ContextWindowMeter | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        `/api/context/scopes/session/${encodeURIComponent(sessionId)}?limit=100&preview=1&model=${encodeURIComponent(model)}`,
        { signal: controller.signal },
      );
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not inspect context');
      setInspection(data.scope as ContextScopeInspection);
      setPreviewMeter((data.previewMeter || data.scope.meter) as ContextWindowMeter);
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === 'AbortError') return;
      setError(loadError instanceof Error ? loadError.message : 'Could not inspect context');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [model, sessionId]);

  useEffect(() => {
    return () => requestRef.current?.abort();
  }, []);

  async function mutate(body: Record<string, unknown>, success: string) {
    setLoading(true);
    try {
      const response = await fetch(`/api/context/scopes/session/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Context update failed');
      setInspection(data.scope || inspection);
      await load();
      toast.success(success);
    } catch (mutationError) {
      toast.error(mutationError instanceof Error ? mutationError.message : 'Context update failed');
    } finally {
      setLoading(false);
    }
  }

  const meter = previewMeter || inspection?.meter;

  return (
    <section className="relative" aria-label="Session context inspector">
      <button
        type="button"
        className="grok-btn grok-btn-ghost text-xs py-1"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !inspection) void load();
        }}
        aria-expanded={open}
      >
        Context
        {meter ? ` · ${meter.totalTokens.toLocaleString()} tok` : ''}
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(42rem,calc(100vw-3rem))] max-h-[70vh] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-4 shadow-2xl">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Context window</h2>
            <button
              type="button"
              className="grok-btn grok-btn-ghost ml-auto p-1"
              onClick={() => void load()}
              disabled={loading}
              title="Refresh context inspection"
              aria-label="Refresh context inspection"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              className="grok-btn grok-btn-secondary text-xs py-1"
              onClick={() => void mutate({ action: 'regenerate' }, 'Context summary regenerated')}
              disabled={loading}
            >
              Regenerate
            </button>
          </div>
          {error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
          {!inspection && loading && <p className="mt-3 text-xs text-dim">Loading context…</p>}
          {inspection && (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-lg border border-[var(--border)] p-2"><dt className="text-dim">Sources</dt><dd className="font-mono">{meter?.sourceCount || 0}</dd></div>
                <div className="rounded-lg border border-[var(--border)] p-2"><dt className="text-dim">Compacted</dt><dd className="font-mono">{meter?.compactedSourceCount || 0}</dd></div>
                <div className="rounded-lg border border-[var(--border)] p-2"><dt className="text-dim">Summaries</dt><dd className="font-mono">{meter?.summaryCount || 0}</dd></div>
                <div className="rounded-lg border border-[var(--border)] p-2"><dt className="text-dim">Pinned</dt><dd className="font-mono">{meter?.pinnedTokens || 0}/{meter?.maxPinnedTokens || '—'} tok{meter?.pinnedOverflowCount ? ` · ${meter.pinnedOverflowCount} citation-only` : ''}</dd></div>
              </dl>
              <details className="mt-3 rounded-lg border border-[var(--border)] p-2 text-xs">
                <summary className="cursor-pointer font-medium">Token breakdown</summary>
                <dl className="mt-2 grid grid-cols-2 gap-1 text-dim sm:grid-cols-3">
                  <div><dt>Messages</dt><dd className="font-mono text-[var(--text)]">{meter?.breakdown.messageTokens || 0}</dd></div>
                  <div><dt>Tool results</dt><dd className="font-mono text-[var(--text)]">{meter?.breakdown.toolResultTokens || 0}</dd></div>
                  <div><dt>Project</dt><dd className="font-mono text-[var(--text)]">{meter?.breakdown.projectTokens || 0}</dd></div>
                  <div><dt>Runs</dt><dd className="font-mono text-[var(--text)]">{meter?.breakdown.runTokens || 0}</dd></div>
                  <div><dt>Summaries/other</dt><dd className="font-mono text-[var(--text)]">{meter?.breakdown.otherTokens || 0}</dd></div>
                  <div><dt>Model</dt><dd className="font-mono text-[var(--text)]">{meter?.model || 'session index'}</dd></div>
                </dl>
              </details>
              <div className="mt-3">
                <h3 className="text-xs font-semibold">Durable summaries</h3>
                {inspection.compactions.length ? (
                  <ul className="mt-1 space-y-1 text-[11px] text-dim">
                    {inspection.compactions.map((compaction) => (
                      <li key={compaction.id} className="rounded border border-[var(--border)] p-2">
                        <code>{compaction.id}</code> · {compaction.sourceIds.length} sources · {compaction.tokenEstimate} tok
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-1 text-[11px] text-dim">No compaction needed yet.</p>}
              </div>
              <div className="mt-3">
                <h3 className="text-xs font-semibold">Sources</h3>
                <ul className="mt-1 space-y-1">
                  {inspection.sources.map((source) => (
                    <li key={source.sourceId} className="flex items-start gap-2 rounded border border-[var(--border)] p-2 text-[11px]">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-dim break-all">{source.sourceId}</div>
                        <p className="mt-1 line-clamp-2 whitespace-pre-wrap">{source.content || '(empty)'}</p>
                      </div>
                      <button
                        type="button"
                        className="grok-btn grok-btn-ghost shrink-0 p-1"
                        onClick={() => void mutate({ action: 'pin', sourceId: source.sourceId, pinned: !source.pinned }, source.pinned ? 'Context unpinned' : 'Context pinned')}
                        disabled={loading}
                        title={source.pinned ? 'Unpin source' : 'Pin source'}
                        aria-label={source.pinned ? `Unpin ${source.sourceId}` : `Pin ${source.sourceId}`}
                      >
                        {source.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                      </button>
                    </li>
                  ))}
                </ul>
                {inspection.pagination.truncated && (
                  <p className="mt-2 text-[11px] text-dim">Showing the first {inspection.pagination.returnedSources} of {inspection.pagination.totalSources} sources.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
