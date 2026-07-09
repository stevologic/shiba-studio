'use client';

// Full audit trail — every consequential action (runs, chats, config,
// integrations, skills, sync, auth) recorded in SQLite and browsable here.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Download, RefreshCw, ScrollText, Search, SquareArrowOutUpRight, X } from 'lucide-react';
import { modelDisplayName } from '@/lib/model-providers';
import { MISSING_AGENT_AVATAR_PATH, resolveAgentAvatarPath } from '@/lib/agent-avatars';
import InfoHint from '@/components/info-hint';

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 320;

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
  // Live agents, for avatars in the Agent column — deleted agents get the UFO.
  const [agentsById, setAgentsById] = useState<Map<string, { id: string; avatar?: string }>>(new Map());

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
    let stale = false;
    (async () => {
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        if (!stale && Array.isArray(data.agents)) {
          setAgentsById(new Map(data.agents.map((a: { id: string; avatar?: string }) => [a.id, a])));
        }
      } catch {
        /* avatars are decoration — ignore */
      }
    })();
    return () => { stale = true; };
  }, []);

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
        });
        if (category !== 'all') params.set('category', category);
        if (searchQ) params.set('q', searchQ);
        const res = await fetch(`/api/logs?${params}`);
        const data = await res.json();
        if (!stale && data.ok) {
          setEntries(data.entries || []);
          setTotal(data.total || 0);
        }
      } catch {
        /* keep last view */
      }
      if (!stale) setLoading(false);
    })();
    return () => { stale = true; };
  }, [category, page, reloadKey, searchQ]);

  function changeCategory(next: string) {
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
                return (
                  <tr key={e.id}>
                    <td className="logs-when" title={new Date(e.ts).toLocaleString()}>
                      {formatWhen(e.ts)}
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
                        <Link
                          href={`/automations?run=${encodeURIComponent(runId)}`}
                          className="link-accent text-[10px] inline-flex items-center gap-1 mt-0.5"
                          title="Open this run's full execution log"
                        >
                          <SquareArrowOutUpRight size={10} /> view execution log
                        </Link>
                      )}
                    </td>
                  </tr>
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
    </div>
  );
}
