import 'server-only';

import { createHash } from 'crypto';
import type { IntegrationCreds } from './types';
import {
  SITE_TRAFFIC_BRANCH,
  SITE_TRAFFIC_PAGE_FILES,
  SITE_TRAFFIC_REPOSITORY,
  SITE_TRAFFIC_URL,
  goatCounterTrackerBlock,
  hasExactGoatCounterTracker,
  injectGoatCounterTracker,
  normalizeGoatCounterSiteCode,
  normalizeTrafficDays,
  removeGoatCounterTracker,
  type AudienceTraffic,
  type PagesCertificate,
  type PagesStatus,
  type RepositoryTraffic,
  type RepositoryTrafficMetric,
  type SiteHealth,
  type SiteTrafficDays,
  type SiteTrafficPageFile,
  type SiteTrafficSnapshot,
  type TrackerPatchFileResult,
  type TrackerPatchResult,
  type TrafficCountRow,
  type TrafficDailyPoint,
  type TrafficSourceError,
} from './site-traffic-types';

const GOATCOUNTER_TIMEOUT_MS = 12_000;
const GITHUB_TIMEOUT_MS = 12_000;
const SITE_HEALTH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60_000;
// GitHub's Contents API base64-encodes the fixed Pages files, so the JSON
// envelope can be ~4/3 larger than the bounded decoded HTML.
const MAX_API_BODY_CHARS = 2_800_000;
const MAX_PAGE_BYTES = 2_000_000;
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_PAGES_SETTINGS_URL =
  'https://github.com/stevologic/shiba-studio/settings/pages';
const GITHUB_API_ROOT =
  'https://api.github.com/repos/stevologic/shiba-studio';

interface GoatCounterTotalResponse {
  total?: unknown;
  total_events?: unknown;
  stats?: unknown;
}

interface GoatCounterHitsResponse {
  hits?: unknown;
}

interface GoatCounterStatsResponse {
  stats?: unknown;
}

interface GitHubTrafficMetricResponse {
  count?: unknown;
  uniques?: unknown;
  views?: unknown;
  clones?: unknown;
}

interface GitHubContentsResponse {
  type?: unknown;
  encoding?: unknown;
  content?: unknown;
  sha?: unknown;
  path?: unknown;
}

interface TrafficCacheEntry {
  expiresAt: number;
  pending: boolean;
  promise: Promise<SiteTrafficSnapshot>;
}

interface GoatCounterRateState {
  lastStartedAt: number;
  tail: Promise<void>;
}

const cacheGlobal = globalThis as typeof globalThis & {
  __shibaSiteTrafficCache?: Map<string, TrafficCacheEntry>;
  __shibaGoatCounterRateLimits?: Map<string, GoatCounterRateState>;
  __shibaSiteTrafficMutationChain?: Promise<void>;
};

function trafficCache(): Map<string, TrafficCacheEntry> {
  cacheGlobal.__shibaSiteTrafficCache ??= new Map();
  return cacheGlobal.__shibaSiteTrafficCache;
}

export class SiteTrafficServiceError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'SITE_TRAFFIC_ERROR',
  ) {
    super(message);
    this.name = 'SiteTrafficServiceError';
  }
}

function safeString(value: unknown, maxChars = 240): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function safePath(value: unknown, maxChars = 300): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxChars);
}

function safeCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), Number.MAX_SAFE_INTEGER);
}

function safeIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeDay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecords(value: unknown, max = 100): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .filter((item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item));
}

function redactErrorText(value: unknown, secrets: readonly string[] = []): string {
  let message = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : 'The upstream service did not complete the request.';
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed) message = message.split(trimmed).join('[redacted]');
  }
  return message
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320) || 'The upstream service did not complete the request.';
}

function apiErrorMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const direct = safeString(record.error, 240)
    || safeString(record.message, 240)
    || safeString(record.Error, 240);
  if (direct) return direct;
  const errors = record.errors;
  if (Array.isArray(errors)) {
    const joined = errors.map((item) => safeString(item, 100)).filter(Boolean).slice(0, 3).join('; ');
    if (joined) return joined;
  }
  if (errors && typeof errors === 'object') {
    const joined = Object.values(errors as Record<string, unknown>)
      .flatMap((item) => Array.isArray(item) ? item : [item])
      .map((item) => safeString(item, 100))
      .filter(Boolean)
      .slice(0, 3)
      .join('; ');
    if (joined) return joined;
  }
  return fallback;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, MAX_API_BODY_CHARS);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SiteTrafficServiceError(
      'The upstream service returned an invalid response.',
      502,
      'INVALID_UPSTREAM_RESPONSE',
    );
  }
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  opts: {
    timeoutMs: number;
    provider: 'GoatCounter' | 'GitHub';
    secrets?: readonly string[];
  },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error
      && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new SiteTrafficServiceError(
      timedOut
        ? `${opts.provider} did not respond before the timeout.`
        : `${opts.provider} could not be reached.`,
      timedOut ? 504 : 502,
      timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
    );
  }

  const body = await readJsonBody(response);
  if (!response.ok) {
    const fallback = response.status === 401 || response.status === 403
      ? `${opts.provider} rejected the configured credentials.`
      : `${opts.provider} returned HTTP ${response.status}.`;
    throw new SiteTrafficServiceError(
      redactErrorText(apiErrorMessage(body, fallback), opts.secrets),
      response.status,
      'UPSTREAM_REQUEST_FAILED',
    );
  }
  return body as T;
}

function normalizeToken(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new SiteTrafficServiceError(`${label} is required.`, 400, 'TOKEN_REQUIRED');
  const token = value.trim();
  if (!token) throw new SiteTrafficServiceError(`${label} is required.`, 400, 'TOKEN_REQUIRED');
  if (token.length > 2_048 || token.includes('\0')) {
    throw new SiteTrafficServiceError(`${label} is invalid.`, 400, 'TOKEN_INVALID');
  }
  return token;
}

function dateWindow(days: SiteTrafficDays): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function goatCounterUrl(
  siteCode: string,
  path: string,
  params?: Record<string, string>,
): string {
  const code = normalizeGoatCounterSiteCode(siteCode);
  const url = new URL(`https://${code}.goatcounter.com/api/v0/${path}`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
  return url.toString();
}

function goatCounterHeaders(apiToken: string): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
}

function scheduleGoatCounterRequest<T>(
  siteCode: string,
  request: () => Promise<T>,
): Promise<T> {
  cacheGlobal.__shibaGoatCounterRateLimits ??= new Map();
  const limits = cacheGlobal.__shibaGoatCounterRateLimits;
  const state = limits.get(siteCode) || {
    lastStartedAt: 0,
    tail: Promise.resolve(),
  };
  limits.set(siteCode, state);

  const turn = state.tail
    .catch(() => {})
    .then(async () => {
      // One start every 275 ms stays below GoatCounter's four requests/second
      // limit even when multiple ranges, refreshes, or credential tests overlap.
      const waitMs = Math.max(0, 275 - (Date.now() - state.lastStartedAt));
      if (waitMs > 0) await delay(waitMs);
      state.lastStartedAt = Date.now();
    });
  state.tail = turn;
  return turn.then(request);
}

