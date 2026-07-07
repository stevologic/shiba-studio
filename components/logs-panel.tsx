'use client';

// Full audit trail — every consequential action (runs, chats, config,
// integrations, skills, sync, auth) recorded in SQLite and browsable here.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Download, RefreshCw, ScrollText, SquareArrowOutUpRight } from 'lucide-react';
import { modelDisplayName } from '@/lib/model-providers';
import { MISSING_AGENT_AVATAR_PATH, resolveAgentAvatarPath } from '@/lib/agent-avatars';
import InfoHint from '@/components/info-hint';

const PAGE_SIZE = 100;

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
  const [page, setPage] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  // Flipped on synchronously in the event handlers below (never in the
  // effect) so pager/refresh buttons disable while a fetch is in flight.
  const [loading, setLoading] = useState(false);
  // Live agents, for avatars in the Agent column — deleted agents get the UFO.
  const [agentsById, setAgentsById] = useState<Map<string, { id: string; avatar?: string }>>(new Map());

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
  }, [category, page, reloadKey]);

  function changeCategory(next: string) {
    setLoading(true);
    setCategory(next);
    setPage(0);
  }

  function goToPage(next: number) {
    setLoading(true);
    setPage(next);
  }

  function refresh() {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  const loaded = entries ?? [];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, page * PAGE_SIZE + loaded.length);

  function exportLogs(format: 'csv' | 'json') {
    const params = new URLSearchParams({ format });
    if (category !== 'all') params.set('category', category);
    const a = document.createElement('a');
    a.href = `/api/logs?${params}`;
    a.download = '';
    a.click();
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div>
          <div className="text-xl font-semibold flex items-center gap-2">
            <ScrollText size={18} className="opacity-70" />
            Logs
            <InfoHint text="Every consequential action lands here — runs, chats, config, integrations, sync. Run entries link to their full execution log; a UFO avatar means the agent has since been deleted." />
          </div>
          <div className="text-sm text-muted mt-1">
            Full audit trail of actions taken — {total.toLocaleString()} event{total === 1 ? '' : 's'} recorded.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => exportLogs('csv')}
            disabled={total === 0}
            className="grok-btn grok-btn-secondary text-xs"
            title={`Download the ${category === 'all' ? 'full' : `"${category}"`} audit trail as CSV`}
          >
            <Download size={14} /> CSV
          </button>
          <button
            type="button"
            onClick={() => exportLogs('json')}
            disabled={total === 0}
            className="grok-btn grok-btn-secondary text-xs"
            title={`Download the ${category === 'all' ? 'full' : `"${category}"`} audit trail as JSON`}
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
          No events{category !== 'all' ? ` in "${category}"` : ''} yet — actions you take will appear here.
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
            <span className="px-2 font-mono">
              {page + 1} / {pageCount}
            </span>
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
