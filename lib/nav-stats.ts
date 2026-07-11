import { listChatSessions } from './chat-sessions';
import { listMcpServers } from './mcp';
import { listProjects } from './projects';
import { loadAgents, loadConfig } from './persistence';
import { listGlobalUploadFiles } from './workspace';
import { getUsageSummary } from './usage';
import type { IntegrationCreds } from './types';

/** Default monthly quota (USD) when the user hasn't set one in Settings. */
const DEFAULT_USAGE_BUDGET_USD = 25;

function countConfiguredIntegrations(creds: IntegrationCreds): number {
  let n = 0;
  if (creds.github?.token?.trim()) n++;
  if (creds.slack?.token?.trim()) n++;
  if (creds.googledrive?.accessToken?.trim() || creds.googledrive?.serviceAccountJson?.trim()) n++;
  if (creds.discord?.token?.trim()) n++;
  if (creds.x?.accessToken?.trim() && creds.x?.apiKey?.trim()) n++;
  if (creds.obsidian?.vaultPath?.trim() || (creds.obsidian?.restApiUrl?.trim() && creds.obsidian?.restApiKey?.trim())) n++;
  if (creds.vercel?.token?.trim()) n++;
  if (creds.netlify?.token?.trim()) n++;
  if (creds.linear?.apiKey?.trim()) n++;
  if (creds.jira?.baseUrl?.trim() && creds.jira?.email?.trim() && creds.jira?.apiToken?.trim()) n++;
  return n;
}

import type { NavStats } from './nav-stats-types';

export type { NavStats } from './nav-stats-types';
export { formatUsageCostUsd } from './nav-stats-types';

// Usage aggregation / xAI billing pull — cache 15 minutes.
// Entity counts stay live (they're cheap directory/JSON reads).
const USAGE_CACHE_MS = 15 * 60_000;
let usageCostCache: { at: number; costUsd: number; source: 'xai' | 'local' } | null = null;

/** Drop the nav usage cache (e.g. after saving a management key). */
export function clearNavUsageCostCache() {
  usageCostCache = null;
}

async function getCachedUsageCost(): Promise<{ costUsd: number; source: 'xai' | 'local' }> {
  if (usageCostCache && Date.now() - usageCostCache.at < USAGE_CACHE_MS) {
    return { costUsd: usageCostCache.costUsd, source: usageCostCache.source };
  }
  // Prefer authoritative month-to-date from xAI billing; fall back to local estimate.
  try {
    const { fetchXaiAccountUsage } = await import('./xai-billing-usage');
    const xai = await fetchXaiAccountUsage({ days: 30 });
    if (xai.available && typeof xai.monthToDateCostUsd === 'number' && Number.isFinite(xai.monthToDateCostUsd)) {
      usageCostCache = {
        at: Date.now(),
        costUsd: Math.max(0, xai.monthToDateCostUsd),
        source: 'xai',
      };
      return { costUsd: usageCostCache.costUsd, source: 'xai' };
    }
  } catch {
    /* fall through to local ledger */
  }
  const usage = await getUsageSummary();
  usageCostCache = {
    at: Date.now(),
    costUsd: usage.estimatedCostUsd,
    source: 'local',
  };
  return { costUsd: usageCostCache.costUsd, source: 'local' };
}

export async function getNavStats(integrations: IntegrationCreds): Promise<NavStats> {
  const { cloudReachable } = await import('./run-guards');
  const [sessions, projects, uploads, agents, mcpServers, usage, cfg, reach] = await Promise.all([
    listChatSessions(),
    listProjects(),
    listGlobalUploadFiles(),
    loadAgents(),
    listMcpServers(),
    getCachedUsageCost(),
    loadConfig(),
    cloudReachable(),
  ]);

  let automationsScheduled = 0;
  for (const agent of agents) {
    const scheds = agent.schedules?.length
      ? agent.schedules
      : agent.schedule
        ? [{ ...agent.schedule, id: 'legacy', instructions: '' }]
        : [];
    automationsScheduled += scheds.filter((s) => s.enabled).length;
  }

  const mcpConfigured = mcpServers.filter((s) => s.enabled).length;

  return {
    chatSessions: sessions.length,
    projects: projects.length,
    workspaceFiles: uploads.length,
    automationsScheduled,
    integrationsConfigured: countConfiguredIntegrations(integrations) + mcpConfigured,
    usageCostUsd: usage.costUsd,
    usageCostSource: usage.source,
    usageBudgetUsd: cfg.usageBudgetUsd ?? DEFAULT_USAGE_BUDGET_USD,
    cloudReachable: reach.ok,
  };
}
