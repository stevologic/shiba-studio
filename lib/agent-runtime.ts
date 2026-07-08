// The heart of Shiba Studio: agent runtime with full Grok tool-calling loop.
// Every intelligence step uses Grok exclusively. Tools execute locally + integrations + browser + worktree.

import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentRun, GrokModel, TraceStep, IntegrationScope } from './types';
import type { AgentStreamEvent } from './agent-stream-types';
import { grokChat, GrokMessage, GrokTool } from './grok-client';
import { resolveWorkspace, ensureWorktree, getGlobalUploadsDir, GLOBAL_UPLOADS_SUBDIR } from './workspace';
import * as Browser from './browser';
import { persistAgentRun } from './agent-runs-store';
import { buildSkillsPrompt } from './skills-catalog';
import { drainInbox, postToAgentInbox } from './agent-inbox';
import { detectGrokCli } from './grok-cli';
import { listEnabledMcpServers } from './mcp';

export { postToAgentInbox, drainInbox } from './agent-inbox';

const MAX_STEPS = 18;

export function getToolDefinitions(
  scope: IntegrationScope,
  hasPeers: boolean,
  origin: 'local' | 'cloud' = 'local',
): GrokTool[] {
  // Cloud agents live in the Grok cloud: they get xAI-hosted capabilities and connected
  // cloud integrations, but no access to this machine (files, shell, browser).
  const localOnlyTools: GrokTool[] = origin === 'cloud' ? [] : [
    {
      type: 'function',
      function: {
        name: 'fs_list',
        description: 'List files and directories in the workspace.',
        parameters: { type: 'object', properties: { dir: { type: 'string', description: 'relative or absolute subdir' } }, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fs_read',
        description: 'Read a text file from workspace.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fs_write',
        description: 'Write or overwrite a file in the workspace. Use for creating/editing code or docs.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'shell_exec',
        description: 'Run a shell command in the agent workspace (node, npm, git, python etc). Keep commands safe and short.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description: 'Open a URL in the controlled Chrome browser.',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_click',
        description: 'Click an element using CSS selector in the browser.',
        parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_type',
        description: 'Type text into an input/textarea. Optionally press Enter.',
        parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['selector', 'text'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the current browser page. Returns image + path.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_extract',
        description: 'Extract visible text from page or specific selector.',
        parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fs_search',
        description: 'Search all workspace files for a text pattern (case-insensitive). Returns file, line number, and matching line.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Text to search for' },
            dir: { type: 'string', description: 'Optional subfolder to scope the search' },
          },
          required: ['pattern'],
        },
      },
    },
  ];

  const tools: GrokTool[] = [...localOnlyTools];

  if (scope.github) {
    tools.push({
      type: 'function',
      function: { name: 'github_create_issue', description: 'Create a GitHub issue.', parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
    });
    tools.push({
      type: 'function',
      function: { name: 'github_list_repos', description: 'List GitHub repositories the token can access.', parameters: { type: 'object', properties: {} } },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'github_create_pr',
        description: 'Push the current workspace branch and open a GitHub pull request against the default branch.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'PR title' },
            body: { type: 'string', description: 'PR description (markdown)' },
          },
          required: ['title'],
        },
      },
    });
  }
  if (scope.slack) {
    tools.push({
      type: 'function',
      function: { name: 'slack_post', description: 'Post a message to Slack channel.', parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } },
    });
  }
  if (scope.googledrive) {
    tools.push({
      type: 'function',
      function: { name: 'drive_list', description: 'List files in Google Drive (optionally filtered).', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
    });
    tools.push({
      type: 'function',
      function: { name: 'drive_upload', description: 'Upload a text file to Drive.', parameters: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] } },
    });
  }
  if (scope.discord) {
    tools.push({
      type: 'function',
      function: {
        name: 'discord_post',
        description: 'Post a message to a Discord channel (channel id snowflake).',
        parameters: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'Discord channel id' },
            text: { type: 'string', description: 'Message content' },
          },
          required: ['text'],
        },
      },
    });
  }
  if (scope.x) {
    tools.push({
      type: 'function',
      function: {
        name: 'x_post',
        description: 'Post a tweet to X (max 280 characters).',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Tweet text' },
          },
          required: ['text'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'x_read_timeline',
        description: "Read recent tweets from X via the API — the user's own posts (feed=mine) or their home timeline (feed=home). Use this instead of fetching x.com pages.",
        parameters: {
          type: 'object',
          properties: {
            feed: { type: 'string', enum: ['mine', 'home'], description: "Which feed: 'mine' = the user's own tweets (default), 'home' = their following timeline" },
            count: { type: 'number', description: 'How many tweets (5-25, default 5)' },
          },
        },
      },
    });
  }
  if (scope.obsidian) {
    tools.push({
      type: 'function',
      function: {
        name: 'obsidian_list',
        description: 'List markdown notes in the Obsidian vault (optional subfolder).',
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: 'Vault subfolder, e.g. Daily or Projects/foo' },
          },
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'obsidian_read',
        description: 'Read an Obsidian note by vault-relative path (e.g. Daily/2024-01-01.md).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Note path relative to vault root' },
          },
          required: ['path'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'obsidian_write',
        description: 'Create or overwrite an Obsidian markdown note.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Note path relative to vault root' },
            content: { type: 'string', description: 'Full markdown content' },
          },
          required: ['path', 'content'],
        },
      },
    });
    tools.push({
      type: 'function',
      function: {
        name: 'obsidian_search',
        description: 'Search Obsidian vault notes by keyword.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search terms' },
          },
          required: ['query'],
        },
      },
    });
  }
  if (hasPeers) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_to_peer',
        description: 'Send a message to another agent (peer) so it can act on it later or in its next run.',
        parameters: { type: 'object', properties: { agentId: { type: 'string' }, message: { type: 'string' } }, required: ['agentId', 'message'] },
      },
    });
  }
  // Always available
  tools.push({
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'Ask to schedule a follow-up task for this same agent (or self). The orchestrator will honor.',
      parameters: { type: 'object', properties: { when: { type: 'string', description: 'e.g. "in 30m" or cron' }, prompt: { type: 'string' } }, required: ['when', 'prompt'] },
    },
  });
  tools.push({
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return its readable text content (HTML is stripped). Use for reading docs, articles, APIs.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'http(s) URL to fetch' } }, required: ['url'] },
    },
  });
  tools.push({
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web (DuckDuckGo) and return top results with title, url, and snippet. Follow up with web_fetch to read a result.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search terms' } }, required: ['query'] },
    },
  });
  tools.push({
    type: 'function',
    function: {
      name: 'memory_save',
      description: 'Persist a fact/preference/insight under a short key. Survives across runs — future runs can recall it.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short stable key, e.g. "user-timezone"' },
          content: { type: 'string', description: 'The fact to remember' },
        },
        required: ['key', 'content'],
      },
    },
  });
  tools.push({
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Recall previously saved memories (optionally filtered by a keyword). Check this early in a run for relevant context.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional keyword filter' } } },
    },
  });
  tools.push({
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt with xAI (grok-2-image). Saves the file into the workspace and shows it in the run trace.',
      parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Image description' } }, required: ['prompt'] },
    },
  });
  return tools;
}

