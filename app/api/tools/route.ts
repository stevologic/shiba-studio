import { NextResponse } from 'next/server';
import { getToolDefinitions, grokCliToolDefinition, mcpToolDefinitions } from '@/lib/agent-runtime';
import { detectGrokCli } from '@/lib/grok-cli';

// Catalog metadata layered over the real runtime tool definitions so the
// Capabilities page always reflects what agents can actually call.
const TOOL_GROUPS: Record<string, { group: string; requires?: string; localOnly?: boolean }> = {
  fs_list: { group: 'Workspace & Files', localOnly: true },
  fs_read: { group: 'Workspace & Files', localOnly: true },
  fs_write: { group: 'Workspace & Files', localOnly: true },
  fs_search: { group: 'Workspace & Files', localOnly: true },
  shell_exec: { group: 'Workspace & Files', localOnly: true },
  web_fetch: { group: 'Web & Research' },
  web_search: { group: 'Web & Research' },
  memory_save: { group: 'Memory' },
  memory_recall: { group: 'Memory' },
  generate_image: { group: 'AI Generation', requires: 'xai' },
  browser_navigate: { group: 'Browser Automation', localOnly: true },
  browser_click: { group: 'Browser Automation', localOnly: true },
  browser_type: { group: 'Browser Automation', localOnly: true },
  browser_screenshot: { group: 'Browser Automation', localOnly: true },
  browser_extract: { group: 'Browser Automation', localOnly: true },
  github_create_issue: { group: 'Integrations', requires: 'github' },
  github_list_repos: { group: 'Integrations', requires: 'github' },
  github_create_pr: { group: 'Integrations', requires: 'github' },
  slack_post: { group: 'Integrations', requires: 'slack' },
  drive_list: { group: 'Integrations', requires: 'googledrive' },
  drive_upload: { group: 'Integrations', requires: 'googledrive' },
  discord_post: { group: 'Integrations', requires: 'discord' },
  x_post: { group: 'Integrations', requires: 'x' },
  obsidian_list: { group: 'Integrations', requires: 'obsidian' },
  obsidian_read: { group: 'Integrations', requires: 'obsidian' },
  obsidian_write: { group: 'Integrations', requires: 'obsidian' },
  obsidian_search: { group: 'Integrations', requires: 'obsidian' },
  send_to_peer: { group: 'Orchestration', requires: 'peers' },
  schedule_task: { group: 'Orchestration' },
  grok_cli: { group: 'Orchestration', localOnly: true },
  mcp_list_tools: { group: 'MCP', requires: 'mcp' },
  mcp_invoke: { group: 'MCP', requires: 'mcp' },
};

export interface ToolCatalogEntry {
  name: string;
  description: string;
  group: string;
  requires?: string;
  localOnly: boolean;
}

export async function GET() {
  const cli = await detectGrokCli();
  const defs = [
    ...getToolDefinitions(
      { github: true, slack: true, googledrive: true, discord: true, x: true, obsidian: true },
      true,
      'local',
    ),
    ...(cli.installed ? [grokCliToolDefinition()] : []),
    ...mcpToolDefinitions(),
  ];
  const tools: ToolCatalogEntry[] = defs.map((t) => {
    const meta = TOOL_GROUPS[t.function.name] || { group: 'Other' };
    return {
      name: t.function.name,
      description: t.function.description || '',
      group: meta.group,
      requires: meta.requires,
      localOnly: !!meta.localOnly,
    };
  });
  return NextResponse.json({ ok: true, tools });
}
