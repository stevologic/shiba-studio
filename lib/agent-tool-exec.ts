import path from 'path';
import type { Agent, AgentRun, IntegrationCreds } from './types';
import { projectRoot } from './data-paths';
import { listFiles, readFile, writeFile, shellExec } from './workspace';

/** Resolve a workspace-relative path with a project-root anchor for Next file tracing. */
function agentPath(workDir: string, rel: string): string {
  const normalized = String(rel || '.');
  if (path.isAbsolute(normalized)) return path.resolve(normalized);
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
import { scheduleFromAgentTool } from './routines';
import { detectGrokCli, runGrokCliPrompt } from './grok-cli';
import { listEnabledMcpServers } from './mcp';
import { invokeMcpTool } from './mcp-client';
import { assertTaskShellCommand, resolveTaskPath, taskToolDecision } from './task-workspace-policy';

export interface AgentToolAuthorization {
  /** Set only after this exact task shell command receives a live approval. */
  liveTaskShellApproval?: boolean;
  /** Issued only by the agent-run approval/autonomous dispatch path. */
  redditSubmitAuthorized?: boolean;
  /**
   * Server-owned durable-context boundary. Model tool arguments must never
   * choose a chat, project, or run to search.
   */
  contextScope?:
    | { kind: 'session'; sessionId: string; projectId?: string | null }
    | { kind: 'project'; projectId: string }
    | { kind: 'run'; runId: string }
    | { kind: 'global' };
}

type TrustedContextScope = NonNullable<AgentToolAuthorization['contextScope']>;

async function trustedContextScope(
  run: Partial<AgentRun>,
  authorization?: AgentToolAuthorization,
): Promise<TrustedContextScope> {
  if (authorization?.contextScope) return authorization.contextScope;

  // Autonomous/background workers carry a durable task id. Resolve their
  // ownership from the ledger instead of trusting model-produced tool args.
  if (run.taskId) {
    const { getTask } = await import('./task-ledger');
    const task = getTask(run.taskId);
    if (task?.sessionId) {
      return { kind: 'session', sessionId: task.sessionId, projectId: task.projectId || null };
    }
    if (task?.projectId) return { kind: 'project', projectId: task.projectId };
  }
  if (run.projectId) return { kind: 'project', projectId: run.projectId };

  // Standalone agents historically searched shared durable context. Keep that
  // behavior, but ignore all model-supplied scope selectors below.
  return { kind: 'global' };
}

function contextSourceIsAuthorized(
  source: { scopeType: string; scopeId: string; projectId?: string; runId?: string },
  scope: TrustedContextScope,
): boolean {
  if (scope.kind === 'global') return true;
  if (scope.kind === 'session') {
    return source.scopeType === 'session' && source.scopeId === scope.sessionId;
  }
  if (scope.kind === 'project') return source.projectId === scope.projectId;
  return source.runId === scope.runId
    || (source.scopeType === 'run' && source.scopeId === scope.runId);
}

export function executeAgentTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model-produced tool JSON; scoped worker validates each case
  args: any,
  agent: Agent,
  run: Partial<AgentRun>,
  workDir: string,
  runIdForBrowser?: string,
  integrationCreds?: IntegrationCreds,
  signal?: AbortSignal,
  authorization?: AgentToolAuthorization,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are heterogeneous and serialized to the model
): Promise<{ result: any; sideEffect?: string; screenshot?: string }> {
  return Ints.withIntegrationCreds(integrationCreds, () =>
    executeAgentToolScoped(name, args, agent, run, workDir, runIdForBrowser, signal, authorization),
  );
}

