'use client';

// Full audit trail — every consequential action (runs, chats, config,
// integrations, skills, sync, auth) recorded in SQLite and browsable here.

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Download, RefreshCw, ScrollText, Search, SquareArrowOutUpRight, Terminal, X } from 'lucide-react';
import type { AgentRun } from '@/lib/types';
import { modelDisplayName } from '@/lib/model-providers';
import { MISSING_AGENT_AVATAR_PATH, resolveAgentAvatarPath } from '@/lib/agent-avatars';
import InfoHint from '@/components/info-hint';
import { invalidateClientJson, loadClientJson } from '@/lib/client-json';

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 320;
const AGENTS_URL = '/api/agents';

function logsUrl(category: string, page: number, searchQ: string): string {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  if (category !== 'all') params.set('category', category);
  if (searchQ) params.set('q', searchQ);
  return `/api/logs?${params}`;
}

/** Clamp a 1-based page number to a valid zero-based index. */
function clampPageIndex(pageOneBased: number, pageCount: number): number {
  if (!Number.isFinite(pageOneBased)) return 0;
  const n = Math.floor(pageOneBased);
  return Math.min(pageCount - 1, Math.max(0, n - 1));
}

interface LogEntry {
  id: number;
  ts: string;
  category: string;
  action: string;
  detail: string | null;
  meta: Record<string, unknown> | null;
}

const CATEGORIES = ['all', 'run', 'chat', 'agent', 'config', 'integration', 'skill', 'sync', 'workspace', 'auth'] as const;

const CATEGORY_COLORS: Record<string, string> = {
  run: 'log-cat-run',
  chat: 'log-cat-chat',
  agent: 'log-cat-agent',
  config: 'log-cat-config',
  integration: 'log-cat-integration',
  skill: 'log-cat-skill',
  sync: 'log-cat-sync',
  workspace: 'log-cat-workspace',
  auth: 'log-cat-auth',
};

