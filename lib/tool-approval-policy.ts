/** Gated tools and Always-approve rules shared by server waiters and the chat UI. */

export const APPROVAL_GATED_TOOLS = new Set([
  'fs_write',
  'shell_exec',
  'terminal_exec',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'github_create_issue',
  'slack_post',
  'discord_post',
  'x_post',
  'reddit_submit',
  'drive_upload',
  'gmail_send',
  'youtube_upload',
  'obsidian_write',
  'vercel_deploy',
  'vercel_set_env',
  'netlify_deploy',
  'netlify_set_env',
  'grok_cli',
  'mcp_invoke',
  'memory_forget',
  'delegate_task_team',
  'native_node_action',
]);

export function canAlwaysApproveTool(toolName: string): boolean {
  return toolName !== 'native_node_action' && APPROVAL_GATED_TOOLS.has(toolName);
}

export function sanitizeApprovedToolNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const unique = new Set<string>();
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (canAlwaysApproveTool(name)) unique.add(name);
  }
  return [...unique].sort();
}

export function toolNeedsApproval(
  toolName: string,
  mode: 'ask' | 'yolo' | undefined,
  alwaysApproved?: Iterable<string> | null,
): boolean {
  if (toolName === 'native_node_action') return true;
  if (alwaysApproved) {
    for (const name of alwaysApproved) {
      if (name === toolName) return false;
    }
  }
  return mode === 'ask' && APPROVAL_GATED_TOOLS.has(toolName);
}
