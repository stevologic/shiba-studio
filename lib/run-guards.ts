// Central run guards: concurrency limits, schedule-overlap suppression,
// spend hard-stops, per-run token caps, cron-frequency estimates, and the
// cloud reachability probe. Every agent entry point (UI runs, schedules,
// tool-spawned follow-ups) funnels through agentRunGenerator, which consults
// these before spending money or forking work.

import type { AppConfig } from './types';
import { loadUsageRecords } from './usage';

export const DEFAULT_MAX_CONCURRENT_RUNS = 3;
export { estimateCronRunsPerDay, SCHEDULE_RUNS_PER_DAY_WARN } from './cron-estimate';

interface ActiveRun {
  runId: string;
  agentId: string;
  agentName: string;
  scheduleKey?: string;
  startedAt: number;
}

// One shared registry per process — Next bundles this module into several
// graphs (instrumentation, API routes), same trap as the scheduler map.
interface GuardGlobals {
  __shibaActiveRuns?: Map<string, ActiveRun>;
  __shibaCloudProbe?: { ok: boolean; checkedAt: number; probing: boolean };
}
const g = globalThis as unknown as GuardGlobals;
const activeRuns: Map<string, ActiveRun> = g.__shibaActiveRuns ?? (g.__shibaActiveRuns = new Map());

export function registerActiveRun(runId: string, agentId: string, agentName: string, scheduleKey?: string): void {
  activeRuns.set(runId, { runId, agentId, agentName, scheduleKey, startedAt: Date.now() });
}

export function releaseActiveRun(runId: string): void {
  activeRuns.delete(runId);
}

export function activeRunCount(): number {
  // Entries are released by the generator's outer finally. Do not age them
  // out: governed runs may legitimately last up to 24 hours, and forgetting a
  // live long run would defeat both capacity and schedule-overlap protection.
  return activeRuns.size;
}

export function listActiveRuns(): ActiveRun[] {
  return Array.from(activeRuns.values());
}

/** True if a run started by this schedule key is still going. */
export function isScheduleStillRunning(scheduleKey: string): boolean {
  for (const r of activeRuns.values()) if (r.scheduleKey === scheduleKey) return true;
  return false;
}

export function maxConcurrentRuns(cfg: AppConfig): number {
  const n = Number(cfg.maxConcurrentRuns);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

/**
 * Concurrency gate — atomically checks the limit AND registers the run in one
 * synchronous step (no awaits between check and claim, so two simultaneous
 * run starts can't both slip under the limit). Returns a human-readable
 * refusal, or null when the slot was claimed — the caller must then
 * releaseActiveRun(runId) when the run ends.
 */
export function tryAcquireRunSlot(
  cfg: AppConfig,
  runId: string,
  agentId: string,
  agentName: string,
  scheduleKey?: string,
): string | null {
  if (activeRuns.has(runId)) {
    return `Run ${runId} is already active. Wait for it to finish before reusing its id.`;
  }
  const limit = maxConcurrentRuns(cfg);
  const count = activeRunCount();
  if (count >= limit) {
    const names = listActiveRuns().map((r) => r.agentName).slice(0, 5).join(', ');
    return `Concurrent-run limit reached (${count}/${limit} active: ${names}). `
      + 'Wait for a run to finish or raise the limit in Settings → Cost & safety.';
  }
  registerActiveRun(runId, agentId, agentName, scheduleKey);
  return null;
}

/** Month-to-date and today's studio-metered spend (estimates, cloud only). */
export async function currentSpend(): Promise<{ monthUsd: number; dayUsd: number }> {
  const records = await loadUsageRecords();
  const now = new Date();
  const monthPrefix = now.toISOString().slice(0, 7); // YYYY-MM
  const dayPrefix = now.toISOString().slice(0, 10);  // YYYY-MM-DD
  let monthUsd = 0;
  let dayUsd = 0;
  for (const r of records) {
    if (!r?.ts || !Number.isFinite(r.estimatedCostUsd)) continue;
    if (r.ts.startsWith(monthPrefix)) monthUsd += r.estimatedCostUsd;
    if (r.ts.startsWith(dayPrefix)) dayUsd += r.estimatedCostUsd;
  }
  return { monthUsd, dayUsd };
}

/**
 * Spend hard-stop — blocks new CLOUD work when a configured budget is
 * exhausted. Local models are free and never blocked. Warn-only mode
 * (budgetHardStop === false) always passes.
 */
export async function checkSpendGuard(
  cfg: AppConfig,
  isLocalModel: boolean,
): Promise<string | null> {
  if (isLocalModel) return null;
  if (cfg.budgetHardStop === false) return null;
  const monthly = Number(cfg.usageBudgetUsd) || 0;
  const daily = Number(cfg.dailyBudgetUsd) || 0;
  if (monthly <= 0 && daily <= 0) return null;

  const { monthUsd, dayUsd } = await currentSpend();
  if (monthly > 0 && monthUsd >= monthly) {
    return `Monthly spend limit reached ($${monthUsd.toFixed(2)} of $${monthly.toFixed(2)}). `
      + 'Cloud runs are paused until next month — raise the budget or disable the hard stop in Settings → Cost & safety, or use a local model.';
  }
  if (daily > 0 && dayUsd >= daily) {
    return `Daily spend limit reached ($${dayUsd.toFixed(2)} of $${daily.toFixed(2)}). `
      + 'Cloud runs are paused until tomorrow — raise the budget or disable the hard stop in Settings → Cost & safety, or use a local model.';
  }
  return null;
}

/** Per-run token budget (0 / unset = unlimited). */
export function perRunTokenCap(cfg: AppConfig): number {
  const n = Number(cfg.perRunTokenCap);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ---------------------------------------------------------------------------
// Cloud reachability probe (offline degradation)
// ---------------------------------------------------------------------------

const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 4_000;

/**
 * Cached reachability of api.x.ai. Never throws. The first call (and one call
 * per TTL window) does a real request; everything else reads the cache, so
 * polling endpoints can include this for free.
 */
export async function cloudReachable(): Promise<{ ok: boolean; checkedAt: number }> {
  const cached = g.__shibaCloudProbe;
  const now = Date.now();
  if (cached && (now - cached.checkedAt < PROBE_TTL_MS || cached.probing)) {
    return { ok: cached.ok, checkedAt: cached.checkedAt };
  }
  g.__shibaCloudProbe = { ok: cached?.ok ?? true, checkedAt: cached?.checkedAt ?? 0, probing: true };
  try {
    // Any HTTP response (even 401) proves the network path to xAI works.
    const res = await fetch('https://api.x.ai/v1/models', {
      method: 'HEAD',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    void res;
    g.__shibaCloudProbe = { ok: true, checkedAt: now, probing: false };
  } catch {
    g.__shibaCloudProbe = { ok: false, checkedAt: now, probing: false };
  }
  return { ok: g.__shibaCloudProbe.ok, checkedAt: g.__shibaCloudProbe.checkedAt };
}

/** Force-refresh the probe (used by the retry button). */
export function invalidateCloudProbe(): void {
  if (g.__shibaCloudProbe) g.__shibaCloudProbe.checkedAt = 0;
}
