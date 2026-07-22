// Background work dispatched from chat. The compatibility API remains, but
// lifecycle and delivery now live in the universal SQLite task ledger/outbox.

import { v4 as uuidv4 } from 'uuid';
import type { Agent } from './types';
import { normalizeAgent } from './types';
import {
  assignTaskExecution,
  createTask,
  getTask,
  listQueuedRetryTasks,
  listTasks,
  transitionTask,
} from './task-ledger';
import { TERMINAL_TASK_STATUSES, type TaskRecord, type TaskStatus } from './task-types';
import { isAutomationMaintenanceActive } from './automation-maintenance';

interface RetryDispatchGlobals {
  __shibaQueuedRetryDispatchPromise?: Promise<number>;
  __shibaQueuedRetryDispatchTimer?: ReturnType<typeof setInterval>;
}

const retryDispatchGlobals = globalThis as typeof globalThis & RetryDispatchGlobals;

export interface BackgroundTaskInfo {
  taskId: string;
  runId: string | null;
  sessionId: string | null;
  projectId: string | null;
  prompt: string;
  agentName: string;
  status: TaskStatus;
  /** Explicit alias retained for tool payload readability. */
  taskStatus: TaskStatus;
  taskUrl: string;
  runUrl?: string;
  startedAt: string;
  completedAt?: string;
  finalOutput?: string;
  error?: string;
}