export function mcpToolDefinitions(): GrokTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'mcp_list_tools',
        description: 'List tools exposed by a configured MCP server (by server id or name).',
        parameters: {
          type: 'object',
          properties: { server: { type: 'string', description: 'MCP server id or display name' } },
          required: ['server'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mcp_invoke',
        description: 'Invoke a tool on a configured MCP server.',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'MCP server id or name' },
            tool: { type: 'string', description: 'Tool name from mcp_list_tools' },
            arguments: { type: 'object', description: 'Tool arguments object' },
          },
          required: ['server', 'tool'],
        },
      },
    },
  ];
}

export function grokCliToolDefinition(): GrokTool {
  return {
    type: 'function',
    function: {
      name: 'grok_cli',
      description:
        'Run a prompt through the local Grok Build CLI (grok) in headless mode. Use for coding agent tasks, repo exploration, or delegating work to Grok CLI when installed on this machine. It has its own tools including web search.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Instructions for Grok CLI' },
          max_turns: { type: 'number', description: 'Max agent turns (default 12)' },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Agentic effort level' },
          check: { type: 'boolean', description: 'Append a self-verification loop so the CLI double-checks its own work' },
          best_of_n: { type: 'number', description: 'Run the task N ways in parallel and keep the best result (2-4)' },
          json_schema: { type: 'string', description: 'JSON Schema string — constrains the CLI output to structured JSON matching it' },
        },
        required: ['prompt'],
      },
    },
  };
}

