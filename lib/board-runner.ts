// Durable Board assignment/work coordinator. Assignment reactions and manual
// starts first become idempotent task-ledger rows; the shared queued dispatcher
// owns execution, while this reconciler projects ledger truth back to Board.

import { randomUUID } from 'node:crypto';
import type { Agent } from './types';
import type { BoardTask } from './board-types';
import type { TaskRecord } from './task-types';
import {
  claimBoardWork,
  disableBoardAutoAssignment,
  ensureBoardWorkCancelled,
  getBoardTask,
  listBoardTasks,
  projectBoardWork,
  requestBoardWorkCancellation,
} from './board';

interface BoardRunnerGlobals {
  __shibaBoardAssignmentTimer?: ReturnType<typeof setInterval>;
  __shibaBoardAssignmentPass?: Promise<BoardAssignmentPass>;
}

const runnerGlobals = globalThis as typeof globalThis & BoardRunnerGlobals;

interface CardPromptInput {
  key: string;
  title: string;
  description: string;
  labels: string[];
  feedback?: string;
  previousOutcome?: string;
}

function buildCardPrompt(task: CardPromptInput): string {
  const refining = !!task.feedback;
  return [
    'You are working a Kanban card from the Shiba Studio board.',
    '',
    `Card ${task.key}: ${task.title}`,
    task.labels.length ? `Labels: ${task.labels.join(', ')}` : '',
    '',
    task.description ? `Brief:\n${task.description}` : 'No further description — use the title as the goal.',
    refining && task.previousOutcome
      ? `\nYour previous run delivered this outcome:\n${task.previousOutcome}`
      : '',
    refining
      ? `\nThe reviewer sent this work back with feedback. Address it specifically while keeping what was already right:\n${task.feedback}`
      : '',
    '',
    'Work the card to completion. You have board tools:',
    '- board_update_task to post progress notes at meaningful milestones',
    '- board_get_task / board_list_tasks to re-read the card or see the rest of the board',
    `When you finish, post a clear summary of ${refining ? 'what changed in response to the feedback' : 'the outcome'} on ${task.key}. Do not move the card to done — successful work lands in review automatically.`,
  ].filter((line) => line !== '').join('\n');
}

function previousAgentOutcome(task: BoardTask): string | undefined {
  return [...task.activity]
    .reverse()
    .find((activity) => activity.kind === 'agent')
    ?.text
    ?.slice(0, 3_000);
}

async function resolveTaskContext(task: BoardTask, agent: Agent): Promise<{
  prompt: string;
  workspacePath: string;
  projectContext: string;
}> {
  let workspacePath = agent.workspace.path || '';
  let projectContext = '';
  if (task.projectId) {
    try {
      const [{ getProject }, projectTypes] = await Promise.all([
        import('./projects'),
        import('./project-types'),
      ]);
      const project = await getProject(task.projectId);
      if (project) {
        workspacePath = projectTypes.resolveProjectWorkspace(project, workspacePath || process.cwd());
        projectContext = projectTypes.buildProjectContextHeader(project, workspacePath || undefined);
      }
    } catch {
      // Project context is useful but not a reason to strand already accepted
      // work. The card prompt and agent workspace remain a complete fallback.
    }
  }
  const feedback = task.activeWork?.feedback;
  const prompt = buildCardPrompt({
    ...task,
    feedback,
    previousOutcome: feedback ? previousAgentOutcome(task) : undefined,
  });
  return {
    prompt,
    workspacePath,
    projectContext,
  };
}

/** Ensure the exact accepted Board work generation has one durable task row. */
async function ensureBoardLedgerTask(task: BoardTask, agent: Agent): Promise<TaskRecord> {
  const work = task.activeWork;
  if (!work) throw new Error(`${task.key} has no active Board work claim`);
  const ledger = await import('./task-ledger');
  const existing = ledger.getTask(work.taskId);
  if (existing) {
    validateBoardLedgerIdentity(task, existing);
    return existing;
  }

  const { prompt, workspacePath, projectContext } = await resolveTaskContext(task, agent);
  return ledger.createTask({
    id: work.taskId,
    kind: 'board',
    title: `${task.key}: ${task.title}`,
    description: prompt,
    status: 'queued',
    originType: 'board',
    originId: task.id,
    agentId: agent.id,
    projectId: task.projectId || undefined,
    workspaceRoots: workspacePath
      ? [{ id: 'board-workspace', path: workspacePath, permission: 'write' }]
      : [],
    maxRetries: 2,
    metadata: {
      boardKey: task.key,
      boardWorkId: work.id,
      boardAssignmentId: work.assignmentId,
      boardWorkMode: work.mode,
      agentName: agent.name,
      model: agent.model,
      ...(projectContext ? { projectContext } : {}),
      dispatchRequested: true,
      suppressFailureSignals: true,
    },
  });
}