async function writeTaskOwnedFile(input: {
  taskId?: string;
  target: string;
  content: string;
  requestedPath: string;
  runId?: string;
  workspaceRootId?: string;
  relativePath?: string;
}): Promise<void> {
  if (!input.taskId) {
    await writeFile(input.target, input.content);
    return;
  }
  if (!input.workspaceRootId || input.relativePath == null) throw new Error('Task write path was not authorized');
  const relativePath = input.relativePath;
  if (!relativePath || relativePath.startsWith('..')) throw new Error('Write target must be a file inside the workspace root');
  const { withTaskCheckpoint } = await import('./task-checkpoints');
  await withTaskCheckpoint({
    taskId: input.taskId,
    reason: `Before fs_write ${relativePath}`,
    files: [{ workspaceRootId: input.workspaceRootId, path: relativePath }],
    context: { runId: input.runId, tool: 'fs_write', requestedPath: input.requestedPath },
  }, async () => writeFile(input.target, input.content));
}

async function executeAgentToolScoped(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool args arrive as model-produced JSON; each case coerces its own fields
  args: any,
  agent: Agent,
  run: Partial<AgentRun>,
  workDir: string,
  runIdForBrowser?: string,
  signal?: AbortSignal,
  authorization?: AgentToolAuthorization,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- results are tool-shaped JSON, serialized straight back to the model
): Promise<{ result: any; sideEffect?: string; screenshot?: string }> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Tool execution aborted');
  const policy = taskToolDecision(run.taskId, name, args && typeof args === 'object' ? args : {});
  if (!policy.allowed) {
    return { result: { error: policy.reason, denied: true }, sideEffect: `blocked task tool ${name}` };
  }
  if (policy.requiresLiveApproval && !authorization?.liveTaskShellApproval) {
    return {
      result: { error: 'Task shell execution requires an exact live approval.', denied: true },
      sideEffect: `blocked unapproved task shell ${name}`,
    };
  }
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
        const target = run.taskId
          ? (await resolveTaskPath({ taskId: run.taskId, requestedPath: String(dir), workDir, access: 'read', requireDirectory: true })).absolute
          : agentPath(workDir, dir);
        const entries = await listFiles(target, 1);
        return { result: entries.slice(0, 40), sideEffect: `listed ${entries.length} files in ${dir}` };
      }
      case 'fs_read': {
        const target = run.taskId
          ? (await resolveTaskPath({ taskId: run.taskId, requestedPath: String(args.path || ''), workDir, access: 'read' })).absolute
          : agentPath(workDir, args.path);
        const content = await readFile(target);
        return { result: content.slice(0, 12000), sideEffect: `read ${args.path}` };
      }
      case 'fs_write': {
        const owned = run.taskId
          ? await resolveTaskPath({ taskId: run.taskId, requestedPath: String(args.path || ''), workDir, access: 'write' })
          : undefined;
        const target = owned?.absolute || agentPath(workDir, args.path);
        await writeTaskOwnedFile({
          taskId: run.taskId,
          target,
          content: args.content || '',
          requestedPath: String(args.path || ''),
          runId: run.id,
          workspaceRootId: owned?.root.id,
          relativePath: owned?.relativePath,
        });
        return { result: `wrote ${args.path} (${(args.content || '').length} chars)`, sideEffect: `wrote file ${args.path}` };
      }
      case 'shell_exec': {
        const command = run.taskId ? assertTaskShellCommand(args.command) : String(args.command || '');
        const owned = run.taskId
          ? await resolveTaskPath({ taskId: run.taskId, requestedPath: '.', workDir, access: 'write', requireDirectory: true })
          : undefined;
        let out: Awaited<ReturnType<typeof shellExec>>;
        if (run.taskId && owned) {
          const { withTaskWorkspaceCheckpoint } = await import('./task-checkpoints');
          const guarded = await withTaskWorkspaceCheckpoint({
            taskId: run.taskId,
            workspaceRootIds: [owned.root.id],
            reason: `Before approved shell command: ${command.slice(0, 300)}`,
            context: { runId: run.id, tool: 'shell_exec', command: command.slice(0, 2_000) },
          }, () => shellExec(command, owned.absolute, 45_000, signal));
          out = guarded.value;
          const changed = guarded.checkpoint.files.filter((file) =>
            file.beforeExists !== file.afterExists || file.beforeHash !== file.afterHash);
          if (changed.length) {
            const { recordTaskEvidence } = await import('./task-ledger');
            recordTaskEvidence({
              taskId: run.taskId,
              kind: 'diff',
              status: 'informational',
              label: 'Approved shell workspace changes',
              summary: `${changed.length} task-owned path(s) changed behind checkpoint ${guarded.checkpoint.id}.`,
              scope: owned.root.id,
              metadata: { checkpointId: guarded.checkpoint.id, paths: changed.slice(0, 200).map((file) => file.relativePath), runId: run.id },
            });
          }
        } else {
          out = await shellExec(command, workDir, 45_000, signal);
        }
        return { result: { stdout: out.stdout.slice(0, 4000), stderr: out.stderr.slice(0, 1200), code: out.code }, sideEffect: `shell: ${args.command}` };
      }
      case 'terminal_exec': {
        const { runTerminalCommand } = await import('./terminal-server');
        const timeoutMs = args.timeoutMs != null ? Number(args.timeoutMs) : undefined;
        const out = await runTerminalCommand(String(args.command || ''), { timeoutMs, signal });
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
        const searchRoot = run.taskId
          ? (await resolveTaskPath({ taskId: run.taskId, requestedPath: args.dir ? String(args.dir) : '.', workDir, access: 'read', requireDirectory: true })).absolute
          : workDir;
        const hits = await fsSearch(searchRoot, String(args.pattern || ''));
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
      case 'meeting_search': {
        const { searchMeetingTranscripts } = await import('./meetings');
        const query = String(args.query || '').trim();
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
        const results = searchMeetingTranscripts(query, limit);
        return {
          result: results,
          sideEffect: `searched voice transcripts for "${query.slice(0, 80)}" (${results.length} results)`,
        };
      }
      case 'session_search': {
        const { getContextSource, searchContext } = await import('./context-engine');
        const scope = await trustedContextScope(run, authorization);
        const citedSourceId = args.source_id ? String(args.source_id) : '';
        if (citedSourceId) {
          let result: ReturnType<typeof getContextSource>;
          try {
            result = getContextSource(citedSourceId);
          } catch {
            // Use the same response for absent and out-of-scope citations so a
            // caller cannot probe another chat's source ids.
            throw new Error('Context source is not available in this execution scope');
          }
          if (!contextSourceIsAuthorized(result.source, scope)) {
            throw new Error('Context source is not available in this execution scope');
          }
          return {
            result,
            sideEffect: `retrieved durable context source ${citedSourceId.slice(0, 120)}`,
          };
        }
        const result = searchContext({
          query: String(args.query || ''),
          ...(scope.kind === 'session'
            ? { scopeType: 'session' as const, scopeId: scope.sessionId }
            : scope.kind === 'project'
              ? { projectId: scope.projectId }
              : scope.kind === 'run'
                ? { runId: scope.runId }
                : {}),
          maxResults: args.limit == null ? undefined : Number(args.limit),
        });
        return {
          result,
          sideEffect: `searched durable context for "${String(args.query || '').slice(0, 80)}" (${result.matches.length} results)`,
        };
      }
      case 'memory_forget': {
        const { deleteMemoryByKey } = await import('./agent-memory');
        const key = String(args.key || '').trim();
        const removed = deleteMemoryByKey(agent.id, key);
        return {
          result: { removed, key },
          sideEffect: removed ? `forgot "${key}"` : `memory "${key}" was not found`,
        };
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
      case 'reddit_read_posts': {
        const result = await Ints.redditReadPosts({
          subreddit: args.subreddit ? String(args.subreddit) : undefined,
          sort: args.sort,
          time: args.time,
          limit: args.limit == null ? undefined : Number(args.limit),
          after: args.after ? String(args.after) : undefined,
        });
        return {
          result,
          sideEffect: `read ${result.posts.length} Reddit posts${args.subreddit ? ` from r/${String(args.subreddit).replace(/^r\//i, '')}` : ' from the installed Devvit community'}`,
        };
      }
      case 'reddit_submit': {
        if (!authorization?.redditSubmitAuthorized) {
          return {
            result: { error: 'Reddit posting requires an approved or explicitly dispatched agent run.', denied: true },
            sideEffect: 'blocked unapproved Reddit post',
          };
        }
        const result = await Ints.redditSubmit({
          subreddit: String(args.subreddit || ''),
          title: String(args.title || ''),
          kind: args.kind === 'link' ? 'link' : 'self',
          text: args.text == null ? undefined : String(args.text),
          url: args.url == null ? undefined : String(args.url),
          nsfw: !!args.nsfw,
          spoiler: !!args.spoiler,
          sendReplies: args.send_replies == null ? undefined : !!args.send_replies,
        });
        return { result, sideEffect: `posted to Reddit r/${result.subreddit}: ${result.url}` };
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
      case 'delegate_task_team': {
        if (!run.taskId) return { result: { error: 'This run has no durable parent task' }, sideEffect: 'team delegation unavailable' };
        const { createTaskTeam, dispatchReadyTeamWorkers } = await import('./task-teams');
        const graph = await createTaskTeam(run.taskId, Array.isArray(args.workers) ? args.workers : []);
        const started = await dispatchReadyTeamWorkers(run.taskId);
        return {
          result: {
            workers: graph.map((node) => ({ id: node.task.id, key: node.key, status: node.task.status, dependencies: node.dependencies })),
            started,
          },
          sideEffect: `delegated ${graph.length} specialist worker${graph.length === 1 ? '' : 's'}`,
        };
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
        const client = await connectMcpServer(server, 25_000, signal);
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
        const out = await invokeMcpTool(server, String(args.tool || ''), args.arguments || {}, signal);
        return {
          result: out.ok ? out.result : { error: out.error },
          sideEffect: `mcp_invoke ${args.tool} on ${server.name}`,
        };
      }
      case 'native_node_action': {
        const { enqueueNativeNodeJob, validateNativeEscalation, waitForNativeNodeJob } = await import('./native-nodes');
        validateNativeEscalation(args.escalation_evidence);
        const job = enqueueNativeNodeJob({
          nodeId: String(args.node_id || ''),
          action: String(args.action || '') as import('./native-nodes').NativeNodeAction,
          args: args.action_args && typeof args.action_args === 'object' ? args.action_args : {},
          targetAppId: args.target_app_id ? String(args.target_app_id) : undefined,
          targetAppRevision: args.target_app_revision ? String(args.target_app_revision) : undefined,
          grantId: args.grant_id ? String(args.grant_id) : undefined,
          expectedGrantRevision: args.expected_grant_revision == null ? undefined : Number(args.expected_grant_revision),
        });
        const completed = await waitForNativeNodeJob(job.id, 60_000);
        const screenshot = typeof completed.result?.screenshotPath === 'string' ? completed.result.screenshotPath : undefined;
        return {
          result: {
            jobId: completed.id,
            status: completed.status,
            actionDigest: completed.actionDigest,
            result: completed.result,
            error: completed.error,
            securityScan: completed.securityScan,
          },
          sideEffect: `native ${completed.action} ${completed.status}`,
          ...(screenshot ? { screenshot } : {}),
        };
      }
      case 'grok_cli': {
        const cli = await detectGrokCli();
        if (!cli.ready) {
          const error = !cli.installed
            ? `Grok CLI is not installed on this machine${cli.error ? `: ${cli.error}` : ''}`
            : cli.authenticated === false
              ? `Grok CLI is installed but not authenticated${cli.authMode ? ` (${cli.authMode})` : ''}${cli.error ? `: ${cli.error}` : ''}`
              : `Grok CLI is installed but not ready${cli.versionNumber ? ` (${cli.versionNumber})` : ''}${cli.error ? `: ${cli.error}` : ''}`;
          return {
            result: {
              error,
              installed: cli.installed,
              ready: cli.ready,
              authenticated: cli.authenticated,
              authMode: cli.authMode,
            },
            sideEffect: 'grok_cli unavailable',
          };
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
          // Invoking the grok_cli tool is the parent agent's explicit
          // authorization for an unattended coding delegation.
          permissionMode: 'bypassPermissions',
          signal,
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
