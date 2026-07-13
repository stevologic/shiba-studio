// Dispatches an agent run for a board card ("Start work"): the assigned agent
// gets the card as a complete brief plus board tools to update it. Fire and
// forget — the card tracks progress (working flag, activity feed, run link)
// and lands in In Review when the run finishes.

import type { AgentRun } from './types';
import { getBoardTask, updateBoardTask } from './board';
import { randomUUID } from 'node:crypto';

/** Cards currently being worked (taskId → runId|null while starting). */
interface BoardRunGlobals {
  __shibaBoardRuns?: Map<string, string | null>;
}
const g = globalThis as unknown as BoardRunGlobals;
const active: Map<string, string | null> = g.__shibaBoardRuns ?? (g.__shibaBoardRuns = new Map());

interface CardPromptInput {
  key: string;
  title: string;
  description: string;
  labels: string[];
  /** Reviewer feedback → the run is a refinement pass, not a fresh start. */
  feedback?: string;
  /** The agent's latest outcome note, echoed so it knows what it delivered. */
  previousOutcome?: string;
}

function buildCardPrompt(task: CardPromptInput): string {
  const refining = !!task.feedback;
  return [
    `You are working a Kanban card from the Shiba Studio board.`,
    ``,
    `Card ${task.key}: ${task.title}`,
    task.labels.length ? `Labels: ${task.labels.join(', ')}` : '',
    ``,
    task.description ? `Brief:\n${task.description}` : 'No further description — use the title as the goal.',
    refining && task.previousOutcome
      ? `\nYour previous run delivered this outcome:\n${task.previousOutcome}`
      : '',
    refining
      ? `\nThe reviewer looked at that work and sent it back with this feedback — address it specifically, keeping what was already right:\n${task.feedback}`
      : '',
    ``,
    `Work the card to completion. You have board tools:`,
    `- board_update_task to post progress notes (do this at meaningful milestones) and change status`,
    `- board_get_task / board_list_tasks to re-read the card or see the rest of the board`,
    `When you finish, post a clear summary of ${refining ? 'what you changed in response to the feedback' : 'the outcome'} as a note on ${task.key}. Do not move the card to done — it lands in review automatically.`,
  ].filter((l) => l !== '').join('\n');
}

export interface StartWorkOpts {
  /** Reviewer feedback: run as a refinement pass instead of a fresh start. */
  feedback?: string;
}

/**
 * Start the assigned agent on a card. Returns the started state immediately;
 * the run continues in the background. With `feedback`, the run is a
 * refinement pass: the agent sees its previous outcome plus the reviewer's
 * notes and is told to address them specifically.
 */
export async function startWorkOnTask(
  idOrKey: string,
  opts: StartWorkOpts = {},
): Promise<{ taskId: string; key: string; agentName: string }> {
  const task = await getBoardTask(idOrKey);
  if (!task) throw new Error(`Board task not found: ${idOrKey}`);
  if (!task.assigneeAgentId) throw new Error(`${task.key} has no assigned agent — assign one first`);
  if (active.has(task.id)) throw new Error(`${task.key} already has a run in progress`);

  const { loadAgents } = await import('./persistence');
  const agent = (await loadAgents()).find((a) => a.id === task.assigneeAgentId);
  if (!agent) throw new Error(`Assigned agent no longer exists — reassign ${task.key}`);

  const feedback = opts.feedback?.trim() || undefined;
  // Latest agent note = what the reviewer just looked at.
  const previousOutcome = feedback
    ? [...task.activity].reverse().find((a) => a.kind === 'agent')?.text?.slice(0, 3000)
    : undefined;

  active.set(task.id, null);
  await updateBoardTask(task.id, {
    status: 'in_progress',
    working: true,
    actor: agent.name,
    note: {
      kind: 'system',
      text: feedback
        ? `${agent.name} started refining this card from review feedback`
        : `${agent.name} started working this card`,
    },
  });

  const ledger = await import('./task-ledger');
  const controlTaskId = `board-${randomUUID()}`;
  const runId = randomUUID();
  const controlTask = ledger.createTask({
    id: controlTaskId,
    kind: 'board',
    title: `${task.key}: ${task.title}`,
    description: buildCardPrompt({ ...task, feedback, previousOutcome }),
    status: 'queued',
    originType: 'board',
    originId: task.id,
    agentId: agent.id,
    projectId: task.projectId || undefined,
    runId,
    workspaceRoots: agent.workspace.path
      ? [{ id: 'board-workspace', path: agent.workspace.path, permission: 'write' }]
      : [],
    maxRetries: 2,
    metadata: { boardKey: task.key, refinement: !!feedback, agentName: agent.name, model: agent.model },
  });
  ledger.transitionTask({
    taskId: controlTask.id,
    status: 'running',
    expectedVersion: controlTask.version,
    currentStep: feedback ? 'Refining card from review feedback' : 'Starting board work',
  });

  void (async () => {
    const { audit } = await import('./audit-log');
    try {
      audit('run', feedback ? 'board card refinement dispatched' : 'board card dispatched', `${task.key}: ${task.title.slice(0, 100)}`, {
        taskId: task.id, agent: agent.name,
      });
      const { runAgentOnce } = await import('./agent-runtime');
      // A card linked to a project runs in that project's workspace with its
      // context, so board work and project work share one place.
      const runOpts: Parameters<typeof runAgentOnce>[2] = {};
      runOpts.taskId = controlTaskId;
      runOpts.runId = runId;
      runOpts.attemptNo = 1;
      if (task.projectId) {
        try {
          const { getProject } = await import('./projects');
          const { resolveProjectWorkspace, buildProjectContextHeader } = await import('./project-types');
          const project = await getProject(task.projectId);
          if (project) {
            const ws = resolveProjectWorkspace(project, agent.workspace.path || process.cwd());
            if (ws) runOpts.workspacePathOverride = ws;
            runOpts.projectContext = buildProjectContextHeader(project, ws || undefined);
            runOpts.projectId = project.id;
          }
        } catch { /* project context is best-effort — never block the run */ }
      }
      const run: AgentRun = await runAgentOnce(
        agent,
        buildCardPrompt({ ...task, feedback, previousOutcome }),
        runOpts,
      );
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
      const currentControlTask = ledger.getTask(controlTaskId);
      if (currentControlTask && currentControlTask.status === 'running') {
        ledger.transitionTask({ taskId: controlTaskId, status: 'failed', error: msg });
      }
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
