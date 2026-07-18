'use client';

import {
  Activity,
  BarChart3,
  ExternalLink,
  Eye,
  GitBranch,
  Globe2,
  HeartPulse,
  Loader2,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface CountRow {
  name?: string;
  label?: string;
  title?: string;
  path?: string;
  count?: number | string;
  visits?: number | string;
  uniques?: number | string;
}

interface DailyRow {
  date?: string;
  timestamp?: string;
  count?: number | string;
  visits?: number | string;
  uniques?: number | string;
}

interface RepositoryMetric {
  count?: number | string;
  uniques?: number | string;
  daily?: DailyRow[];
}

interface SiteTrafficSnapshot {
  ok?: boolean;
  error?: string;
  stale?: boolean;
  generatedAt?: string;
  repository?: {
    connected?: boolean;
    rangeLabel?: string;
    views?: RepositoryMetric;
    clones?: RepositoryMetric;
    referrers?: CountRow[];
    paths?: CountRow[];
    error?: string;
  };
  siteHealth?: {
    ok?: boolean;
    status?: number | string;
    latencyMs?: number | string;
    checkedAt?: string;
    error?: string;
  };
  pages?: {
    status?: string;
    htmlUrl?: string;
    cname?: string;
    httpsEnforced?: boolean;
    buildType?: string;
    source?: string | { branch?: string; path?: string };
    latestBuild?: string | { status?: string; updatedAt?: string; commit?: string };
    certificate?: string | { state?: string; description?: string };
    error?: string;
  };
}

interface NormalizedCountRow {
  label: string;
  count: number;
  uniques?: number;
}

interface NormalizedDailyRow {
  date: string;
  count: number;
  uniques?: number;
}

const TRAFFIC_ENDPOINT = '/api/site-traffic';
const compactNumber = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function toFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.replaceAll(',', ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function formatCount(value: number | undefined): string {
  if (value == null) return '—';
  return Math.abs(value) < 1_000 ? value.toLocaleString() : compactNumber.format(value);
}

function formatDateLabel(value: string): string {
  const parsed = new Date(value.includes('T') ? value : `${value}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTimestamp(value?: string): string {
  if (!value) return 'Not reported';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

function normalizeDaily(rows?: DailyRow[]): NormalizedDailyRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const date = row.date || row.timestamp;
    const count = toFiniteNumber(row.count, row.visits);
    return date && count != null
      ? [{ date, count: Math.max(0, count), uniques: toFiniteNumber(row.uniques) }]
      : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeCounts(rows?: CountRow[]): NormalizedCountRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const label = row.name || row.label || row.path || row.title;
    const count = toFiniteNumber(row.count, row.visits);
    return label && count != null
      ? [{ label, count: Math.max(0, count), uniques: toFiniteNumber(row.uniques) }]
      : [];
  });
}

function StatusPill({
  tone,
  children,
}: {
  tone: 'live' | 'quiet' | 'warning' | 'error';
  children: React.ReactNode;
}) {
  return (
    <span className={`site-traffic-pill site-traffic-pill-${tone}`}>
      <span className="site-traffic-pill-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value?: number;
  hint: string;
}) {
  return (
    <div className="grok-card site-traffic-metric">
      <div className="site-traffic-metric-label">{label}</div>
      <div className={value == null ? 'site-traffic-metric-value site-traffic-value-muted' : 'site-traffic-metric-value'}>
        {formatCount(value)}
      </div>
      <div className="site-traffic-metric-hint">{hint}</div>
    </div>
  );
}

function DailyBars({ rows }: { rows: NormalizedDailyRow[] }) {
  if (!rows.length) {
    return <div className="site-traffic-empty-chart">GitHub did not return a daily view series.</div>;
  }
  const maximum = Math.max(...rows.map((row) => row.count), 1);
  return (
    <div className="site-traffic-chart-scroll" tabIndex={0} aria-label="GitHub repository views by day">
      <div
        className="site-traffic-chart"
        style={{ '--site-traffic-chart-width': `${Math.max(640, rows.length * 32)}px` } as React.CSSProperties}
        role="img"
        aria-label="GitHub repository views during the rolling 14-day window"
      >
        {rows.map((row, index) => (
          <div
            key={row.date}
            className="site-traffic-chart-column"
            title={`${formatDateLabel(row.date)}: ${row.count.toLocaleString()} views${row.uniques != null ? `, ${row.uniques.toLocaleString()} unique` : ''}`}
          >
            <div className="site-traffic-chart-value">{row.count ? formatCount(row.count) : ''}</div>
            <div className="site-traffic-chart-track" aria-hidden="true">
              <div
                className="site-traffic-chart-bar"
                style={{ height: `${row.count ? Math.max(6, (row.count / maximum) * 100) : 2}%` }}
              />
            </div>
            <div className="site-traffic-chart-label">
              {index === 0 || index === rows.length - 1 || index % 2 === 0
                ? formatDateLabel(row.date)
                : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RankedList({ rows, emptyLabel }: { rows: NormalizedCountRow[]; emptyLabel: string }) {
  if (!rows.length) return <div className="site-traffic-empty-list">{emptyLabel}</div>;
  const visible = rows.slice(0, 8);
  const maximum = Math.max(...visible.map((row) => row.count), 1);
  return (
    <div className="site-traffic-ranked-list">
      {visible.map((row, index) => (
        <div className="site-traffic-ranked-row" key={`${row.label}-${index}`}>
          <div className="site-traffic-ranked-copy">
            <span className="site-traffic-ranked-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="site-traffic-ranked-label" title={row.label}>{row.label}</span>
            <span className="site-traffic-ranked-count">
              {formatCount(row.count)}
              {row.uniques != null ? <small>{formatCount(row.uniques)} unique</small> : null}
            </span>
          </div>
          <div className="site-traffic-list-track" aria-hidden="true">
            <div className="site-traffic-list-fill" style={{ width: `${Math.max(3, (row.count / maximum) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function sourceLabel(source?: string | { branch?: string; path?: string }): string {
  if (!source) return 'Not reported';
  if (typeof source === 'string') return source;
  return `${source.branch || 'unknown branch'}${source.path ? ` ${source.path}` : ''}`;
}

export default function SiteTrafficDashboard() {
  const [snapshot, setSnapshot] = useState<SiteTrafficSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal, refresh = false) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`${TRAFFIC_ENDPOINT}${refresh ? '?refresh=1' : ''}`, {
        cache: 'no-store',
        signal,
      });
      const data = await response.json().catch(() => null) as SiteTrafficSnapshot | null;
      if (!response.ok || !data || data.ok === false) {
        throw new Error(data?.error || `Traffic service returned ${response.status}`);
      }
      if (!signal?.aborted && requestId === requestIdRef.current) setSnapshot(data);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (!signal?.aborted && requestId === requestIdRef.current) {
        setLoadError(error instanceof Error ? error.message : 'Unable to load repository traffic');
      }
    } finally {
      if (!signal?.aborted && requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const daily = useMemo(() => normalizeDaily(snapshot?.repository?.views?.daily), [snapshot]);
  const referrers = useMemo(() => normalizeCounts(snapshot?.repository?.referrers), [snapshot]);
  const paths = useMemo(() => normalizeCounts(snapshot?.repository?.paths), [snapshot]);
  const views = toFiniteNumber(snapshot?.repository?.views?.count);
  const uniqueViews = toFiniteNumber(snapshot?.repository?.views?.uniques);
  const clones = toFiniteNumber(snapshot?.repository?.clones?.count);
  const uniqueClones = toFiniteNumber(snapshot?.repository?.clones?.uniques);
  const latency = snapshot?.siteHealth?.ok ? toFiniteNumber(snapshot.siteHealth.latencyMs) : undefined;
  const build = snapshot?.pages?.latestBuild;
  const buildLabel = typeof build === 'string'
    ? build
    : [build?.status, build?.commit?.slice(0, 8), formatTimestamp(build?.updatedAt)]
        .filter((value) => value && value !== 'Not reported')
        .join(' · ') || 'Not reported';
  const certificate = snapshot?.pages?.certificate;
  const certificateLabel = typeof certificate === 'string'
    ? certificate
    : certificate?.state || certificate?.description || 'Not reported';

  return (
    <div className="site-traffic-dashboard page-content">
      <div className="site-traffic-atmosphere" aria-hidden="true" />
      <div className="page-head-row site-traffic-header">
        <div className="min-w-0">
          <div className="site-traffic-eyebrow">SHIBA-STUDIO.IO · MISSION CONTROL</div>
          <h1 className="page-title">Repository Traffic</h1>
          <div className="page-subtitle">GitHub repository discovery, Pages delivery, and site health.</div>
        </div>
        <div className="site-traffic-header-actions">
          <a href="https://shiba-studio.io/traffic/" target="_blank" rel="noreferrer" className="grok-btn grok-btn-ghost text-xs">
            <Globe2 size={14} aria-hidden="true" /> Open public page <ExternalLink size={11} aria-hidden="true" />
          </a>
          <button type="button" className="grok-btn grok-btn-secondary text-xs" disabled={loading} onClick={() => void load(undefined, true)}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>

      {loadError && snapshot ? (
        <div className="site-traffic-banner site-traffic-banner-warning" role="alert">
          <Activity size={16} aria-hidden="true" />
          <span><strong>Live refresh failed.</strong> Showing the last snapshot. {loadError}</span>
        </div>
      ) : null}

      {loading && !snapshot ? (
        <div className="site-traffic-loading" role="status">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" />
          <div><strong>Loading repository traffic</strong><span>Contacting GitHub and shiba-studio.io…</span></div>
        </div>
      ) : null}

      {loadError && !snapshot ? (
        <div className="grok-card site-traffic-fatal" role="alert">
          <div className="site-traffic-fatal-icon"><Unplug size={22} aria-hidden="true" /></div>
          <div><h2>Traffic monitor unavailable</h2><p>{loadError}</p></div>
          <button type="button" className="grok-btn grok-btn-primary" onClick={() => void load(undefined, true)}>
            <RefreshCw size={14} aria-hidden="true" /> Try again
          </button>
        </div>
      ) : null}

      {snapshot ? (
        <>
          <section className="site-traffic-section" aria-labelledby="repository-traffic-heading">
            <div className="site-traffic-section-head">
              <div>
                <div className="site-traffic-section-kicker">01 · REPOSITORY DISCOVERY</div>
                <h2 id="repository-traffic-heading">GitHub repository activity</h2>
                <p>Rolling 14-day repository views and clones. These numbers are not website visitors.</p>
              </div>
              {snapshot.repository?.connected
                ? <StatusPill tone="live">GitHub connected</StatusPill>
                : <StatusPill tone="quiet">GitHub data unavailable</StatusPill>}
            </div>
            <div className="site-traffic-data-scope">
              <GitBranch size={16} aria-hidden="true" />
              <span><strong>Repository scope:</strong> <span className="font-mono">stevologic/shiba-studio</span> on GitHub.</span>
            </div>
            {snapshot.repository?.error ? (
              <div className="site-traffic-banner site-traffic-banner-warning" role="alert">
                <Activity size={16} aria-hidden="true" /><span>{snapshot.repository.error}</span>
              </div>
            ) : null}
            <div className="site-traffic-metrics">
              <MetricCard label="Repository views" value={views} hint={snapshot.repository?.rangeLabel || 'Rolling 14 days'} />
              <MetricCard label="Unique viewers" value={uniqueViews} hint="GitHub repository uniques" />
              <MetricCard label="Full clones" value={clones} hint="Fetches are not included" />
              <MetricCard label="Unique cloners" value={uniqueClones} hint="Rolling GitHub window" />
            </div>
            <div className="grok-card site-traffic-card site-traffic-repo-chart">
              <div className="site-traffic-card-head">
                <div><div className="site-traffic-card-kicker">GITHUB VIEWS</div><h3>Repository pulse</h3></div>
                <span className="site-traffic-mono-note">14D · UTC</span>
              </div>
              <DailyBars rows={daily} />
            </div>
            <div className="site-traffic-two-column">
              <div className="grok-card site-traffic-card">
                <div className="site-traffic-card-head">
                  <div><div className="site-traffic-card-kicker">GITHUB REFERRERS</div><h3>Repository discovery</h3></div>
                  <BarChart3 size={17} aria-hidden="true" />
                </div>
                <RankedList rows={referrers} emptyLabel="No GitHub referrers reported." />
              </div>
              <div className="grok-card site-traffic-card">
                <div className="site-traffic-card-head">
                  <div><div className="site-traffic-card-kicker">POPULAR CONTENT</div><h3>Repository paths</h3></div>
                  <Eye size={17} aria-hidden="true" />
                </div>
                <RankedList rows={paths} emptyLabel="No popular repository paths reported." />
              </div>
            </div>
          </section>

          <section className="site-traffic-section" aria-labelledby="site-health-heading">
            <div className="site-traffic-section-head">
              <div>
                <div className="site-traffic-section-kicker">02 · DELIVERY</div>
                <h2 id="site-health-heading">Site health &amp; GitHub Pages</h2>
                <p>Reachability, deployment, custom-domain, and certificate signals.</p>
              </div>
              {snapshot.siteHealth?.ok
                ? <StatusPill tone="live">Site reachable</StatusPill>
                : <StatusPill tone="error">Health check failed</StatusPill>}
            </div>
            <div className="site-traffic-health-grid">
              <div className="grok-card site-traffic-health-card">
                <div className="site-traffic-health-orb" data-ok={snapshot.siteHealth?.ok === true}>
                  <HeartPulse size={22} aria-hidden="true" />
                </div>
                <div className="site-traffic-health-copy">
                  <div className="site-traffic-card-kicker">LIVE ENDPOINT</div>
                  <h3>{snapshot.siteHealth?.ok ? 'shiba-studio.io is online' : 'Site check needs attention'}</h3>
                  <p>{snapshot.siteHealth?.error || 'HTTPS reachability check completed.'}</p>
                </div>
                <dl className="site-traffic-health-stats">
                  <div><dt>Status</dt><dd>{snapshot.siteHealth?.status ?? '—'}</dd></div>
                  <div><dt>Latency</dt><dd>{latency == null ? '—' : `${Math.round(latency)} ms`}</dd></div>
                  <div><dt>Checked</dt><dd>{formatTimestamp(snapshot.siteHealth?.checkedAt)}</dd></div>
                </dl>
              </div>
              <div className="grok-card site-traffic-pages-card">
                <div className="site-traffic-card-head">
                  <div><div className="site-traffic-card-kicker">GITHUB PAGES</div><h3>Deployment state</h3></div>
                  <Globe2 size={17} aria-hidden="true" />
                </div>
                {snapshot.pages?.error ? <div className="site-traffic-inline-error">{snapshot.pages.error}</div> : null}
                <dl className="site-traffic-detail-list">
                  <div><dt>Status</dt><dd>{snapshot.pages?.status || 'Not reported'}</dd></div>
                  <div><dt>Custom domain</dt><dd>{snapshot.pages?.cname || 'Not configured'}</dd></div>
                  <div><dt>HTTPS</dt><dd>{snapshot.pages?.httpsEnforced == null ? 'Not reported' : snapshot.pages.httpsEnforced ? 'Enforced' : 'Not enforced'}</dd></div>
                  <div><dt>Source</dt><dd>{sourceLabel(snapshot.pages?.source)}</dd></div>
                  <div><dt>Build type</dt><dd>{snapshot.pages?.buildType || 'Not reported'}</dd></div>
                  <div><dt>Latest build</dt><dd>{buildLabel}</dd></div>
                  <div><dt>Certificate</dt><dd>{certificateLabel}</dd></div>
                </dl>
                {snapshot.pages?.htmlUrl ? (
                  <a className="site-traffic-pages-link" href={snapshot.pages.htmlUrl} target="_blank" rel="noreferrer">
                    Open GitHub Pages settings <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </div>
          </section>
          <footer className="site-traffic-footer">
            <span>Snapshot generated <span className="font-mono">{formatTimestamp(snapshot.generatedAt)}</span></span>
            <span className={snapshot.stale ? 'site-traffic-freshness is-stale' : 'site-traffic-freshness'}>
              <span aria-hidden="true" />{snapshot.stale ? 'Cached snapshot' : 'Live snapshot'}
            </span>
          </footer>
        </>
      ) : null}
    </div>
  );
}
