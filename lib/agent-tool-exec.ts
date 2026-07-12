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

export async function executeAgentTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool args arrive as model-produced JSON; each case coerces its own fields
  args: any,
  agent: Agent,
  run: Partial<AgentRun>,
  workDir: string,
  runIdForBrowser?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- results are tool-shaped JSON, serialized straight back to the model
): Promise<{ result: any; sideEffect?: string; screenshot?: string }> {
  // Global Capabilities → Tools toggle — never run a disabled tool even if the
  // model still tries (stale context, race after toggle, etc.).
  try {
    const { loadConfig } = await import('./persistence');
    const { isToolDisabled } = await import('./disabled-tools');
    const cfg = await loadConfig();
    if (isToolDisabled(name, cfg.disabledTools)) {
      return {
        result: {
          error: `Tool "${name}" is disabled in Capabilities → Tools. Re-enable it there to use it again.`,
          disabled: true,
        },
        sideEffect: `blocked disabled tool ${name}`,
      };
    }
  } catch { /* config load is best-effort; fall through to normal exec */ }
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
      case 'terminal_exec': {
        const { runTerminalCommand } = await import('./terminal-server');
        const timeoutMs = args.timeoutMs != null ? Number(args.timeoutMs) : undefined;
        const out = await runTerminalCommand(String(args.command || ''), { timeoutMs });
        return {
          result: {
            ok: out.ok,
            output: out.output.slice(0, 8000),
            code: out.code,
            timedOut: out.timedOut,
            shell: out.shell,
            pid: out.pid,
            error: out.error,
            note: 'Command ran in the shared Studio Terminal (visible in the Terminal panel).',
          },
          sideEffect: `terminal: ${String(args.command || '').slice(0, 120)}`,
        };
      }
      case 'fs_search': {
        const { fsSearch } = await import('./agent-power-tools');
        const hits = await fsSearch(workDir, String(args.pattern || ''), args.dir ? String(args.dir) : undefined);
        return { result: hits, sideEffect: `searched workspace for "${args.pattern}" → ${hits.length} hits` };
      }
      case 'sandbox_exec': {
        const { sandboxExec } = await import('./agent-sandbox');
        const out = await sandboxExec(
          agent.id,
          String(args.command || ''),
          args.timeoutSec != null ? Number(args.timeoutSec) : undefined,
        );
        return {
          result: {
            ok: out.ok,
            stdout: out.stdout.slice(0, 8000),
            stderr: out.stderr.slice(0, 2000),
            code: out.code,
            ...(out.timedOut ? { timedOut: true } : {}),
            ...(out.error ? { error: out.error } : {}),
          },
          sideEffect: `sandbox: ${String(args.command || '').slice(0, 120)}`,
        };
      }
      case 'sandbox_write_file': {
        const { sandboxWriteFile } = await import('./agent-sandbox');
        const out = await sandboxWriteFile(agent.id, String(args.path || ''), String(args.content ?? ''));
        return {
          result: out,
          sideEffect: out.ok ? `sandbox: wrote ${out.path} (${out.bytes} bytes)` : 'sandbox write failed',
        };
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
      case 'board_list_tasks': {
        const { listBoardTasks } = await import('./board');
        let tasks = await listBoardTasks();
        if (args.mine) tasks = tasks.filter((t) => t.assigneeAgentId === agent.id);
        if (args.status) tasks = tasks.filter((t) => t.status === String(args.status));
        // Compact listing — full card via board_get_task.
        const listing = tasks.map((t) => ({
          key: t.key, title: t.title, status: t.status, priority: t.priority,
          assigneeAgentId: t.assigneeAgentId, labels: t.labels,
        }));
        return { result: listing, sideEffect: `listed ${listing.length} board cards` };
      }
      case 'board_get_task': {
        const { getBoardTask } = await import('./board');
        const task = await getBoardTask(String(args.id || ''));
        return {
          result: task || { error: `No board card ${args.id}` },
          sideEffect: task ? `read board card ${task.key}` : `board card ${args.id} not found`,
        };
      }
      case 'board_update_task': {
        const { updateBoardTask } = await import('./board');
        const { isBoardStatus } = await import('./board-types');
        let status = args.status && isBoardStatus(String(args.status)) ? String(args.status) : undefined;
        // Done is the USER's validation gate — agent-completed work must land
        // in review (with View work / Validate / Refine), never skip past it.
        let coercedDone = false;
        if (status === 'done') {
          status = 'in_review';
          coercedDone = true;
        }

        // Resolve an assignee given as an agent name or id (so a PM agent can
        // just say "assign to Engineer"). 'unassign'/'none'/'' clears it.
        let assigneeAgentId: string | null | undefined;
        let assigneeLabel = '';
        if (args.assignee !== undefined) {
          const raw = String(args.assignee || '').trim();
          if (!raw || /^(unassign|none|nobody|clear)$/i.test(raw)) {
            assigneeAgentId = null;
            assigneeLabel = ' (unassigned)';
          } else {
            const { loadAgents } = await import('./persistence');
            const all = await loadAgents();
            const match = all.find((a) => a.id === raw)
              || all.find((a) => a.name.toLowerCase() === raw.toLowerCase())
              || all.find((a) => a.name.toLowerCase().includes(raw.toLowerCase()));
            if (!match) {
              return {
                result: { error: `No agent matches "${raw}". Call list_agents to see valid names/ids.` },
                sideEffect: `board assign failed: no agent "${raw}"`,
              };
            }
            assigneeAgentId = match.id;
            assigneeLabel = ` (→ ${match.name})`;
          }
        }

        // Priority accepts words or 0-4 (0 none, 1 urgent, 2 high, 3 medium, 4 low).
        let priority: number | undefined;
        if (args.priority !== undefined) {
          const p = String(args.priority).trim().toLowerCase();
          const byWord: Record<string, number> = { none: 0, urgent: 1, high: 2, medium: 3, med: 3, low: 4 };
          priority = p in byWord ? byWord[p] : (Number.isFinite(Number(p)) ? Number(p) : undefined);
        }

        // When an agent submits a card for review, link THIS run to the card
        // so "View work" appears consistently — even when the run wasn't
        // dispatched from the board (a scheduled agent that finds a card,
        // works it, and moves it to in_review on its own).
        const submittingForReview = status === 'in_review' || coercedDone;
        const linkRunId = submittingForReview && run.id ? String(run.id) : undefined;
        const task = await updateBoardTask(String(args.id || ''), {
          status: status as import('./board-types').BoardStatus | undefined,
          assigneeAgentId,
          priority,
          labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
          title: args.title !== undefined ? String(args.title) : undefined,
          description: args.description !== undefined ? String(args.description) : undefined,
          addRunId: linkRunId,
          actor: agent.name,
          note: args.note
            ? { kind: 'agent', text: String(args.note), agentName: agent.name }
            : (coercedDone
              ? { kind: 'system', text: `${agent.name} marked this complete — parked in review for validation` }
              : undefined),
        });
        return {
          result: {
            key: task.key,
            status: task.status,
            assigneeAgentId: task.assigneeAgentId,
            priority: task.priority,
            labels: task.labels,
            updated: true,
            ...(coercedDone ? { note: 'Cards move to done only after the user validates them — this one is now In Review.' } : {}),
          },
          sideEffect: `updated board card ${task.key}${status ? ` → ${status}` : ''}${assigneeLabel}${args.note ? ' (+note)' : ''}`,
        };
      }
      case 'list_agents': {
        const { loadAgents } = await import('./persistence');
        const { listBoardTasks } = await import('./board');
        const [all, tasks] = await Promise.all([loadAgents(), listBoardTasks().catch(() => [])]);
        // Count each agent's open (non-terminal) board load so a PM can balance.
        const openLoad = new Map<string, number>();
        for (const t of tasks) {
          if (t.assigneeAgentId && t.status !== 'done' && t.status !== 'cancelled') {
            openLoad.set(t.assigneeAgentId, (openLoad.get(t.assigneeAgentId) || 0) + 1);
          }
        }
        const roster = all.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.description || '',
          skills: a.skills || [],
          openBoardCards: openLoad.get(a.id) || 0,
          isYou: a.id === agent.id,
        }));
        return { result: roster, sideEffect: `listed ${roster.length} agents` };
      }
      case 'board_create_task': {
        const { createBoardTask } = await import('./board');
        const task = await createBoardTask({
          title: String(args.title || ''),
          description: args.description ? String(args.description) : '',
          status: String(args.status) === 'todo' ? 'todo' : 'backlog',
          labels: Array.isArray(args.labels) ? args.labels.map(String) : [],
          createdBy: agent.name,
        });
        return {
          result: { key: task.key, id: task.id, status: task.status },
          sideEffect: `filed board card ${task.key}: ${task.title.slice(0, 80)}`,
        };
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
      case 'vercel_list_projects': {
        const r = await Ints.vercelListProjects(args.limit ? Number(args.limit) : 20);
        return { result: r, sideEffect: `listed ${r.length} Vercel project(s)` };
      }
      case 'vercel_list_deployments': {
        const r = await Ints.vercelListDeployments(
          args.project ? String(args.project) : undefined,
          args.limit ? Number(args.limit) : 10,
        );
        return { result: r, sideEffect: `listed ${r.length} Vercel deployment(s)` };
      }
      case 'vercel_get_deployment': {
        const r = await Ints.vercelGetDeployment(String(args.id_or_url || ''));
        return {
          result: r,
          sideEffect: `Vercel deployment ${r.readyState || 'unknown'}${r.url ? `: ${r.url}` : ''}`,
        };
      }
      case 'vercel_deploy': {
        const r = await Ints.vercelDeploy({
          project: args.project ? String(args.project) : undefined,
          target: args.target ? String(args.target) : undefined,
          gitRef: args.git_ref ? String(args.git_ref) : undefined,
          deploymentId: args.deployment_id ? String(args.deployment_id) : undefined,
        });
        return {
          result: r,
          sideEffect: `Vercel deploy started${r.url ? `: ${r.url}` : ''}${r.readyState ? ` (${r.readyState})` : ''}`,
        };
      }
      case 'vercel_set_env': {
        const targetRaw = args.target ? String(args.target) : undefined;
        const target = targetRaw
          ? targetRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
          : undefined;
        const r = await Ints.vercelSetEnv({
          project: args.project ? String(args.project) : '',
          key: String(args.key || ''),
          value: String(args.value ?? ''),
          target,
          type: args.type as 'plain' | 'secret' | 'encrypted' | undefined,
        });
        return { result: r, sideEffect: `set Vercel env ${r.key}` };
      }
      case 'netlify_list_sites': {
        const r = await Ints.netlifyListSites(args.limit ? Number(args.limit) : 20);
        return { result: r, sideEffect: `listed ${r.length} Netlify site(s)` };
      }
      case 'netlify_list_deploys': {
        const r = await Ints.netlifyListDeploys(
          args.site ? String(args.site) : undefined,
          args.limit ? Number(args.limit) : 10,
        );
        return { result: r, sideEffect: `listed ${r.length} Netlify deploy(s)` };
      }
      case 'netlify_get_deploy': {
        const r = await Ints.netlifyGetDeploy(String(args.deploy_id || ''));
        return {
          result: r,
          sideEffect: `Netlify deploy ${r.state || 'unknown'}${r.url ? `: ${r.url}` : ''}`,
        };
      }
      case 'netlify_deploy': {
        const r = await Ints.netlifyDeploy({
          site: args.site ? String(args.site) : undefined,
          clearCache: args.clear_cache === true || args.clear_cache === 'true',
          title: args.title ? String(args.title) : undefined,
        });
        return {
          result: r,
          sideEffect: `Netlify deploy started${r.url ? `: ${r.url}` : ''}${r.state ? ` (${r.state})` : ''}`,
        };
      }
      case 'netlify_set_env': {
        const r = await Ints.netlifySetEnv({
          site: args.site ? String(args.site) : '',
          key: String(args.key || ''),
          value: String(args.value ?? ''),
          context: args.context ? String(args.context) : undefined,
        });
        return { result: r, sideEffect: `set Netlify env ${r.key}` };
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
  } catch (err) {
    return {
      result: { error: err instanceof Error ? err.message : String(err) },
      sideEffect: `tool ${name} failed`,
    };
  }
}