function validateBoardLedgerIdentity(task: BoardTask, durableTask: TaskRecord): void {
  const work = task.activeWork;
  if (
    !work
    || durableTask.id !== work.taskId
    || durableTask.originType !== 'board'
    || durableTask.originId !== task.id
    || durableTask.agentId !== work.agentId
    || durableTask.metadata.boardWorkId !== work.id
  ) {
    throw new Error(`Durable task identity collision for ${task.key}`);
  }
}

/**
 * A control-plane cancellation makes the task row terminal before the worker
 * has necessarily observed its run-control signal. Keep the Board claim (and
 * therefore the per-agent busy fence) until that exact run has stopped. The
 * missing-row grace period covers the launch gap between assigning a run id
 * and persisting the first run heartbeat.
 */
async function canReleaseTerminalBoardClaim(
  work: NonNullable<BoardTask['activeWork']>,
  task: TaskRecord,
): Promise<boolean> {
  if (!task.runId) return true;
  const { getRun, RUN_LEASE_TIMEOUT_MS } = await import('./agent-runs-store');
  const run = await getRun(task.runId);
  if (run?.status === 'running') return false;
  if (run) return true;

  // A missing run row is normally harmless for synthetic/manual terminal test
  // projections. Cancellation is different: a worker may be inside the short
  // assigned-before-first-persist launch window, so wait one full lease before
  // concluding that no live execution can remain.
  if (task.status !== 'cancelled' && !work.cancelRequestedAt) return true;
  const referenceMs = Date.parse(work.cancelRequestedAt || task.updatedAt);
  return Number.isFinite(referenceMs) && Date.now() - referenceMs >= RUN_LEASE_TIMEOUT_MS;
}

async function retryInterruptedBoardTask(task: TaskRecord): Promise<boolean> {
  if (task.status !== 'lost' || task.retryCount >= task.maxRetries) return false;
  const ledger = await import('./task-ledger');
  try {
    const command = ledger.enqueueTaskCommand({
      taskId: task.id,
      kind: 'retry',
      expectedVersion: task.version,
      idempotencyKey: `board-interrupted-retry:${task.id}:${task.retryCount + 1}`,
    });
    ledger.applyTaskCommand(command.id);
    return true;
  } catch (error) {
    const current = ledger.getTask(task.id);
    // A concurrent reconciler winning the same retry is success.
    if (current?.status === 'queued' || current?.status === 'running') return true;
    console.error(`[board-runner] interrupted task retry deferred for ${task.id}`, error);
    return false;
  }
}

async function projectLedgerTask(
  task: TaskRecord,
  options: { retryInterrupted?: boolean; terminalError?: string; agentName?: string } = {},
): Promise<boolean> {
  if (options.retryInterrupted !== false && await retryInterruptedBoardTask(task)) {
    await projectBoardWork({
      taskId: task.id,
      state: 'queued',
      agentName: String(task.metadata.agentName || 'Agent'),
    });
    return true;
  }
  let state: Parameters<typeof projectBoardWork>[0]['state'];
  if (task.status === 'queued') state = 'queued';
  else if (['running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked'].includes(task.status)) {
    state = 'running';
  } else {
    state = task.status as 'succeeded' | 'failed' | 'cancelled' | 'lost';
  }
  const projected = await projectBoardWork({
    taskId: task.id,
    state,
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined
      ? { error: task.error }
      : options.terminalError
        ? { error: options.terminalError }
        : {}),
    agentName: options.agentName || String(task.metadata.agentName || 'Agent'),
  });
  return projected.applied;
}

export interface StartWorkOpts {
  feedback?: string;
}

/**
 * Manual Start Work and review refinement use the same durable path as an
 * automatic assignment. The call returns once the card has accepted the work;
 * execution may wait in the ledger for an available run slot.
 */
export async function startWorkOnTask(
  idOrKey: string,
  opts: StartWorkOpts = {},
): Promise<{ taskId: string; key: string; agentName: string }> {
  const { isAutomationMaintenanceActive } = await import('./automation-maintenance');
  if (isAutomationMaintenanceActive()) {
    throw new Error('Board work is temporarily paused for maintenance. Try again when maintenance finishes.');
  }
  const task = await getBoardTask(idOrKey);
  if (!task) throw new Error(`Board task not found: ${idOrKey}`);
  if (!task.assigneeAgentId) throw new Error(`${task.key} has no assigned agent — assign one first`);

  const { loadAgents } = await import('./persistence');
  const agent = (await loadAgents()).find((candidate) => candidate.id === task.assigneeAgentId);
  if (!agent) throw new Error(`Assigned agent no longer exists — reassign ${task.key}`);

  const feedback = opts.feedback?.trim().slice(0, 2_000) || undefined;
  const workId = randomUUID();
  const durableTaskId = `board-${workId}`;
  const claim = await claimBoardWork({
    idOrKey: task.id,
    workId,
    taskId: durableTaskId,
    agentId: agent.id,
    agentName: agent.name,
    mode: feedback ? 'refinement' : 'manual',
    feedback,
  });
  if (!claim.claimed) {
    if (claim.busy) throw new Error(`${agent.name} already has accepted Board work in progress`);
    throw new Error(`${task.key} changed before work could be accepted. Reload the card and try again.`);
  }
  await ensureBoardLedgerTask(claim.task, agent);
  void requestBoardDispatch();
  return { taskId: task.id, key: task.key, agentName: agent.name };
}

