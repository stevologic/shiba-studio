/**
 * Vercel REST API client for the core Vercel integration.
 * Auth: Bearer access token (https://vercel.com/account/tokens).
 * Optional teamId / teamSlug scopes requests to a team.
 */

import type { IntegrationCreds } from './types';
// Lazy runtime import avoids circular init with integrations.ts re-exports.
import { getIntegrationCreds } from './integrations';

const VERCEL_API = 'https://api.vercel.com';

export type VercelCreds = NonNullable<IntegrationCreds['vercel']>;

function getCreds(from?: IntegrationCreds): VercelCreds | null {
  // Prefer explicit creds (Test Connection / one-off), else the in-memory
  // store populated by agent runs and the integrations API.
  const c = from?.vercel ?? getIntegrationCreds().vercel;
  if (!c?.token?.trim()) return null;
  return {
    token: c.token.trim(),
    teamId: c.teamId?.trim() || undefined,
    teamSlug: c.teamSlug?.trim() || undefined,
    defaultProject: c.defaultProject?.trim() || undefined,
  };
}

function teamQuery(c: VercelCreds): string {
  const q = new URLSearchParams();
  if (c.teamId) q.set('teamId', c.teamId);
  else if (c.teamSlug) q.set('slug', c.teamSlug);
  const s = q.toString();
  return s ? `?${s}` : '';
}

function appendTeam(url: string, c: VercelCreds): string {
  const sep = url.includes('?') ? '&' : '?';
  if (c.teamId) return `${url}${sep}teamId=${encodeURIComponent(c.teamId)}`;
  if (c.teamSlug) return `${url}${sep}slug=${encodeURIComponent(c.teamSlug)}`;
  return url;
}

async function vercelFetch(
  c: VercelCreds,
  path: string,
  init?: RequestInit & { rawPath?: boolean },
): Promise<Response> {
  const url = init?.rawPath ? path : `${VERCEL_API}${path}`;
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
    const msg = j?.error?.message || j?.message || j?.error || JSON.stringify(j);
    return String(msg).slice(0, 400);
  } catch {
    return (await res.text().catch(() => '')).slice(0, 400) || res.statusText;
  }
}

