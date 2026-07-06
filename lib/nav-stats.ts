import { listChatSessions } from './chat-sessions';
import { listMcpServers } from './mcp';
import { listProjects } from './projects';
import { loadAgents } from './persistence';
import { listGlobalUploadFiles } from './workspace';
import { getUsageSummary } from './usage';
import type { IntegrationCreds } from './types';

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

export async function getNavStats(integrations: IntegrationCreds): Promise<NavStats> {
  const [sessions, projects, uploads, agents, mcpServers, usage] = await Promise.all([
    listChatSessions(),
    listProjects(),
    listGlobalUploadFiles(),
    loadAgents(),
    listMcpServers(),
    getUsageSummary(),
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
    usageCostUsd: usage.estimatedCostUsd,
  };
}