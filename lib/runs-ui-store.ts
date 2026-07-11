/**
 * Module-level run list for the client shell.
 * Survives React remounts (every tab navigation remounts the shell) so
 * Dashboard "Recent Agent Runs" and Automations never flash empty while the
 * refetch is in flight.
 */
'use client';

import type { AgentRun } from './types';

let cached: AgentRun[] | null = null;

export function getCachedRuns(): AgentRun[] | null {
  return cached;
}

export function setCachedRuns(runs: AgentRun[]): void {
  cached = runs;
}

export function hasCachedRuns(): boolean {
  return cached !== null;
}
