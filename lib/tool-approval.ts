import { v4 as uuidv4 } from 'uuid';
import type { ToolApprovalMode } from './types';

export const APPROVAL_GATED_TOOLS = new Set([
  'fs_write',
  'shell_exec',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'github_create_issue',
  'slack_post',
  'discord_post',
  'x_post',
  'drive_upload',
  'obsidian_write',
  'grok_cli',
  'mcp_invoke',
]);

export function toolNeedsApproval(toolName: string, mode: ToolApprovalMode | undefined): boolean {
  return mode === 'ask' && APPROVAL_GATED_TOOLS.has(toolName);
}

export interface PendingApproval {
  id: string;
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
}

type ApprovalResolver = (approved: boolean) => void;

const pending = new Map<string, { meta: PendingApproval; resolve: ApprovalResolver }>();

export function beginToolApproval(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 5 * 60_000,
): { approvalId: string; wait: Promise<boolean> } {
  const id = uuidv4();
  const meta: PendingApproval = {
    id,
    runId,
    toolName,
    args,
    createdAt: new Date().toISOString(),
  };

  const wait = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, timeoutMs);

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

export function getPendingApproval(approvalId: string): PendingApproval | null {
  return pending.get(approvalId)?.meta || null;
}