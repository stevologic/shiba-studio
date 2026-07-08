import path from 'path';
import type { Agent, AgentRun } from './types';
import { projectRoot } from './data-paths';
import { listFiles, readFile, writeFile, shellExec } from './workspace';

/** Resolve a workspace-relative path with a project-root anchor for Next file tracing. */
function agentPath(workDir: string, rel: string): string {
  const normalized = (rel || '.').replace(/^[/\\]+/, '');
  if (path.isAbsolute(normalized)) return normalized;
  const absolute = path.resolve(workDir, normalized);
  const relFromRoot = path.relative(projectRoot(), absolute);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    return absolute;
  }
  return path.join(/* turbopackIgnore: true */ process.cwd(), relFromRoot);
}
import * as Browser from './browser';
import * as Ints from './integrations';
import { postToAgentInbox } from './agent-inbox';
import { scheduleFromAgentTool } from './scheduler';
import { detectGrokCli, runGrokCliPrompt } from './grok-cli';
import { listEnabledMcpServers } from './mcp';
import { invokeMcpTool } from './mcp-client';

/** Tools that touch this machine — never available to cloud agents. */
const LOCAL_ONLY_TOOLS = new Set([
  'fs_list', 'fs_read', 'fs_write', 'fs_search', 'shell_exec',
  'browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_extract',
  'grok_cli', 'mcp_list_tools', 'mcp_invoke',
]);

