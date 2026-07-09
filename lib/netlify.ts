/**
 * Netlify REST API client for the core Netlify integration.
 * Auth: Bearer personal access token (https://app.netlify.com/user/applications#personal-access-tokens).
 * Optional site filter via defaultSite (site id or name).
 *
 * Deploy path mirrors Vercel: list sites, list/get deploys, trigger a build
 * (git-linked sites), and upsert env vars — enough for agents to ship vibe-coded projects.
 */

import type { IntegrationCreds } from './types';
// Lazy runtime import avoids circular init with integrations.ts re-exports.
import { getIntegrationCreds } from './integrations';

const NETLIFY_API = 'https://api.netlify.com/api/v1';

export type NetlifyCreds = NonNullable<IntegrationCreds['netlify']>;

function getCreds(from?: IntegrationCreds): NetlifyCreds | null {
  // Prefer explicit creds (Test Connection / one-off), else the in-memory
  // store populated by agent runs and the integrations API.
  const c = from?.netlify ?? getIntegrationCreds().netlify;
  if (!c?.token?.trim()) return null;
  return {
    token: c.token.trim(),
    accountSlug: c.accountSlug?.trim() || undefined,
    defaultSite: c.defaultSite?.trim() || undefined,
  };
}

async function netlifyFetch(
  c: NetlifyCreds,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${NETLIFY_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${c.token}`,
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, { ...init, headers });
}

async function readError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    const msg = j?.message || j?.error || j?.errors || JSON.stringify(j);
    return String(msg).slice(0, 400);
  } catch {
    return (await res.text().catch(() => '')).slice(0, 400) || res.statusText;
  }
}

export async function testNetlify(
  from?: IntegrationCreds,
): Promise<{ ok: boolean; user?: string; email?: string; account?: string; error?: string }> {
  const c = getCreds(from);
  if (!c) return { ok: false, error: 'No Netlify personal access token configured' };
  try {
    const res = await netlifyFetch(c, '/user');
    if (!res.ok) return { ok: false, error: `${res.status} ${await readError(res)}` };
    const user = await res.json();
    const slug = c.accountSlug
      || user?.slug
      || user?.account_slug
      || (Array.isArray(user?.teams) && user.teams[0]?.slug)
      || undefined;
    return {
      ok: true,
      user: user?.full_name || user?.name || user?.slug || user?.id,
      email: user?.email,
      account: slug,
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Netlify test failed' };
  }
}

export interface NetlifySiteSummary {
  id: string;
  name: string;
  url?: string;
  adminUrl?: string;
  sslUrl?: string;
  accountSlug?: string;
  buildSettings?: {
    provider?: string;
    repoUrl?: string;
    repoBranch?: string;
  } | null;
  publishedDeploy?: {
    id?: string;
    state?: string;
    url?: string;
  } | null;
  updatedAt?: string;
}

function mapSite(s: Record<string, unknown>): NetlifySiteSummary {
  const build = (s.build_settings || s.buildSettings) as Record<string, unknown> | undefined;
  const pub = (s.published_deploy || s.publishedDeploy) as Record<string, unknown> | undefined;
  return {
    id: String(s.id || s.site_id || ''),
    name: String(s.name || s.site_name || ''),
    url: s.url ? String(s.url) : undefined,
    adminUrl: s.admin_url ? String(s.admin_url) : (s.adminUrl ? String(s.adminUrl) : undefined),
    sslUrl: s.ssl_url ? String(s.ssl_url) : (s.sslUrl ? String(s.sslUrl) : undefined),
    accountSlug: s.account_slug ? String(s.account_slug) : undefined,
    buildSettings: build
      ? {
        provider: build.provider ? String(build.provider) : undefined,
        repoUrl: build.repo_url ? String(build.repo_url) : (build.repoUrl ? String(build.repoUrl) : undefined),
        repoBranch: build.repo_branch ? String(build.repo_branch) : (build.repoBranch ? String(build.repoBranch) : undefined),
      }
      : null,
    publishedDeploy: pub
      ? {
        id: pub.id ? String(pub.id) : undefined,
        state: pub.state ? String(pub.state) : undefined,
        url: pub.ssl_url ? String(pub.ssl_url) : (pub.url ? String(pub.url) : undefined),
      }
      : null,
    updatedAt: s.updated_at ? String(s.updated_at) : undefined,
  };
}

export async function netlifyListSites(
  limit = 20,
  from?: IntegrationCreds,
): Promise<NetlifySiteSummary[]> {
  const c = getCreds(from);
  if (!c) throw new Error('Netlify not configured — add a personal access token on Capabilities');
  const q = new URLSearchParams({
    per_page: String(Math.min(Math.max(limit, 1), 100)),
  });
  if (c.accountSlug) q.set('filter', 'all');
  const res = await netlifyFetch(c, `/sites?${q}`);
  if (!res.ok) throw new Error(`Netlify sites ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  const sites = Array.isArray(data) ? data : (data.sites || []);
  return (sites as Array<Record<string, unknown>>).slice(0, limit).map(mapSite);
}

export async function netlifyGetSite(
  siteIdOrName: string,
  from?: IntegrationCreds,
): Promise<NetlifySiteSummary> {
  const c = getCreds(from);
  if (!c) throw new Error('Netlify not configured');
  const key = siteIdOrName.trim();
  if (!key) throw new Error('site id or name is required');

  // Prefer direct id lookup; fall back to name scan.
  const res = await netlifyFetch(c, `/sites/${encodeURIComponent(key)}`);
  if (res.ok) return mapSite(await res.json());

  const sites = await netlifyListSites(100, from);
  const match = sites.find(
    (s) => s.id === key || s.name === key || s.name?.toLowerCase() === key.toLowerCase(),
  );
  if (!match) throw new Error(`Netlify site not found: ${key}`);
  return match;
}

export interface NetlifyDeploySummary {
  id: string;
  url: string;
  state?: string;
  name?: string;
  createdAt?: string;
  publishedAt?: string;
  errorMessage?: string;
  deployUrl?: string;
  adminUrl?: string;
  branch?: string;
  context?: string;
}

function mapDeploy(d: Record<string, unknown>): NetlifyDeploySummary {
  const url = d.ssl_url || d.url || d.deploy_ssl_url || d.deploy_url || '';
  return {
    id: String(d.id || ''),
    url: url ? String(url) : '',
    state: d.state ? String(d.state) : undefined,
    name: d.name ? String(d.name) : undefined,
    createdAt: d.created_at ? String(d.created_at) : undefined,
    publishedAt: d.published_at ? String(d.published_at) : undefined,
    errorMessage: d.error_message ? String(d.error_message) : undefined,
    deployUrl: d.deploy_ssl_url ? String(d.deploy_ssl_url) : (d.deploy_url ? String(d.deploy_url) : undefined),
    adminUrl: d.admin_url ? String(d.admin_url) : undefined,
    branch: d.branch ? String(d.branch) : undefined,
    context: d.context ? String(d.context) : undefined,
  };
}

export async function netlifyListDeploys(
  siteIdOrName?: string,
  limit = 10,
  from?: IntegrationCreds,
): Promise<NetlifyDeploySummary[]> {
  const c = getCreds(from);
  if (!c) throw new Error('Netlify not configured');
  const siteKey = (siteIdOrName || c.defaultSite || '').trim();
  if (!siteKey) throw new Error('site is required (or set a default site on Capabilities)');
  const site = await netlifyGetSite(siteKey, from);
  const q = new URLSearchParams({
    per_page: String(Math.min(Math.max(limit, 1), 50)),
  });
  const res = await netlifyFetch(c, `/sites/${encodeURIComponent(site.id)}/deploys?${q}`);
  if (!res.ok) throw new Error(`Netlify deploys ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.deploys || []);
  return (list as Array<Record<string, unknown>>).slice(0, limit).map(mapDeploy);
}

export async function netlifyGetDeploy(
  deployId: string,
  from?: IntegrationCreds,
): Promise<NetlifyDeploySummary> {
  const c = getCreds(from);
  if (!c) throw new Error('Netlify not configured');
  const id = deployId.trim();
  if (!id) throw new Error('deploy id is required');
  const res = await netlifyFetch(c, `/deploys/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Netlify deploy ${res.status}: ${await readError(res)}`);
  return mapDeploy(await res.json());
}

export interface NetlifyDeployResult extends NetlifyDeploySummary {
  siteId?: string;
  siteName?: string;
  buildId?: string;
}

/**
 * Trigger a Netlify site build / deploy (git-linked sites).
 * Uses POST /sites/{site_id}/builds — same outcome as "Trigger deploy" in the UI.
 */
export async function netlifyDeploy(
  opts: {
    site?: string;
    clearCache?: boolean;
    /** Optional branch / title hint stored on the build when supported. */
    title?: string;
  },
  from?: IntegrationCreds,
): Promise<NetlifyDeployResult> {
  const c = getCreds(from);
  if (!c) throw new Error('Netlify not configured — add a personal access token on Capabilities');
  const siteKey = (opts.site || c.defaultSite || '').trim();
  if (!siteKey) {
    throw new Error('site is required (or set a default site on Capabilities)');
  }
  const site = await netlifyGetSite(siteKey, from);
  if (!site.buildSettings?.repoUrl && !site.buildSettings?.provider) {
    // Still allow build trigger — Netlify may use linked CI without repo_url populated.
  }

  const body: Record<string, unknown> = {};
  if (opts.clearCache) body.clear_cache = true;
  if (opts.title) body.title = opts.title;

  const res = await netlifyFetch(c, `/sites/${encodeURIComponent(site.id)}/builds`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Netlify build ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  // Build response may nest deploy or return build + deploy_id.
  const deployId = data.deploy_id || data.deploy?.id || data.id;
  let deploy: NetlifyDeploySummary | null = null;
  if (deployId) {
    try {
      deploy = await netlifyGetDeploy(String(deployId), from);
    } catch {
      deploy = mapDeploy(data.deploy || data);
    }
  } else {
    deploy = mapDeploy(data.deploy || data);
  }
  return {
    ...deploy,
    siteId: site.id,
    siteName: site.name,
    buildId: data.id ? String(data.id) : undefined,
  };
}

/**
 * Create or update a Netlify site environment variable (all contexts by default).
 * Uses the account env API with site_id scope when account slug is known;
 * falls back to the site build_settings env patch.
 */
export async function netlifySetEnv(
  opts: {
    site: string;
    key: string;
    value: string;
    /** production | deploy-preview | branch-deploy | dev | all (default all) */
    context?: string;
  },
  from?: IntegrationCreds,
): Promise<{ ok: boolean; key: string }> {
  const c = getCreds(from);
  if (!c) throw new Error('Netlify not configured');
  const siteKey = (opts.site || c.defaultSite || '').trim();
  if (!siteKey) throw new Error('site is required');
  const key = opts.key.trim();
  const value = opts.value;
  if (!key) throw new Error('env key is required');
  if (value == null || value === '') throw new Error('env value is required');

  const site = await netlifyGetSite(siteKey, from);
  const account = c.accountSlug || site.accountSlug;
  const context = (opts.context || 'all').trim() || 'all';

  if (account) {
    // Modern account-scoped env API (upsert).
    const body = {
      key,
      scopes: ['builds', 'functions', 'runtime', 'post_processing'],
      values: [{ value, context: context === 'all' ? 'all' : context }],
    };
    const res = await netlifyFetch(
      c,
      `/accounts/${encodeURIComponent(account)}/env?site_id=${encodeURIComponent(site.id)}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (res.ok || res.status === 201) return { ok: true, key };
    // Conflict → try update
    if (res.status === 422 || res.status === 409) {
      const put = await netlifyFetch(
        c,
        `/accounts/${encodeURIComponent(account)}/env/${encodeURIComponent(key)}?site_id=${encodeURIComponent(site.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            key,
            scopes: ['builds', 'functions', 'runtime', 'post_processing'],
            values: [{ value, context: context === 'all' ? 'all' : context }],
          }),
        },
      );
      if (put.ok) return { ok: true, key };
      throw new Error(`Netlify env ${put.status}: ${await readError(put)}`);
    }
    throw new Error(`Netlify env ${res.status}: ${await readError(res)}`);
  }

  // Fallback: site env endpoint (legacy).
  const res = await netlifyFetch(c, `/sites/${encodeURIComponent(site.id)}/env/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ values: [{ value, context: context === 'all' ? 'all' : context }] }),
  });
  if (!res.ok) throw new Error(`Netlify env ${res.status}: ${await readError(res)}`);
  return { ok: true, key };
}
