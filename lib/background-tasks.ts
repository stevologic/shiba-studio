// Background tasks dispatched FROM CHAT: long-running work (build an app,
// deep research) runs as a normal agent run — traced on Automations, bounded
// by the run guards (concurrency, budgets, token caps) — while the chat stays
// responsive. When the run finishes, the result is delivered back into the
// originating chat session as an assistant message, and it's always available
// via run history even if the user kept chatting meanwhile.

import { v4 as uuidv4 } from 'uuid';
import type { Agent, AgentRun } from './types';
import { normalizeAgent } from './types';

export interface BackgroundTaskInfo {
  taskId: string;
  runId: string | null;
  sessionId: string | null;
  prompt: string;
  agentName: string;
  status: 'running' | 'completed' | 'error';
  startedAt: string;
  completedAt?: string;
  /** Final answer once completed (also persisted with the run). */
  finalOutput?: string;
  error?: string;
}

interface BgGlobals {
  __shibaBgTasks?: Map<string, BackgroundTaskInfo>;
}
const g = globalThis as unknown as BgGlobals;
const tasks: Map<string, BackgroundTaskInfo> = g.__shibaBgTasks ?? (g.__shibaBgTasks = new Map());

const MAX_TRACKED = 100;

function trim(): void {
  if (tasks.size <= MAX_TRACKED) return;
  const oldestFirst = [...tasks.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const t of oldestFirst.slice(0, tasks.size - MAX_TRACKED)) tasks.delete(t.taskId);
}

/** Build the worker agent for a plain-chat dispatch (no bound agent). */
function syntheticWorker(model: string, workspaceDir: string | undefined): Agent {
  return normalizeAgent({
    id: `bg-${uuidv4().slice(0, 8)}`,
    name: 'Background Task',
    model,
    origin: 'local',
    description: 'One-off background task dispatched from chat',
    // Empty path → the runtime's default workspace (same as unconfigured agents).
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
  /** Chat session to deliver the result into (and for status lookups). */
  sessionId?: string | null;
  /** Bound chat agent — used as the worker when present (its tools/scopes apply). */
  agent?: Agent | null;
  /** Chat workspace — the worker operates on this folder. */
  workspaceDir?: string;
  /** Model for the synthetic worker when no agent is bound. */
  model: string;
}

/**
 * Fire-and-forget dispatch. Returns immediately with the task handle; the run
 * proceeds through the standard agent runtime (guards, trace, persistence).
 */
export function startBackgroundTask(opts: StartBackgroundTaskOpts): BackgroundTaskInfo {
  const worker = opts.agent && opts.agent.origin !== 'cloud'
    ? opts.agent
    : syntheticWorker(opts.model, opts.workspaceDir);
  // A chat workspace wins over the worker's own folder so "code it here" works.
  const agentForRun: Agent = opts.workspaceDir
    ? { ...worker, workspace: { ...worker.workspace, path: opts.workspaceDir, useWorktree: false } }
    : worker;

  const info: BackgroundTaskInfo = {
    taskId: uuidv4(),
    runId: null,
    sessionId: opts.sessionId || null,
    prompt: opts.prompt,
    agentName: agentForRun.name,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  tasks.set(info.taskId, info);
  trim();

  void (async () => {
    const { audit } = await import('./audit-log');
    try {
      audit('run', 'background task dispatched', `${agentForRun.name}: ${opts.prompt.slice(0, 120)}`, {
        taskId: info.taskId, sessionId: info.sessionId,
      });
      const { runAgentOnce } = await import('./agent-runtime');
      const run: AgentRun = await runAgentOnce(agentForRun, opts.prompt, {});
      info.runId = run.id;
      info.status = run.status === 'error' ? 'error' : 'completed';
      info.completedAt = new Date().toISOString();
      info.finalOutput = run.finalOutput || '';
      await deliverToChat(info, run);
    } catch (e) {
      info.status = 'error';
      info.completedAt = new Date().toISOString();
      info.error = e instanceof Error ? e.message : String(e);
      audit('run', 'background task failed', `${agentForRun.name}: ${info.error.slice(0, 160)}`, {
        taskId: info.taskId, sessionId: info.sessionId,
      });
      await deliverToChat(info, null).catch(() => {});
    }
  })();

  return info;
}

/** Post the finished result back into the originating chat session. */
async function deliverToChat(info: BackgroundTaskInfo, run: AgentRun | null): Promise<void> {
  if (!info.sessionId) return;
  try {
    const { appendChatMessage } = await import('./chat-sessions');
    const ok = info.status === 'completed';
    const link = info.runId ? `/automations?run=${encodeURIComponent(info.runId)}` : '/automations';
    const body = ok
      ? (info.finalOutput || '(no output)')
      : `The task hit an error: ${run?.finalOutput || info.error || 'unknown error'}`;
    await appendChatMessage(info.sessionId, {
      id: uuidv4(),
      role: 'assistant',
      content: [
        `📦 **Background task ${ok ? 'finished' : 'failed'}** — “${info.prompt.slice(0, 100)}${info.prompt.length > 100 ? '…' : ''}”`,
        '',
        body,
        '',
        `[Full execution trace](${link})`,
      ].join('\n'),
      agentName: info.agentName,
      createdAt: new Date().toISOString(),
    });
    const { audit } = await import('./audit-log');
    audit('chat', 'background task result delivered', info.prompt.slice(0, 120), {
      taskId: info.taskId, runId: info.runId, sessionId: info.sessionId, status: info.status,
    });
  } catch {
    /* delivery is best-effort; the run itself is persisted regardless */
  }
}

export function getBackgroundTask(taskId: string): BackgroundTaskInfo | null {
  return tasks.get(taskId) || null;
}

/** Most recent first; optionally scoped to one chat session. */
export function listBackgroundTasks(sessionId?: string | null): BackgroundTaskInfo[] {
  const all = [...tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sessionId ? all.filter((t) => t.sessionId === sessionId) : all;
}
