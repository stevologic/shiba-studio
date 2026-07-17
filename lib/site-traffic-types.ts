export const SITE_TRAFFIC_URL = 'https://shiba-studio.io';
export const SITE_TRAFFIC_REPOSITORY = 'stevologic/shiba-studio';
export const SITE_TRAFFIC_BRANCH = 'gh-pages';
export const SITE_TRAFFIC_PAGE_FILES = ['index.html', 'docs.html'] as const;
export const SITE_TRAFFIC_DAY_OPTIONS = [7, 30, 90] as const;

export type SiteTrafficDays = (typeof SITE_TRAFFIC_DAY_OPTIONS)[number];
export type SiteTrafficPageFile = (typeof SITE_TRAFFIC_PAGE_FILES)[number];

export interface TrafficDailyPoint {
  date: string;
  count: number;
  visits?: number;
  uniques?: number;
}

export interface TrafficCountRow {
  name?: string;
  label?: string;
  title?: string;
  path?: string;
  count: number;
  visits?: number;
  uniques?: number;
}

export interface AudienceTraffic {
  configured: boolean;
  connected: boolean;
  /** Public GoatCounter code used in the published tracker URL. */
  siteCode?: string;
  trackerInstalled: boolean;
  /** True when only some of the published Pages documents contain the tracker. */
  trackerPartial: boolean;
  /** True only when both published Pages files were read successfully. */
  trackerVerified: boolean;
  /** Selected-range page visits. GoatCounter event hits are excluded. */
  totalVisits?: number;
  rangeVisits?: number;
  totalLabel: string;
  /** Separate event count excluded from totalVisits. */
  eventCount?: number;
  /**
   * GoatCounter's aggregate daily buckets do not separate custom events.
   * The UI should avoid presenting the daily sum as an event-free total.
   */
  dailyIncludesEvents: boolean;
  daily: TrafficDailyPoint[];
  topPages: TrafficCountRow[];
  referrers: TrafficCountRow[];
  browsers: TrafficCountRow[];
  systems: TrafficCountRow[];
  locations: TrafficCountRow[];
  error?: string;
}

export interface RepositoryTrafficMetric {
  count: number;
  uniques: number;
  daily: TrafficDailyPoint[];
}

export interface TrafficSourceError {
  source: string;
  message: string;
}

export interface RepositoryTraffic {
  configured: boolean;
  connected: boolean;
  partial: boolean;
  scope: 'repository';
  repository: typeof SITE_TRAFFIC_REPOSITORY;
  rangeLabel: 'Rolling 14 days · UTC';
  views?: RepositoryTrafficMetric;
  clones?: RepositoryTrafficMetric;
  referrers: TrafficCountRow[];
  paths: TrafficCountRow[];
  errors: TrafficSourceError[];
  error?: string;
}

