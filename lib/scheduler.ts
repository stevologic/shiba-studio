// Scheduler + inter-agent orchestration for Shiba Studio agents.
// Scoped schedules per agent. Runs in-process using node-cron.

import * as cron from 'node-cron';
import { Agent, normalizeAgent, ScheduleEntry } from './types';
import { loadAgents, mutateAgents } from './persistence';

async function runScheduledAgent(
  agent: Agent,
  prompt: string,
  opts?: { scheduled?: boolean; scheduleId?: string; scheduleInstructions?: string },
) {
  const { runAgentOnce } = await import('./agent-runtime');
  return runAgentOnce(agent, prompt, opts);
}

// Scheduler state MUST live on globalThis: Next bundles this module into
// several separate graphs (instrumentation.ts, each API route), and per-copy
// maps meant each copy armed its own cron task for every schedule — the cause
// of automations firing twice on the same tick. One shared map lets any
// copy's resync stop tasks armed by another.
interface SchedulerGlobals {
  __shibaCronTasks?: Map<string, cron.ScheduledTask>;
  __shibaCronAgents?: Map<string, Agent>;
  __shibaCronResync?: Promise<void>;
  __shibaCronInterval?: ReturnType<typeof setInterval>;
}
const g = globalThis as unknown as SchedulerGlobals;
const tasks: Map<string, cron.ScheduledTask> = g.__shibaCronTasks ?? (g.__shibaCronTasks = new Map());
const agentMap: Map<string, Agent> = g.__shibaCronAgents ?? (g.__shibaCronAgents = new Map());

export function initScheduler() {
  // Will be called on server boot
  loadAndScheduleAll().catch(console.error);
  // Periodically resync (in case agents change) — one interval per process,
  // no matter how many module copies or /api/boot hits call this.
  if (!g.__shibaCronInterval) {
    g.__shibaCronInterval = setInterval(() => {
      loadAndScheduleAll().catch(() => {});
    }, 1000 * 60 * 4);
  }
}

/** Resyncs are serialized — two callers interleaving stop-all/arm-all (e.g.
 *  an agent save racing a page-load /api/boot) could otherwise overwrite a
 *  just-armed task in the map without stopping it, leaving a duplicate. */
export function loadAndScheduleAll(): Promise<void> {
  const next = (g.__shibaCronResync ?? Promise.resolve()).then(resyncAllSchedules, resyncAllSchedules);
  g.__shibaCronResync = next.catch(() => {});
  return next;
}

async function resyncAllSchedules() {
  let agents = await loadAgents();
  // Normalize legacy single-schedule agents to multi + skills for compatibility
  agents = agents.map(normalizeAgent);
  // Clean any accumulated 'manual' entries to prevent bad cron spam and clutter (fix accumulation bug)
  agents = agents.map(a => {
    if (a.schedules && Array.isArray(a.schedules)) {
      a.schedules = a.schedules.filter((s: ScheduleEntry) => s.cron && !String(s.cron).includes('manual'));
    }
    return a;
  });
  agentMap.clear();
  for (const a of agents) agentMap.set(a.id, a);

  // Stop all existing first for clean resync on edits
  for (const [id, task] of tasks) {
    try { task.stop(); } catch {}
    tasks.delete(id);
  }

  for (const agent of agents) {
    const scheds: ScheduleEntry[] = agent.schedules || [];
    for (const entry of scheds) {
      if (!entry.enabled || !entry.cron || String(entry.cron).includes('manual')) continue;
      const taskKey = `${agent.id}:${entry.id}`;
      try {
        const task = cron.schedule(entry.cron, async () => {
          // Deleted agents must never fire: re-verify existence at trigger time
          // and retire the schedule if the agent is gone.
          const live = (await loadAgents()).find((a) => a.id === agent.id);
          if (!live) {
            console.log(`[scheduler] agent ${agent.name} (${agent.id}) no longer exists — retiring schedule ${entry.id}`);
            const stale = tasks.get(taskKey);
            if (stale) { try { stale.stop(); } catch {} tasks.delete(taskKey); }
            const { audit } = await import('./audit-log');
            audit('run', 'schedule retired', `${agent.name}: agent deleted — automation stopped`, { agentId: agent.id, scheduleId: entry.id });
            return;
          }
          // Claim this cron tick in SQLite before running: if a stray task
          // (another module copy, or a second server process on the same data
          // dir) fires for the same schedule in the same minute, exactly one
          // claim succeeds and the rest skip — no more double runs.
          const tick = new Date().toISOString().slice(0, 16);
          const { claimScheduleTick } = await import('./db');
          if (!claimScheduleTick(taskKey, tick)) {
            console.log(`[scheduler] tick ${tick} for ${agent.name}/${entry.id} already claimed — skipping duplicate fire`);
            return;
          }
          // Overlap suppression: if this schedule's previous run is still
          // going, skip the tick instead of stacking a second run.
          const guards = await import('./run-guards');
          if (guards.isScheduleStillRunning(taskKey)) {
            console.log(`[scheduler] ${agent.name}/${entry.id} previous run still going — skipping tick ${tick}`);
            const { audit } = await import('./audit-log');
            audit('run', 'schedule tick skipped', `${agent.name}: previous scheduled run still in progress`, {
              agentId: agent.id, scheduleId: entry.id, tick,
            });
            return;
          }
          // Offline degradation: cloud-model agents skip the tick (with an
          // audit entry) when api.x.ai is unreachable, instead of burning the
          // run on a guaranteed network error.
          const { parseModelRef } = await import('./model-providers');
          if (parseModelRef(live.model).provider !== 'local') {
            const reach = await guards.cloudReachable();
            if (!reach.ok) {
              console.log(`[scheduler] api.x.ai unreachable — skipping tick ${tick} for ${agent.name}/${entry.id}`);
              const { audit } = await import('./audit-log');
              audit('run', 'schedule tick skipped', `${agent.name}: api.x.ai unreachable (offline) — tick skipped`, {
                agentId: agent.id, scheduleId: entry.id, tick,
              });
              return;
            }
          }
          console.log(`[scheduler] firing ${agent.name} schedule ${entry.id} with specific instructions`);
          try {
            // Use the schedule entry's dedicated instructions as the prompt (AC3)
            await runScheduledAgent(normalizeAgent(live), entry.instructions, {
              scheduled: true,
              scheduleId: entry.id,
              scheduleInstructions: entry.instructions,
            });
          } catch (e) {
            console.error('scheduled run error', e);
          }
        });
        // Defensive: never orphan a still-running task under the same key.
        const existing = tasks.get(taskKey);
        if (existing) { try { existing.stop(); } catch { /* already stopped */ } }
        tasks.set(taskKey, task);
      } catch {
        console.error('bad cron for', agent.name, entry.cron, entry.id);
      }
    }
  }
}

