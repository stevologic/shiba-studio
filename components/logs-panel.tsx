'use client';

// Full audit trail — every consequential action (runs, chats, config,
// integrations, skills, sync, auth) recorded in SQLite and browsable here.

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';

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

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleString();
}

export default function LogsPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (cat: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (cat !== 'all') params.set('category', cat);
      const res = await fetch(`/api/logs?${params}`);
      const data = await res.json();
      if (data.ok) {
        setEntries(data.entries || []);
        setTotal(data.total || 0);
      }
    } catch {
      /* keep last view */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(category);
  }, [category, load]);

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <div className="text-xl font-semibold flex items-center gap-2">
            <ScrollText size={18} className="opacity-70" />
            Logs
          </div>
          <div className="text-sm text-muted mt-1">
            Full audit trail of actions taken — {total.toLocaleString()} event{total === 1 ? '' : 's'} recorded.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load(category)}
          disabled={loading}
          className="grok-btn grok-btn-secondary text-xs"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={`log-filter-chip ${category === c ? 'log-filter-chip-active' : ''}`}
          >
            {c}
          </button>
        ))}
      </div>

      {loading && entries.length === 0 ? (
        <div className="data-loading-row py-8"><span className="data-spinner data-spinner-lg" /> Loading audit trail…</div>
      ) : entries.length === 0 ? (
        <div className="grok-card p-8 text-center text-dim text-sm">
          No events{category !== 'all' ? ` in "${category}"` : ''} yet — actions you take will appear here.
        </div>
      ) : (
        <div className="grok-card overflow-hidden">
          <table className="logs-table w-full text-xs">
            <thead>
              <tr>
                <th className="w-[110px]">When</th>
                <th className="w-[90px]">Category</th>
                <th className="w-[170px]">Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="text-dim whitespace-nowrap" title={new Date(e.ts).toLocaleString()}>
                    {relativeTime(e.ts)}
                  </td>
                  <td>
                    <span className={`log-cat-chip ${CATEGORY_COLORS[e.category] || ''}`}>{e.category}</span>
                  </td>
                  <td className="font-medium">{e.action}</td>
                  <td className="text-muted">
                    <span className="line-clamp-2">{e.detail || '—'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
