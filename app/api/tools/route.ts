import { NextRequest, NextResponse } from 'next/server';
import { getToolDefinitions, grokCliToolDefinition, mcpToolDefinitions } from '@/lib/agent-runtime';
import { detectGrokCli } from '@/lib/grok-cli';
import { loadConfig, saveConfig } from '@/lib/persistence';
import { setToolDisabled } from '@/lib/disabled-tools';

// Catalog metadata layered over the real runtime tool definitions so the
// Capabilities page always reflects what agents can actually call.
const TOOL_GROUPS: Record<string, { group: string; requires?: string }> = {
  fs_list: { group: 'Workspace & Files' },
  fs_read: { group: 'Workspace & Files' },
  fs_write: { group: 'Workspace & Files' },
  fs_search: { group: 'Workspace & Files' },
  shell_exec: { group: 'Workspace & Files' },
  terminal_exec: { group: 'Workspace & Files' },
  sandbox_exec: { group: 'Sandbox' },
  sandbox_write_file: { group: 'Sandbox' },
  web_fetch: { group: 'Web & Research' },
  web_search: { group: 'Web & Research' },
  memory_save: { group: 'Memory' },
  memory_recall: { group: 'Memory' },
  memory_forget: { group: 'Memory' },
  generate_image: { group: 'AI Generation', requires: 'xai' },
  browser_navigate: { group: 'Browser Automation' },
  browser_click: { group: 'Browser Automation' },
  browser_type: { group: 'Browser Automation' },
  browser_screenshot: { group: 'Browser Automation' },
  browser_extract: { group: 'Browser Automation' },
  github_create_issue: { group: 'Integrations', requires: 'github' },
  github_list_repos: { group: 'Integrations', requires: 'github' },
  github_create_pr: { group: 'Integrations', requires: 'github' },
  slack_post: { group: 'Integrations', requires: 'slack' },
  drive_list: { group: 'Integrations', requires: 'googledrive' },
  drive_upload: { group: 'Integrations', requires: 'googledrive' },
  discord_post: { group: 'Integrations', requires: 'discord' },
  x_post: { group: 'Integrations', requires: 'x' },
  x_read_timeline: { group: 'Integrations', requires: 'x' },
  obsidian_list: { group: 'Integrations', requires: 'obsidian' },
  obsidian_read: { group: 'Integrations', requires: 'obsidian' },
  obsidian_write: { group: 'Integrations', requires: 'obsidian' },
  obsidian_search: { group: 'Integrations', requires: 'obsidian' },
  vercel_list_projects: { group: 'Integrations', requires: 'vercel' },
  vercel_list_deployments: { group: 'Integrations', requires: 'vercel' },
  vercel_get_deployment: { group: 'Integrations', requires: 'vercel' },
  vercel_deploy: { group: 'Integrations', requires: 'vercel' },
  vercel_set_env: { group: 'Integrations', requires: 'vercel' },
  netlify_list_sites: { group: 'Integrations', requires: 'netlify' },
  netlify_list_deploys: { group: 'Integrations', requires: 'netlify' },
  netlify_get_deploy: { group: 'Integrations', requires: 'netlify' },
  netlify_deploy: { group: 'Integrations', requires: 'netlify' },
  netlify_set_env: { group: 'Integrations', requires: 'netlify' },
  send_to_peer: { group: 'Orchestration', requires: 'peers' },
  schedule_task: { group: 'Orchestration' },
  grok_cli: { group: 'Orchestration' },
  list_agents: { group: 'Board' },
  board_list_tasks: { group: 'Board' },
  board_get_task: { group: 'Board' },
  board_update_task: { group: 'Board' },
  board_create_task: { group: 'Board' },
  mcp_list_tools: { group: 'MCP', requires: 'mcp' },
  mcp_invoke: { group: 'MCP', requires: 'mcp' },
};

export interface ToolCatalogEntry {
  name: string;
  description: string;
  group: string;
  requires?: string;
  /** false when the user disabled this tool in Capabilities */
  enabled: boolean;
}

export async function GET() {
  const cfg = await loadConfig();
  const disabled = new Set(cfg.disabledTools || []);
  const cli = await detectGrokCli();
  const defs = [
    ...getToolDefinitions(
      {
        github: true,
        slack: true,
        googledrive: true,
        discord: true,
        x: true,
        obsidian: true,
        vercel: true,
        netlify: true,
      },
      true,
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
      enabled: !disabled.has(t.function.name),
    };
  });
  return NextResponse.json({
    ok: true,
    tools,
    disabledTools: cfg.disabledTools || [],
  });
}

/** Toggle one tool, or replace the full disabled list. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const cfg = await loadConfig();

    // Full replace: { disabledTools: string[] }
    if (Array.isArray(body.disabledTools) && body.tool === undefined && body.name === undefined) {
      const next: string[] = body.disabledTools
        .map((n: unknown) => String(n).trim())
        .filter((n: string) => !!n);
      const unique: string[] = [...new Set(next)].sort();
      const saved = await saveConfig({ disabledTools: unique });
      const { audit } = await import('@/lib/audit-log');
      audit('config', 'tools disabled list updated', unique.join(', ') || '(none)');
      return NextResponse.json({
        ok: true,
        disabledTools: saved.disabledTools || [],
      });
    }

    // Single toggle: { tool|name, enabled: boolean } or { tool, disabled: true }
    const toolName = String(body.tool || body.name || '').trim();
    if (!toolName) {
      return NextResponse.json({ ok: false, error: 'Provide tool name or disabledTools array' }, { status: 400 });
    }
    let shouldEnable = true;
    if (body.enabled !== undefined) {
      shouldEnable = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
    } else if (body.disabled !== undefined) {
      shouldEnable = !(body.disabled === true || body.disabled === 'true' || body.disabled === 1);
    }

    const nextDisabled = setToolDisabled(cfg.disabledTools, toolName, shouldEnable);
    const saved = await saveConfig({ disabledTools: nextDisabled });
    const { audit } = await import('@/lib/audit-log');
    audit('config', shouldEnable ? 'tool enabled' : 'tool disabled', toolName);
    return NextResponse.json({
      ok: true,
      tool: toolName,
      enabled: shouldEnable,
      disabledTools: saved.disabledTools || [],
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed to update tools' },
      { status: 500 },
    );
  }
}
