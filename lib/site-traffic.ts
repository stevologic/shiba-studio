import { createHash } from 'node:crypto';
import {
  SITE_TRAFFIC_REPOSITORY,
  SITE_TRAFFIC_URL,
  type PagesCertificate,
  type PagesStatus,
  type RepositoryTraffic,
  type RepositoryTrafficMetric,
  type SiteHealth,
  type SiteTrafficSnapshot,
  type TrafficSourceError,
} from './site-traffic-types';

const GITHUB_API = `https://api.github.com/repos/${SITE_TRAFFIC_REPOSITORY}`;
const GITHUB_PAGES_SETTINGS_URL =
  `https://github.com/${SITE_TRAFFIC_REPOSITORY}/settings/pages`;
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;

export class SiteTrafficServiceError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code = 'SITE_TRAFFIC_ERROR',
  ) {
    super(message);
    this.name = 'SiteTrafficServiceError';
  }
}

interface CacheEntry {
  expiresAt: number;
  pending: boolean;
  promise: Promise<SiteTrafficSnapshot>;
}

interface GitHubTrafficMetricResponse {
  count?: unknown;
  uniques?: unknown;
  views?: unknown;
  clones?: unknown;
}

const cacheGlobal = globalThis as typeof globalThis & {
  __shibaSiteTrafficCache?: Map<string, CacheEntry>;
};

function trafficCache(): Map<string, CacheEntry> {
  cacheGlobal.__shibaSiteTrafficCache ??= new Map();
  return cacheGlobal.__shibaSiteTrafficCache;
}

function normalizeToken(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SiteTrafficServiceError(
      'Connect GitHub to load repository traffic and Pages details.',
      409,
      'GITHUB_NOT_CONFIGURED',
    );
  }
  return value.trim();
}

function safeString(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function safeIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeDay(value: unknown): string | undefined {
  const iso = safeIso(value);
  return iso?.slice(0, 10);
}

function safePath(value: unknown, max = 300): string {
  const path = safeString(value, max);
  return path.startsWith('/') ? path : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecords(value: unknown, limit: number): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.slice(0, limit).map(asRecord)
    : [];
}

function redactErrorText(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error || 'Unknown error');
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return message.slice(0, 500);
}

async function githubRequest<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'Shiba-Studio-Traffic',
    },
  });
  if (!response.ok) {
    const status = response.status;
    const message = status === 401 || status === 403
      ? 'GitHub denied this traffic request. The token needs repository Administration read access.'
      : `GitHub returned HTTP ${status}.`;
    throw new SiteTrafficServiceError(message, status, 'GITHUB_TRAFFIC_ERROR');
  }
  return response.json() as Promise<T>;
}

function settledError(
  source: string,
  result: PromiseSettledResult<unknown>,
  token: string,
): TrafficSourceError | null {
  return result.status === 'rejected'
    ? { source, message: redactErrorText(result.reason, [token]) }
    : null;
}

function summarizeErrors(errors: TrafficSourceError[]): string | undefined {
  return errors.length
    ? errors.map((error) => `${error.source}: ${error.message}`).join(' · ')
    : undefined;
}

function normalizeRepositoryMetric(
  value: GitHubTrafficMetricResponse,
  listKey: 'views' | 'clones',
): RepositoryTrafficMetric {
  return {
    count: safeCount(value.count),
    uniques: safeCount(value.uniques),
    daily: asRecords(value[listKey], 20).flatMap((row) => {
      const date = safeDay(row.timestamp);
      return date
        ? [{
            date,
            count: safeCount(row.count),
            visits: safeCount(row.count),
            uniques: safeCount(row.uniques),
          }]
        : [];
    }).slice(-14),
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
  const githubToken = normalizeToken(token);
  const results = await Promise.allSettled([
    githubRequest<GitHubTrafficMetricResponse>('/traffic/views?per=day', githubToken),
    githubRequest<GitHubTrafficMetricResponse>('/traffic/clones?per=day', githubToken),
    githubRequest<unknown[]>('/traffic/popular/referrers', githubToken),
    githubRequest<unknown[]>('/traffic/popular/paths', githubToken),
  ]);
  const sources = ['views', 'clones', 'referrers', 'paths'];
  const errors = results.flatMap((result, index) => {
    const error = settledError(sources[index], result, githubToken);
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
        path: safePath(row.path) || '/',
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'Shiba-Studio-Traffic' },
    });
    const ok = response.status >= 200 && response.status < 400;
    return {
      ok,
      url: SITE_TRAFFIC_URL,
      status: response.status,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      checkedAt,
      ...(ok ? {} : { error: `The site returned HTTP ${response.status}.` }),
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
  if (!token?.trim()) return emptyPagesStatus('Connect GitHub to load Pages deployment details.');
  const githubToken = normalizeToken(token);
  const results = await Promise.allSettled([
    githubRequest<Record<string, unknown>>('/pages', githubToken),
    githubRequest<Record<string, unknown>>('/pages/builds/latest', githubToken),
  ]);
  const errors = [
    settledError('site', results[0], githubToken),
    settledError('latest build', results[1], githubToken),
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
          ? certificateRaw.domains.map((domain) => safeString(domain, 180)).filter(Boolean).slice(0, 10)
          : [],
      }
    : undefined;

  return {
    configured: true,
    connected: successCount > 0,
    partial: successCount > 0 && errors.length > 0,
    status: safeString(site.status, 60) || undefined,
    htmlUrl: GITHUB_PAGES_SETTINGS_URL,
    cname: safeString(site.cname, 180) || undefined,
    httpsEnforced: typeof site.https_enforced === 'boolean' ? site.https_enforced : undefined,
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
          error: safeString(asRecord(build.error).message, 200) || undefined,
        }
      : undefined,
    certificate,
    errors,
    error: summarizeErrors(errors),
  };
}

async function buildSiteTrafficSnapshot(githubToken?: string): Promise<SiteTrafficSnapshot> {
  const generatedAt = new Date().toISOString();
  const [repository, siteHealth, pages] = await Promise.allSettled([
    fetchRepositoryTraffic(githubToken),
    fetchSiteHealth(),
    fetchPagesStatus(githubToken),
  ]);
  return {
    ok: true,
    siteUrl: SITE_TRAFFIC_URL,
    repositoryName: SITE_TRAFFIC_REPOSITORY,
    generatedAt,
    stale: false,
    repository: repository.status === 'fulfilled'
      ? repository.value
      : emptyRepositoryTraffic(redactErrorText(repository.reason, [githubToken || ''])),
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
      : emptyPagesStatus(redactErrorText(pages.reason, [githubToken || ''])),
  };
}

export function clearSiteTrafficCache(): void {
  trafficCache().clear();
}

export async function getSiteTrafficSnapshot(input: {
  refresh?: boolean;
  githubToken?: string;
}): Promise<SiteTrafficSnapshot> {
  const key = createHash('sha256')
    .update(input.githubToken || '')
    .digest('hex')
    .slice(0, 24);
  const cache = trafficCache();
  const now = Date.now();
  const existing = cache.get(key);
  if (existing?.pending) return existing.promise;
  if (!input.refresh && existing && existing.expiresAt > now) {
    return { ...await existing.promise, stale: true };
  }
  const entry: CacheEntry = {
    expiresAt: now + CACHE_TTL_MS,
    pending: true,
    promise: Promise.resolve(null as unknown as SiteTrafficSnapshot),
  };
  entry.promise = buildSiteTrafficSnapshot(input.githubToken)
    .then((snapshot) => {
      entry.pending = false;
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      return snapshot;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, entry);
  return entry.promise;
}