/** Build the worker agent for a plain-chat dispatch (no bound agent). */
function syntheticWorker(model: string, workspaceDir: string | undefined): Agent {
  return normalizeAgent({
    id: `bg-${uuidv4().slice(0, 8)}`,
    name: 'Background Task',
    model,
    description: 'One-off background task dispatched from chat',
    workspace: { path: workspaceDir || '', useWorktree: false },
    integrations: {},
    peers: [],
    skills: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export interface StartBackgroundTaskOpts {
  prompt: string;
  sessionId?: string | null;
  projectId?: string | null;
  projectContext?: string;
  agent?: Agent | null;
  workspaceDir?: string;
  model: string;
}

function toInfo(task: TaskRecord): BackgroundTaskInfo {
  return {
    taskId: task.id,
    runId: task.runId || null,
    sessionId: task.sessionId || null,
    projectId: task.projectId || null,
    prompt: task.description,
    agentName: String(task.metadata.agentName || 'Background Task'),
    status: task.status,
    taskStatus: task.status,
    taskUrl: `/tasks/${encodeURIComponent(task.id)}`,
    ...(task.runId ? { runUrl: `/automations?run=${encodeURIComponent(task.runId)}` } : {}),
    startedAt: task.startedAt || task.createdAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.result != null ? { finalOutput: task.result } : {}),
    ...(task.error != null ? { error: task.error } : {}),
  };
}

function runScopeForTask(task: TaskRecord): {
  projectId?: string;
  projectContext?: string;
  workspacePathOverride?: string;
} {
  const ownedWorkspace = task.workspaceRoots.find((root) => root.permission === 'write')?.path
    || task.workspaceRoots[0]?.path;
  return {
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(typeof task.metadata.projectContext === 'string' && task.metadata.projectContext.trim()
      ? { projectContext: task.metadata.projectContext }
      : {}),
    ...(ownedWorkspace && (task.kind === 'board' || task.originType === 'chat')
      ? { workspacePathOverride: ownedWorkspace }
      : {}),
  };
}

export const backgroundTaskTestHooks = { runScopeForTask };

function deferTaskForCapacity(taskId: string): void {
  let current = getTask(taskId);
  if (!current || ['succeeded', 'cancelled'].includes(current.status)) return;
  if (!['queued', 'failed', 'lost'].includes(current.status)) {
    current = transitionTask({
      taskId: current.id,
      status: 'failed',
      expectedVersion: current.version,
      error: 'Concurrent-run limit reached; waiting for an available run slot.',
    });
  }
  if (current.status === 'failed' || current.status === 'lost') {
    transitionTask({
      taskId: current.id,
      status: 'queued',
      expectedVersion: current.version,
      result: null,
      error: null,
      currentStep: 'Waiting for an available run slot',
      metadata: { capacityDeferred: true },
    });
  }
}

function launchTaskExecution(task: TaskRecord, agentForRun: Agent, runId: string): BackgroundTaskInfo {
  if (isAutomationMaintenanceActive()) {
    throw new Error('Background work is temporarily paused for maintenance. Retry after maintenance finishes.');
  }
  const assigned = assignTaskExecution({
    taskId: task.id,
    runId,
    agentId: agentForRun.id,
    expectedVersion: task.version,
  });
  const runningTask = transitionTask({
    taskId: assigned.id,
    status: 'running',
    expectedVersion: assigned.version,
    currentStep: 'Starting agent run',
    metadata: { capacityDeferred: false },
  });

  void (async () => {
    try {
      const { audit } = await import('./audit-log');
      const boardTask = task.kind === 'board';
      audit('run', boardTask ? 'board card dispatched' : 'background task dispatched', boardTask
        ? `${String(task.metadata.boardKey || task.title)}: ${task.title.slice(0, 100)}`
        : `${agentForRun.name}: ${task.description.slice(0, 120)}`, {
        taskId: task.id, runId, sessionId: task.sessionId || null,
      });
    } catch { /* audit is derived bookkeeping */ }

    try {
      const { runAgentOnce } = await import('./agent-runtime');
      const runOptions: Parameters<typeof runAgentOnce>[2] = {
        taskId: task.id,
        runId,
        attemptNo: task.retryCount + 1,
        taskKind: task.kind,
        ...runScopeForTask(task),
      };
      const run = await runAgentOnce(agentForRun, task.description, runOptions);
      if (run.status === 'error' && /Concurrent-run limit reached/i.test(run.finalOutput || '')) {
        deferTaskForCapacity(task.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Concurrent-run limit reached/i.test(message)) {
        try { deferTaskForCapacity(task.id); } catch { /* periodic recovery retries the durable projection */ }
        return;
      }
      try {
        const current = getTask(task.id);
        if (current && !TERMINAL_TASK_STATUSES.has(current.status)) {
          transitionTask({ taskId: task.id, status: 'failed', error: message });
        }
      } catch {
        /* the run row/audit below still preserve the failure for diagnosis */
      }
      try {
        const { audit } = await import('./audit-log');
        audit('run', 'background task failed', `${agentForRun.name}: ${message.slice(0, 160)}`, {
          taskId: task.id, runId, sessionId: task.sessionId || null,
        });
      } catch { /* audit is best-effort */ }
    }
    if (task.kind === 'board') {
      try {
        const { processBoardAssignmentsOnce } = await import('./board-runner');
        await processBoardAssignmentsOnce({ dispatch: false });
      } catch {
        // The periodic Board processor projects the same terminal state.
      }
    }
    try {
      const { processTaskOutbox } = await import('./task-delivery');
      await processTaskOutbox();
    } catch { /* periodic delivery pump retries durable rows */ }
  })().catch((error) => {
    console.error('[background-tasks] detached worker failed', error);
  });

  return toInfo(runningTask);
}

/** Launch a queued task created by Dispatch using its persisted scope and identity. */
export async function dispatchExistingTask(taskId: string): Promise<BackgroundTaskInfo> {
  if (isAutomationMaintenanceActive()) {
    throw new Error('Background work is temporarily paused for maintenance. Retry after maintenance finishes.');
  }
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.status !== 'queued') throw new Error(`Only queued tasks can be dispatched (current status: ${task.status})`);
  if (task.kind === 'routine') throw new Error('Routine drafts must be configured with a trigger before they can run');
  if (task.parentId && typeof task.metadata.teamWorkerKey === 'string') {
    // Team workers must always pass through the team launcher. Generic
    // dispatch would silently discard their read-only, integration, tool, and
    // worktree grants and would not advance dependent workers.
    const { dispatchReadyTeamWorkers } = await import('./task-teams');
    await dispatchReadyTeamWorkers(task.parentId);
    return toInfo(getTask(task.id) || task);
  }
  if (task.kind === 'board') {
    const { getBoardTask } = await import('./board');
    const card = task.originId ? await getBoardTask(task.originId) : null;
    const claim = card?.activeWork;
    if (
      !card
      || !claim
      || claim.taskId !== task.id
      || claim.agentId !== task.agentId
      || !!claim.cancelRequestedAt
      || card.assigneeAgentId !== task.agentId
      || card.status === 'done'
      || card.status === 'cancelled'
    ) {
      transitionTask({
        taskId: task.id,
        status: 'cancelled',
        expectedVersion: task.version,
        error: 'Board assignment changed or was cancelled before execution began.',
      });
      throw new Error('Board work claim is no longer active');
    }
  }

  const [{ loadAgents, loadConfig }] = await Promise.all([import('./persistence')]);
  const [agents, config] = await Promise.all([loadAgents(), loadConfig()]);
  const configured = task.agentId ? agents.find((agent) => agent.id === task.agentId) : undefined;
  const workspaceDir = task.workspaceRoots.find((root) => root.permission === 'write')?.path
    || task.workspaceRoots[0]?.path
    || config.defaultWorkspace
    || '';
  const model = String(task.metadata.model || config.defaultGrokModel || 'cloud:grok-4');
  // A durable task that was explicitly bound to a saved agent must never be
  // resumed under a made-up identity after that agent is deleted. Apart from
  // being surprising, doing so turns a broken reference into an irreversible
  // side effect under different credentials. Plain chat tasks use the
  // intentionally ephemeral `bg-*` identity and can be reconstructed.
  if (task.agentId && !task.agentId.startsWith('bg-') && !configured) {
    transitionTask({
      taskId: task.id,
      status: 'lost',
      expectedVersion: task.version,
      error: `The assigned agent (${task.agentId}) no longer exists. Reassign or retry this task explicitly.`,
    });
    throw new Error(`Assigned agent no longer exists: ${task.agentId}`);
  }
  const worker = configured || syntheticWorker(model, workspaceDir);
  const preserveBoardWorktree = task.kind === 'board'
    && !task.projectId
    && configured?.workspace.useWorktree === true;
  const agentForRun: Agent = workspaceDir
    ? {
        ...worker,
        workspace: {
          ...worker.workspace,
          path: workspaceDir,
          useWorktree: preserveBoardWorktree,
        },
      }
    : worker;
  // Every dispatch attempt gets a new run row while the durable task identity
  // remains stable; reusing the prior run id would overwrite history on retry.
  return launchTaskExecution(task, agentForRun, uuidv4());
}

/**
 * The queued+retryCount projection is itself a durable execution intent. Scan
 * it periodically so a crash after the atomic retry command but before the
 * imperative dispatch cannot strand work forever. Team children are routed
 * through dispatchExistingTask's scoped team path.
 */
export function processQueuedTaskRetries(limit = 500): Promise<number> {
  if (retryDispatchGlobals.__shibaQueuedRetryDispatchPromise) {
    return retryDispatchGlobals.__shibaQueuedRetryDispatchPromise;
  }
  if (isAutomationMaintenanceActive()) return Promise.resolve(0);
  const operation = (async () => {
    const [{ activeRunCount, maxConcurrentRuns }, { loadConfig }] = await Promise.all([
      import('./run-guards'),
      import('./persistence'),
    ]);
    const availableSlots = Math.max(0, maxConcurrentRuns(await loadConfig()) - activeRunCount());
    if (isAutomationMaintenanceActive()) return 0;
    const queued = listQueuedRetryTasks(limit);
    let genericSlots = availableSlots;
    let attempted = 0;
    for (const task of queued) {
      if (isAutomationMaintenanceActive()) break;
      const teamWorker = Boolean(task.parentId && typeof task.metadata.teamWorkerKey === 'string');
      if (!teamWorker && genericSlots <= 0) continue;
      if (!teamWorker) genericSlots -= 1;
      try {
        await dispatchExistingTask(task.id);
        attempted += 1;
      } catch (error) {
        const current = getTask(task.id);
        // Another process won the optimistic dispatch race. That is success
        // for recovery purposes; transient queued failures remain discoverable
        // on the next pump pass.
        if (current?.status !== 'queued') attempted += 1;
        else console.error('[background-tasks] queued retry dispatch failed', { taskId: task.id, error });
      }
    }
    return attempted;
  })();
  retryDispatchGlobals.__shibaQueuedRetryDispatchPromise = operation.finally(() => {
    retryDispatchGlobals.__shibaQueuedRetryDispatchPromise = undefined;
  });
  return retryDispatchGlobals.__shibaQueuedRetryDispatchPromise;
}

export function startQueuedRetryDispatcher(intervalMs = 2_000): void {
  if (retryDispatchGlobals.__shibaQueuedRetryDispatchTimer || isAutomationMaintenanceActive()) return;
  void processQueuedTaskRetries().catch((error) => {
    console.error('[background-tasks] initial queued retry recovery failed', error);
  });
  const period = Math.max(250, Math.floor(Number(intervalMs) || 2_000));
  retryDispatchGlobals.__shibaQueuedRetryDispatchTimer = setInterval(() => {
    void processQueuedTaskRetries().catch((error) => {
      console.error('[background-tasks] queued retry recovery failed', error);
    });
  }, period);
  retryDispatchGlobals.__shibaQueuedRetryDispatchTimer.unref?.();
}

export async function stopQueuedRetryDispatcher(): Promise<void> {
  if (retryDispatchGlobals.__shibaQueuedRetryDispatchTimer) {
    clearInterval(retryDispatchGlobals.__shibaQueuedRetryDispatchTimer);
    retryDispatchGlobals.__shibaQueuedRetryDispatchTimer = undefined;
  }
  const active = retryDispatchGlobals.__shibaQueuedRetryDispatchPromise;
  if (active) await active;
}

/**
 * Fire-and-forget dispatch. Task and run identities are allocated and persisted
 * before execution begins, so status remains queryable after a reload/restart.
 */
export function startBackgroundTask(opts: StartBackgroundTaskOpts): BackgroundTaskInfo {
  if (isAutomationMaintenanceActive()) {
    throw new Error('Background work is temporarily paused for maintenance. Retry after maintenance finishes.');
  }
  const worker = opts.agent ?? syntheticWorker(opts.model, opts.workspaceDir);
  const agentForRun: Agent = opts.workspaceDir
    ? { ...worker, workspace: { ...worker.workspace, path: opts.workspaceDir, useWorktree: false } }
    : worker;
  const taskId = uuidv4();
  const runId = uuidv4();
  createTask({
    id: taskId,
    kind: opts.workspaceDir ? 'code' : 'work',
    title: opts.prompt.slice(0, 120) || 'Background task',
    description: opts.prompt,
    status: 'queued',
    originType: 'chat',
    originId: opts.sessionId || taskId,
    sessionId: opts.sessionId || undefined,
    projectId: opts.projectId || undefined,
    agentId: agentForRun.id,
    runId,
    workspaceRoots: opts.workspaceDir
      ? [{ id: 'chat-workspace', path: opts.workspaceDir, permission: 'write' }]
      : [],
    maxRetries: 1,
    metadata: {
      agentName: agentForRun.name,
      model: agentForRun.model,
      ...(opts.projectContext?.trim() ? { projectContext: opts.projectContext.trim() } : {}),
    },
  });
  return launchTaskExecution(getTask(taskId)!, agentForRun, runId);
}

export function getBackgroundTask(taskId: string, sessionId?: string | null): BackgroundTaskInfo | null {
  const task = getTask(taskId);
  if (!task || task.originType !== 'chat') return null;
  if (sessionId !== undefined && task.sessionId !== sessionId) return null;
  return toInfo(task);
}

/** Most recent first; optionally scoped to one chat session. */
export function listBackgroundTasks(sessionId?: string | null): BackgroundTaskInfo[] {
  return listTasks({
    originType: 'chat',
    ...(sessionId ? { sessionId } : {}),
    limit: 100,
  }).tasks.map(toInfo);
}