export async function testVercel(
  from?: IntegrationCreds,
): Promise<{ ok: boolean; user?: string; email?: string; team?: string; error?: string }> {
  const c = getCreds(from);
  if (!c) return { ok: false, error: 'No Vercel access token configured' };
  try {
    const res = await vercelFetch(c, `/v2/user${teamQuery(c)}`);
    if (!res.ok) return { ok: false, error: `${res.status} ${await readError(res)}` };
    const data = await res.json();
    const user = data.user || data;
    let team: string | undefined;
    if (c.teamId || c.teamSlug) {
      try {
        const tRes = await vercelFetch(c, `/v2/teams${teamQuery(c)}`);
        if (tRes.ok) {
          const tData = await tRes.json();
          const teams = tData.teams || (tData.id ? [tData] : []);
          const match = Array.isArray(teams)
            ? teams.find((t: { id?: string; slug?: string }) =>
              (c.teamId && t.id === c.teamId) || (c.teamSlug && t.slug === c.teamSlug),
            ) || teams[0]
            : null;
          if (match) team = match.name || match.slug || match.id;
        }
      } catch { /* team label optional */ }
    }
    return {
      ok: true,
      user: user.username || user.name || user.id,
      email: user.email,
      team,
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Vercel test failed' };
  }
}

export interface VercelProjectSummary {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number;
  link?: {
    type?: string;
    repo?: string;
    org?: string;
    repoId?: string | number;
    productionBranch?: string;
  } | null;
  latestDeployments?: Array<{
    id?: string;
    url?: string;
    readyState?: string;
    target?: string | null;
  }>;
}

export async function vercelListProjects(
  limit = 20,
  from?: IntegrationCreds,
): Promise<VercelProjectSummary[]> {
  const c = getCreds(from);
  if (!c) throw new Error('Vercel not configured — add an access token on Capabilities');
  const q = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)) });
  if (c.teamId) q.set('teamId', c.teamId);
  else if (c.teamSlug) q.set('slug', c.teamSlug);
  const res = await vercelFetch(c, `/v9/projects?${q}`);
  if (!res.ok) throw new Error(`Vercel projects ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  return (data.projects || []).map((p: Record<string, unknown>) => {
    const link = p.link as Record<string, unknown> | undefined;
    const latest = (p.latestDeployments as Array<Record<string, unknown>> | undefined) || [];
    return {
      id: String(p.id || ''),
      name: String(p.name || ''),
      framework: (p.framework as string | null | undefined) ?? null,
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : undefined,
      link: link
        ? {
          type: link.type ? String(link.type) : undefined,
          repo: link.repo ? String(link.repo) : undefined,
          org: link.org ? String(link.org) : undefined,
          repoId: link.repoId as string | number | undefined,
          productionBranch: link.productionBranch ? String(link.productionBranch) : undefined,
        }
        : null,
      latestDeployments: latest.slice(0, 2).map((d) => ({
        id: d.id ? String(d.id) : undefined,
        url: d.url ? String(d.url) : undefined,
        readyState: d.readyState ? String(d.readyState) : undefined,
        target: d.target != null ? String(d.target) : null,
      })),
    };
  });
}

export async function vercelGetProject(
  projectIdOrName: string,
  from?: IntegrationCreds,
): Promise<VercelProjectSummary> {
  const c = getCreds(from);
  if (!c) throw new Error('Vercel not configured');
  const id = projectIdOrName.trim();
  if (!id) throw new Error('project name or id is required');
  const res = await vercelFetch(c, appendTeam(`/v9/projects/${encodeURIComponent(id)}`, c));
  if (!res.ok) throw new Error(`Vercel project ${res.status}: ${await readError(res)}`);
  const p = await res.json();
  const link = p.link as Record<string, unknown> | undefined;
  return {
    id: String(p.id || ''),
    name: String(p.name || ''),
    framework: p.framework ?? null,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : undefined,
    link: link
      ? {
        type: link.type ? String(link.type) : undefined,
        repo: link.repo ? String(link.repo) : undefined,
        org: link.org ? String(link.org) : undefined,
        repoId: link.repoId as string | number | undefined,
        productionBranch: link.productionBranch ? String(link.productionBranch) : undefined,
      }
      : null,
  };
}

export interface VercelDeploymentSummary {
  id: string;
  url: string;
  name?: string;
  readyState?: string;
  target?: string | null;
  createdAt?: number;
  inspectorUrl?: string | null;
  meta?: Record<string, string>;
}

function mapDeployment(d: Record<string, unknown>): VercelDeploymentSummary {
  const urlHost = d.url ? String(d.url) : '';
  return {
    id: String(d.id || d.uid || ''),
    url: urlHost ? (urlHost.startsWith('http') ? urlHost : `https://${urlHost}`) : '',
    name: d.name ? String(d.name) : undefined,
    readyState: d.readyState ? String(d.readyState) : (d.state ? String(d.state) : undefined),
    target: d.target != null ? String(d.target) : null,
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : undefined,
    inspectorUrl: d.inspectorUrl != null ? String(d.inspectorUrl) : null,
    meta: (d.meta as Record<string, string> | undefined) || undefined,
  };
}