export async function executeAgentTool(
  name: string,
  args: any,
  agent: Agent,
  run: Partial<AgentRun>,
  workDir: string,
  runIdForBrowser?: string,
): Promise<{ result: any; sideEffect?: string; screenshot?: string }> {
  if (agent.origin === 'cloud' && LOCAL_ONLY_TOOLS.has(name)) {
    return {
      result: { error: `Tool "${name}" requires local system access, which cloud agents do not have. Use cloud integrations instead.` },
      sideEffect: `blocked local tool ${name} for cloud agent`,
    };
  }
  try {
    switch (name) {
      case 'fs_list': {
        const dir = args.dir || '.';
        const entries = await listFiles(agentPath(workDir, dir), 1);
        return { result: entries.slice(0, 40), sideEffect: `listed ${entries.length} files in ${dir}` };
      }
      case 'fs_read': {
        const content = await readFile(agentPath(workDir, args.path));
        return { result: content.slice(0, 12000), sideEffect: `read ${args.path}` };
      }
      case 'fs_write': {
        await writeFile(agentPath(workDir, args.path), args.content || '');
        return { result: `wrote ${args.path} (${(args.content || '').length} chars)`, sideEffect: `wrote file ${args.path}` };
      }
      case 'shell_exec': {
        const out = await shellExec(args.command, workDir, 45000);
        return { result: { stdout: out.stdout.slice(0, 4000), stderr: out.stderr.slice(0, 1200), code: out.code }, sideEffect: `shell: ${args.command}` };
      }
      case 'fs_search': {
        const { fsSearch } = await import('./agent-power-tools');
        const hits = await fsSearch(workDir, String(args.pattern || ''), args.dir ? String(args.dir) : undefined);
        return { result: hits, sideEffect: `searched workspace for "${args.pattern}" → ${hits.length} hits` };
      }
      case 'web_fetch': {
        const { webFetch } = await import('./agent-power-tools');
        const page = await webFetch(String(args.url || ''));
        return { result: page, sideEffect: `fetched ${page.url}` };
      }
      case 'web_search': {
        const { webSearch } = await import('./agent-power-tools');
        const results = await webSearch(String(args.query || ''));
        return { result: results, sideEffect: `web search "${args.query}" → ${results.length} results` };
      }
      case 'memory_save': {
        const { memorySave } = await import('./agent-power-tools');
        const entry = memorySave(agent.id, String(args.key || ''), String(args.content || ''));
        return { result: { saved: entry.key }, sideEffect: `remembered "${entry.key}"` };
      }
      case 'memory_recall': {
        const { memoryRecall } = await import('./agent-power-tools');
        const entries = memoryRecall(agent.id, args.query ? String(args.query) : undefined);
        return { result: entries, sideEffect: `recalled ${entries.length} memories` };
      }
      case 'generate_image': {
        const { generateImage } = await import('./agent-power-tools');
        const { loadConfig } = await import('./persistence');
        const { resolveCloudBearer } = await import('./xai-oauth');
        const auth = await resolveCloudBearer(await loadConfig());
        if (!auth.token) {
          return { result: { error: 'Image generation needs cloud xAI credentials (API key or OAuth) — configure them in Settings.' }, sideEffect: 'generate_image blocked: no cloud auth' };
        }
        const img = await generateImage(String(args.prompt || ''), auth.token, workDir);
        return {
          result: { path: img.path, revisedPrompt: img.revisedPrompt },
          sideEffect: `generated image → ${img.path}`,
          screenshot: img.dataUrl,
        };
      }
      case 'browser_navigate': {
        const r = await Browser.browserNavigate(args.url, runIdForBrowser);
        return { result: r, sideEffect: `navigated to ${r.url}` };
      }
      case 'browser_click': {
        const r = await Browser.browserClick(args.selector, runIdForBrowser);
        return { result: r, sideEffect: `clicked ${args.selector}` };
      }
      case 'browser_type': {
        const r = await Browser.browserType(args.selector, args.text, !!args.submit, runIdForBrowser);
        return { result: r, sideEffect: `typed into ${args.selector}` };
      }
      case 'browser_screenshot': {
        const r = await Browser.browserScreenshot(args.name || agent.id, runIdForBrowser);
        return { result: { path: r.path }, sideEffect: 'captured screenshot', screenshot: r.dataUrl };
      }
      case 'browser_extract': {
        const txt = await Browser.browserExtractText(args.selector, runIdForBrowser);
        return { result: txt.slice(0, 5000), sideEffect: 'extracted text' };
      }
      case 'github_create_issue': {
        const r = await Ints.githubCreateIssue(args.owner, args.repo, args.title, args.body);
        return { result: r, sideEffect: `created GH issue #${r.number}` };
      }
      case 'github_list_repos': {
        const r = await Ints.githubListRepos();
        return { result: r, sideEffect: `listed ${r.length} repos` };
      }
      case 'github_create_pr': {
        const { gitCreatePr } = await import('./git-actions');
        const out = await gitCreatePr(workDir, String(args.title || ''), args.body ? String(args.body) : undefined);
        return { result: out, sideEffect: `opened GitHub PR: ${String(args.title || '').slice(0, 60)}` };
      }
      case 'slack_post': {
        const r = await Ints.slackPostMessage(args.channel, args.text);
        return { result: r, sideEffect: `posted to Slack ${args.channel}` };
      }
      case 'discord_post': {
        const r = await Ints.discordPostMessage(args.channel_id || '', args.text);
        return { result: r, sideEffect: `posted to Discord ${r.channel_id}` };
      }
      case 'x_post': {
        const r = await Ints.xPostTweet(args.text);
        return { result: r, sideEffect: r.url ? `posted to X: ${r.url}` : 'posted to X' };
      }
      case 'x_read_timeline': {
        const feed = args.feed === 'home' ? 'home' : 'mine';
        const tweets = await Ints.xReadTimeline(feed, args.count ? Number(args.count) : 5);
        return { result: tweets, sideEffect: `read ${tweets.length} tweets from X (${feed})` };
      }
      case 'drive_list': {
        const folders = (agent.driveFolders || []).map((f) => f.id).filter(Boolean);
        const r = await Ints.driveListFiles(args.query, 8, folders);
        return { result: r, sideEffect: folders.length ? `listed Drive files in ${folders.length} scoped folder(s)` : 'listed Drive files' };
      }
      case 'drive_upload': {
        const folders = (agent.driveFolders || []).map((f) => f.id).filter(Boolean);
        const r = await Ints.driveUploadText(args.name, args.content, folders);
        return { result: r, sideEffect: `uploaded ${args.name} to Drive${folders.length ? ' (scoped folder)' : ''}` };
      }
      case 'obsidian_list': {
        const creds = Ints.getIntegrationCreds();
        const r = await Ints.obsidianListNotes(creds, args.dir || '', 40);
        return { result: r, sideEffect: `listed ${r.length} Obsidian notes` };
      }
      case 'obsidian_read': {
        const creds = Ints.getIntegrationCreds();
        const r = await Ints.obsidianReadNote(creds, args.path);
        return { result: r.slice(0, 12000), sideEffect: `read Obsidian note ${args.path}` };
      }
      case 'obsidian_write': {
        const creds = Ints.getIntegrationCreds();
        await Ints.obsidianWriteNote(creds, args.path, args.content || '');
        return { result: { ok: true, path: args.path }, sideEffect: `wrote Obsidian note ${args.path}` };
      }
      case 'obsidian_search': {
        const creds = Ints.getIntegrationCreds();
        const r = await Ints.obsidianSearch(creds, args.query);
        return { result: r, sideEffect: `Obsidian search "${args.query}" → ${r.length} hits` };
      }
      case 'send_to_peer': {
        postToAgentInbox(args.agentId, agent.id, args.message);
        return { result: 'message queued to peer', sideEffect: `sent message to agent ${args.agentId}` };
      }
      case 'schedule_task': {
        const schedRes = await scheduleFromAgentTool(agent.id, String(args.when || ''), String(args.prompt || ''));
        return { result: schedRes, sideEffect: `scheduled task (${schedRes.type || 'unknown'})` };
      }
      case 'mcp_list_tools': {
        const servers = await listEnabledMcpServers();
        const key = String(args.server || '');
        const server = servers.find((s) => s.id === key || s.name.toLowerCase() === key.toLowerCase());
        if (!server) {
          return {
            result: { error: 'MCP server not found', available: servers.map((s) => ({ id: s.id, name: s.name })) },
            sideEffect: 'mcp_list_tools failed',
          };
        }
        const { connectMcpServer, disconnectMcpClient } = await import('./mcp-client');
        const client = await connectMcpServer(server, 25_000);
        try {
          const listed = await client.listTools();
          const tools = (listed.tools || []).map((t) => ({ name: t.name, description: t.description }));
          return { result: { server: server.name, tools }, sideEffect: `listed ${tools.length} MCP tools on ${server.name}` };
        } finally {
          await disconnectMcpClient(client);
        }
      }
      case 'mcp_invoke': {
        const servers = await listEnabledMcpServers();
        const key = String(args.server || '');
        const server = servers.find((s) => s.id === key || s.name.toLowerCase() === key.toLowerCase());
        if (!server) {
          return { result: { error: 'MCP server not found' }, sideEffect: 'mcp_invoke failed' };
        }
        const out = await invokeMcpTool(server, String(args.tool || ''), args.arguments || {});
        return {
          result: out.ok ? out.result : { error: out.error },
          sideEffect: `mcp_invoke ${args.tool} on ${server.name}`,
        };
      }
      case 'grok_cli': {
        const cli = await detectGrokCli();
        if (!cli.installed) {
          return { result: { error: 'Grok CLI is not installed on this machine' }, sideEffect: 'grok_cli unavailable' };
        }
        const out = await runGrokCliPrompt({
          prompt: String(args.prompt || ''),
          cwd: workDir,
          model: agent.model,
          maxTurns: args.max_turns ?? 12,
          effort: args.effort ? String(args.effort) : undefined,
          check: !!args.check,
          bestOfN: args.best_of_n ? Number(args.best_of_n) : undefined,
          jsonSchema: args.json_schema ? String(args.json_schema) : undefined,
        });
        return {
          result: {
            ok: out.ok,
            stdout: out.stdout.slice(0, 12000),
            stderr: out.stderr.slice(0, 2000),
            code: out.code,
            cliVersion: cli.version,
          },
          sideEffect: `grok_cli: ${String(args.prompt || '').slice(0, 80)}`,
        };
      }
      default:
        return { result: `unknown tool ${name}`, sideEffect: '' };
    }
  } catch (err: any) {
    return { result: { error: err.message }, sideEffect: `tool ${name} failed` };
  }
}