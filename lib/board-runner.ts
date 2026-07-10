// Dispatches an agent run for a board card ("Start work"): the assigned agent
// gets the card as a complete brief plus board tools to update it. Fire and
// forget — the card tracks progress (working flag, activity feed, run link)
// and lands in In Review when the run finishes.

import type { AgentRun } from './types';
import { getBoardTask, updateBoardTask } from './board';

/** Cards currently being worked (taskId → runId|null while starting). */
interface BoardRunGlobals {
  __shibaBoardRuns?: Map<string, string | null>;
}
const g = globalThis as unknown as BoardRunGlobals;
const active: Map<string, string | null> = g.__shibaBoardRuns ?? (g.__shibaBoardRuns = new Map());

function buildCardPrompt(task: { key: string; title: string; description: string; labels: string[] }): string {
  return [
    `You are working a Kanban card from the Shiba Studio board.`,
    ``,
    `Card ${task.key}: ${task.title}`,
    task.labels.length ? `Labels: ${task.labels.join(', ')}` : '',
    ``,
    task.description ? `Brief:\n${task.description}` : 'No further description — use the title as the goal.',
    ``,
    `Work the card to completion. You have board tools:`,
    `- board_update_task to post progress notes (do this at meaningful milestones) and change status`,
    `- board_get_task / board_list_tasks to re-read the card or see the rest of the board`,
    `When you finish, post a clear summary of the outcome as a note on ${task.key}. Do not move the card to done — it lands in review automatically.`,
  ].filter((l) => l !== '').join('\n');
}

/**
 * Start the assigned agent on a card. Returns the started state immediately;
 * the run continues in the background.
 */
export async function startWorkOnTask(idOrKey: string): Promise<{ taskId: string; key: string; agentName: string }> {
  const task = await getBoardTask(idOrKey);
  if (!task) throw new Error(`Board task not found: ${idOrKey}`);
  if (!task.assigneeAgentId) throw new Error(`${task.key} has no assigned agent — assign one first`);
  if (active.has(task.id)) throw new Error(`${task.key} already has a run in progress`);

  const { loadAgents } = await import('./persistence');
  const agent = (await loadAgents()).find((a) => a.id === task.assigneeAgentId);
  if (!agent) throw new Error(`Assigned agent no longer exists — reassign ${task.key}`);

  active.set(task.id, null);
  await updateBoardTask(task.id, {
    status: 'in_progress',
    working: true,
    actor: agent.name,
    note: { kind: 'system', text: `${agent.name} started working this card` },
  });

  void (async () => {
    const { audit } = await import('./audit-log');
    try {
      audit('run', 'board card dispatched', `${task.key}: ${task.title.slice(0, 100)}`, {
        taskId: task.id, agent: agent.name,
      });
      const { runAgentOnce } = await import('./agent-runtime');
      const run: AgentRun = await runAgentOnce(agent, buildCardPrompt(task), {});
      active.set(task.id, run.id);
      const ok = run.status !== 'error';
      await updateBoardTask(task.id, {
        status: ok ? 'in_review' : 'in_progress',
        working: false,
        addRunId: run.id,
        actor: agent.name,
        note: {
          kind: 'agent',
          agentName: agent.name,
          runId: run.id,
          text: ok
            ? (run.finalOutput || 'Run finished (no summary output)').slice(0, 4000)
            : `Run failed: ${(run.finalOutput || 'unknown error').slice(0, 500)}`,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateBoardTask(task.id, {
        working: false,
        actor: agent.name,
        note: { kind: 'system', text: `Run could not complete: ${msg.slice(0, 500)}` },
      }).catch(() => {});
      audit('run', 'board card run failed', `${task.key}: ${msg.slice(0, 160)}`, { taskId: task.id });
    } finally {
      active.delete(task.id);
    }
  })();

  return { taskId: task.id, key: task.key, agentName: agent.name };
}

export function isTaskBeingWorked(taskId: string): boolean {
  return active.has(taskId);
}