/** Pull a non-empty string field out of an entry's meta blob. */
function metaStr(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Meta keys already surfaced inline on the row — the expander shows the rest. */
const INLINE_META_KEYS = new Set(['agent', 'agentName', 'model', 'agentId']);

/** True when a row has more to show than the clamped inline cells. */
function hasMoreDetail(e: LogEntry): boolean {
  if (e.detail && e.detail.length > 90) return true;
  const extra = e.meta ? Object.keys(e.meta).filter((k) => !INLINE_META_KEYS.has(k)) : [];
  return extra.length > 0;
}

/** Recent events read relatively; older ones get a compact absolute stamp that fits the column. */
function formatWhen(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function LogsPanel() {
  // null = first load still in flight (distinct from "loaded, zero events").
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState<string>('all');
  /** What the user is typing */
  const [searchDraft, setSearchDraft] = useState('');
  /** Debounced query sent to the API (matches any column) */
  const [searchQ, setSearchQ] = useState('');
  const [page, setPage] = useState(0);
  /** Draft for the jump-to-page field (1-based string while editing). */
  const [pageInput, setPageInput] = useState('1');
  const [reloadKey, setReloadKey] = useState(0);
  // Flipped on synchronously in the event handlers below (never in the
  // effect) so pager/refresh buttons disable while a fetch is in flight.
  const [loading, setLoading] = useState(false);
  /** Row opened to its full detail + metadata. */
  const [expandedId, setExpandedId] = useState<number | null>(null);
  /** Execution trace opened in-place (no more bouncing to Automations). */
  const [traceRun, setTraceRun] = useState<AgentRun | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const traceRequestRef = useRef(0);
  const logsRequestRef = useRef(0);

  async function openTrace(runId: string) {
    const requestId = ++traceRequestRef.current;
    setTraceLoading(true);
    try {
      const data = await loadClientJson<{ ok?: boolean; run?: AgentRun; error?: string }>(
        `/api/runs?id=${encodeURIComponent(runId)}`,
        { maxAgeMs: 5_000 },
      );
      if (!data.ok || !data.run) throw new Error(data.error || 'Run not found (it may have been pruned by retention)');
      if (requestId === traceRequestRef.current) setTraceRun(data.run);
    } catch (err) {
      if (requestId !== traceRequestRef.current) return;
      const { toast } = await import('@/lib/toast');
      toast.error(err instanceof Error ? err.message : 'Could not load the run');
    } finally {
      if (requestId === traceRequestRef.current) setTraceLoading(false);
    }
  }

  function closeTrace() {
    traceRequestRef.current += 1;
    setTraceLoading(false);
    setTraceRun(null);
  }
  // Live agents, for avatars in the Agent column — deleted agents get the UFO.
  const [agentsById, setAgentsById] = useState<Map<string, { id: string; avatar?: string }>>(new Map());

  // Deep link: /logs?q=… seeds the search box (global search hands off here).
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('q');
      if (q) setSearchDraft(q);
    } catch { /* SSR/no window */ }
  }, []);

  // Debounce free-text search; reset to page 1 when the query settles.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = searchDraft.trim();
      setSearchQ((prev) => {
        if (prev === next) return prev;
        setLoading(true);
        setPage(0);
        setPageInput('1');
        return next;
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [searchDraft]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await loadClientJson<{ agents?: Array<{ id: string; avatar?: string }> }>(AGENTS_URL, {
          maxAgeMs: 30_000,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && Array.isArray(data.agents)) {
          setAgentsById(new Map(data.agents.map((a: { id: string; avatar?: string }) => [a.id, a])));
        }
      } catch {
        /* avatars are decoration — ignore */
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++logsRequestRef.current;
    const url = logsUrl(category, page, searchQ);
    void (async () => {
      try {
        const data = await loadClientJson<{ ok?: boolean; entries?: LogEntry[]; total?: number }>(url, {
          maxAgeMs: 5_000,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && requestId === logsRequestRef.current && data.ok) {
          setEntries(data.entries || []);
          setTotal(data.total || 0);
        }
      } catch {
        /* keep last view */
      } finally {
        if (!controller.signal.aborted && requestId === logsRequestRef.current) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [category, page, reloadKey, searchQ]);

  function changeCategory(next: string) {
    if (next === category && page === 0) return;
    setLoading(true);
    setCategory(next);
    setPage(0);
    setPageInput('1');
  }

  function clearSearch() {
    setSearchDraft('');
    if (searchQ) {
      setLoading(true);
      setSearchQ('');
      setPage(0);
      setPageInput('1');
    }
  }

  function goToPage(next: number) {
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const clamped = Math.min(pageCount - 1, Math.max(0, next));
    if (clamped === page) {
      setPageInput(String(page + 1));
      return;
    }
    setLoading(true);
    setPage(clamped);
    setPageInput(String(clamped + 1));
  }

  function commitPageInput() {
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const raw = pageInput.trim();
    if (!raw) {
      setPageInput(String(page + 1));
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setPageInput(String(page + 1));
      return;
    }
    const next = clampPageIndex(parsed, pageCount);
    if (next === page) {
      setPageInput(String(page + 1));
      return;
    }
    goToPage(next);
  }

  function refresh() {
    setLoading(true);
    invalidateClientJson(logsUrl(category, page, searchQ));
    setReloadKey((k) => k + 1);
  }

  const loaded = entries ?? [];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, page * PAGE_SIZE + loaded.length);

  // Keep the jump field in sync when Prev/Next (or external) changes `page`.
  useEffect(() => {
    setPageInput(String(page + 1));
  }, [page]);

  function exportLogs(format: 'csv' | 'json') {
    const params = new URLSearchParams({ format });
    if (category !== 'all') params.set('category', category);
    if (searchQ) params.set('q', searchQ);
    const a = document.createElement('a');
    a.href = `/api/logs?${params}`;
    a.download = '';
    a.click();
  }

  return (
    <div className="page-content">
      <div className="page-head-row">
        <div className="min-w-0">
          <div className="page-title">
            <ScrollText size={20} className="opacity-70" />
            Logs
            <InfoHint text="Every consequential action lands here — runs, chats, config, integrations, sync. Run entries link to their full execution log; a UFO avatar means the agent has since been deleted." />
          </div>
          <div className="page-subtitle">
            Full audit trail of actions taken —
            {searchQ
              ? ` ${total.toLocaleString()} match${total === 1 ? '' : 'es'} for “${searchQ}”`
              : ` ${total.toLocaleString()} event${total === 1 ? '' : 's'} recorded`}.
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <button
            type="button"
            onClick={() => exportLogs('csv')}
            disabled={total === 0}
            className="grok-btn grok-btn-secondary text-xs"
            title={`Download the ${category === 'all' ? 'full' : `"${category}"`}${searchQ ? ' matching' : ''} audit trail as CSV`}
          >
            <Download size={14} /> CSV
          </button>
          <button
            type="button"
            onClick={() => exportLogs('json')}
            disabled={total === 0}
            className="grok-btn grok-btn-secondary text-xs"
            title={`Download the ${category === 'all' ? 'full' : `"${category}"`}${searchQ ? ' matching' : ''} audit trail as JSON`}
          >
            <Download size={14} /> JSON
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="grok-btn grok-btn-ghost text-xs"
            title="Reload the trail"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="logs-search-wrap">
          <Search size={14} className="logs-search-icon" aria-hidden />
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && searchDraft) {
                e.preventDefault();
                clearSearch();
              }
            }}
            placeholder="Search any column…"
            className="grok-input logs-search-input"
            aria-label="Search logs in any column"
            disabled={loading && entries === null}
          />
          {searchDraft ? (
            <button
              type="button"
              className="logs-search-clear"
              onClick={clearSearch}
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
        {searchQ ? (
          <span className="text-[11px] text-dim">
            Searching when, category, action, agent/model, detail, and meta
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-5">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => changeCategory(c)}
            className={`log-filter-chip ${category === c ? 'log-filter-chip-active' : ''}`}
          >
            {c}
          </button>
        ))}
      </div>

      {entries === null ? (
        <div className="data-loading-row py-8"><span className="data-spinner data-spinner-lg" /> Loading audit trail…</div>
      ) : loaded.length === 0 ? (
        <div className="grok-card p-8 text-center text-dim text-sm">
          {searchQ
            ? `No events match “${searchQ}”${category !== 'all' ? ` in “${category}”` : ''}.`
            : `No events${category !== 'all' ? ` in "${category}"` : ''} yet — actions you take will appear here.`}
          {searchQ ? (
            <div className="mt-3">
              <button type="button" className="grok-btn grok-btn-secondary text-xs" onClick={clearSearch}>
                Clear search
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grok-card logs-table-wrap">
          <table className="logs-table w-full text-xs">
            <thead>
              <tr>
                <th className="logs-col-when">When</th>
                <th className="logs-col-category">Category</th>
                <th className="logs-col-action">Action</th>
                <th className="logs-col-source">Agent / Model</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {loaded.map((e) => {
                const agent = metaStr(e.meta, 'agent') || metaStr(e.meta, 'agentName');
                const model = metaStr(e.meta, 'model');
                const runId = metaStr(e.meta, 'runId');
                const agentId = metaStr(e.meta, 'agentId');
                const liveAgent = agentId ? agentsById.get(agentId) : undefined;
                const expandable = hasMoreDetail(e);
                const expanded = expandedId === e.id;
                return (
                  <React.Fragment key={e.id}>
                  <tr
                    className={expandable ? 'logs-row-expandable' : undefined}
                    title={expandable ? (expanded ? 'Collapse details' : 'Show full details') : undefined}
                    onClick={expandable ? () => setExpandedId(expanded ? null : e.id) : undefined}
                  >
                    <td className="logs-when" title={new Date(e.ts).toLocaleString()}>
                      <span className="logs-when-cell">
                        {expandable
                          ? (expanded ? <ChevronDown size={11} className="logs-expand-caret" /> : <ChevronRight size={11} className="logs-expand-caret" />)
                          : <span className="logs-expand-caret logs-expand-caret-none" />}
                        {formatWhen(e.ts)}
                      </span>
                    </td>
                    <td>
                      <span className={`log-cat-chip ${CATEGORY_COLORS[e.category] || ''}`}>{e.category}</span>
                    </td>
                    <td className="font-medium">{e.action}</td>
                    <td className="logs-source">
                      {agent || model ? (
                        <span className="flex items-center gap-1.5 min-w-0">
                          {agent && agentId && (
                            <img
                              src={liveAgent ? resolveAgentAvatarPath(liveAgent) : MISSING_AGENT_AVATAR_PATH}
                              alt=""
                              className="agent-avatar-xs shrink-0"
                              width={16}
                              height={16}
                              title={liveAgent ? agent : `${agent} — this agent has since been deleted`}
                            />
                          )}
                          <span className="flex flex-col min-w-0">
                            {agent && <span className="truncate" title={agent}>{agent}</span>}
                            {model && (
                              <span className="truncate text-dim font-mono text-[10px]" title={model}>
                                {modelDisplayName(model)}
                              </span>
                            )}
                          </span>
                        </span>
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                    </td>
                    <td className="text-muted">
                      <span className="line-clamp-2" title={e.detail || undefined}>{e.detail || '—'}</span>
                      {runId && (
                        <button
                          type="button"
                          className="link-accent text-[10px] inline-flex items-center gap-1 mt-0.5"
                          title="Open this run's full execution log right here"
                          disabled={traceLoading}
                          onClick={(event) => { event.stopPropagation(); void openTrace(runId); }}
                        >
                          <SquareArrowOutUpRight size={10} /> view execution log
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="logs-detail-row">
                      <td />
                      <td colSpan={4}>
                        <div className="logs-detail">
                          {e.detail && <div className="logs-detail-text">{e.detail}</div>}
                          {e.meta && Object.keys(e.meta).length > 0 && (
                            <dl className="logs-meta-grid">
                              {Object.entries(e.meta).map(([k, v]) => (
                                <React.Fragment key={k}>
                                  <dt>{k}</dt>
                                  <dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
                                </React.Fragment>
                              ))}
                            </dl>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-3 text-xs text-dim flex-wrap gap-2">
          <span>
            Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {total.toLocaleString()}
          </span>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => goToPage(Math.max(0, page - 1))}
              disabled={page === 0 || loading}
              className="grok-btn grok-btn-secondary text-xs py-1"
              aria-label="Previous page"
            >
              <ChevronLeft size={14} /> Prev
            </button>
            <label className="flex items-center gap-1.5 px-1 font-mono" title="Jump to page">
              <span className="text-dim">Page</span>
              <input
                type="number"
                min={1}
                max={pageCount}
                inputMode="numeric"
                value={pageInput}
                disabled={loading}
                onChange={(e) => setPageInput(e.target.value)}
                onBlur={() => commitPageInput()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                    commitPageInput();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setPageInput(String(page + 1));
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className="grok-input logs-page-input font-mono text-xs"
                aria-label={`Page number, 1 to ${pageCount}`}
              />
              <span className="text-dim whitespace-nowrap">/ {pageCount}</span>
            </label>
            <button
              type="button"
              onClick={() => goToPage(Math.min(pageCount - 1, page + 1))}
              disabled={page >= pageCount - 1 || loading}
              className="grok-btn grok-btn-secondary text-xs py-1"
              aria-label="Next page"
            >
              Next <ChevronRight size={14} />
            </button>
          </span>
        </div>
      )}

      {traceRun && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4" onClick={closeTrace}>
          <div className="modal modal-pop w-full max-w-4xl p-5 max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Execution trace">
            <div className="flex items-center gap-2 mb-3 shrink-0">
              <Terminal size={16} />
              <div className="font-medium">Execution Trace</div>
              <span className={`badge ${traceRun.status === 'running' ? 'badge-accent' : ''}`}>{traceRun.status}</span>
              <span className="text-xs text-muted truncate min-w-0">
                {traceRun.agentName} · {modelDisplayName(traceRun.model)} · {new Date(traceRun.startedAt).toLocaleString()}
              </span>
              <button type="button" className="grok-btn grok-btn-ghost p-1.5 ml-auto shrink-0" onClick={closeTrace} title="Close" aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto space-y-3 pr-1">
              <div className="grok-card p-4 font-mono text-xs bg-black/40">
                {(traceRun.trace || []).length > 0 ? (traceRun.trace || []).map((step, idx) => (
                  <div key={idx} className={`trace-step mb-3 ${step.type}`}>
                    <div className="text-[10px] text-dim">{new Date(step.ts).toLocaleTimeString()} — {step.type.toUpperCase()}</div>
                    <div className="mt-0.5">{step.content}</div>
                    {step.tool && <div className="tool-call mt-1">{step.tool.name} {JSON.stringify(step.tool.args)}</div>}
                    {step.screenshot && <div className="mt-2 screenshot"><img src={step.screenshot} alt="browser" /></div>}
                  </div>
                )) : <div className="text-dim">This run recorded no trace steps.</div>}
              </div>
              {traceRun.finalOutput && (
                <div className="text-xs text-muted">Final: {traceRun.finalOutput.slice(0, 300)}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
