import { countChatSessions } from './chat-sessions';
import { listMcpServersReadOnly } from './mcp';
import { countProjects } from './projects';
import { loadConfig } from './persistence';
import { countGlobalUploadFiles } from './workspace';
import { getUsageSummary } from './usage';
import type { AppConfig, IntegrationCreds } from './types';
import { memoryStats } from './agent-memory';

/** Default monthly quota (USD) when the user hasn't set one in Settings. */
const DEFAULT_USAGE_BUDGET_USD = 25;

function countConfiguredIntegrations(creds: IntegrationCreds): number {
  let n = 0;
  if (creds.github?.token?.trim()) n++;
  if (creds.slack?.token?.trim()) n++;
  if (creds.googledrive?.accessToken?.trim() || creds.googledrive?.serviceAccountJson?.trim()) n++;
  if (creds.discord?.token?.trim()) n++;
  if (creds.x?.accessToken?.trim() && creds.x?.apiKey?.trim()) n++;
  if (creds.reddit?.devvitEndpoint?.trim() && creds.reddit?.devvitAppToken?.trim()) n++;
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

async function getCachedUsageCost(cfg?: AppConfig): Promise<{ costUsd: number; source: 'xai' | 'local' }> {
  if (usageCostCache && Date.now() - usageCostCache.at < USAGE_CACHE_MS) {
    return { costUsd: usageCostCache.costUsd, source: usageCostCache.source };
  }
  // Settings → Usage source: auto prefers xAI billing, or the user pins one.
  const pref = (cfg ?? await loadConfig()).usageCostSource || 'auto';
  // Prefer authoritative month-to-date from xAI billing; fall back to local estimate.
  if (pref !== 'local') {
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
  }
  const usage = await getUsageSummary();
  usageCostCache = {
    at: Date.now(),
    costUsd: usage.estimatedCostUsd,
    source: 'local',
  };
  return { costUsd: usageCostCache.costUsd, source: 'local' };
}

/**
 * The exact figure shown in the sidebar "Usage" badge, plus which source it
 * resolved to and the user's configured preference. The Usage & Cost page
 * uses this to explain the badge instead of re-deriving (and possibly
 * disagreeing with) it.
 */
export async function getNavUsageBadge(): Promise<{
  costUsd: number;
  source: 'xai' | 'local';
  pref: 'auto' | 'xai' | 'local';
}> {
  const cfg = await loadConfig();
  const pref = (cfg.usageCostSource || 'auto') as 'auto' | 'xai' | 'local';
  const { costUsd, source } = await getCachedUsageCost(cfg);
  return { costUsd, source, pref };
}

export async function getNavStats(cfg: AppConfig): Promise<NavStats> {
  const { cloudReachable } = await import('./run-guards');
  const { listBoardTasks } = await import('./board');
  const [sessionCount, projectCount, uploadCount, mcpServers, usage, reach, boardTasks] = await Promise.all([
    countChatSessions(),
    countProjects(),
    countGlobalUploadFiles(cfg.defaultWorkspace),
    listMcpServersReadOnly(),
    getCachedUsageCost(cfg),
    cloudReachable(),
    listBoardTasks().catch(() => []),
  ]);

  let automationsScheduled = 0;
  try {
    const { listRoutines } = await import('./routines');
    automationsScheduled = listRoutines({ enabled: true, limit: 1 }).total;
  } catch {
    // Keep navigation usable while the Automation schema is initialized or repaired.
  }

  const mcpConfigured = mcpServers.filter((s) => s.enabled).length;
  const { listAttention, listTasks } = await import('./task-ledger');
  const tasksActive = listTasks({
    statuses: ['queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked'],
    limit: 1,
  }).total;
  const attentionOpen = listAttention({ limit: 1 }).total;

  return {
    tasksActive,
    attentionOpen,
    chatSessions: sessionCount,
    projects: projectCount,
    boardOpen: boardTasks.filter(
      (t) => t.status === 'backlog' || t.status === 'todo' || t.status === 'in_progress',
    ).length,
    memories: memoryStats().total,
    workspaceFiles: uploadCount,
    automationsScheduled,
    integrationsConfigured: countConfiguredIntegrations(cfg.integrations || {}) + mcpConfigured,
    usageCostUsd: usage.costUsd,
    usageCostSource: usage.source,
    usageBudgetUsd: cfg.usageBudgetUsd ?? DEFAULT_USAGE_BUDGET_USD,
    cloudReachable: reach.ok,
  };
}
