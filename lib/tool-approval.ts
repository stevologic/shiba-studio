import { v4 as uuidv4 } from 'uuid';
import {
  APPROVAL_GATED_TOOLS,
  canAlwaysApproveTool,
  sanitizeApprovedToolNames,
  toolNeedsApproval,
} from './tool-approval-policy';

export {
  APPROVAL_GATED_TOOLS,
  canAlwaysApproveTool,
  sanitizeApprovedToolNames,
  toolNeedsApproval,
};

export interface PendingApproval {
  id: string;
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  agentId?: string | null;
  sessionId?: string | null;
}

type ApprovalResolver = (approved: boolean) => void;

interface ToolApprovalGlobals {
  __shibaPendingToolApprovals?: Map<string, { meta: PendingApproval; resolve: ApprovalResolver }>;
}

// Next.js can evaluate this module more than once across route/runtime bundles.
// Keep one process-wide registry so the route resolving an approval sees the
// same waiter created by the agent runtime.
const approvalGlobals = globalThis as unknown as ToolApprovalGlobals;
const pending = approvalGlobals.__shibaPendingToolApprovals
  ?? (approvalGlobals.__shibaPendingToolApprovals = new Map<
    string,
    { meta: PendingApproval; resolve: ApprovalResolver }
  >());

export function beginToolApproval(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 5 * 60_000,
  context?: { agentId?: string | null; sessionId?: string | null },
): { approvalId: string; wait: Promise<boolean> } {
  const id = uuidv4();
  const createdAt = new Date();
  const boundedTimeoutMs = Math.max(1, Math.min(5 * 60_000, Number(timeoutMs) || 5 * 60_000));
  const meta: PendingApproval = {
    id,
    runId,
    toolName,
    args,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + boundedTimeoutMs).toISOString(),
    agentId: context?.agentId || null,
    sessionId: context?.sessionId || null,
  };

  const wait = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, boundedTimeoutMs);

    pending.set(id, {
      meta,
      resolve: (approved) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(approved);
      },
    });
  });

  return { approvalId: id, wait };
}

export async function requestToolApproval(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 5 * 60_000,
): Promise<{ approved: boolean; approvalId: string }> {
  const { approvalId, wait } = beginToolApproval(runId, toolName, args, timeoutMs);
  const approved = await wait;
  return { approved, approvalId };
}

export function resolveToolApproval(approvalId: string, approved: boolean): boolean {
  const entry = pending.get(approvalId);
  if (!entry) return false;
  entry.resolve(approved);
  return true;
}

/** Resolve every pending approval for one run (used by task cancellation). */
export function resolveRunApprovals(runId: string, approved = false): number {
  const matches = [...pending.entries()].filter(([, entry]) => entry.meta.runId === runId);
  for (const [, entry] of matches) entry.resolve(approved);
  return matches.length;
}

export function getPendingApproval(approvalId: string): PendingApproval | null {
  return pending.get(approvalId)?.meta || null;
}

export async function loadAlwaysApprovedTools(agentId?: string | null): Promise<string[]> {
  const { loadConfig } = await import('./persistence');
  const cfg = await loadConfig();
  const global = sanitizeApprovedToolNames(cfg.alwaysApprovedTools);
  if (!agentId || agentId === '__chat__') return global;
  const { loadAgents } = await import('./persistence');
  const agent = (await loadAgents()).find((item) => item.id === agentId);
  return sanitizeApprovedToolNames([
    ...global,
    ...(agent?.alwaysApprovedTools || []),
  ]);
}

/** Remember a gated tool so Ask-before-act no longer prompts for it. */
export async function rememberAlwaysApprovedTool(
  toolName: string,
  agentId?: string | null,
): Promise<boolean> {
  const name = String(toolName || '').trim();
  if (!canAlwaysApproveTool(name)) return false;
  if (agentId && agentId !== '__chat__') {
    const { mutateAgents } = await import('./persistence');
    return mutateAgents((agents) => {
      const agent = agents.find((item) => item.id === agentId);
      if (!agent) return false;
      agent.alwaysApprovedTools = sanitizeApprovedToolNames([
        ...(agent.alwaysApprovedTools || []),
        name,
      ]);
      agent.updatedAt = new Date().toISOString();
      return true;
    });
  }
  const { loadConfig, saveConfig } = await import('./persistence');
  const cfg = await loadConfig();
  await saveConfig({
    alwaysApprovedTools: sanitizeApprovedToolNames([
      ...(cfg.alwaysApprovedTools || []),
      name,
    ]),
  });
  return true;
}

export async function awaitLiveToolApproval(opts: {
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId?: string | null;
  sessionId?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  onRequest?: (pending: { approvalId: string; toolName: string; args: Record<string, unknown> }) => void;
}): Promise<boolean> {
  const { approvalId, wait } = beginToolApproval(
    opts.runId,
    opts.toolName,
    opts.args,
    opts.timeoutMs,
    { agentId: opts.agentId, sessionId: opts.sessionId },
  );
  opts.onRequest?.({ approvalId, toolName: opts.toolName, args: opts.args });
  if (!opts.signal) return wait;
  if (opts.signal.aborted) {
    resolveToolApproval(approvalId, false);
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const onAbort = () => {
      resolveToolApproval(approvalId, false);
    };
    opts.signal!.addEventListener('abort', onAbort, { once: true });
    void wait.then((approved) => {
      opts.signal!.removeEventListener('abort', onAbort);
      resolve(approved);
    });
  });
}