async function executeTool(
  name: string,
  args: any,
  agent: Agent,
  run: Partial<AgentRun>,
  workDir: string,
  runIdForBrowser?: string,
): Promise<{ result: any; sideEffect?: string; screenshot?: string }> {
  const { executeAgentTool } = await import('./agent-tool-exec');
  return executeAgentTool(name, args, agent, run, workDir, runIdForBrowser);
}

function buildSystem(
  agent: Agent,
  inbox: string[],
  globalUploadsPath: string,
  grokCliAvailable: boolean,
  grokCliVersion: string | undefined,
  mcpServers: Array<{ id: string; name: string; presetId?: string }>,
  globalInstructionsText?: string,
  projectContext?: string,
  skillCatalog?: import('./skills-catalog').SkillPreset[],
  integrationContext?: string,
): string {
  const peers = agent.peers.length ? `You can communicate with peer agents: ${agent.peers.join(', ')}.` : '';
  const integ = Object.entries(agent.integrations).filter(([,v])=>v).map(([k])=>k).join(', ') || 'none';
  const skills = buildSkillsPrompt(agent.skills || [], skillCatalog);
  const chatPersonality = agent.chatSkill?.trim()
    ? `Chat personality (Skill): ${agent.chatSkill.trim()}`
    : '';
  const isCloud = agent.origin === 'cloud';
  const homeLine = isCloud
    ? 'You are a CLOUD agent: you run against Grok cloud services only. You have NO access to the local machine — no file system, shell, browser, or local CLI tools. Work exclusively through your cloud integrations and reasoning.'
    : `Workspace: ${agent.workspace.path} ${agent.workspace.useWorktree ? '(using isolated git worktree)' : ''}
Global shared uploads (all agents): ${globalUploadsPath} — files dropped here are available to every agent. Use fs_list/fs_read with paths under "${GLOBAL_UPLOADS_SUBDIR}/" relative to workspace root, or the absolute path above.`;
  const actionLine = isCloud
    ? 'You use tools to act through cloud services: GitHub/Slack/Drive/Discord/X/Obsidian when enabled, peer messaging, and self-scheduling.'
    : 'You use tools to take real actions: edit files, run shell, control Chrome browser, GitHub/Slack/Drive when enabled.';
  return `You are a powerful autonomous Grok agent named "${agent.name}" running inside Shiba Studio (localhost agent studio).
${homeLine}
Available scoped integrations: ${integ}
${skills}
${chatPersonality}
${globalInstructionsText ? `\n${globalInstructionsText}\n` : ''}
${projectContext ? `\n${projectContext}\n` : ''}
${integrationContext ? `\n${integrationContext}\n` : ''}
${peers}
${actionLine}
${!isCloud && grokCliAvailable ? `Grok Build CLI is installed on this machine (${grokCliVersion || 'grok'}). Use grok_cli to delegate coding tasks to the local Grok CLI agent in headless mode.` : ''}
${!isCloud && mcpServers.length ? `Enabled MCP servers: ${mcpServers.map((s) => `${s.name} (id:${s.id})`).join(', ')}. Use mcp_list_tools then mcp_invoke to call their tools.` : ''}
Be concise, decisive and goal-oriented. Always use tools when you need to act on the world.
Inbox messages from peers: ${inbox.length ? inbox.join(' | ') : 'none'}
Finish by giving a short summary when task is complete.`;
}