export interface SiteHealth {
  ok: boolean;
  url: typeof SITE_TRAFFIC_URL;
  status?: number;
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

export interface PagesLatestBuild {
  status: string;
  updatedAt?: string;
  createdAt?: string;
  commit?: string;
  durationMs?: number;
  error?: string;
}

export interface PagesCertificate {
  state: string;
  description?: string;
  expiresAt?: string;
  domains: string[];
}

export interface PagesStatus {
  configured: boolean;
  connected: boolean;
  partial: boolean;
  status?: string;
  /** Fixed GitHub settings URL, never taken from an API response. */
  htmlUrl: string;
  cname?: string;
  httpsEnforced?: boolean;
  buildType?: string;
  source?: {
    branch?: string;
    path?: string;
  };
  latestBuild?: PagesLatestBuild;
  certificate?: PagesCertificate;
  errors: TrafficSourceError[];
  error?: string;
}

export interface SiteTrafficSnapshot {
  ok: true;
  siteUrl: typeof SITE_TRAFFIC_URL;
  repositoryName: typeof SITE_TRAFFIC_REPOSITORY;
  days: SiteTrafficDays;
  rangeLabel: string;
  generatedAt: string;
  stale: boolean;
  audience: AudienceTraffic;
  repository: RepositoryTraffic;
  siteHealth: SiteHealth;
  pages: PagesStatus;
}

export type TrackerPatchStatus =
  | 'installed'
  | 'already-installed'
  | 'removed'
  | 'already-absent'
  | 'error';

export interface TrackerPatchFileResult {
  path: SiteTrafficPageFile;
  ok: boolean;
  changed: boolean;
  status: TrackerPatchStatus;
  commitSha?: string;
  error?: string;
}

export interface TrackerPatchResult {
  ok: boolean;
  partial: boolean;
  operation: 'install' | 'remove';
  files: TrackerPatchFileResult[];
  trackerMayRemain?: boolean;
}

export interface HtmlTransformResult {
  html: string;
  changed: boolean;
}

export const GOATCOUNTER_TRACKER_START = '<!-- shiba-studio:goatcounter:start -->';
export const GOATCOUNTER_TRACKER_END = '<!-- shiba-studio:goatcounter:end -->';
export const GOATCOUNTER_DISCLOSURE_START = '<!-- shiba-studio:analytics-disclosure:start -->';
export const GOATCOUNTER_DISCLOSURE_END = '<!-- shiba-studio:analytics-disclosure:end -->';

const GOATCOUNTER_SITE_CODE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TRACKER_BLOCK_RE =
  /<!-- shiba-studio:goatcounter:start -->[\s\S]*?<!-- shiba-studio:goatcounter:end -->/gi;
const DISCLOSURE_BLOCK_RE =
  /<!-- shiba-studio:analytics-disclosure:start -->[\s\S]*?<!-- shiba-studio:analytics-disclosure:end -->/gi;
const UNMANAGED_GOATCOUNTER_SCRIPT_RE =
  /<script\b[^>]*(?:data-goatcounter\s*=|src\s*=\s*["'][^"']*gc\.zgo\.at\/count\.js)[^>]*>/i;

function countLiteral(value: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(search, offset)) >= 0) {
    count += 1;
    offset += search.length;
  }
  return count;
}

function assertBalancedMarkers(html: string): void {
  const pairs = [
    [GOATCOUNTER_TRACKER_START, GOATCOUNTER_TRACKER_END],
    [GOATCOUNTER_DISCLOSURE_START, GOATCOUNTER_DISCLOSURE_END],
  ] as const;
  for (const [start, end] of pairs) {
    if (countLiteral(html, start) !== countLiteral(html, end)) {
      throw new Error('The published page contains an incomplete Shiba Studio analytics marker.');
    }
  }
}

export function normalizeTrafficDays(value: unknown, fallback: SiteTrafficDays = 30): SiteTrafficDays {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (SITE_TRAFFIC_DAY_OPTIONS.includes(parsed as SiteTrafficDays)) {
    return parsed as SiteTrafficDays;
  }
  throw new Error('days must be 7, 30, or 90.');
}

export function normalizeGoatCounterSiteCode(value: unknown): string {
  if (typeof value !== 'string') throw new Error('GoatCounter site code is required.');
  const normalized = value.trim().toLowerCase();
  if (!GOATCOUNTER_SITE_CODE_RE.test(normalized)) {
    throw new Error('GoatCounter site code must use lowercase letters, numbers, or hyphens.');
  }
  return normalized;
}

export function maskGoatCounterSiteCode(value: string): string {
  const code = normalizeGoatCounterSiteCode(value);
  if (code.length <= 4) return `${code[0]}***`;
  return `${code.slice(0, 3)}...${code.slice(-2)}`;
}

export function goatCounterTrackerBlock(siteCode: string): string {
  const code = normalizeGoatCounterSiteCode(siteCode);
  return [
    GOATCOUNTER_TRACKER_START,
    `<script data-goatcounter="https://${code}.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>`,
    GOATCOUNTER_TRACKER_END,
  ].join('\n');
}

export function goatCounterDisclosureBlock(): string {
  return [
    GOATCOUNTER_DISCLOSURE_START,
    '<p class="shiba-analytics-disclosure" style="margin-top:12px;color:var(--muted,#a3a3a3);font-size:12px;line-height:1.55;">',
    '  This marketing site uses anonymous, cookie-free traffic counts via <a href="https://www.goatcounter.com/" rel="noreferrer">GoatCounter</a>. The Shiba Studio app itself sends no telemetry.',
    '</p>',
    GOATCOUNTER_DISCLOSURE_END,
  ].join('\n');
}

export function hasExactGoatCounterTracker(html: string, siteCode: string): boolean {
  if (typeof html !== 'string') return false;
  const tracker = goatCounterTrackerBlock(siteCode);
  return html.includes(tracker)
    && html.includes('This marketing site uses anonymous, cookie-free traffic counts via')
    && countLiteral(html, GOATCOUNTER_TRACKER_START) === 1
    && countLiteral(html, GOATCOUNTER_TRACKER_END) === 1
    && countLiteral(html, GOATCOUNTER_DISCLOSURE_START) === 1
    && countLiteral(html, GOATCOUNTER_DISCLOSURE_END) === 1;
}

/**
 * Add or update the two Shiba-owned analytics blocks. Existing marked blocks
 * are replaced, so reconnecting a different GoatCounter site is safe.
 */
export function injectGoatCounterTracker(html: string, siteCode: string): HtmlTransformResult {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('Published page HTML is empty.');
  }
  if (html.length > 2_000_000) throw new Error('Published page HTML is too large to patch safely.');
  const tracker = goatCounterTrackerBlock(siteCode);
  const disclosure = goatCounterDisclosureBlock();
  assertBalancedMarkers(html);
  if (hasExactGoatCounterTracker(html, siteCode)) return { html, changed: false };

