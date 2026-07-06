export interface NavStats {
  chatSessions: number;
  projects: number;
  workspaceFiles: number;
  automationsScheduled: number;
  integrationsConfigured: number;
  usageCostUsd: number;
}

export function formatUsageCostUsd(usd: number): string {
  if (!usd || usd < 0.005) return '$0.00';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}