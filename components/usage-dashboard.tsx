'use client';

import React, { useEffect, useState } from 'react';
import { RefreshCw, HardDrive } from 'lucide-react';
import type { LocalUsageSavings, UsageRecord, UsageSummary } from '@/lib/usage';
import { modelDisplayName, parseModelRef, providerLabel } from '@/lib/model-providers';

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtUsd(n: number): string {
  if (n < 0.01 && n > 0) return '<$0.01';
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function DonutChart({ rows }: { rows: UsageSummary['byModel'] }) {
  const total = rows.reduce((s, r) => s + r.totalTokens, 0) || 1;
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const shades = ['#f5f5f5', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#404040'];

  return (
    <div className="usage-donut-wrap">
      <svg viewBox="0 0 100 100" className="usage-donut" aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" stroke="#262626" strokeWidth="14" />
        {rows.slice(0, 6).map((row, i) => {
          const frac = row.totalTokens / total;
          const dash = frac * c;
          const el = (
            <circle
              key={row.model}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke={shades[i % shades.length]}
              strokeWidth="14"
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 50 50)"
            />
          );
          offset += dash;
          return el;
        })}
      </svg>
      <div className="usage-donut-center">
        <div className="text-lg font-semibold">{fmtNum(total)}</div>
        <div className="text-[10px] text-dim">tokens</div>
      </div>
    </div>
  );
}

function SourceBars({ bySource }: { bySource: UsageSummary['bySource'] }) {
  const max = Math.max(...bySource.map((s) => s.totalTokens), 1);
  const labels: Record<string, string> = { chat: 'Grok Chat', agent: 'Agent runs', other: 'Other' };

  return (
    <div className="usage-source-bars space-y-3">
      {bySource.length === 0 && <div className="text-sm text-dim">No usage recorded yet.</div>}
      {bySource.map((s) => (
        <div key={s.source}>
          <div className="flex justify-between text-xs mb-1">
            <span>{labels[s.source] || s.source}</span>
            <span className="text-dim">{fmtNum(s.totalTokens)} · {fmtUsd(s.estimatedCostUsd)}</span>
          </div>
          <div className="usage-bar-track">
            <div className="usage-bar-fill" style={{ width: `${(s.totalTokens / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function LocalSavingsSection({ local }: { local: LocalUsageSavings }) {
  const defaultRef = parseModelRef(local.defaultModel);
  const defaultLabel = modelDisplayName(local.defaultModel);
  const maxTokens = Math.max(...local.byLocalModel.map((m) => m.totalTokens), 1);
  const hasSavings = local.estimatedSavingsUsd > 0;

  return (
    <div className="grok-card p-5 mb-5 usage-local-section">
      <div className="flex items-start gap-3 mb-4">
        <div className="usage-local-icon">
          <HardDrive size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Offline (local) model usage</div>
          <div className="text-xs text-dim mt-0.5">
            Tokens processed on this machine vs your configured default{' '}
            <span className="font-mono text-muted">
              {defaultLabel} ({providerLabel(defaultRef.provider)})
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Local calls', value: String(local.totalRequests) },
          { label: 'Local tokens', value: fmtNum(local.totalTokens) },
          {
            label: hasSavings ? 'Would cost (default)' : 'Hypothetical cost',
            value: fmtUsd(local.hypotheticalCostUsd),
          },
          {
            label: 'Est. savings',
            value: hasSavings ? fmtUsd(local.estimatedSavingsUsd) : '$0.00',
            highlight: hasSavings,
          },
        ].map((c) => (
          <div
            key={c.label}
            className={`usage-stat-card grok-card p-3 ${c.highlight ? 'usage-local-savings-highlight' : ''}`}
          >
            <div className="text-[10px] uppercase tracking-wider text-dim mb-1">{c.label}</div>
            <div className="text-xl font-semibold font-mono">{c.value}</div>
          </div>
        ))}
      </div>

      {hasSavings && (
        <div className="usage-local-savings-bar-wrap mb-4">
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-dim">Token cost avoided vs default cloud model</span>
            <span className="font-mono text-success">{local.savingsPct.toFixed(0)}% saved</span>
          </div>
          <div className="usage-bar-track h-2">
            <div
              className="usage-bar-fill usage-local-savings-fill"
              style={{ width: `${Math.min(100, local.savingsPct)}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-dim mt-2">
            <span>Input: {fmtNum(local.totalPromptTokens)}</span>
            <span>Output: {fmtNum(local.totalCompletionTokens)}</span>
            {local.totalReasoningTokens > 0 && (
              <span>Reasoning: {fmtNum(local.totalReasoningTokens)}</span>
            )}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="usage-table w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-dim border-b border-default">
              <th className="pb-2 pr-4">Local model</th>
              <th className="pb-2 pr-4">Calls</th>
              <th className="pb-2 pr-4">Tokens</th>
              <th className="pb-2">Est. savings vs default</th>
            </tr>
          </thead>
          <tbody>
            {local.byLocalModel.map((m) => (
              <tr key={m.model} className="border-b border-default/50">
                <td className="py-3 pr-4">
                  <div className="font-mono text-xs">
                    {modelDisplayName(m.model)}{' '}
                    <span className="text-dim">· {providerLabel(parseModelRef(m.model).provider)}</span>
                  </div>
                  <div className="usage-bar-track mt-1.5 h-1.5">
                    <div
                      className="usage-bar-fill usage-local-model-fill"
                      style={{ width: `${(m.totalTokens / maxTokens) * 100}%` }}
                    />
                  </div>
                </td>
                <td className="py-3 pr-4 font-mono">{m.requests}</td>
                <td className="py-3 pr-4 font-mono">{fmtNum(m.totalTokens)}</td>
                <td className="py-3 font-mono text-success">
                  {hasSavings ? fmtUsd(m.hypotheticalCostUsd) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[10px] text-dim mt-3">{local.note}</div>
    </div>
  );
}

function DailyChart({ byDay }: { byDay: UsageSummary['byDay'] }) {
  const max = Math.max(...byDay.map((d) => d.totalTokens), 1);

  return (
    <div className="usage-daily-chart">
      <div className="usage-daily-bars">
        {byDay.map((d) => (
          <div key={d.date} className="usage-daily-col" title={`${d.date}: ${fmtNum(d.totalTokens)} tokens, ${fmtUsd(d.estimatedCostUsd)}`}>
            <div
              className="usage-daily-bar"
              style={{ height: `${Math.max(4, (d.totalTokens / max) * 100)}%` }}
            />
            <div className="usage-daily-label">{fmtDate(d.date)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface LiveXaiStatus {
  connected: boolean;
  checkedAt: string;
  keyName?: string;
  teamId?: string;
  modelCount?: number;
  error?: string;
}

export default function UsageDashboard() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [live, setLive] = useState<LiveXaiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/usage');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to load usage');
      setSummary(data as UsageSummary);
      setLive((data.live as LiveXaiStatus) || null);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  if (loading && !summary) {
    return (
      <div className="data-loading-row py-8 text-sm">
        <span className="data-spinner data-spinner-lg" /> Loading usage data…
      </div>
    );
  }

  if (error && !summary) {
    return <div className="text-error text-sm py-8">Error: {error}</div>;
  }

  if (!summary) return null;

  const maxModelTokens = Math.max(...summary.byModel.map((m) => m.totalTokens), 1);

  return (
    <div className="usage-dashboard max-w-5xl">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <div className="text-xl font-semibold">Usage &amp; Cost</div>
          <div className="text-sm text-muted">
            Live token usage metered from every xAI API response, with estimated spend
          </div>
        </div>
        <div className="flex items-center gap-2">
          {live && (
            <span
              className={`usage-live-pill ${live.connected ? 'usage-live-connected' : 'usage-live-offline'}`}
              title={live.connected
                ? `Connected to api.x.ai${live.keyName ? ` · key: ${live.keyName}` : ''}${live.modelCount ? ` · ${live.modelCount} models` : ''} · checked ${new Date(live.checkedAt).toLocaleTimeString()}`
                : `xAI API check failed: ${live.error || 'unreachable'} · usage below is from recorded API responses`}
            >
              <span className="usage-live-dot" />
              {live.connected ? 'xAI API · live' : 'xAI API · offline'}
            </span>
          )}
          <button onClick={load} disabled={loading} className="grok-btn grok-btn-secondary text-xs">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {summary.totalRequests === 0 ? (
        <div className="grok-card p-8 text-center">
          <div className="text-muted mb-2">No API usage recorded yet</div>
          <div className="text-xs text-dim">Send a Grok Chat message or run an agent — token usage is tracked automatically from API responses.</div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'API calls', value: String(summary.totalRequests) },
              { label: 'Total tokens', value: fmtNum(summary.totalTokens) },
              { label: 'Input tokens', value: fmtNum(summary.totalPromptTokens) },
              { label: 'Est. cost', value: fmtUsd(summary.estimatedCostUsd) },
            ].map((c) => (
              <div key={c.label} className="grok-card p-4 usage-stat-card">
                <div className="text-[10px] uppercase tracking-wider text-dim mb-1">{c.label}</div>
                <div className="text-2xl font-semibold font-mono">{c.value}</div>
              </div>
            ))}
          </div>

          {summary.localSavings && <LocalSavingsSection local={summary.localSavings} />}

          <div className="grid md:grid-cols-2 gap-5 mb-5">
            <div className="grok-card p-5">
              <div className="font-semibold mb-4">Token share by model</div>
              <div className="flex flex-col sm:flex-row items-center gap-6 min-w-0">
                <DonutChart rows={summary.byModel} />
                <div className="flex-1 w-full space-y-2 min-w-0">
                  {summary.byModel.slice(0, 6).map((m, i) => (
                    <div key={m.model} className="flex items-center gap-2 text-xs min-w-0">
                      <span className="usage-legend-dot" style={{ background: ['#f5f5f5', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#404040'][i % 6] }} />
                      <span className="flex-1 truncate font-mono min-w-0" title={modelDisplayName(m.model)}>
                        {modelDisplayName(m.model)} <span className="text-dim">({providerLabel(parseModelRef(m.model).provider)})</span>
                      </span>
                      <span className="text-dim shrink-0">{m.sharePct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grok-card p-5">
              <div className="font-semibold mb-4">Usage by source</div>
              <SourceBars bySource={summary.bySource} />
            </div>
          </div>

          <div className="grok-card p-5 mb-5">
            <div className="font-semibold mb-1">Daily activity (14 days)</div>
            <div className="text-xs text-dim mb-4">Bar height = tokens consumed</div>
            <DailyChart byDay={summary.byDay} />
          </div>

          <div className="grok-card p-5 mb-5 overflow-x-auto">
            <div className="font-semibold mb-4">Per-model breakdown</div>
            <table className="usage-table w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-dim border-b border-default">
                  <th className="pb-2 pr-4">Model</th>
                  <th className="pb-2 pr-4">Calls</th>
                  <th className="pb-2 pr-4">Input</th>
                  <th className="pb-2 pr-4">Output</th>
                  <th className="pb-2 pr-4">Total</th>
                  <th className="pb-2 pr-4">Rate (in/out per 1M)</th>
                  <th className="pb-2">Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.byModel.map((m) => (
                  <tr key={m.model} className="border-b border-default/50">
                    <td className="py-3 pr-4">
                      <div className="font-mono text-xs">{modelDisplayName(m.model)} <span className="text-dim">· {providerLabel(parseModelRef(m.model).provider)}</span></div>
                      <div className="usage-bar-track mt-1.5 h-1.5">
                        <div className="usage-bar-fill" style={{ width: `${(m.totalTokens / maxModelTokens) * 100}%` }} />
                      </div>
                    </td>
                    <td className="py-3 pr-4 font-mono">{m.requests}</td>
                    <td className="py-3 pr-4 font-mono text-dim">{fmtNum(m.promptTokens)}</td>
                    <td className="py-3 pr-4 font-mono text-dim">{fmtNum(m.completionTokens)}</td>
                    <td className="py-3 pr-4 font-mono">{fmtNum(m.totalTokens)}</td>
                    <td className="py-3 pr-4 text-xs text-dim">${m.inputPer1M} / ${m.outputPer1M}</td>
                    <td className="py-3 font-mono">{fmtUsd(m.estimatedCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {summary.recent.length > 0 && (
            <div className="grok-card p-5">
              <div className="font-semibold mb-4">Recent API calls</div>
              <div className="space-y-2">
                {summary.recent.map((r: UsageRecord) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs py-2 border-b border-default/40 last:border-0">
                    <span className="font-mono text-dim">{new Date(r.ts).toLocaleString()}</span>
                    <span className="font-mono">{modelDisplayName(r.model)} ({providerLabel(parseModelRef(r.model).provider)})</span>
                    <span className="badge badge-accent">{r.source}</span>
                    <span className="text-dim">{fmtNum(r.totalTokens)} tok</span>
                    <span className="ml-auto font-mono">{fmtUsd(r.estimatedCostUsd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="text-[10px] text-dim mt-4">{summary.pricingNote}</div>
    </div>
  );
}