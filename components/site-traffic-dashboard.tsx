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
  ShieldCheck,
  Unplug,
  Wrench,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type TrafficRange = 7 | 30 | 90;
type PendingAction = 'save' | 'install' | 'disconnect' | 'forget' | null;

interface CountRow {
  name?: string;
  label?: string;
  title?: string;
  path?: string;
  count?: number | string;
  value?: number | string;
  visits?: number | string;
  uniques?: number | string;
}

interface DailyRow {
  date?: string;
  timestamp?: string;
  day?: string;
  count?: number | string;
  value?: number | string;
  visits?: number | string;
  uniques?: number | string;
}

interface AudienceTraffic {
  configured?: boolean;
  connected?: boolean;
  siteCode?: string;
  trackerInstalled?: boolean;
  trackerPartial?: boolean;
  trackerVerified?: boolean;
  totalVisits?: number | string;
  rangeVisits?: number | string;
  eventCount?: number | string;
  dailyIncludesEvents?: boolean;
  total?: number | string | {
    count?: number | string;
    visits?: number | string;
    total?: number | string;
  };
  daily?: DailyRow[];
  topPages?: CountRow[];
  referrers?: CountRow[];
  browsers?: CountRow[];
  systems?: CountRow[];
  locations?: CountRow[];
  error?: string;
}

interface RepositoryMetric {
  count?: number | string;
  total?: number | string;
  uniques?: number | string;
  unique?: number | string;
  daily?: DailyRow[];
}

interface RepositoryTraffic {
  connected?: boolean;
  rangeLabel?: string;
  views?: RepositoryMetric;
  clones?: RepositoryMetric;
  referrers?: CountRow[];
  paths?: CountRow[];
  error?: string;
}

interface SiteHealth {
  ok?: boolean;
  status?: number | string;
  latencyMs?: number | string;
  checkedAt?: string;
  error?: string;
}

interface PagesStatus {
  status?: string;
  htmlUrl?: string;
  cname?: string;
  httpsEnforced?: boolean;
  buildType?: string;
  source?: string | { branch?: string; path?: string };
  latestBuild?: string | { status?: string; updatedAt?: string; commit?: string };
  certificate?: string | { state?: string; description?: string };
  error?: string;
}

interface SiteTrafficSnapshot {
  ok?: boolean;
  error?: string;
  stale?: boolean;
  generatedAt?: string;
  audience?: AudienceTraffic;
  repository?: RepositoryTraffic;
  siteHealth?: SiteHealth;
  pages?: PagesStatus;
}

interface TrackerPatchFile {
  path?: string;
  ok?: boolean;
  changed?: boolean;
  status?: string;
  error?: string;
}

interface TrafficErrorBody {
  error?: string;
  code?: string;
  result?: {
    files?: TrackerPatchFile[];
  };
}

class TrafficApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly files: TrackerPatchFile[] = [],
  ) {
    super(message);
    this.name = 'TrafficApiError';
  }
}

interface NormalizedCountRow {
  label: string;
  count?: number;
  uniques?: number;
}

interface NormalizedDailyRow {
  date: string;
  count: number;
  uniques?: number;
}

const TRAFFIC_ENDPOINT = '/api/site-traffic';
const RANGE_OPTIONS: TrafficRange[] = [7, 30, 90];
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
  if (Math.abs(value) < 1_000) return value.toLocaleString();
  return compactNumber.format(value);
}

