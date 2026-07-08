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
  return n;
}

import type { NavStats } from './nav-stats-types';

export type { NavStats } from './nav-stats-types';
export { formatUsageCostUsd } from './nav-stats-types';

// Usage aggregation / xAI billing pull — cache 15 minutes.
// Entity counts stay live (they're cheap directory/JSON reads).
const USAGE_CACHE_MS = 15 * 60_000;
let usageCostCache: { at: number; costUsd: number } | null = null;

async function getCachedUsageCost(): Promise<number> {
  if (usageCostCache && Date.now() - usageCostCache.at < USAGE_CACHE_MS) {
    return usageCostCache.costUsd;
  }
  // Prefer authoritative month-to-date from xAI billing; fall back to local estimate.
  try {
    const { fetchXaiAccountUsage } = await import('./xai-billing-usage');
    const xai = await fetchXaiAccountUsage({ days: 30 });
    if (xai.available && xai.monthToDateCostUsd != null) {
      usageCostCache = { at: Date.now(), costUsd: xai.monthToDateCostUsd };
      return usageCostCache.costUsd;
    }
  } catch {
    /* fall through to local ledger */
  }
  const usage = await getUsageSummary();
  usageCostCache = { at: Date.now(), costUsd: usage.estimatedCostUsd };
  return usageCostCache.costUsd;
}

export async function getNavStats(integrations: IntegrationCreds): Promise<NavStats> {
  const [sessions, projects, uploads, agents, mcpServers, usageCostUsd, cfg] = await Promise.all([
    listChatSessions(),
    listProjects(),
    listGlobalUploadFiles(),
    loadAgents(),
    listMcpServers(),
    getCachedUsageCost(),
    loadConfig(),
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
    usageCostUsd,
    usageBudgetUsd: cfg.usageBudgetUsd ?? DEFAULT_USAGE_BUDGET_USD,
  };
}