/** React exactly once to the current assignment generation when the agent opted in. */
export async function reactToBoardAssignment(idOrKey: string): Promise<BoardTask | null> {
  const task = await getBoardTask(idOrKey);
  const assignment = task?.autoAssignment;
  if (!task || !assignment || assignment.status !== 'pending') return task;
  const { isAutomationMaintenanceActive } = await import('./automation-maintenance');
  if (isAutomationMaintenanceActive()) return task;
  if (task.status === 'done' || task.status === 'cancelled') {
    return disableBoardAutoAssignment(task.id, assignment.id);
  }

  const { loadAgents } = await import('./persistence');
  const agent = (await loadAgents()).find((candidate) => candidate.id === assignment.agentId);
  if (!agent || agent.autoAcceptBoardAssignments !== true) {
    return disableBoardAutoAssignment(task.id, assignment.id);
  }

  const durableTaskId = `board-auto-${assignment.id}`;
  const claim = await claimBoardWork({
    idOrKey: task.id,
    workId: assignment.id,
    taskId: durableTaskId,
    agentId: agent.id,
    agentName: agent.name,
    mode: 'automatic',
    assignmentId: assignment.id,
  });
  if (!claim.claimed) return claim.task;
  await ensureBoardLedgerTask(claim.task, agent);
  void requestBoardDispatch();
  return (await getBoardTask(task.id)) || claim.task;
}

export interface BoardAssignmentPass {
  inspected: number;
  ensured: number;
  projected: number;
  reacted: number;
  dispatches: number;
  errors: number;
}

async function runBoardAssignmentPass(dispatch: boolean): Promise<BoardAssignmentPass> {
  const report: BoardAssignmentPass = {
    inspected: 0,
    ensured: 0,
    projected: 0,
    reacted: 0,
    dispatches: 0,
    errors: 0,
  };
  const { isAutomationMaintenanceActive } = await import('./automation-maintenance');
  if (isAutomationMaintenanceActive()) return report;
  const [{ loadAgents }, ledger] = await Promise.all([
    import('./persistence'),
    import('./task-ledger'),
  ]);
  const agents = await loadAgents();
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  // Settle/repair existing claims first. That frees an agent before pending
  // assignments are considered, giving each agent a durable FIFO-like queue.
  for (const task of await listBoardTasks()) {
    if (!task.activeWork) continue;
    report.inspected += 1;
    try {
      const originalWork = task.activeWork;
      let currentCard = task;
      let durableTask = ledger.getTask(originalWork.taskId);
      const agent = agentById.get(originalWork.agentId);

      // Always validate a pre-existing row. A task-id collision must never be
      // projected onto an unrelated card merely because both ids happen to
      // match the Board claim.
      if (agent) {
        const existed = !!durableTask;
        durableTask = await ensureBoardLedgerTask(task, agent);
        if (!existed) report.ensured += 1;
      } else if (durableTask) {
        validateBoardLedgerIdentity(task, durableTask);
      }

      // Ledger truth wins even if the agent was deleted between execution and
      // this projection. In particular, never replace a completed result with
      // a synthetic missing-agent failure.
      if (durableTask && ['succeeded', 'failed', 'cancelled', 'lost'].includes(durableTask.status)) {
        if (!(await canReleaseTerminalBoardClaim(originalWork, durableTask))) continue;
        if (await projectLedgerTask(durableTask, {
          retryInterrupted: !!agent && !originalWork.cancelRequestedAt,
        })) report.projected += 1;
        continue;
      }

      const cancellationReason = originalWork.cancelReason
        || (!agent
          ? 'Assigned agent no longer exists; stopping active work.'
          : task.status === 'done' || task.status === 'cancelled'
            ? 'Board card is closed; stopping active work.'
            : undefined);
      if (cancellationReason && !originalWork.cancelRequestedAt) {
        currentCard = (await requestBoardWorkCancellation({
          taskId: originalWork.taskId,
          reason: cancellationReason,
        })) || task;
      }
      const currentWork = currentCard.activeWork;
      if (currentWork?.cancelRequestedAt && currentWork.cancelRequestId) {
        if (!durableTask) {
          // No ledger row means no worker can have launched. Release the stale
          // claim without fabricating a task solely to cancel it.
          const projected = await projectBoardWork({
            taskId: currentWork.taskId,
            state: agent ? 'cancelled' : 'lost',
            error: currentWork.cancelReason || 'Board work was cancelled before it started.',
            agentName: agent?.name || 'Deleted agent',
          });
          if (projected.applied) report.projected += 1;
          continue;
        }
        await ensureBoardWorkCancelled({
          taskId: durableTask.id,
          cancelRequestId: currentWork.cancelRequestId,
          reason: currentWork.cancelReason,
        });
        durableTask = ledger.getTask(durableTask.id);
        if (durableTask && ['succeeded', 'failed', 'cancelled', 'lost'].includes(durableTask.status)) {
          if (!(await canReleaseTerminalBoardClaim(currentWork, durableTask))) continue;
          if (await projectLedgerTask(durableTask, {
            retryInterrupted: false,
            terminalError: currentWork.cancelReason,
            agentName: agent?.name || 'Deleted agent',
          })) report.projected += 1;
        }
        continue;
      }

      if (!agent) {
        // requestBoardWorkCancellation above should make this unreachable, but
        // retain the claim if a concurrent Board edit won the generation.
        continue;
      }
      if (durableTask && await projectLedgerTask(durableTask)) report.projected += 1;
    } catch (error) {
      report.errors += 1;
      console.error(`[board-runner] claim reconciliation deferred for ${task.key}`, error);
    }
  }

  for (const task of await listBoardTasks()) {
    if (task.autoAssignment?.status !== 'pending') continue;
    try {
      const before = task.autoAssignment.status;
      const reacted = await reactToBoardAssignment(task.id);
      if (reacted?.autoAssignment?.status !== before) report.reacted += 1;
    } catch (error) {
      report.errors += 1;
      console.error(`[board-runner] assignment reaction deferred for ${task.key}`, error);
    }
  }

  if (dispatch) {
    const { processQueuedTaskRetries } = await import('./background-tasks');
    report.dispatches = await processQueuedTaskRetries();
  }
  return report;
}