function formatDateLabel(value: string): string {
  const parsed = new Date(value.includes('T') ? value : `${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTimestamp(value?: string): string {
  if (!value) return 'Not reported';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeDaily(rows: DailyRow[] | undefined): NormalizedDailyRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row, index) => {
    if (!row || typeof row !== 'object') return [];
    const date = row.date || row.timestamp || row.day;
    const count = toFiniteNumber(row.count, row.visits, row.value);
    if (!date || count == null) return [];
    return [{
      date,
      count: Math.max(0, count),
      uniques: toFiniteNumber(row.uniques),
      index,
    }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeCounts(rows: CountRow[] | undefined): NormalizedCountRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const label = row.name || row.label || row.path || row.title;
    const count = toFiniteNumber(row.count, row.visits, row.value);
    if (!label || count == null) return [];
    return [{
      label,
      count: Math.max(0, count),
      uniques: toFiniteNumber(row.uniques),
    }];
  });
}

async function readJsonResponse(response: Response): Promise<SiteTrafficSnapshot> {
  const body = await response.json().catch(() => null) as
    | (SiteTrafficSnapshot & TrafficErrorBody)
    | null;
  if (!response.ok || body?.ok === false) {
    throw new TrafficApiError(
      body?.error || `Traffic service returned ${response.status}`,
      body?.code,
      Array.isArray(body?.result?.files) ? body.result.files : [],
    );
  }
  if (!body || typeof body !== 'object') {
    throw new Error('Traffic service returned an invalid response');
  }
  return body;
}

function patchFailureDetails(files: TrackerPatchFile[]): string {
  return files
    .slice(0, 4)
    .map((file) => {
      const path = file.path || 'unknown file';
      if (file.ok) return `${path}: ${file.status || (file.changed ? 'updated' : 'unchanged')}`;
      return `${path}: ${file.error || 'failed'}`;
    })
    .join(' · ');
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
  unavailable = false,
}: {
  label: string;
  value: number | undefined;
  hint: string;
  unavailable?: boolean;
}) {
  return (
    <div className="grok-card site-traffic-metric">
      <div className="site-traffic-metric-label">{label}</div>
      <div className={unavailable ? 'site-traffic-metric-value site-traffic-value-muted' : 'site-traffic-metric-value'}>
        {formatCount(value)}
      </div>
      <div className="site-traffic-metric-hint">{hint}</div>
    </div>
  );
}

function DailyBars({
  rows,
  label,
  emptyLabel,
  unitSingular,
  unitPlural,
}: {
  rows: NormalizedDailyRow[];
  label: string;
  emptyLabel: string;
  unitSingular: string;
  unitPlural: string;
}) {
  if (rows.length === 0) {
    return <div className="site-traffic-empty-chart">{emptyLabel}</div>;
  }

  const maximum = Math.max(...rows.map((row) => row.count), 1);
  const labelEvery = rows.length > 45 ? 15 : rows.length > 18 ? 7 : Math.max(1, Math.ceil(rows.length / 7));

  return (
    <div
      className="site-traffic-chart-scroll"
      tabIndex={0}
      aria-label={`${label}. Scroll horizontally to inspect the chart.`}
    >
      <div
        className="site-traffic-chart"
        style={{ '--site-traffic-chart-width': `${Math.max(640, rows.length * 16)}px` } as React.CSSProperties}
        role="img"
        aria-label={label}
      >
        {rows.map((row, index) => {
          const height = row.count === 0 ? 2 : Math.max(6, (row.count / maximum) * 100);
          const showLabel = index === 0 || index === rows.length - 1 || index % labelEvery === 0;
          return (
            <div
              key={`${row.date}-${index}`}
              className="site-traffic-chart-column"
              title={`${formatDateLabel(row.date)}: ${row.count.toLocaleString()} ${row.count === 1 ? unitSingular : unitPlural}${row.uniques != null ? `, ${row.uniques.toLocaleString()} unique` : ''}`}
            >
              <div className="site-traffic-chart-value">{row.count > 0 ? formatCount(row.count) : ''}</div>
              <div className="site-traffic-chart-track" aria-hidden="true">
                <div className="site-traffic-chart-bar" style={{ height: `${height}%` }} />
              </div>
              <div className="site-traffic-chart-label">{showLabel ? formatDateLabel(row.date) : ''}</div>
            </div>
          );
        })}
      </div>
      <ul className="sr-only" aria-label={`${label} data`}>
        {rows.map((row) => (
          <li key={`accessible-${row.date}`}>
            {formatDateLabel(row.date)}: {row.count.toLocaleString()} {row.count === 1 ? unitSingular : unitPlural}
            {row.uniques != null ? `, ${row.uniques.toLocaleString()} unique` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RankedList({
  rows,
  emptyLabel,
  showUniques = false,
}: {
  rows: NormalizedCountRow[];
  emptyLabel: string;
  showUniques?: boolean;
}) {
  if (rows.length === 0) {
    return <div className="site-traffic-empty-list">{emptyLabel}</div>;
  }

  const visibleRows = rows.slice(0, 8);
  const maximum = Math.max(...visibleRows.map((row) => row.count || 0), 1);

  return (
    <div className="site-traffic-ranked-list">
      {visibleRows.map((row, index) => (
        <div className="site-traffic-ranked-row" key={`${row.label}-${index}`}>
          <div className="site-traffic-ranked-copy">
            <span className="site-traffic-ranked-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="site-traffic-ranked-label" title={row.label}>{row.label}</span>
            <span className="site-traffic-ranked-count">
              {formatCount(row.count)}
              {showUniques && row.uniques != null ? <small>{formatCount(row.uniques)} unique</small> : null}
            </span>
          </div>
          <div className="site-traffic-list-track" aria-hidden="true">
            <div
              className="site-traffic-list-fill"
              style={{ width: `${Math.max(3, ((row.count || 0) / maximum) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: NormalizedCountRow[];
}) {
  return (
    <div className="grok-card site-traffic-breakdown-card">
      <div className="site-traffic-card-kicker">{title}</div>
      <RankedList rows={rows} emptyLabel="No breakdown reported yet." />
    </div>
  );
}

function LoadingPanel() {
  return (
    <div className="site-traffic-loading" role="status">
      <Loader2 size={18} className="animate-spin" aria-hidden="true" />
      <div>
        <strong>Contacting shiba-studio.io</strong>
        <span>Loading audience, repository, and site-health signals…</span>
      </div>
    </div>
  );
}

function sourceLabel(source: PagesStatus['source']): string {
  if (!source) return 'Not reported';
  if (typeof source === 'string') return source;
  const branch = source.branch || 'unknown branch';
  return `${branch}${source.path ? ` ${source.path}` : ''}`;
}

function latestBuildLabel(build: PagesStatus['latestBuild']): string {
  if (!build) return 'Not reported';
  if (typeof build === 'string') return build;
  return [build.status, build.commit?.slice(0, 8), build.updatedAt ? formatTimestamp(build.updatedAt) : null]
    .filter(Boolean)
    .join(' · ') || 'Not reported';
}

function certificateLabel(certificate: PagesStatus['certificate']): string {
  if (!certificate) return 'Not reported';
  if (typeof certificate === 'string') return certificate;
  return certificate.state || certificate.description || 'Not reported';
}

export default function SiteTrafficDashboard() {
  const [days, setDays] = useState<TrafficRange>(30);
  const [snapshot, setSnapshot] = useState<SiteTrafficSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [siteCode, setSiteCode] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const daysRef = useRef<TrafficRange>(days);

  const load = useCallback(async (range: TrafficRange, signal?: AbortSignal, force = false) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError(null);

    try {
      const response = await fetch(`${TRAFFIC_ENDPOINT}?days=${range}${force ? '&refresh=1' : ''}`, {
        cache: 'no-store',
        signal,
      });
      const data = await readJsonResponse(response);
      if (signal?.aborted || requestId !== requestIdRef.current) return;
      setSnapshot(data);
      setStale(data.stale === true);
      if (data.audience?.siteCode) setSiteCode(data.audience.siteCode);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (!signal?.aborted && requestId === requestIdRef.current) {
        setLoadError(error instanceof Error ? error.message : 'Unable to load site traffic');
        setStale(true);
      }
    } finally {
      if (!signal?.aborted && requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(days, controller.signal);
    });
    return () => controller.abort();
  }, [days, load]);

  const audienceDaily = useMemo(() => normalizeDaily(snapshot?.audience?.daily), [snapshot?.audience?.daily]);
  const topPages = useMemo(() => normalizeCounts(snapshot?.audience?.topPages), [snapshot?.audience?.topPages]);
  const audienceReferrers = useMemo(
    () => normalizeCounts(snapshot?.audience?.referrers),
    [snapshot?.audience?.referrers],
  );
  const browsers = useMemo(() => normalizeCounts(snapshot?.audience?.browsers), [snapshot?.audience?.browsers]);
  const systems = useMemo(() => normalizeCounts(snapshot?.audience?.systems), [snapshot?.audience?.systems]);
  const locations = useMemo(() => normalizeCounts(snapshot?.audience?.locations), [snapshot?.audience?.locations]);
  const repositoryViewsDaily = useMemo(
    () => normalizeDaily(snapshot?.repository?.views?.daily),
    [snapshot?.repository?.views?.daily],
  );
  const repositoryReferrers = useMemo(
    () => normalizeCounts(snapshot?.repository?.referrers),
    [snapshot?.repository?.referrers],
  );
  const repositoryPaths = useMemo(
    () => normalizeCounts(snapshot?.repository?.paths),
    [snapshot?.repository?.paths],
  );

  const audienceConfigured = snapshot?.audience?.configured === true || snapshot?.audience?.connected === true;
  const audienceConnected = snapshot?.audience?.connected === true;
  const audienceTotal = snapshot?.audience?.total;
  const providerRangeVisits = toFiniteNumber(
    snapshot?.audience?.rangeVisits,
    snapshot?.audience?.totalVisits,
    typeof audienceTotal === 'object' && audienceTotal
      ? audienceTotal.visits
      : audienceTotal,
    typeof audienceTotal === 'object' && audienceTotal
      ? audienceTotal.total
      : undefined,
    typeof audienceTotal === 'object' && audienceTotal
      ? audienceTotal.count
      : undefined,
  );
  const dailyRangeVisits = audienceDaily.length > 0
    ? audienceDaily.reduce((sum, row) => sum + row.count, 0)
    : undefined;
  const rangeVisits = providerRangeVisits ?? dailyRangeVisits;
  const averageVisits = rangeVisits == null ? undefined : Math.round((rangeVisits / days) * 10) / 10;
  const latestDayVisits = audienceDaily.length > 0 ? audienceDaily[audienceDaily.length - 1]?.count : undefined;
  const eventCount = toFiniteNumber(snapshot?.audience?.eventCount) || 0;
  const audienceDailyIncludesEvents = snapshot?.audience?.dailyIncludesEvents === true && eventCount > 0;
  const trackerVerified = snapshot?.audience?.trackerVerified === true;
  const trackerPartial = snapshot?.audience?.trackerPartial === true;
  const trackerStatus = trackerPartial
    ? 'Tracker partially installed'
    : trackerVerified
    ? snapshot?.audience?.trackerInstalled
      ? 'Tracker installed'
      : 'Tracker not installed'
    : 'Tracker not verified';
  const repoViews = toFiniteNumber(snapshot?.repository?.views?.count, snapshot?.repository?.views?.total);
  const repoViewUniques = toFiniteNumber(snapshot?.repository?.views?.uniques, snapshot?.repository?.views?.unique);
  const repoClones = toFiniteNumber(snapshot?.repository?.clones?.count, snapshot?.repository?.clones?.total);
  const repoCloneUniques = toFiniteNumber(snapshot?.repository?.clones?.uniques, snapshot?.repository?.clones?.unique);
  const healthLatency = snapshot?.siteHealth?.ok
    ? toFiniteNumber(snapshot.siteHealth.latencyMs)
    : undefined;

  async function runAction(action: Exclude<PendingAction, null>, payload: Record<string, unknown>) {
    setPendingAction(action);
    setActionError(null);
    setActionMessage(null);

    try {
      const response = await fetch(TRAFFIC_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      await readJsonResponse(response);
      if (action === 'save') {
        setApiToken('');
        setActionMessage('GoatCounter connected. Install the tracker to begin recording website visits.');
      } else if (action === 'install') {
        setActionMessage('Tracker installation requested. New visits will appear after GoatCounter processes them.');
      } else if (action === 'disconnect') {
        setApiToken('');
        setSiteCode('');
        setActionMessage('GoatCounter disconnected. The published tracker and local credential were removed; data in GoatCounter was not deleted.');
      } else {
        setApiToken('');
        setSiteCode('');
        setActionMessage('The local GoatCounter credential was forgotten. The published tracker was not changed.');
      }
      await load(daysRef.current, undefined, true);
    } catch (error: unknown) {
      const detail = error instanceof TrafficApiError
        ? patchFailureDetails(error.files)
        : '';
      setActionError(
        `${error instanceof Error ? error.message : `Unable to ${action} traffic analytics`}${detail ? ` ${detail}` : ''}`,
      );
      if (
        error instanceof TrafficApiError
        && ['TRACKER_INSTALL_INCOMPLETE', 'TRACKER_REMOVE_INCOMPLETE'].includes(error.code || '')
      ) {
        await load(daysRef.current, undefined, true);
      }
    } finally {
      setPendingAction(null);
    }
  }

  function saveConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedCode = siteCode.trim();
    const token = apiToken.trim();
    if (!normalizedCode || !token) {
      setActionError('Enter both the GoatCounter site code and API token.');
      return;
    }
    void runAction('save', { siteCode: normalizedCode, apiToken: token });
  }

  function disconnectAudience() {
    if (!window.confirm(
      'Disconnect GoatCounter from Shiba Studio? This removes the tracker from the published site and deletes the local credential. It does not delete data in GoatCounter.',
    )) return;
    void runAction('disconnect', {});
  }

  function forgetAudienceCredential() {
    if (!window.confirm(
      'Forget only the local GoatCounter credential? A tracker already published on shiba-studio.io will keep sending visits until it is removed separately.',
    )) return;
    void runAction('forget', {});
  }

  return (
    <div className="site-traffic-dashboard page-content">
      <div className="site-traffic-atmosphere" aria-hidden="true" />

      <div className="page-head-row site-traffic-header">
        <div className="min-w-0">
          <div className="site-traffic-eyebrow">SHIBA-STUDIO.IO · MISSION CONTROL</div>
          <h1 className="page-title">Site Traffic</h1>
          <div className="page-subtitle">
            Privacy-friendly website audience, GitHub discovery, and Pages health in one view.
          </div>
        </div>
        <div className="site-traffic-header-actions">
          <a
            href="https://shiba-studio.io"
            target="_blank"
            rel="noreferrer"
            className="grok-btn grok-btn-ghost text-xs"
          >
            <Globe2 size={14} aria-hidden="true" /> Open site <ExternalLink size={11} aria-hidden="true" />
          </a>
          <button
            type="button"
            className="grok-btn grok-btn-secondary text-xs"
            disabled={loading}
            onClick={() => void load(days, undefined, true)}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {loadError && snapshot && (
        <div className="site-traffic-banner site-traffic-banner-warning" role="alert">
          <Activity size={16} aria-hidden="true" />
          <span><strong>Live refresh failed.</strong> Showing the last successful snapshot. {loadError}</span>
          <button type="button" className="grok-btn grok-btn-ghost text-xs" onClick={() => void load(days, undefined, true)}>
            Retry
          </button>
        </div>
      )}

      {actionError && (
        <div className="site-traffic-banner site-traffic-banner-error" role="alert">
          <span>{actionError}</span>
          <button type="button" className="site-traffic-banner-close" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {actionMessage && (
        <div className="site-traffic-banner site-traffic-banner-success" role="status">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>{actionMessage}</span>
        </div>
      )}

      {loading && !snapshot ? <LoadingPanel /> : null}

      {loadError && !snapshot ? (
        <div className="grok-card site-traffic-fatal" role="alert">
          <div className="site-traffic-fatal-icon"><Unplug size={22} aria-hidden="true" /></div>
          <div>
            <h2>Traffic monitor unavailable</h2>
            <p>{loadError}</p>
          </div>
          <button type="button" className="grok-btn grok-btn-primary" onClick={() => void load(days, undefined, true)}>
            <RefreshCw size={14} aria-hidden="true" /> Try again
          </button>
        </div>
      ) : null}

      {snapshot ? (
        <>
          <section className="site-traffic-section" aria-labelledby="website-audience-heading">
            <div className="site-traffic-section-head">
              <div>
                <div className="site-traffic-section-kicker">01 · WEBSITE AUDIENCE</div>
                <h2 id="website-audience-heading">People visiting shiba-studio.io</h2>
                <p>Anonymous visit counts from GoatCounter. This is website traffic—not Shiba Studio app telemetry.</p>
              </div>
              {audienceConnected
                ? <StatusPill tone="live">GoatCounter connected</StatusPill>
                : audienceConfigured
                  ? <StatusPill tone="warning">GoatCounter configured</StatusPill>
                  : <StatusPill tone="quiet">Analytics not connected</StatusPill>}
            </div>

            {!audienceConfigured ? (
              <div className="grok-card site-traffic-onboarding">
                <div className="site-traffic-onboarding-intro">
                  <div className="site-traffic-orbit-icon" aria-hidden="true">
                    <Activity size={22} />
                  </div>
                  <div>
                    <div className="site-traffic-card-kicker">CONNECT AN AUDIENCE SIGNAL</div>
                    <h3>GitHub Pages does not include visitor analytics</h3>
                    <p>
                      Connect GoatCounter to count privacy-friendly visits without cookies or cross-site tracking.
                      Until it is connected, Shiba Studio will not invent a visitor total or present repository
                      views as website visitors.
                    </p>
                    {snapshot.audience?.error ? (
                      <div className="site-traffic-inline-error" role="note">{snapshot.audience.error}</div>
                    ) : null}
                  </div>
                </div>

                <form className="site-traffic-connect-form" onSubmit={saveConnection}>
                  <div className="site-traffic-field">
                    <label htmlFor="site-traffic-code">GoatCounter site code</label>
                    <input
                      id="site-traffic-code"
                      className="grok-input"
                      value={siteCode}
                      onChange={(event) => setSiteCode(event.target.value)}
                      placeholder="shiba-studio"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pendingAction === 'save'}
                    />
                    <span>The code before <span className="font-mono">.goatcounter.com</span>.</span>
                  </div>
                  <div className="site-traffic-field">
                    <label htmlFor="site-traffic-token">GoatCounter API token</label>
                    <input
                      id="site-traffic-token"
                      className="grok-input"
                      type="password"
                      value={apiToken}
                      onChange={(event) => setApiToken(event.target.value)}
                      placeholder="Stored encrypted on this machine"
                      autoComplete="new-password"
                      disabled={pendingAction === 'save'}
                    />
                    <span>Stored locally after its site-read and statistics permissions are verified.</span>
                  </div>
                  <div className="site-traffic-connect-actions">
                    <button
                      type="submit"
                      className="grok-btn grok-btn-primary"
                      disabled={pendingAction === 'save' || !siteCode.trim() || !apiToken.trim()}
                    >
                      {pendingAction === 'save'
                        ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                        : <ShieldCheck size={14} aria-hidden="true" />}
                      Connect analytics
                    </button>
                    <a
                      href="https://www.goatcounter.com/signup"
                      target="_blank"
                      rel="noreferrer"
                      className="grok-btn grok-btn-ghost"
                    >
                      Create free GoatCounter site <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </div>
                </form>
              </div>
            ) : (
              <>
                <div className="site-traffic-control-row">
                  <div className="site-traffic-range" role="group" aria-label="Website traffic date range">
                    {RANGE_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={days === option ? 'site-traffic-range-button is-active' : 'site-traffic-range-button'}
                        aria-pressed={days === option}
                        disabled={pendingAction != null}
                        onClick={() => {
                          daysRef.current = option;
                          setDays(option);
                        }}
                      >
                        {option} days
                      </button>
                    ))}
                  </div>
                  <div className="site-traffic-connection-meta">
                    <span className="font-mono">{snapshot.audience?.siteCode || 'GoatCounter'}</span>
                    <span className={snapshot.audience?.trackerInstalled && trackerVerified ? 'site-traffic-tracker-ok' : 'site-traffic-tracker-pending'}>
                      {trackerStatus}
                    </span>
                  </div>
                </div>

                {snapshot.audience?.error ? (
                  <div className="site-traffic-banner site-traffic-banner-warning" role="alert">
                    <Activity size={16} aria-hidden="true" />
                    <span>GoatCounter reported: {snapshot.audience.error}</span>
                  </div>
                ) : null}

                {trackerPartial ? (
                  <div className="site-traffic-banner site-traffic-banner-warning" role="alert">
                    <Wrench size={16} aria-hidden="true" />
                    <span>
                      The tracker is present on only part of the published site. Run installation again
                      to finish it, or disconnect to remove it from every Pages document.
                    </span>
                  </div>
                ) : null}

                <div className="site-traffic-metrics">
                  <MetricCard
                    label={`${days}-day visits`}
                    value={rangeVisits}
                    hint={rangeVisits == null ? 'No range total reported' : 'Privacy-friendly provider total'}
                    unavailable={rangeVisits == null}
                  />
                  <MetricCard
                    label="Average / day"
                    value={averageVisits}
                    hint={averageVisits == null ? 'Available when daily data arrives' : `Across selected ${days}-day range`}
                    unavailable={averageVisits == null}
                  />
                  <MetricCard
                    label={audienceDailyIncludesEvents ? 'Latest daily count' : 'Latest day'}
                    value={latestDayVisits}
                    hint={
                      latestDayVisits == null
                        ? 'No daily series reported'
                        : `${formatDateLabel(audienceDaily[audienceDaily.length - 1]?.date || '')}${audienceDailyIncludesEvents ? ' · visits + events' : ''}`
                    }
                    unavailable={latestDayVisits == null}
                  />
                  <MetricCard
                    label="Ranked pages"
                    value={topPages.length > 0 ? topPages.length : undefined}
                    hint={topPages.length > 0 ? 'Top pages returned by provider' : 'No page ranking reported'}
                    unavailable={topPages.length === 0}
                  />
                </div>

                <div className="grok-card site-traffic-card site-traffic-trend-card">
                  <div className="site-traffic-card-head">
                    <div>
                      <div className="site-traffic-card-kicker">
                        {audienceDailyIncludesEvents ? 'DAILY COUNTS OVER TIME' : 'VISITS OVER TIME'}
                      </div>
                      <h3>Audience pulse</h3>
                    </div>
                    <span className="site-traffic-mono-note">{days}D · DAILY</span>
                  </div>
                  <DailyBars
                    rows={audienceDaily}
                    label={
                      audienceDailyIncludesEvents
                        ? `Website visits and events during the last ${days} days`
                        : `Website visits during the last ${days} days`
                    }
                    emptyLabel="Connected, but no daily audience series has been reported yet."
                    unitSingular={audienceDailyIncludesEvents ? 'visit or event' : 'visit'}
                    unitPlural={audienceDailyIncludesEvents ? 'visits or events' : 'visits'}
                  />
                </div>

                <div className="site-traffic-two-column">
                  <div className="grok-card site-traffic-card">
                    <div className="site-traffic-card-head">
                      <div>
                        <div className="site-traffic-card-kicker">CONTENT</div>
                        <h3>Top pages</h3>
                      </div>
                      <Eye size={17} aria-hidden="true" />
                    </div>
                    <RankedList rows={topPages} emptyLabel="No page ranking reported yet." />
                  </div>
                  <div className="grok-card site-traffic-card">
                    <div className="site-traffic-card-head">
                      <div>
                        <div className="site-traffic-card-kicker">DISCOVERY</div>
                        <h3>Website referrers</h3>
                      </div>
                      <Globe2 size={17} aria-hidden="true" />
                    </div>
                    <RankedList rows={audienceReferrers} emptyLabel="No website referrers reported yet." />
                  </div>
                </div>

                {(browsers.length > 0 || systems.length > 0 || locations.length > 0) ? (
                  <div className="site-traffic-breakdowns">
                    <BreakdownCard title="Browsers" rows={browsers} />
                    <BreakdownCard title="Systems" rows={systems} />
                    <BreakdownCard title="Locations" rows={locations} />
                  </div>
                ) : null}

                <div className="grok-card site-traffic-connection-strip">
                  <div>
                    <strong>Analytics connection</strong>
                    <span>
                      {trackerPartial
                        ? 'Only part of the published site has the tracker; finish installation or disconnect it.'
                        : snapshot.audience?.trackerInstalled
                        ? 'The published GitHub Pages site is configured to record new visits.'
                        : 'Install the tracker on gh-pages before audience data can accumulate.'}
                    </span>
                  </div>
                  <div className="site-traffic-connection-actions">
                    <button
                      type="button"
                      className="grok-btn grok-btn-primary text-xs"
                      disabled={pendingAction != null}
                      onClick={() => void runAction('install', {})}
                    >
                      {pendingAction === 'install'
                        ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                        : <Wrench size={13} aria-hidden="true" />}
                      {trackerPartial
                        ? 'Finish installation'
                        : snapshot.audience?.trackerInstalled
                          ? 'Reinstall tracker'
                          : 'Install tracker'}
                    </button>
                    <button
                      type="button"
                      className="grok-btn grok-btn-ghost text-xs text-error"
                      disabled={pendingAction != null}
                      onClick={disconnectAudience}
                    >
                      {pendingAction === 'disconnect'
                        ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                        : <Unplug size={13} aria-hidden="true" />}
                      Disconnect
                    </button>
                    <button
                      type="button"
                      className="grok-btn grok-btn-ghost text-xs"
                      disabled={pendingAction != null}
                      onClick={forgetAudienceCredential}
                      title="Remove the local token without changing the published site"
                    >
                      {pendingAction === 'forget'
                        ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                        : <ShieldCheck size={13} aria-hidden="true" />}
                      Forget local only
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="site-traffic-section" aria-labelledby="repository-traffic-heading">
            <div className="site-traffic-section-head">
              <div>
                <div className="site-traffic-section-kicker">02 · REPOSITORY DISCOVERY</div>
                <h2 id="repository-traffic-heading">GitHub repository activity</h2>
                <p>
                  Rolling 14-day GitHub repository views and clones. These numbers are not website visitors.
                </p>
              </div>
              {snapshot.repository?.connected
                ? <StatusPill tone="live">GitHub connected</StatusPill>
                : <StatusPill tone="quiet">GitHub data unavailable</StatusPill>}
            </div>

            <div className="site-traffic-data-scope">
              <GitBranch size={16} aria-hidden="true" />
              <span>
                <strong>Repository scope:</strong> people viewing or cloning <span className="font-mono">stevologic/shiba-studio</span> on GitHub.
              </span>
            </div>

            {!snapshot.repository?.connected ? (
              <div className="grok-card site-traffic-unavailable-card">
                <GitBranch size={21} aria-hidden="true" />
                <div>
                  <strong>Repository traffic is not connected</strong>
                  <span>{snapshot.repository?.error || 'Connect GitHub with repository access to load the rolling traffic window.'}</span>
                </div>
              </div>
            ) : (
              <>
                {snapshot.repository.error ? (
                  <div className="site-traffic-banner site-traffic-banner-warning" role="alert">
                    <Activity size={16} aria-hidden="true" />
                    <span>GitHub traffic is partially available: {snapshot.repository.error}</span>
                  </div>
                ) : null}

                <div className="site-traffic-metrics">
                  <MetricCard label="Repository views" value={repoViews} hint={snapshot.repository.rangeLabel || 'Rolling 14 days'} unavailable={repoViews == null} />
                  <MetricCard label="Unique viewers" value={repoViewUniques} hint="GitHub repository uniques" unavailable={repoViewUniques == null} />
                  <MetricCard label="Full clones" value={repoClones} hint="Fetches are not included" unavailable={repoClones == null} />
                  <MetricCard label="Unique cloners" value={repoCloneUniques} hint="Rolling GitHub window" unavailable={repoCloneUniques == null} />
                </div>

                <div className="grok-card site-traffic-card site-traffic-repo-chart">
                  <div className="site-traffic-card-head">
                    <div>
                      <div className="site-traffic-card-kicker">GITHUB VIEWS</div>
                      <h3>Repository pulse</h3>
                    </div>
                    <span className="site-traffic-mono-note">14D · UTC</span>
                  </div>
                  <DailyBars
                    rows={repositoryViewsDaily}
                    label="GitHub repository views during the rolling 14-day window"
                    emptyLabel="GitHub did not return a daily view series."
                    unitSingular="view"
                    unitPlural="views"
                  />
                </div>

                <div className="site-traffic-two-column">
                  <div className="grok-card site-traffic-card">
                    <div className="site-traffic-card-head">
                      <div>
                        <div className="site-traffic-card-kicker">GITHUB REFERRERS</div>
                        <h3>Repository discovery</h3>
                      </div>
                      <BarChart3 size={17} aria-hidden="true" />
                    </div>
                    <RankedList rows={repositoryReferrers} showUniques emptyLabel="No GitHub referrers reported." />
                  </div>
                  <div className="grok-card site-traffic-card">
                    <div className="site-traffic-card-head">
                      <div>
                        <div className="site-traffic-card-kicker">POPULAR CONTENT</div>
                        <h3>Repository paths</h3>
                      </div>
                      <Eye size={17} aria-hidden="true" />
                    </div>
                    <RankedList rows={repositoryPaths} showUniques emptyLabel="No popular repository paths reported." />
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="site-traffic-section" aria-labelledby="site-health-heading">
            <div className="site-traffic-section-head">
              <div>
                <div className="site-traffic-section-kicker">03 · DELIVERY</div>
                <h2 id="site-health-heading">Site health &amp; GitHub Pages</h2>
                <p>Reachability, deployment, custom-domain, and certificate signals for the public site.</p>
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
                  <p>{snapshot.siteHealth?.error || 'HTTPS reachability check completed from this Shiba Studio host.'}</p>
                </div>
                <dl className="site-traffic-health-stats">
                  <div>
                    <dt>Status</dt>
                    <dd>{snapshot.siteHealth?.status ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Latency</dt>
                    <dd>{healthLatency == null ? '—' : `${Math.round(healthLatency)} ms`}</dd>
                  </div>
                  <div>
                    <dt>Checked</dt>
                    <dd>{formatTimestamp(snapshot.siteHealth?.checkedAt)}</dd>
                  </div>
                </dl>
              </div>

              <div className="grok-card site-traffic-pages-card">
                <div className="site-traffic-card-head">
                  <div>
                    <div className="site-traffic-card-kicker">GITHUB PAGES</div>
                    <h3>Deployment state</h3>
                  </div>
                  <Globe2 size={17} aria-hidden="true" />
                </div>
                {snapshot.pages?.error ? (
                  <div className="site-traffic-inline-error">{snapshot.pages.error}</div>
                ) : null}
                <dl className="site-traffic-detail-list">
                  <div><dt>Status</dt><dd>{snapshot.pages?.status || 'Not reported'}</dd></div>
                  <div><dt>Custom domain</dt><dd>{snapshot.pages?.cname || 'Not configured'}</dd></div>
                  <div><dt>HTTPS</dt><dd>{snapshot.pages?.httpsEnforced == null ? 'Not reported' : snapshot.pages.httpsEnforced ? 'Enforced' : 'Not enforced'}</dd></div>
                  <div><dt>Source</dt><dd>{sourceLabel(snapshot.pages?.source)}</dd></div>
                  <div><dt>Build type</dt><dd>{snapshot.pages?.buildType || 'Not reported'}</dd></div>
                  <div><dt>Latest build</dt><dd>{latestBuildLabel(snapshot.pages?.latestBuild)}</dd></div>
                  <div><dt>Certificate</dt><dd>{certificateLabel(snapshot.pages?.certificate)}</dd></div>
                </dl>
                {snapshot.pages?.htmlUrl ? (
                  <a
                    className="site-traffic-pages-link"
                    href={snapshot.pages.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open GitHub Pages settings <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </div>
          </section>

          <footer className="site-traffic-footer">
            <span>
              Snapshot generated <span className="font-mono">{formatTimestamp(snapshot.generatedAt)}</span>
            </span>
            <span className={stale ? 'site-traffic-freshness is-stale' : 'site-traffic-freshness'}>
              <span aria-hidden="true" />
              {stale ? 'Cached snapshot' : 'Live snapshot'}
            </span>
          </footer>
        </>
      ) : null}
    </div>
  );
}