type AgentRunOpts = {
  scheduled?: boolean;
  grokChatFn?: any;
  scheduleId?: string;
  scheduleInstructions?: string;
  /** Pre-built project context (instructions, workspace, uploads) */
  projectContext?: string;
  /** Override agent workspace path for project-scoped builds */
  workspacePathOverride?: string;
  projectId?: string;
};

type AgentRunEvent =
  | { kind: 'step'; step: TraceStep }
  | { kind: 'approval'; approvalId: string; toolName: string; args: Record<string, unknown> }
  | { kind: 'done'; run: AgentRun };

async function* agentRunGenerator(
  agent: Agent,
  prompt: string,
  opts: AgentRunOpts = {},
): AsyncGenerator<AgentRunEvent> {
  const runId = uuidv4();
  const startedAt = new Date().toISOString();
  const trace: TraceStep[] = [];
  const { audit } = await import('./audit-log');
  audit('run', opts.scheduled ? 'scheduled run started' : 'run started', `${agent.name}: ${prompt.slice(0, 120)}`, {
    runId, agent: agent.name, agentId: agent.id, model: agent.model, origin: agent.origin || 'local',
  });

  const emit = (step: TraceStep) => {
    trace.push(step);
    return { kind: 'step' as const, step };
  };

  const { parseModelRef } = await import('./model-providers');
  const { loadConfig } = await import('./persistence');
  const { resolveCloudBearer, ensureCloudAuth } = await import('./xai-oauth');
  const modelRef = parseModelRef(agent.model);
  const cfg = await loadConfig();
  const cloudAuth = await resolveCloudBearer(cfg, modelRef.authSource);
  const modelError = modelRef.provider === 'local'
    ? (!cfg.localGrokEnabled ? 'Local Grok is disabled. Enable it in Settings or switch this agent to a Cloud model.' : null)
    : (!cloudAuth.hasCloudAuth
      ? 'No cloud credentials configured. Add an xAI API key, sign in with X (OAuth) in Settings, or switch to a Local model.'
      : null);
  if (!modelError && modelRef.provider !== 'local') {
    // Pin the same credential the model selection chose, if any.
    const { setApiKey } = await import('./grok-client');
    if (cloudAuth.token) setApiKey(cloudAuth.token);
    else await ensureCloudAuth(cfg);
  }
  if (modelError) {
    yield emit({ id: uuidv4(), ts: startedAt, type: 'error', content: modelError });
    const r: AgentRun = {
      id: runId, agentId: agent.id, agentName: agent.name, prompt, model: agent.model,
      startedAt, status: 'error', trace, sideEffects: [],
    };
    await persistAgentRun(r);
    audit('run', 'run failed', `${agent.name}: ${modelError.slice(0, 120)}`, {
      runId, agent: agent.name, agentId: agent.id, model: agent.model,
    });
    yield { kind: 'done', run: r };
    return;
  }

  // Resolve workspace + optional worktree (project override skips agent worktree)
  const workspaceBase = opts.workspacePathOverride?.trim() || agent.workspace.path;
  let workDir = resolveWorkspace(workspaceBase);
  if (agent.origin === 'cloud') {
    yield emit({
      id: uuidv4(),
      ts: new Date().toISOString(),
      type: 'think',
      content: 'Cloud agent — running against Grok cloud services only (no local file, shell, or browser access).',
    });
  }
  if (!opts.workspacePathOverride && agent.workspace.useWorktree && agent.origin !== 'cloud') {
    try {
      const wt = await ensureWorktree(agent.workspace.path, agent.id);
      workDir = wt.worktreePath;
      yield emit({ id: uuidv4(), ts: new Date().toISOString(), type: 'think', content: `Using worktree at ${workDir}` });
    } catch (e: any) {
      yield emit({ id: uuidv4(), ts: new Date().toISOString(), type: 'error', content: `Worktree setup issue: ${e.message}. Using base workspace.` });
    }
  }

  const inbox = drainInbox(agent.id);
  if (inbox.length) {
    yield emit({ id: uuidv4(), ts: new Date().toISOString(), type: 'peer_msg', content: `Inbox: ${inbox.join(' ')}` });
  }
  if (opts.scheduled && opts.scheduleInstructions) {
    yield emit({ id: uuidv4(), ts: new Date().toISOString(), type: 'schedule', content: `Using schedule-specific instructions: ${opts.scheduleInstructions.slice(0,100)}` });
  }
  if (opts.projectContext) {
    yield emit({
      id: uuidv4(),
      ts: new Date().toISOString(),
      type: 'think',
      content: `Project scope active${opts.projectId ? ` (${opts.projectId})` : ''} — workspace: ${workDir}`,
    });
  }

  const origin = agent.origin === 'cloud' ? 'cloud' : 'local';
  const tools = getToolDefinitions(agent.integrations, agent.peers.length > 0, origin);
  const cliStatus = await detectGrokCli();
  if (cliStatus.installed && origin === 'local') tools.push(grokCliToolDefinition());
  const mcpServers = origin === 'local' ? await listEnabledMcpServers() : [];
  if (mcpServers.length) tools.push(...mcpToolDefinitions());
  const globalUploadsPath = await getGlobalUploadsDir();
  const { buildGlobalInstructionsContext } = await import('./global-instructions');
  const globalInstructionsText = await buildGlobalInstructionsContext(cfg);

  // Use schedule-specific instructions as the prompt when originating from a schedule entry (AC3)
  const effectivePrompt = (opts.scheduleInstructions && opts.scheduled) ? opts.scheduleInstructions : prompt;
  const messages: GrokMessage[] = [
    {
      role: 'system',
      content: buildSystem(
        agent,
        inbox,
        globalUploadsPath,
        cliStatus.installed,
        cliStatus.version,
        mcpServers.map((s) => ({ id: s.id, name: s.name, presetId: s.presetId })),
        globalInstructionsText,
        opts.projectContext,
        await (await import('./custom-skills')).getAllSkillPresets(),
        await (await import('./integration-context'))
          .buildIntegrationContext(agent.integrations)
          .catch(() => ''),
      ),
    },
    { role: 'user', content: effectivePrompt },
  ];

  let finalOutput = '';
  let steps = 0;
  const sideEffects: string[] = [];

  try {
    while (steps < MAX_STEPS) {
      steps++;
      const chatFn = opts.grokChatFn || grokChat;
      const resp = await chatFn({
        model: agent.model,
        messages,
        tools,
        tool_choice: 'auto',
        usageContext: { source: 'agent', sourceId: runId },
      });
      const choice = resp.choices?.[0];
      const msg = choice?.message;
      if (!msg) break;

      if (msg.content) {
        yield emit({ id: uuidv4(), ts: new Date().toISOString(), type: 'think', content: msg.content });
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          finalOutput = msg.content;
          yield emit({ id: uuidv4(), ts: new Date().toISOString(), type: 'final', content: msg.content });
          break;
        }
        messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls as any });
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: msg.tool_calls as any });
      }

      // Execute tool calls
      for (const tc of (msg.tool_calls || [])) {
        const fn = tc.function;
        let args: any = {};
        try { args = JSON.parse(fn.arguments || '{}'); } catch { args = { raw: fn.arguments }; }

        yield emit({
          id: uuidv4(),
          ts: new Date().toISOString(),
          type: 'tool',
          content: `${fn.name}(${JSON.stringify(args).slice(0,180)})`,
          tool: { name: fn.name, args },
        });

        const { toolNeedsApproval, beginToolApproval } = await import('./tool-approval');
        if (toolNeedsApproval(fn.name, cfg.toolApprovalMode)) {
          const { approvalId, wait } = beginToolApproval(runId, fn.name, args);
          yield emit({
            id: uuidv4(),
            ts: new Date().toISOString(),
            type: 'approval',
            content: `Awaiting approval for ${fn.name}`,
            tool: { name: fn.name, args },
          });
          yield { kind: 'approval', approvalId, toolName: fn.name, args };
          const approved = await wait;
          if (!approved) {
            const denied = { denied: true, reason: 'User denied or approval timed out' };
            messages.push({
              role: 'tool' as const,
              tool_call_id: tc.id,
              name: fn.name,
              content: JSON.stringify(denied),
            } as any);
            yield emit({
              id: uuidv4(),
              ts: new Date().toISOString(),
              type: 'result',
              content: 'Tool execution denied',
              tool: { name: fn.name, args, result: denied },
            });
            continue;
          }
        }

        const execRes = await executeTool(fn.name, args, agent, { id: runId }, workDir, runId);

        if (execRes.sideEffect) sideEffects.push(execRes.sideEffect);
        const toolResultMsg = {
          role: 'tool' as const,
          tool_call_id: tc.id,
          name: fn.name,
          content: JSON.stringify(execRes.result).slice(0, 8000),
        };
        messages.push(toolResultMsg as any);

        yield emit({
          id: uuidv4(),
          ts: new Date().toISOString(),
          type: 'result',
          content: JSON.stringify(execRes.result).slice(0, 300),
          tool: { name: fn.name, args, result: execRes.result },
          screenshot: execRes.screenshot,
        });
      }
    }

    if (!finalOutput) finalOutput = 'Agent completed (see trace for details).';
  } catch (e: any) {
    yield emit({ id: uuidv4(), ts: new Date().toISOString(), type: 'error', content: e.message || String(e) });
  } finally {
    await Browser.closeRunPage(runId).catch(() => {});
  }

  const run: AgentRun = {
    id: runId,
    agentId: agent.id,
    agentName: agent.name,
    prompt: effectivePrompt,
    model: agent.model,
    startedAt,
    completedAt: new Date().toISOString(),
    status: trace.some(t => t.type === 'error') ? 'error' : 'completed',
    trace,
    finalOutput,
    workspaceSnapshot: workDir,
    sideEffects,
    ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
    ...(opts.scheduleInstructions ? { scheduleInstructions: opts.scheduleInstructions } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  } as any;

  await persistAgentRun(run);
  audit('run', `run ${run.status}`, `${agent.name}: ${(run.finalOutput || prompt).slice(0, 120)}`, {
    runId, agent: agent.name, agentId: agent.id, model: agent.model,
    steps: trace.length, sideEffects: run.sideEffects?.length || 0,
  });
  yield { kind: 'done', run };
}

export async function runAgentOnce(
  agent: Agent,
  prompt: string,
  opts: AgentRunOpts = {},
): Promise<AgentRun> {
  let finalRun: AgentRun | undefined;
  for await (const event of agentRunGenerator(agent, prompt, opts)) {
    if (event.kind === 'done') finalRun = event.run;
  }
  if (!finalRun) throw new Error('Agent run did not complete');
  return finalRun;
}

export async function* runAgentStream(
  agent: Agent,
  prompt: string,
  opts: AgentRunOpts = {},
): AsyncGenerator<AgentStreamEvent> {
  try {
    for await (const event of agentRunGenerator(agent, prompt, opts)) {
      if (event.kind === 'step') yield { type: 'trace', step: event.step };
      else if (event.kind === 'approval') {
        yield { type: 'approval_required', approvalId: event.approvalId, toolName: event.toolName, args: event.args };
      } else yield { type: 'run', run: event.run };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Agent stream failed';
    yield { type: 'error', message: msg };
  }
}

export { loadRuns } from './agent-runs-store';