async function goatCounterGet<T>(
  siteCode: string,
  apiToken: string,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const code = normalizeGoatCounterSiteCode(siteCode);
  return scheduleGoatCounterRequest(
    code,
    () => requestJson<T>(
      goatCounterUrl(code, path, params),
      { method: 'GET', headers: goatCounterHeaders(apiToken) },
      { timeoutMs: GOATCOUNTER_TIMEOUT_MS, provider: 'GoatCounter', secrets: [apiToken] },
    ),
  );
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Shiba-Studio-Traffic',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

async function githubRequest<T>(
  path: string,
  token: string,
  init: Omit<RequestInit, 'headers'> = {},
): Promise<T> {
  return requestJson<T>(
    `${GITHUB_API_ROOT}${path}`,
    { ...init, headers: githubHeaders(token) },
    { timeoutMs: GITHUB_TIMEOUT_MS, provider: 'GitHub', secrets: [token] },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settledError(
  source: string,
  result: PromiseSettledResult<unknown>,
  secrets: readonly string[] = [],
): TrafficSourceError | null {
  if (result.status === 'fulfilled') return null;
  return { source, message: redactErrorText(result.reason, secrets) };
}

function summarizeErrors(errors: TrafficSourceError[]): string | undefined {
  if (!errors.length) return undefined;
  return errors
    .slice(0, 4)
    .map((item) => `${item.source}: ${item.message}`)
    .join(' · ')
    .slice(0, 600);
}

function normalizeDailyStats(value: unknown): TrafficDailyPoint[] {
  return asRecords(value, 120)
    .flatMap((row) => {
      const date = safeDay(row.day);
      if (!date) return [];
      const count = safeCount(row.daily);
      return [{ date, count, visits: count }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeGoatCounterRanking(value: unknown): TrafficCountRow[] {
  return asRecords(value, 20)
    .map((row) => ({
      name: safeString(row.name, 180) || '(unknown)',
      count: safeCount(row.count),
      visits: safeCount(row.count),
    }))
    .slice(0, 10);
}

function normalizeGoatCounterPages(value: unknown): TrafficCountRow[] {
  return asRecords(value, 100)
    .filter((row) => row.event !== true)
    .map((row) => ({
      path: safePath(row.path, 300) || '/',
      title: safeString(row.title, 220) || undefined,
      count: safeCount(row.count),
      visits: safeCount(row.count),
    }))
    .slice(0, 10);
}

async function getPageFile(
  token: string,
  path: SiteTrafficPageFile,
): Promise<{ html: string; sha: string }> {
  const result = await githubRequest<GitHubContentsResponse>(
    `/contents/${path}?ref=${SITE_TRAFFIC_BRANCH}`,
    token,
  );
  if (result.type !== 'file' || result.encoding !== 'base64' || typeof result.content !== 'string') {
    throw new SiteTrafficServiceError(
      `GitHub did not return ${path} as a regular file.`,
      409,
      'PAGES_FILE_INVALID',
    );
  }
  const compact = result.content.replace(/\s+/g, '');
  if (compact.length > Math.ceil(MAX_PAGE_BYTES * 4 / 3) + 16) {
    throw new SiteTrafficServiceError(
      `${path} is too large to patch safely.`,
      413,
      'PAGES_FILE_TOO_LARGE',
    );
  }
  const decoded = Buffer.from(compact, 'base64');
  if (decoded.byteLength > MAX_PAGE_BYTES) {
    throw new SiteTrafficServiceError(
      `${path} is too large to patch safely.`,
      413,
      'PAGES_FILE_TOO_LARGE',
    );
  }
  const sha = safeString(result.sha, 80);
  if (!sha) throw new SiteTrafficServiceError(`GitHub did not return a SHA for ${path}.`, 502);
  return { html: decoded.toString('utf8'), sha };
}

async function checkTrackerInstalled(
  token: string | undefined,
  siteCode: string,
): Promise<{ installed: boolean; partial: boolean; verified: boolean }> {
  if (!token?.trim()) return { installed: false, partial: false, verified: false };
  const safeToken = normalizeToken(token, 'GitHub token');
  const files = await Promise.allSettled(
    SITE_TRAFFIC_PAGE_FILES.map((path) => getPageFile(safeToken, path)),
  );
  const verified = files.every((result) => result.status === 'fulfilled');
  const installedCount = files.filter((result) =>
    result.status === 'fulfilled'
      && hasExactGoatCounterTracker(result.value.html, siteCode)).length;
  return {
    verified,
    installed: verified && installedCount === files.length,
    partial: installedCount > 0 && installedCount < files.length,
  };
}

function emptyAudience(days: SiteTrafficDays, error?: string): AudienceTraffic {
  return {
    configured: false,
    connected: false,
    trackerInstalled: false,
    trackerPartial: false,
    trackerVerified: false,
    totalLabel: `Last ${days} days (events excluded)`,
    dailyIncludesEvents: true,
    daily: [],
    topPages: [],
    referrers: [],
    browsers: [],
    systems: [],
    locations: [],
    ...(error ? { error } : {}),
  };
}

async function fetchAudienceTraffic(
  days: SiteTrafficDays,
  creds: IntegrationCreds['goatcounter'],
  githubToken?: string,
): Promise<AudienceTraffic> {
  if (!creds?.siteCode?.trim() || !creds.apiToken?.trim()) {
    return emptyAudience(days, 'Connect GoatCounter to collect website audience data.');
  }

  let siteCode: string;
  let apiToken: string;
  try {
    siteCode = normalizeGoatCounterSiteCode(creds.siteCode);
    apiToken = normalizeToken(creds.apiToken, 'GoatCounter API token');
  } catch (error) {
    return emptyAudience(days, redactErrorText(error));
  }

  const trackerPromise = checkTrackerInstalled(githubToken, siteCode)
    .catch(() => ({ installed: false, partial: false, verified: false }));
  const { start, end } = dateWindow(days);
  const common = { start, end };
  const errors: TrafficSourceError[] = [];
  let successCount = 0;

  const first = await Promise.allSettled([
    goatCounterGet<GoatCounterTotalResponse>(siteCode, apiToken, 'stats/total', common),
    goatCounterGet<GoatCounterHitsResponse>(
      siteCode,
      apiToken,
      'stats/hits',
      { ...common, group: 'day', limit: '10' },
    ),
  ]);
  for (const [index, source] of ['total', 'hits'].entries()) {
    const result = first[index];
    if (result.status === 'fulfilled') successCount += 1;
    else errors.push({ source, message: redactErrorText(result.reason, [apiToken]) });
  }

  let browsers: PromiseSettledResult<GoatCounterStatsResponse> = {
    status: 'rejected',
    reason: new Error('Not requested because authentication failed.'),
  };
  let systems: PromiseSettledResult<GoatCounterStatsResponse> = browsers;
  let locations: PromiseSettledResult<GoatCounterStatsResponse> = browsers;
  let toprefs: PromiseSettledResult<GoatCounterStatsResponse> = browsers;

  const primaryUnavailable = first.every((result) => result.status === 'rejected');

  if (!primaryUnavailable) {
    [browsers, systems, locations, toprefs] = await Promise.allSettled([
      goatCounterGet<GoatCounterStatsResponse>(
        siteCode,
        apiToken,
        'stats/browsers',
        { ...common, limit: '10' },
      ),
      goatCounterGet<GoatCounterStatsResponse>(
        siteCode,
        apiToken,
        'stats/systems',
        { ...common, limit: '10' },
      ),
      goatCounterGet<GoatCounterStatsResponse>(
        siteCode,
        apiToken,
        'stats/locations',
        { ...common, limit: '10' },
      ),
      goatCounterGet<GoatCounterStatsResponse>(
        siteCode,
        apiToken,
        'stats/toprefs',
        { ...common, limit: '10' },
      ),
    ]);

    const detailResults = [
      ['browsers', browsers],
      ['systems', systems],
      ['locations', locations],
      ['referrers', toprefs],
    ] as const;
    for (const [source, result] of detailResults) {
      if (result.status === 'fulfilled') successCount += 1;
      else errors.push({ source, message: redactErrorText(result.reason, [apiToken]) });
    }
  }

  const totalResponse = first[0].status === 'fulfilled' ? first[0].value : undefined;
  const eventCount = totalResponse ? safeCount(totalResponse.total_events) : undefined;
  const rangeVisits = totalResponse
    ? Math.max(0, safeCount(totalResponse.total) - (eventCount || 0))
    : undefined;
  const hitsResponse = first[1].status === 'fulfilled' ? first[1].value : undefined;

  const tracker = await trackerPromise;
  return {
    configured: true,
    connected: successCount > 0,
    siteCode,
    trackerInstalled: tracker.installed,
    trackerPartial: tracker.partial,
    trackerVerified: tracker.verified,
    totalVisits: rangeVisits,
    rangeVisits,
    totalLabel: `Last ${days} days (events excluded)`,
    eventCount,
    dailyIncludesEvents: true,
    // Keep every provider bucket in the rolling range. GoatCounter groups by
    // the account timezone, so a fixed-duration range can span N+1 dates.
    daily: normalizeDailyStats(totalResponse?.stats),
    topPages: normalizeGoatCounterPages(hitsResponse?.hits),
    referrers: toprefs.status === 'fulfilled'
      ? normalizeGoatCounterRanking(toprefs.value.stats)
      : [],
    browsers: browsers.status === 'fulfilled'
      ? normalizeGoatCounterRanking(browsers.value.stats)
      : [],
    systems: systems.status === 'fulfilled'
      ? normalizeGoatCounterRanking(systems.value.stats)
      : [],
    locations: locations.status === 'fulfilled'
      ? normalizeGoatCounterRanking(locations.value.stats)
      : [],
    error: summarizeErrors(errors),
  };
}

function normalizeRepositoryMetric(
  value: GitHubTrafficMetricResponse,
  listKey: 'views' | 'clones',
): RepositoryTrafficMetric {
  return {
    count: safeCount(value.count),
    uniques: safeCount(value.uniques),
    daily: asRecords(value[listKey], 20)
      .flatMap((row) => {
        // GitHub reports these buckets at UTC midnight. Preserve the UTC day
        // instead of letting the browser shift the label into its local zone.
        const date = safeDay(row.timestamp);
        if (!date) return [];
        return [{
          date,
          count: safeCount(row.count),
          visits: safeCount(row.count),
          uniques: safeCount(row.uniques),
        }];
      })
      .slice(-14),
  };
}

function emptyRepositoryTraffic(error: string): RepositoryTraffic {
  return {
    configured: false,
    connected: false,
    partial: false,
    scope: 'repository',
    repository: SITE_TRAFFIC_REPOSITORY,
    rangeLabel: 'Rolling 14 days · UTC',
    referrers: [],
    paths: [],
    errors: [{ source: 'GitHub', message: error }],
    error,
  };
}

async function fetchRepositoryTraffic(token?: string): Promise<RepositoryTraffic> {
  if (!token?.trim()) {
    return emptyRepositoryTraffic(
      'Connect GitHub with repository Administration read access to load traffic.',
    );
  }
  const githubToken = normalizeToken(token, 'GitHub token');
  const results = await Promise.allSettled([
    githubRequest<GitHubTrafficMetricResponse>('/traffic/views?per=day', githubToken),
    githubRequest<GitHubTrafficMetricResponse>('/traffic/clones?per=day', githubToken),
    githubRequest<unknown[]>('/traffic/popular/referrers', githubToken),
    githubRequest<unknown[]>('/traffic/popular/paths', githubToken),
  ]);
  const sources = ['views', 'clones', 'referrers', 'paths'];
  const errors = results.flatMap((result, index) => {
    const error = settledError(sources[index], result, [githubToken]);
    return error ? [error] : [];
  });
  const successCount = results.length - errors.length;

  const referrers = results[2].status === 'fulfilled'
    ? asRecords(results[2].value, 10).map((row) => ({
        name: safeString(row.referrer, 180) || '(direct / unknown)',
        count: safeCount(row.count),
        uniques: safeCount(row.uniques),
      }))
    : [];
  const paths = results[3].status === 'fulfilled'
    ? asRecords(results[3].value, 10).map((row) => ({
        path: safePath(row.path, 300) || '/',
        title: safeString(row.title, 220) || undefined,
        count: safeCount(row.count),
        uniques: safeCount(row.uniques),
      }))
    : [];

  return {
    configured: true,
    connected: successCount > 0,
    partial: successCount > 0 && errors.length > 0,
    scope: 'repository',
    repository: SITE_TRAFFIC_REPOSITORY,
    rangeLabel: 'Rolling 14 days · UTC',
    views: results[0].status === 'fulfilled'
      ? normalizeRepositoryMetric(results[0].value, 'views')
      : undefined,
    clones: results[1].status === 'fulfilled'
      ? normalizeRepositoryMetric(results[1].value, 'clones')
      : undefined,
    referrers,
    paths,
    errors,
    error: summarizeErrors(errors),
  };
}

async function fetchSiteHealth(): Promise<SiteHealth> {
  const checkedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const response = await fetch(SITE_TRAFFIC_URL, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(SITE_HEALTH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Shiba-Studio-Traffic' },
    });
    return {
      ok: response.status >= 200 && response.status < 400,
      url: SITE_TRAFFIC_URL,
      status: response.status,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      checkedAt,
      ...(
        response.status >= 200 && response.status < 400
          ? {}
          : { error: `The site returned HTTP ${response.status}.` }
      ),
    };
  } catch (error) {
    const timedOut = error instanceof Error
      && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      ok: false,
      url: SITE_TRAFFIC_URL,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      checkedAt,
      error: timedOut
        ? 'The site did not respond before the timeout.'
        : 'The site could not be reached.',
    };
  }
}

function emptyPagesStatus(error: string): PagesStatus {
  return {
    configured: false,
    connected: false,
    partial: false,
    htmlUrl: GITHUB_PAGES_SETTINGS_URL,
    errors: [{ source: 'GitHub Pages', message: error }],
    error,
  };
}

async function fetchPagesStatus(token?: string): Promise<PagesStatus> {
  if (!token?.trim()) {
    return emptyPagesStatus('Connect GitHub to load Pages deployment details.');
  }
  const githubToken = normalizeToken(token, 'GitHub token');
  const results = await Promise.allSettled([
    githubRequest<Record<string, unknown>>('/pages', githubToken),
    githubRequest<Record<string, unknown>>('/pages/builds/latest', githubToken),
  ]);
  const errors = [
    settledError('site', results[0], [githubToken]),
    settledError('latest build', results[1], [githubToken]),
  ].filter((value): value is TrafficSourceError => value !== null);
  const successCount = results.length - errors.length;
  const site = results[0].status === 'fulfilled' ? results[0].value : {};
  const build = results[1].status === 'fulfilled' ? results[1].value : {};
  const source = asRecord(site.source);
  const certificateRaw = asRecord(site.https_certificate);
  const certificate: PagesCertificate | undefined = Object.keys(certificateRaw).length
    ? {
        state: safeString(certificateRaw.state, 60) || 'unknown',
        description: safeString(certificateRaw.description, 180) || undefined,
        expiresAt: safeIso(certificateRaw.expires_at),
        domains: Array.isArray(certificateRaw.domains)
          ? certificateRaw.domains
              .map((domain) => safeString(domain, 180))
              .filter(Boolean)
              .slice(0, 10)
          : [],
      }
    : undefined;
  const buildError = safeString(asRecord(build.error).message, 200) || undefined;

  return {
    configured: true,
    connected: successCount > 0,
    partial: successCount > 0 && errors.length > 0,
    status: safeString(site.status, 60) || undefined,
    htmlUrl: GITHUB_PAGES_SETTINGS_URL,
    cname: safeString(site.cname, 180) || undefined,
    httpsEnforced: typeof site.https_enforced === 'boolean'
      ? site.https_enforced
      : undefined,
    buildType: safeString(site.build_type, 60) || undefined,
    source: Object.keys(source).length
      ? {
          branch: safeString(source.branch, 120) || undefined,
          path: safePath(source.path, 200) || undefined,
        }
      : undefined,
    latestBuild: results[1].status === 'fulfilled'
      ? {
          status: safeString(build.status, 60) || 'unknown',
          updatedAt: safeIso(build.updated_at),
          createdAt: safeIso(build.created_at),
          commit: safeString(build.commit, 80) || undefined,
          durationMs: safeCount(build.duration) || undefined,
          error: buildError,
        }
      : undefined,
    certificate,
    errors,
    error: summarizeErrors(errors),
  };
}

function configFingerprint(
  days: SiteTrafficDays,
  goatcounter: IntegrationCreds['goatcounter'],
  githubToken?: string,
): string {
  return createHash('sha256')
    .update(String(days))
    .update('\0')
    .update(goatcounter?.siteCode || '')
    .update('\0')
    .update(goatcounter?.apiToken || '')
    .update('\0')
    .update(githubToken || '')
    .digest('hex')
    .slice(0, 24);
}

function unexpectedAudience(days: SiteTrafficDays, reason: unknown): AudienceTraffic {
  return emptyAudience(days, redactErrorText(reason));
}

function unexpectedRepository(reason: unknown): RepositoryTraffic {
  return emptyRepositoryTraffic(redactErrorText(reason));
}

async function buildSiteTrafficSnapshot(
  days: SiteTrafficDays,
  goatcounter: IntegrationCreds['goatcounter'],
  githubToken?: string,
): Promise<SiteTrafficSnapshot> {
  const generatedAt = new Date().toISOString();
  const [audience, repository, siteHealth, pages] = await Promise.allSettled([
    fetchAudienceTraffic(days, goatcounter, githubToken),
    fetchRepositoryTraffic(githubToken),
    fetchSiteHealth(),
    fetchPagesStatus(githubToken),
  ]);

  return {
    ok: true,
    siteUrl: SITE_TRAFFIC_URL,
    repositoryName: SITE_TRAFFIC_REPOSITORY,
    days,
    rangeLabel: `Last ${days} days`,
    generatedAt,
    stale: false,
    audience: audience.status === 'fulfilled'
      ? audience.value
      : unexpectedAudience(days, audience.reason),
    repository: repository.status === 'fulfilled'
      ? repository.value
      : unexpectedRepository(repository.reason),
    siteHealth: siteHealth.status === 'fulfilled'
      ? siteHealth.value
      : {
          ok: false,
          url: SITE_TRAFFIC_URL,
          latencyMs: 0,
          checkedAt: generatedAt,
          error: redactErrorText(siteHealth.reason),
        },
    pages: pages.status === 'fulfilled'
      ? pages.value
      : emptyPagesStatus(redactErrorText(pages.reason)),
  };
}

export function clearSiteTrafficCache(): void {
  trafficCache().clear();
}

/** Serialize tracker/config mutations so install, reconnect, and disconnect cannot cross. */
export async function withSiteTrafficMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = cacheGlobal.__shibaSiteTrafficMutationChain ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = previous.catch(() => {});
  cacheGlobal.__shibaSiteTrafficMutationChain = ready.then(() => gate);
  await ready;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function getSiteTrafficSnapshot(input: {
  days?: unknown;
  refresh?: boolean;
  goatcounter?: IntegrationCreds['goatcounter'];
  githubToken?: string;
}): Promise<SiteTrafficSnapshot> {
  const days = normalizeTrafficDays(input.days);
  const key = configFingerprint(days, input.goatcounter, input.githubToken);
  const cache = trafficCache();
  const now = Date.now();

  for (const [entryKey, entry] of cache) {
    if (!entry.pending && entry.expiresAt <= now) cache.delete(entryKey);
  }
  while (cache.size > 24) cache.delete(cache.keys().next().value as string);

  const existing = cache.get(key);
  if (existing?.pending) return existing.promise;
  if (!input.refresh && existing && existing.expiresAt > now) {
    const snapshot = await existing.promise;
    return { ...snapshot, stale: true };
  }

  const entry: TrafficCacheEntry = {
    expiresAt: now + CACHE_TTL_MS,
    pending: true,
    promise: Promise.resolve(null as unknown as SiteTrafficSnapshot),
  };
  entry.promise = buildSiteTrafficSnapshot(days, input.goatcounter, input.githubToken)
    .then((snapshot) => {
      entry.pending = false;
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      return snapshot;
    })
    .catch((error) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
  cache.set(key, entry);
  return entry.promise;
}

export async function validateGoatCounterCredentials(
  siteCodeValue: unknown,
  apiTokenValue: unknown,
): Promise<{ siteCode: string; apiToken: string }> {
  let siteCode: string;
  try {
    siteCode = normalizeGoatCounterSiteCode(siteCodeValue);
  } catch (error) {
    throw new SiteTrafficServiceError(redactErrorText(error), 400, 'INVALID_SITE_CODE');
  }
  const apiToken = normalizeToken(apiTokenValue, 'GoatCounter API token');
  const result = await goatCounterGet<Record<string, unknown>>(siteCode, apiToken, 'me');
  if (!result.user || typeof result.user !== 'object' || !result.token || typeof result.token !== 'object') {
    throw new SiteTrafficServiceError(
      'GoatCounter accepted the request but returned an unexpected account response.',
      502,
      'INVALID_GOATCOUNTER_ACCOUNT',
    );
  }
  try {
    await goatCounterGet<GoatCounterTotalResponse>(
      siteCode,
      apiToken,
      'stats/total',
      dateWindow(7),
    );
  } catch (error) {
    if (error instanceof SiteTrafficServiceError && [401, 403].includes(error.status)) {
      throw new SiteTrafficServiceError(
        'The GoatCounter token needs permission to read this site and its statistics.',
        403,
        'GOATCOUNTER_STATS_PERMISSION_REQUIRED',
      );
    }
    throw error;
  }
  return { siteCode, apiToken };
}

async function updatePageFile(
  token: string,
  path: SiteTrafficPageFile,
  html: string,
  sha: string,
  operation: 'install' | 'remove',
): Promise<string | undefined> {
  const response = await githubRequest<Record<string, unknown>>(
    `/contents/${path}`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({
        message: operation === 'install'
          ? 'chore(pages): install privacy-friendly traffic counter'
          : 'chore(pages): remove traffic counter',
        content: Buffer.from(html, 'utf8').toString('base64'),
        sha,
        branch: SITE_TRAFFIC_BRANCH,
      }),
    },
  );
  return safeString(asRecord(response.commit).sha, 80) || undefined;
}

async function patchPageFile(
  token: string,
  path: SiteTrafficPageFile,
  operation: 'install' | 'remove',
  siteCode?: string,
): Promise<TrackerPatchFileResult> {
  try {
    const current = await getPageFile(token, path);
    const transformed = operation === 'install'
      ? injectGoatCounterTracker(current.html, siteCode || '')
      : removeGoatCounterTracker(current.html);
    if (!transformed.changed) {
      return {
        path,
        ok: true,
        changed: false,
        status: operation === 'install' ? 'already-installed' : 'already-absent',
      };
    }
    const commitSha = await updatePageFile(
      token,
      path,
      transformed.html,
      current.sha,
      operation,
    );
    return {
      path,
      ok: true,
      changed: true,
      status: operation === 'install' ? 'installed' : 'removed',
      commitSha,
    };
  } catch (error) {
    return {
      path,
      ok: false,
      changed: false,
      status: 'error',
      error: redactErrorText(error, [token]),
    };
  }
}

async function patchPublishedPages(input: {
  operation: 'install' | 'remove';
  githubToken: unknown;
  siteCode?: unknown;
}): Promise<TrackerPatchResult> {
  const token = normalizeToken(input.githubToken, 'GitHub token');
  const siteCode = input.operation === 'install'
    ? normalizeGoatCounterSiteCode(input.siteCode)
    : undefined;
  const files: TrackerPatchFileResult[] = [];

  // The Contents API creates one commit per file. Run sequentially so the
  // second write is based on the branch tip produced by the first.
  for (const path of SITE_TRAFFIC_PAGE_FILES) {
    files.push(await patchPageFile(token, path, input.operation, siteCode));
  }
  const okCount = files.filter((file) => file.ok).length;
  const ok = okCount === files.length;
  return {
    ok,
    partial: okCount > 0 && !ok,
    operation: input.operation,
    files,
    ...(input.operation === 'remove' && !ok ? { trackerMayRemain: true } : {}),
  };
}

export async function installGoatCounterTracker(input: {
  siteCode: unknown;
  githubToken: unknown;
}): Promise<TrackerPatchResult> {
  // Constructing the expected block here validates the site code before any
  // GitHub request and makes the fixed hosted-domain constraint explicit.
  goatCounterTrackerBlock(normalizeGoatCounterSiteCode(input.siteCode));
  return patchPublishedPages({
    operation: 'install',
    githubToken: input.githubToken,
    siteCode: input.siteCode,
  });
}

export async function removeInstalledGoatCounterTracker(input: {
  githubToken: unknown;
}): Promise<TrackerPatchResult> {
  return patchPublishedPages({
    operation: 'remove',
    githubToken: input.githubToken,
  });
}
