// Scheduler + inter-agent orchestration for Shiba Studio agents.
// Scoped schedules per agent. Runs in-process using node-cron.

import * as cron from 'node-cron';
import { Agent, normalizeAgent, ScheduleEntry } from './types';
import { loadAgents, saveAgents } from './persistence';

async function runScheduledAgent(
  agent: Agent,
  prompt: string,
  opts?: { scheduled?: boolean; scheduleId?: string; scheduleInstructions?: string },
) {
  const { runAgentOnce } = await import('./agent-runtime');
  return runAgentOnce(agent, prompt, opts);
}

let tasks: Map<string, cron.ScheduledTask> = new Map();
let agentMap: Map<string, Agent> = new Map();

export function initScheduler() {
  // Will be called on server boot
  loadAndScheduleAll().catch(console.error);
  // Periodically resync (in case agents change)
  setInterval(() => {
    loadAndScheduleAll().catch(() => {});
  }, 1000 * 60 * 4);
}

export async function loadAndScheduleAll() {
  let agents = await loadAgents();
  // Normalize legacy single-schedule agents to multi + skills for compatibility
  agents = agents.map(normalizeAgent);
  // Clean any accumulated 'manual' entries to prevent bad cron spam and clutter (fix accumulation bug)
  agents = agents.map(a => {
    if (a.schedules && Array.isArray(a.schedules)) {
      a.schedules = a.schedules.filter((s: any) => s.cron && !String(s.cron).includes('manual'));
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
        tasks.set(taskKey, task);
      } catch (e) {
        console.error('bad cron for', agent.name, entry.cron, entry.id);
      }
    }
  }
}

export function scheduleAgentNow(agent: Agent, scheduleId?: string) {
  // Run immediately using schedule-specific instructions if scheduleId provided or first enabled.
  // This makes schedule instructions for 'manual scheduler trigger' reachable (fix dead code gap).
  const ag = normalizeAgent(agent);
  let entry = scheduleId ? (ag.schedules || []).find((s: any) => s.id === scheduleId) : null;
  if (!entry) entry = (ag.schedules || []).find((s: any) => s.enabled);
  const prompt = entry ? entry.instructions : `Manual trigger from scheduler UI at ${new Date().toISOString()}`;
  const sid = entry ? entry.id : undefined;
  return runScheduledAgent(ag, prompt, { scheduled: true, scheduleId: sid, scheduleInstructions: entry ? entry.instructions : undefined });
}

export async function updateAgentSchedule(agentId: string, cronExpr: string, enabled: boolean) {
  // Legacy support: add/update a schedule entry (use first or create)
  let agents = await loadAgents();
  agents = agents.map(normalizeAgent);
  const idx = agents.findIndex(a => a.id === agentId);
  if (idx === -1) return;
  const ag = agents[idx];
  if (ag.schedules.length === 0) {
    ag.schedules.push({ id: 'sch-legacy', enabled, cron: cronExpr, instructions: ag.description || 'Scheduled task', description: '' });
  } else {
    // update first
    ag.schedules[0] = { ...ag.schedules[0], enabled, cron: cronExpr };
  }
  await saveAgents(agents);

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
    await saveAgents(agents);
    setTimeout(async () => {
      try { await runScheduledAgent(ag, instructions, { scheduled: true, scheduleInstructions: instructions }); } catch (e) { console.error(e); }
    }, Math.max(1000, delay));
    return { ok: true, type: 'timeout', delayMs: delay };
  }
  if (mSec) {
    const delay = parseInt(mSec[1], 10) * 1000;
    await saveAgents(agents);
    setTimeout(async () => {
      try { await runScheduledAgent(ag, instructions, { scheduled: true, scheduleInstructions: instructions }); } catch (e) { console.error(e); }
    }, Math.max(500, delay));
    return { ok: true, type: 'timeout', delayMs: delay };
  }

  // Treat as cron string: add as enabled schedule entry
  if (when && (when.includes('*') || when.includes('/'))) {
    const entry: any = { id: 'sch-tool-' + Date.now(), enabled: true, cron: when, instructions, description: (prompt || '').slice(0, 80) };
    ag.schedules.push(entry);
    await saveAgents(agents);
    await loadAndScheduleAll();
    return { ok: true, type: 'cron', cron: when };
  }

  // default: immediate one-off using instructions -- DO NOT pollute schedules with 'manual' entry
  setTimeout(async () => {
    try { await runScheduledAgent(ag, instructions, { scheduled: true, scheduleInstructions: instructions }); } catch (e) { console.error(e); }
  }, 1000);
  return { ok: true, type: 'immediate' };
}
