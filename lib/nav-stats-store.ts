/**
 * Client-side nav badge cache.
 *
 * Badges must NOT reload when the user clicks around the left nav. Counts are
 * loaded once per browser tab, survive React remounts, and only change when a
 * mutation site calls loadNavStats / patchNavStats after a real data change.
 */
'use client';

import type { NavStats } from './nav-stats-types';

export const EMPTY_NAV_STATS: NavStats = {
  chatSessions: 0,
  projects: 0,
  workspaceFiles: 0,
  automationsScheduled: 0,
  integrationsConfigured: 0,
  usageCostUsd: 0,
  usageCostSource: 'local',
  usageBudgetUsd: 0,
};

let cache: NavStats = { ...EMPTY_NAV_STATS };
let loaded = false;

function sameStats(a: NavStats, b: NavStats): boolean {
  return (
    a.chatSessions === b.chatSessions
    && a.projects === b.projects
    && a.workspaceFiles === b.workspaceFiles
    && a.automationsScheduled === b.automationsScheduled
    && a.integrationsConfigured === b.integrationsConfigured
    && a.usageCostUsd === b.usageCostUsd
    && a.usageCostSource === b.usageCostSource
    && a.usageBudgetUsd === b.usageBudgetUsd
  );
}

export function getCachedNavStats(): NavStats {
  return cache;
}

export function isNavStatsLoaded(): boolean {
  return loaded;
}

/** Returns true if state should update (values actually changed). */
export function writeCachedNavStats(next: NavStats): boolean {
  if (loaded && sameStats(cache, next)) return false;
  cache = { ...next };
  loaded = true;
  return true;
}

/** Partial badge update after a known mutation (e.g. chat created → +1). */
export function patchCachedNavStats(partial: Partial<NavStats>): NavStats {
  cache = { ...cache, ...partial };
  loaded = true;
  return cache;
}