export function scheduleAgentNow(agent: Agent, scheduleId?: string) {
  // Run immediately using schedule-specific instructions if scheduleId provided or first enabled.
  // This makes schedule instructions for 'manual scheduler trigger' reachable (fix dead code gap).
  const ag = normalizeAgent(agent);
  let entry = scheduleId ? (ag.schedules || []).find((s: ScheduleEntry) => s.id === scheduleId) : null;
  if (!entry) entry = (ag.schedules || []).find((s: ScheduleEntry) => s.enabled);
  const prompt = entry ? entry.instructions : `Manual trigger from scheduler UI at ${new Date().toISOString()}`;
  const sid = entry ? entry.id : undefined;
  return runScheduledAgent(ag, prompt, { scheduled: true, scheduleId: sid, scheduleInstructions: entry ? entry.instructions : undefined });
}

export async function updateAgentSchedule(agentId: string, cronExpr: string, enabled: boolean) {
  // Legacy support: add/update a schedule entry (use first or create)
  const updated = await mutateAgents((agents) => {
    const idx = agents.findIndex(a => a.id === agentId);
    if (idx === -1) return false;
    const ag = normalizeAgent(agents[idx]);
    agents[idx] = ag;
    if (ag.schedules.length === 0) {
      ag.schedules.push({ id: 'sch-legacy', enabled, cron: cronExpr, instructions: ag.description || 'Scheduled task', description: '' });
    } else {
      // update first
      ag.schedules[0] = { ...ag.schedules[0], enabled, cron: cronExpr };
    }
    return true;
  });
  if (!updated) return;

  // resync all
  await loadAndScheduleAll();
}

export function listScheduled() {
  return Array.from(tasks.keys());
}

/** Stop all cron tasks — used by verification scripts so the process can exit cleanly. */
export function stopAllScheduledTasks() {
  for (const [, task] of tasks) {
    try {
      task.stop();
    } catch {
      /* ignore */
    }
  }
  tasks.clear();
  agentMap.clear();
}

// Support for schedule_task tool: parse natural "when" and register into agent's schedules[] with instructions
export async function scheduleFromAgentTool(agentId: string, when: string, prompt: string) {
  let agents = await loadAgents();
  agents = agents.map(normalizeAgent);
  const ag = agents.find(a => a.id === agentId);
  if (!ag) return { ok: false, error: 'agent not found' };

  const instructions = prompt || 'Scheduled follow-up task';

  // Support "in 15m", "in 90s", or raw cron -> add ScheduleEntry
  const mMin = when.match(/in\s+(\d+)\s*m/i);
  const mSec = when.match(/in\s+(\d+)\s*s/i);
  if (mMin) {
    const delay = parseInt(mMin[1], 10) * 60 * 1000;
    // timeout one-off, do not pollute; but pass scheduleInstructions for metadata (AC3)
    setTimeout(async () => {
      try { await runScheduledAgent(ag, instructions, { scheduled: true, scheduleInstructions: instructions }); } catch (e) { console.error(e); }
    }, Math.max(1000, delay));
    return { ok: true, type: 'timeout', delayMs: delay };
  }
  if (mSec) {
    const delay = parseInt(mSec[1], 10) * 1000;
    setTimeout(async () => {
      try { await runScheduledAgent(ag, instructions, { scheduled: true, scheduleInstructions: instructions }); } catch (e) { console.error(e); }
    }, Math.max(500, delay));
    return { ok: true, type: 'timeout', delayMs: delay };
  }

  // Treat as cron string: add as enabled schedule entry
  if (when && (when.includes('*') || when.includes('/'))) {
    const entry: ScheduleEntry = { id: 'sch-tool-' + Date.now(), enabled: true, cron: when, instructions, description: (prompt || '').slice(0, 80) };
    const scheduled = await mutateAgents((current) => {
      const idx = current.findIndex((agent) => agent.id === agentId);
      if (idx < 0) return false;
      const live = normalizeAgent(current[idx]);
      live.schedules.push(entry);
      current[idx] = live;
      return true;
    });
    if (!scheduled) return { ok: false, error: 'agent not found' };
    await loadAndScheduleAll();
    return { ok: true, type: 'cron', cron: when };
  }

  // default: immediate one-off using instructions -- DO NOT pollute schedules with 'manual' entry
  setTimeout(async () => {
    try { await runScheduledAgent(ag, instructions, { scheduled: true, scheduleInstructions: instructions }); } catch (e) { console.error(e); }
  }, 1000);
  return { ok: true, type: 'immediate' };
}