/** One idempotent recovery/projection pass; exported for startup and tests. */
export function processBoardAssignmentsOnce(
  options: { dispatch?: boolean } = {},
): Promise<BoardAssignmentPass> {
  if (runnerGlobals.__shibaBoardAssignmentPass) return runnerGlobals.__shibaBoardAssignmentPass;
  const operation = runBoardAssignmentPass(options.dispatch !== false);
  runnerGlobals.__shibaBoardAssignmentPass = operation.finally(() => {
    runnerGlobals.__shibaBoardAssignmentPass = undefined;
  });
  return runnerGlobals.__shibaBoardAssignmentPass;
}

async function requestBoardDispatch(): Promise<void> {
  if (process.env.SHIBA_DISABLE_BOARD_DISPATCH === '1') return;
  try {
    await processBoardAssignmentsOnce();
  } catch (error) {
    // The durable queued row remains discoverable by both periodic pumps.
    console.error('[board-runner] immediate Board dispatch deferred', error);
  }
}

export function startBoardAssignmentProcessor(intervalMs = 1_000): void {
  if (runnerGlobals.__shibaBoardAssignmentTimer) return;
  void processBoardAssignmentsOnce().catch((error) => {
    console.error('[board-runner] initial Board assignment recovery failed', error);
  });
  const period = Math.max(250, Math.floor(Number(intervalMs) || 1_000));
  runnerGlobals.__shibaBoardAssignmentTimer = setInterval(() => {
    void processBoardAssignmentsOnce().catch((error) => {
      console.error('[board-runner] Board assignment recovery failed', error);
    });
  }, period);
  runnerGlobals.__shibaBoardAssignmentTimer.unref?.();
}

export function isBoardAssignmentProcessorRunning(): boolean {
  return !!runnerGlobals.__shibaBoardAssignmentTimer;
}

export async function stopBoardAssignmentProcessor(): Promise<void> {
  if (runnerGlobals.__shibaBoardAssignmentTimer) {
    clearInterval(runnerGlobals.__shibaBoardAssignmentTimer);
    runnerGlobals.__shibaBoardAssignmentTimer = undefined;
  }
  if (runnerGlobals.__shibaBoardAssignmentPass) {
    await runnerGlobals.__shibaBoardAssignmentPass;
  }
}

export async function isTaskBeingWorked(taskId: string): Promise<boolean> {
  return !!(await getBoardTask(taskId))?.activeWork;
}
