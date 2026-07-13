'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, HardDrive } from 'lucide-react';
import type { LocalUsageSavings, UsageRecord, UsageSummary } from '@/lib/usage';
import { modelDisplayName, parseModelRef, providerLabel } from '@/lib/model-providers';
import { invalidateClientJson, loadClientJson } from '@/lib/client-json';

const USAGE_URL = '/api/usage';
const USAGE_REFRESH_URL = '/api/usage?refresh=1';

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

interface XaiAccountUsage {
  available: boolean;
  checkedAt: string;
  teamId?: string;
  authSource?: string | null;
  prepaidBalanceUsd?: number;
  monthToDateCostUsd?: number;
  spendingLimitUsd?: number;
  billingCycle?: { year: number; month: number };
  byModel: Array<{
    model: string;
    label: string;
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    otherTokens: number;
    totalTokens: number;
  }>;
  byDay: Array<{ date: string; costUsd: number; totalTokens: number }>;
  rangeStart?: string;
  rangeEnd?: string;
  error?: string;
  note: string;
}

function XaiAccountSection({ xai }: { xai: XaiAccountUsage }) {
  const maxCost = Math.max(...xai.byModel.map((m) => m.costUsd), 0.0001);
  const maxDay = Math.max(...xai.byDay.map((d) => d.costUsd), 0.0001);

  if (!xai.available) {
    return (
      <div className="grok-card p-5 mb-5 usage-xai-account">
        <div className="font-semibold mb-1">xAI account usage</div>
        <div className="text-xs text-dim mb-2">
          Authoritative costs from the xAI Billing API (same data as Console → Usage).
        </div>
        <div className="text-sm text-muted">
          {xai.error || 'Not available'} — {xai.note}
        </div>
        <div className="text-[10px] text-dim mt-2">
          Tip: add a Management Key in Settings (Console → Settings → Management Keys) if your inference key cannot read billing.
        </div>
      </div>
    );
  }

  return (
    <div className="grok-card p-5 mb-5 usage-xai-account">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
        <div>
          <div className="font-semibold">xAI account usage</div>
          <div className="text-xs text-dim mt-0.5">
            Backported from xAI Billing API
            {xai.billingCycle ? ` · cycle ${xai.billingCycle.year}-${String(xai.billingCycle.month).padStart(2, '0')}` : ''}
            {xai.rangeStart && xai.rangeEnd ? ` · ${xai.rangeStart} → ${xai.rangeEnd}` : ''}
            {xai.authSource ? ` · via ${xai.authSource}` : ''}
          </div>
        </div>
        <span className="usage-live-pill usage-live-connected" title={xai.note}>
          <span className="usage-live-dot" />
          Billing · live
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          {
            label: 'Month-to-date spend',
            value: xai.monthToDateCostUsd != null ? fmtUsd(xai.monthToDateCostUsd) : '—',
          },
          {
            label: 'Prepaid balance',
            value: xai.prepaidBalanceUsd != null ? fmtUsd(xai.prepaidBalanceUsd) : '—',
          },
          {
            label: 'Spending limit',
            value: xai.spendingLimitUsd != null ? fmtUsd(xai.spendingLimitUsd) : '—',
          },
          {
            label: 'Models with usage',
            value: String(xai.byModel.length),
          },
        ].map((c) => (
          <div key={c.label} className="usage-stat-card grok-card p-3">
            <div className="text-[10px] uppercase tracking-wider text-dim mb-1">{c.label}</div>
            <div className="text-xl font-semibold font-mono">{c.value}</div>
          </div>
        ))}
      </div>

      {xai.byDay.some((d) => d.costUsd > 0) && (
        <div className="mb-4">
          <div className="text-xs text-dim mb-2">Daily spend (14 days) — from xAI</div>
          <div className="usage-daily-bars">
            {xai.byDay.map((d) => (
              <div key={d.date} className="usage-daily-col" title={`${d.date}: ${fmtUsd(d.costUsd)}`}>
                <div
                  className="usage-daily-bar"
                  style={{ height: `${Math.max(4, (d.costUsd / maxDay) * 100)}%` }}
                />
                <div className="usage-daily-label">{fmtDate(d.date)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {xai.byModel.length > 0 && (
        <div className="overflow-x-auto">
          <table className="usage-table w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-dim border-b border-default">
                <th className="pb-2 pr-4">Model (xAI)</th>
                <th className="pb-2 pr-4">Input tok</th>
                <th className="pb-2 pr-4">Output tok</th>
                <th className="pb-2 pr-4">Total tok</th>
                <th className="pb-2">Billed cost</th>
              </tr>
            </thead>
            <tbody>
              {xai.byModel.map((m) => (
                <tr key={m.model + m.label} className="border-b border-default/50">
                  <td className="py-3 pr-4">
                    <div className="font-mono text-xs">{m.model}</div>
                    {m.label !== m.model && (
                      <div className="text-[10px] text-dim truncate" title={m.label}>{m.label}</div>
                    )}
                    <div className="usage-bar-track mt-1.5 h-1.5">
                      <div
                        className="usage-bar-fill"
                        style={{ width: `${(m.costUsd / maxCost) * 100}%` }}
                      />
                    </div>
                  </td>
                  <td className="py-3 pr-4 font-mono text-dim">{m.promptTokens ? fmtNum(m.promptTokens) : '—'}</td>
                  <td className="py-3 pr-4 font-mono text-dim">{m.completionTokens ? fmtNum(m.completionTokens) : '—'}</td>
                  <td className="py-3 pr-4 font-mono">{m.totalTokens ? fmtNum(m.totalTokens) : '—'}</td>
                  <td className="py-3 font-mono">{fmtUsd(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-[10px] text-dim mt-3">{xai.note}</div>
    </div>
  );
}

interface UsageBadge {
  costUsd: number;
  source: 'xai' | 'local';
  pref: 'auto' | 'xai' | 'local';
}

/**
 * Explains the sidebar "Usage" badge in place: the exact figure, which source
 * it resolved to, why that source was chosen, and — when the billed number
 * differs from the studio estimate — how to reconcile the two.
 */
function UsageBadgeExplainer({
  badge,
  studioEstimateUsd,
}: {
  badge: UsageBadge;
  studioEstimateUsd: number;
}) {
  const isXai = badge.source === 'xai';
  const sourceName = isXai ? 'xAI billing' : 'studio metering';
  const sourceDesc = isXai
    ? 'your account’s month-to-date spend, pulled live from the xAI Billing API'
    : 'estimated from the tokens this app sent and received, priced at public xAI rates';

  const prefLine =
    badge.pref === 'auto'
      ? 'Source: Auto — xAI billing when a Management Key or cloud sign-in can read it, otherwise studio metering.'
      : badge.pref === 'xai'
        ? 'Source: xAI billing (pinned in Settings → Cost & safety).'
        : 'Source: Studio metering (pinned in Settings → Cost & safety).';

  // Only reconcile when the billed figure is authoritative AND the studio
  // estimate is materially higher (the usual cached-token-discount gap).
  const showGap = isXai && studioEstimateUsd > badge.costUsd + 0.01;

  return (
    <div className="grok-card p-5 mb-5 usage-badge-explainer">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs uppercase tracking-wider text-dim">Sidebar “Usage” badge</span>
        <span className="text-2xl font-semibold font-mono">{fmtUsd(badge.costUsd)}</span>
        <span className={`usage-source-tag ${isXai ? 'usage-source-xai' : 'usage-source-local'}`}>
          {isXai ? 'xAI billing' : 'studio metering'}
        </span>
      </div>
      <div className="text-sm text-muted mt-2">
        The <strong>{fmtUsd(badge.costUsd)}</strong> in your sidebar is <strong>{sourceName}</strong> — {sourceDesc}.
      </div>
      <div className="text-xs text-dim mt-1">{prefLine}</div>
      {showGap && (
        <div className="text-xs text-muted mt-2 usage-badge-gap">
          Studio metering below estimates <strong>{fmtUsd(studioEstimateUsd)}</strong> from full public
          per-token rates. The billed figure is lower because xAI discounts cached-prompt tokens and
          applies your account’s actual pricing — the sidebar shows the billed number.
        </div>
      )}
      {!isXai && (
        <div className="text-xs text-dim mt-2">
          This is an estimate. Add a Management Key (or cloud sign-in) in Settings to show authoritative
          billed spend from xAI instead.
        </div>
      )}
    </div>
  );
}

export default function UsageDashboard() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [xaiAccount, setXaiAccount] = useState<XaiAccountUsage | null>(null);
  const [authoritativeCostUsd, setAuthoritativeCostUsd] = useState<number | null>(null);
  const [usageBadge, setUsageBadge] = useState<UsageBadge | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);

  const load = useCallback(async (force = false, signal?: AbortSignal) => {
    const requestId = ++loadRequestRef.current;
    const url = force ? USAGE_REFRESH_URL : USAGE_URL;
    if (force) {
      invalidateClientJson(USAGE_URL);
      invalidateClientJson(USAGE_REFRESH_URL);
    }
    setLoading(true);
    setError(null);
    try {
      const data = await loadClientJson<UsageSummary & {
        ok?: boolean;
        error?: string;
        xaiAccount?: XaiAccountUsage;
        authoritativeCostUsd?: number;
        usageBadge?: UsageBadge;
      }>(url, { maxAgeMs: force ? 0 : 10_000, signal });
      if (!data.ok) throw new Error(data.error || 'Failed to load usage');
      if (signal?.aborted || requestId !== loadRequestRef.current) return;
      setSummary(data as UsageSummary);
      setXaiAccount((data.xaiAccount as XaiAccountUsage) || null);
      setAuthoritativeCostUsd(
        typeof data.authoritativeCostUsd === 'number' ? data.authoritativeCostUsd : null,
      );
      setUsageBadge((data.usageBadge as UsageBadge) || null);
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return;
      if (!signal?.aborted && requestId === loadRequestRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to load usage');
      }
    } finally {
      if (!signal?.aborted && requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(false, controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  if (loading && !summary) {
    return (
      <div className="data-loading-row py-8 text-sm">
        <span className="data-spinner data-spinner-lg" /> Loading usage data…
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="py-8 text-sm">
        <div className="text-error mb-3">Error: {error}</div>
        <button type="button" className="grok-btn grok-btn-secondary text-xs" onClick={() => void load(true)}>
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );
  }

  if (!summary) return null;

  const maxModelTokens = Math.max(...summary.byModel.map((m) => m.totalTokens), 1);
  const hasLocal = summary.totalRequests > 0;
  const hasXai = !!xaiAccount?.available;

  return (
    <div className="usage-dashboard page-content">
      <div className="page-head-row">
        <div className="min-w-0">
          <div className="page-title">Usage &amp; Cost</div>
          <div className="page-subtitle">
            {hasXai
              ? 'Account spend from the xAI Billing API, plus this app’s local metering'
              : 'Local metering from API responses — connect billing to backport official model usage'}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => void load(true)} disabled={loading} className="grok-btn grok-btn-secondary text-xs">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="grok-card p-3 mb-4 flex flex-wrap items-center gap-3 text-sm text-warning" role="alert">
          <span className="flex-1 min-w-[14rem]">
            Refresh failed: {error}. Showing the last successfully loaded usage data.
          </span>
          <button
            type="button"
            className="grok-btn grok-btn-secondary text-xs"
            onClick={() => void load(true)}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Retry
          </button>
        </div>
      )}

      {usageBadge && (
        <UsageBadgeExplainer badge={usageBadge} studioEstimateUsd={summary.estimatedCostUsd} />
      )}

      {xaiAccount && <XaiAccountSection xai={xaiAccount} />}

      {!hasLocal && !hasXai && (
        <div className="grok-card p-8 text-center">
          <div className="text-muted mb-2">No usage data yet</div>
          <div className="text-xs text-dim">
            Send a Grok Chat message or run an agent — or add cloud credentials / a Management Key to pull account usage from xAI.
          </div>
        </div>
      )}

      {hasLocal && (
        <>
          <div className="text-sm font-medium mb-2 text-muted">This app (studio metering)</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'API calls', value: String(summary.totalRequests) },
              { label: 'Total tokens', value: fmtNum(summary.totalTokens) },
              { label: 'Input tokens', value: fmtNum(summary.totalPromptTokens) },
              {
                label: hasXai ? 'Est. cost (studio)' : 'Est. cost',
                value: fmtUsd(
                  authoritativeCostUsd != null && !hasXai
                    ? authoritativeCostUsd
                    : summary.estimatedCostUsd,
                ),
              },
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
