// Background work dispatched from chat. The compatibility API remains, but
// lifecycle and delivery now live in the universal SQLite task ledger/outbox.

import { v4 as uuidv4 } from 'uuid';
import type { Agent } from './types';
import { normalizeAgent } from './types';
import {
  assignTaskExecution,
  createTask,
  getTask,
  listTasks,
  transitionTask,
} from './task-ledger';
import type { TaskRecord } from './task-types';

export interface BackgroundTaskInfo {
  taskId: string;
  runId: string | null;
  sessionId: string | null;
  prompt: string;
  agentName: string;
  status: 'running' | 'completed' | 'error';
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
    schedules: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export interface StartBackgroundTaskOpts {
  prompt: string;
  sessionId?: string | null;
  agent?: Agent | null;
  workspaceDir?: string;
  model: string;
}

function toInfo(task: TaskRecord): BackgroundTaskInfo {
  const status: BackgroundTaskInfo['status'] = task.status === 'succeeded'
    ? 'completed'
    : task.status === 'failed' || task.status === 'lost' || task.status === 'cancelled'
      ? 'error'
      : 'running';
  return {
    taskId: task.id,
    runId: task.runId || null,
    sessionId: task.sessionId || null,
    prompt: task.description,
    agentName: String(task.metadata.agentName || 'Background Task'),
    status,
    startedAt: task.startedAt || task.createdAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.result != null ? { finalOutput: task.result } : {}),
    ...(task.error != null ? { error: task.error } : {}),
  };
}

function launchTaskExecution(task: TaskRecord, agentForRun: Agent, runId: string): BackgroundTaskInfo {
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
  });

  void (async () => {
    const { audit } = await import('./audit-log');
    try {
      audit('run', 'background task dispatched', `${agentForRun.name}: ${task.description.slice(0, 120)}`, {
        taskId: task.id, runId, sessionId: task.sessionId || null,
      });
      const { runAgentOnce } = await import('./agent-runtime');
      await runAgentOnce(agentForRun, task.description, {
        taskId: task.id,
        runId,
        attemptNo: task.retryCount + 1,
      });
      const { processTaskOutbox } = await import('./task-delivery');
      await processTaskOutbox();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = getTask(task.id);
      if (current && current.status === 'running') {
        transitionTask({ taskId: task.id, status: 'failed', error: message });
      }
      audit('run', 'background task failed', `${agentForRun.name}: ${message.slice(0, 160)}`, {
        taskId: task.id, runId, sessionId: task.sessionId || null,
      });
      const { processTaskOutbox } = await import('./task-delivery');
      await processTaskOutbox().catch(() => {});
    }
  })();

  return toInfo(runningTask);
}

/** Launch a queued task created by Dispatch using its persisted scope and identity. */
export async function dispatchExistingTask(taskId: string): Promise<BackgroundTaskInfo> {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.status !== 'queued') throw new Error(`Only queued tasks can be dispatched (current status: ${task.status})`);
  if (task.kind === 'routine') throw new Error('Routine drafts must be configured with a trigger before they can run');

  const [{ loadAgents, loadConfig }] = await Promise.all([import('./persistence')]);
  const [agents, config] = await Promise.all([loadAgents(), loadConfig()]);
  const configured = task.agentId ? agents.find((agent) => agent.id === task.agentId) : undefined;
  const workspaceDir = task.workspaceRoots.find((root) => root.permission === 'write')?.path
    || task.workspaceRoots[0]?.path
    || config.defaultWorkspace
    || '';
  const model = String(task.metadata.model || config.defaultGrokModel || 'cloud:grok-4');
  const worker = configured || syntheticWorker(model, workspaceDir);
  const agentForRun: Agent = workspaceDir
    ? { ...worker, workspace: { ...worker.workspace, path: workspaceDir, useWorktree: false } }
    : worker;
  // Every dispatch attempt gets a new run row while the durable task identity
  // remains stable; reusing the prior run id would overwrite history on retry.
  return launchTaskExecution(task, agentForRun, uuidv4());
}

/**
 * Fire-and-forget dispatch. Task and run identities are allocated and persisted
 * before execution begins, so status remains queryable after a reload/restart.
 */
export function startBackgroundTask(opts: StartBackgroundTaskOpts): BackgroundTaskInfo {
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
    agentId: agentForRun.id,
    runId,
    workspaceRoots: opts.workspaceDir
      ? [{ id: 'chat-workspace', path: opts.workspaceDir, permission: 'write' }]
      : [],
    maxRetries: 1,
    metadata: { agentName: agentForRun.name, model: agentForRun.model },
  });
  return launchTaskExecution(getTask(taskId)!, agentForRun, runId);
}

export function getBackgroundTask(taskId: string): BackgroundTaskInfo | null {
  const task = getTask(taskId);
  return task && task.originType === 'chat' ? toInfo(task) : null;
}

/** Most recent first; optionally scoped to one chat session. */
export function listBackgroundTasks(sessionId?: string | null): BackgroundTaskInfo[] {
  return listTasks({
    originType: 'chat',
    ...(sessionId ? { sessionId } : {}),
    limit: 100,
  }).tasks.map(toInfo);
}