export async function vercelListDeployments(
  projectIdOrName?: string,
  limit = 10,
  from?: IntegrationCreds,
): Promise<VercelDeploymentSummary[]> {
  const c = getCreds(from);
  if (!c) throw new Error('Vercel not configured');
  let project = (projectIdOrName || c.defaultProject || '').trim();
  // Resolve name → id so the deployments filter is reliable.
  if (project && !project.startsWith('prj_')) {
    try {
      const p = await vercelGetProject(project, from);
      if (p.id) project = p.id;
    } catch { /* use as-is */ }
  }
  const q = new URLSearchParams({
    limit: String(Math.min(Math.max(limit, 1), 50)),
  });
  if (project) q.set('projectId', project);
  if (c.teamId) q.set('teamId', c.teamId);
  else if (c.teamSlug) q.set('slug', c.teamSlug);
  const res = await vercelFetch(c, `/v6/deployments?${q}`);
  if (!res.ok) throw new Error(`Vercel deployments ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  return ((data.deployments || []) as Array<Record<string, unknown>>).map(mapDeployment);
}

export async function vercelGetDeployment(
  idOrUrl: string,
  from?: IntegrationCreds,
): Promise<VercelDeploymentSummary> {
  const c = getCreds(from);
  if (!c) throw new Error('Vercel not configured');
  const id = idOrUrl.trim().replace(/^https?:\/\//, '');
  if (!id) throw new Error('deployment id or url is required');
  const res = await vercelFetch(c, appendTeam(`/v13/deployments/${encodeURIComponent(id)}`, c));
  if (!res.ok) throw new Error(`Vercel deployment ${res.status}: ${await readError(res)}`);
  return mapDeployment(await res.json());
}

export interface VercelDeployResult extends VercelDeploymentSummary {
  projectId?: string;
}

/**
 * Deploy / redeploy a Vercel project.
 * Preferred path for git-linked projects: redeploy latest with withLatestCommit,
 * or create from gitSource when a branch ref is specified.
 */
export async function vercelDeploy(
  opts: {
    project?: string;
    target?: 'production' | 'preview' | string;
    gitRef?: string;
    /** Explicit redeploy of an existing deployment id. */
    deploymentId?: string;
  },
  from?: IntegrationCreds,
): Promise<VercelDeployResult> {
  const c = getCreds(from);
  if (!c) throw new Error('Vercel not configured — add an access token on Capabilities');
  const projectKey = (opts.project || c.defaultProject || '').trim();
  if (!projectKey && !opts.deploymentId) {
    throw new Error('project is required (or set a default project on Capabilities)');
  }

  let project: VercelProjectSummary | null = null;
  if (projectKey) {
    project = await vercelGetProject(projectKey, from);
  }

  const body: Record<string, unknown> = {
    name: project?.name || projectKey,
  };
  if (project?.id) body.project = project.id;
  if (opts.target && opts.target !== 'preview') body.target = opts.target;

  if (opts.deploymentId) {
    body.deploymentId = opts.deploymentId;
    body.withLatestCommit = true;
  } else if (opts.gitRef && project?.link?.repoId) {
    const linkType = (project.link.type || 'github').toLowerCase();
    const gitType = linkType.includes('github') ? 'github' : linkType;
    body.gitSource = {
      type: gitType,
      ref: opts.gitRef,
      repoId: project.link.repoId,
    };
  } else if (project) {
    // Redeploy latest commit on the linked repo when possible.
    const deploys = await vercelListDeployments(project.id, 1, from);
    if (deploys[0]?.id) {
      body.deploymentId = deploys[0].id;
      body.withLatestCommit = true;
    } else if (project.link?.repoId) {
      body.gitSource = {
        type: (project.link.type || 'github').toLowerCase().includes('github') ? 'github' : (project.link.type || 'github'),
        ref: project.link.productionBranch || 'main',
        repoId: project.link.repoId,
      };
    } else {
      throw new Error(
        `Project "${project.name}" has no prior deployments and no linked Git repo. Connect a Git repository in the Vercel dashboard, or pass deploymentId / gitRef.`,
      );
    }
  }

  const url = appendTeam('/v13/deployments?forceNew=1&skipAutoDetectionConfirmation=1', c);
  const res = await vercelFetch(c, url, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Vercel deploy ${res.status}: ${await readError(res)}`);
  const d = mapDeployment(await res.json());
  return { ...d, projectId: project?.id };
}

/**
 * Create or update a project environment variable.
 * target: production | preview | development (or array).
 */
export async function vercelSetEnv(
  opts: {
    project: string;
    key: string;
    value: string;
    target?: string | string[];
    type?: 'plain' | 'secret' | 'encrypted' | 'system';
    gitBranch?: string;
  },
  from?: IntegrationCreds,
): Promise<{ ok: boolean; key: string; id?: string }> {
  const c = getCreds(from);
  if (!c) throw new Error('Vercel not configured');
  const project = (opts.project || c.defaultProject || '').trim();
  if (!project) throw new Error('project is required');
  const key = opts.key.trim();
  const value = opts.value;
  if (!key) throw new Error('env key is required');
  if (value == null || value === '') throw new Error('env value is required');

  const targets = Array.isArray(opts.target)
    ? opts.target
    : opts.target
      ? [opts.target]
      : ['production', 'preview', 'development'];

  const body: Record<string, unknown> = {
    key,
    value,
    type: opts.type || 'encrypted',
    target: targets,
  };
  if (opts.gitBranch) body.gitBranch = opts.gitBranch;

  const res = await vercelFetch(
    c,
    appendTeam(`/v10/projects/${encodeURIComponent(project)}/env?upsert=true`, c),
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(`Vercel env ${res.status}: ${await readError(res)}`);
  const data = await res.json();
  const created = data.created || data;
  return { ok: true, key, id: created?.id ? String(created.id) : undefined };
}
