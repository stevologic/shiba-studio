/**
 * Module-level agents list for the client shell.
 * Survives React remounts so the Agents page never flashes empty while disk still has agents.
 */
'use client';

import type { Agent } from './types';

let cached: Agent[] | null = null;

export function getCachedAgents(): Agent[] | null {
  return cached;
}

export function setCachedAgents(agents: Agent[]): void {
  cached = agents;
}

export function hasCachedAgents(): boolean {
  return cached !== null;
}