  let next = html.replace(TRACKER_BLOCK_RE, '').replace(DISCLOSURE_BLOCK_RE, '');
  if (UNMANAGED_GOATCOUNTER_SCRIPT_RE.test(next)) {
    throw new Error(
      'The published page already contains an unmanaged GoatCounter tracker. Remove it before using Shiba Studio installation.',
    );
  }
  if (!/<\/head\s*>/i.test(next)) {
    throw new Error('Published page has no closing head element.');
  }
  next = next.replace(/<\/head\s*>/i, `${tracker}\n</head>`);

  if (/<\/footer\s*>/i.test(next)) {
    next = next.replace(/<\/footer\s*>/i, `${disclosure}\n</footer>`);
  } else if (/<\/body\s*>/i.test(next)) {
    const fallback = [
      '<div class="shiba-analytics-disclosure" style="position:relative;z-index:1;padding:16px 24px;text-align:center;color:var(--muted,#a3a3a3);font:12px/1.55 ui-sans-serif,system-ui,sans-serif;">',
      '  This marketing site uses anonymous, cookie-free traffic counts via <a href="https://www.goatcounter.com/" rel="noreferrer" style="color:#a3a3a3;">GoatCounter</a>. The Shiba Studio app itself sends no telemetry.',
      '</div>',
    ].join('\n');
    const markedFallback = `${GOATCOUNTER_DISCLOSURE_START}\n${fallback}\n${GOATCOUNTER_DISCLOSURE_END}`;
    next = next.replace(/<\/body\s*>/i, `${markedFallback}\n</body>`);
  } else {
    throw new Error('Published page has no footer or closing body element.');
  }

  return { html: next, changed: next !== html };
}

/** Remove only the blocks owned by Shiba Studio; unrelated scripts are untouched. */
export function removeGoatCounterTracker(html: string): HtmlTransformResult {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('Published page HTML is empty.');
  }
  if (html.length > 2_000_000) throw new Error('Published page HTML is too large to patch safely.');
  assertBalancedMarkers(html);
  const next = html.replace(TRACKER_BLOCK_RE, '').replace(DISCLOSURE_BLOCK_RE, '');
  return { html: next, changed: next !== html };
}
