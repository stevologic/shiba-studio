import { NextRequest } from 'next/server';
import * as fs from 'fs';
import { setApiKey } from '@/lib/grok-client';
import { encodeSseEvent, grokChatStream } from '@/lib/grok-chat-stream';
import { parseModelRef } from '@/lib/model-providers';
import type { ChatMessagePayload } from '@/lib/chat-types';
import { loadConfig } from '@/lib/persistence';
import { buildGlobalUploadsChatContext } from '@/lib/workspace';
import { buildGlobalInstructionsContext } from '@/lib/global-instructions';
import { resolveCloudBearer } from '@/lib/xai-oauth';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const cfg = await loadConfig();
  const rawModel = (body.model && String(body.model).trim()) || cfg.defaultGrokModel || 'cloud:grok-4';
  const parsedModel = parseModelRef(rawModel);
  const model = parsedModel.encoded;
  // Honor the model's pinned credential source (OAuth-tagged vs Token-tagged).
  const auth = await resolveCloudBearer(cfg, parsedModel.authSource);
  if (auth.token) setApiKey(auth.token);
  if (body.key) setApiKey(body.key);

  const messages: ChatMessagePayload[] = [];
  const systemParts: string[] = [];
  if (body.system) systemParts.push(String(body.system));
  const globalInstructions = await buildGlobalInstructionsContext(cfg);
  if (globalInstructions) systemParts.push(globalInstructions);
  const globalUploadsContext = body.globalUploadsContext
    ? String(body.globalUploadsContext)
    : await buildGlobalUploadsChatContext();
  systemParts.push(globalUploadsContext);
  if (body.projectContext) systemParts.push(String(body.projectContext));

  // Chatting as an agent: inject live context from its enabled integrations
  // (e.g. the Obsidian vault index + contents) so the conversation carries the
  // same knowledge the agent gets during autonomous runs.
  let agentName: string | null = null;
  let chatAgent: import('@/lib/types').Agent | null = null;
  if (body.agentId) {
    try {
      const { loadAgents } = await import('@/lib/persistence');
      const agent = (await loadAgents()).find((a) => a.id === String(body.agentId));
      if (agent) {
        chatAgent = agent;
        agentName = agent.name;
        // Scope this chat's integration tools to the agent's own credential
        // overrides (its own token/account) before building context or running.
        const { setIntegrationCreds, mergeAgentIntegrationCreds } = await import('@/lib/integrations');
        setIntegrationCreds(mergeAgentIntegrationCreds(cfg.integrations || {}, agent.integrationOverrides));
        const { buildIntegrationContext } = await import('@/lib/integration-context');
        const integrationContext = await buildIntegrationContext(agent.integrations, agent.driveFolders);
        if (integrationContext) systemParts.push(integrationContext);
      }
    } catch {
      /* integration context is best-effort */
    }
  }
  // Chat workspace: a folder the user bound this chat to (usually a cloned
  // repo). Validated here; fs tools + the system prompt are rooted in it.
  let workspaceDir = '';
  if (body.workspaceDir) {
    const requested = String(body.workspaceDir).trim();
    try {
      if (requested && fs.statSync(requested).isDirectory()) workspaceDir = requested;
    } catch { /* stale/unreachable folder — chat continues without it */ }
  }
  // Local agents browse for real in chat: tell the model how that works so it
  // neither refuses nor invents results.
  if (chatAgent && chatAgent.origin !== 'cloud') {
    systemParts.push([
      '## Browser',
      'Your browser tools (browser_navigate, browser_click, browser_type, browser_extract, browser_screenshot) drive a real headless Chrome — no window appears on screen by design.',
      'A screenshot of the final page is automatically appended to your reply after you use them, and the user can watch or take over the same page at any time by typing /annotate.',
      'Never claim a page was opened without actually calling the tools.',
    ].join('\n'));
  }

  if (workspaceDir) {
    systemParts.push([
      '## Chat workspace (coding agent)',
      `This chat is bound to the folder \`${workspaceDir}\` on the user's machine.`,
      'You have live tools that run on that folder:',
      '- fs_list / fs_search — explore structure and find symbols',
      '- fs_read — read file contents (always read before editing)',
      '- fs_write — create or overwrite files with the full new content',
      '- shell_exec — run silent one-shot commands (git, npm, tests, builds) inside the workspace',
      '- terminal_exec — run commands in the shared Studio Terminal panel (user can watch; cwd/env persist)',
      '',
      '### Mandatory workflow for coding tasks',
      '1. Use tools to explore and read the relevant code first — do not guess paths or invent file contents.',
      '2. Make the requested edits with fs_write (and shell_exec / terminal_exec when install/test/build is needed).',
      '3. Verify with shell_exec or terminal_exec when practical (tests, typecheck, or a targeted command).',
      '4. ONLY after the work is done (or you hit a real blocker) write your final reply summarizing what changed.',
      '',
      '### Hard rules',
      '- Never claim you edited, created, or ran something without actually calling the tool.',
      '- Do not end with a plan or pseudo-code when the user asked you to implement — implement first, then summarize.',
      '- Paths for fs_* tools are relative to the workspace root unless absolute.',
      '- Prefer small, correct edits over large rewrites; match existing style.',
      '- When the user mentions the terminal, or wants to see shell output, use terminal_exec.',
    ].join('\n'));
  }

  // Always-on: Studio Terminal is available for local chat (same machine).
  systemParts.push([
    '## Studio Terminal',
    'You can drive the in-app Studio Terminal with the terminal_exec tool.',
    'Commands run in a real shared PTY the user can open anytime (Ctrl+` / Terminal button); they see live output.',
    'Prefer terminal_exec when the user asks to run something in the terminal, or for interactive multi-step shell work.',
    'Prefer shell_exec for silent workspace automation. Avoid full-screen interactive apps (vim, less, top) via tools.',
  ].join('\n'));

  // Always-on chat tools (web, etc.) — never promise to look something up without
  // calling tools and finishing with a complete answer in the same turn sequence.
  systemParts.push([
    '## Tools & complete answers',
    'You have live tools in this chat (at least web_search, web_fetch, and terminal_exec; more when an agent or workspace is bound).',
    'For current events, sports fixtures, news, docs, or anything time-sensitive: call web_search / web_fetch (or other tools) before answering.',
    'Never end with only a promise like "I\'ll check", "let me look that up", or "one moment" — the user only sees your final message after tools finish.',
    'Workflow: call tools as needed → then write a complete final answer with the facts. If tools fail, say what failed and answer with best effort.',
  ].join('\n'));

  if (systemParts.length) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    for (const m of body.messages) {
      if (!m?.role) continue;
      if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
      messages.push({
        role: m.role,
        content: String(m.content || ''),
        attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
        thinking: m.thinking ? String(m.thinking) : undefined,
      });
    }
  } else if (body.prompt) {
    messages.push({ role: 'user', content: String(body.prompt) });
  }

  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: 'No messages provided' }), { status: 400 });
  }

  const { audit } = await import('@/lib/audit-log');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  audit('chat', 'message sent', (lastUser?.content || '').slice(0, 120), {
    model, agent: agentName, agentId: body.agentId || null, turns: messages.length,
    workspace: workspaceDir || null,
  });

  // Tool loop for every chat (not only agent/workspace): web search etc. so the
  // model can actually look things up. Attachments fall back to the plain vision stream.
  // Works for OAuth, API token, and local OpenAI-compatible models.
  const hasAttachments = messages.some((m) => m.attachments?.length);
  const useAgentTools = !hasAttachments;
  // Extra turns for research/coding so we never stop mid-promise.
  const MAX_TOOL_TURNS = workspaceDir ? 18 : 12;
  /** How many times we re-ask after a promise-only / empty final. */
  const MAX_COMPLETION_NUDGES = 3;

  /** Detect "I'll check…" style answers that never deliver the facts. */
  function looksIncompleteReply(text: string): boolean {
    const t = text.trim();
    if (!t) return true;

    const promisesAction = /\b(i('ll| will)|let me|one moment|hang on|give me a (sec|second|moment)|checking|looking (that|it|this) up|searching|i('m| am) (going to |gonna )?(check|look|search|find|fetch|get back))\b/i.test(t)
      || /^(sure|okay|ok|right|alright)[,!.]?\s+.*(check|look|search|find)\b/i.test(t);

    // Real substance: lists, links, clock times, concrete match lines — not just
    // the word "today" inside a promise like "I'll check today's fixtures".
    const hasSubstance = /https?:\/\//i.test(t)
      || (t.match(/\n\s*[-*•]|\n\s*\d+\./g) || []).length >= 2
      || /\b\d{1,2}:\d{2}\b/.test(t)
      || (/\bvs\.?\b/i.test(t) && /\d/.test(t))
      || /\b(final score|kick-?off at|plays against|defeated|beat \w+|won \d)/i.test(t)
      || t.length > 450;

    if (promisesAction && !hasSubstance && t.length < 500) return true;

    // Ends on a bare promise clause
    if (/\b(i('ll| will) (check|look|search|find|fetch|get)\b[^.!?]{0,100})$/i.test(t)
      && !hasSubstance) {
      return true;
    }
    return false;
  }

  const stream = useAgentTools
    ? new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (event: Parameters<typeof encodeSseEvent>[0]) =>
            controller.enqueue(encoder.encode(encodeSseEvent(event)));
          try {
            const { grokChat } = await import('@/lib/grok-client');
            const { getToolDefinitions } = await import('@/lib/agent-runtime');
            const { executeAgentTool } = await import('@/lib/agent-tool-exec');
            const { resolveWorkspace } = await import('@/lib/workspace');
            const { normalizeAgent } = await import('@/lib/types');

            const agent = chatAgent;
            // Workspace tools run as this synthetic local "agent" so a cloud-origin
            // chat agent (or plain OAuth/token/local chat) can still touch the
            // user-granted workspace folder.
            const WORKSPACE_TOOL_NAMES = new Set([
              'fs_list', 'fs_read', 'fs_write', 'fs_search', 'shell_exec', 'terminal_exec',
            ]);
            const BROWSER_TOOL_NAMES = new Set([
              'browser_navigate', 'browser_click', 'browser_type',
              'browser_screenshot', 'browser_extract',
            ]);
            /** Always available for plain chat (no agent required). */
            const CHAT_CORE_TOOL_NAMES = new Set([
              'web_search', 'web_fetch', 'memory_save', 'memory_recall', 'generate_image',
              'terminal_exec',
            ]);
            const toolLabel = (name: string, args: Record<string, unknown>): string => {
              const short = (v: unknown, n = 80) =>
                String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
              switch (name) {
                case 'fs_list': return `Listing ${short(args.dir || '.', 60) || '.'}`;
                case 'fs_read': return `Reading ${short(args.path, 100)}`;
                case 'fs_write': return `Writing ${short(args.path, 100)}`;
                case 'fs_search': return `Searching for “${short(args.pattern, 60)}”`;
                case 'shell_exec': return `Running \`${short(args.command, 120)}\``;
                case 'terminal_exec': return `Terminal \`${short(args.command, 120)}\``;
                case 'web_search': return `Searching the web for “${short(args.query, 80)}”`;
                case 'web_fetch': return `Fetching ${short(args.url, 100)}`;
                case 'browser_navigate': return `Opening ${short(args.url, 100)}`;
                case 'browser_click': return `Clicking ${short(args.selector, 60)}`;
                case 'browser_type': return `Typing into ${short(args.selector, 60)}`;
                case 'browser_screenshot': return 'Taking screenshot';
                case 'browser_extract': return 'Extracting page text';
                default: return `${name}(${short(JSON.stringify(args), 100)})`;
              }
            };
            const resultPreview = (name: string, result: unknown): string => {
              try {
                if (name === 'fs_write') return `✓ ${typeof result === 'string' ? result : JSON.stringify(result)}`;
                if (name === 'shell_exec' && result && typeof result === 'object') {
                  const r = result as { code?: number; stdout?: string; stderr?: string };
                  const out = (r.stdout || r.stderr || '').trim().slice(0, 180);
                  return r.code === 0
                    ? `✓ exit 0${out ? ` — ${out}` : ''}`
                    : `✗ exit ${r.code}${out ? ` — ${out}` : ''}`;
                }
                if (name === 'terminal_exec' && result && typeof result === 'object') {
                  const r = result as { code?: number | null; output?: string; timedOut?: boolean; error?: string };
                  if (r.error) return `✗ ${String(r.error).slice(0, 160)}`;
                  const out = (r.output || '').trim().slice(0, 180);
                  if (r.timedOut) return `⏱ timeout${out ? ` — ${out}` : ''}`;
                  return r.code === 0 || r.code == null
                    ? `✓ terminal${out ? ` — ${out}` : ''}`
                    : `✗ exit ${r.code}${out ? ` — ${out}` : ''}`;
                }
                if (name === 'fs_read' && typeof result === 'string') {
                  return `✓ ${result.length} chars`;
                }
                if (name === 'web_search' && Array.isArray(result)) {
                  return `✓ ${result.length} result(s)`;
                }
                if (Array.isArray(result)) return `✓ ${result.length} item(s)`;
                return `→ ${JSON.stringify(result).slice(0, 200)}`;
              } catch {
                return '→ (done)';
              }
            };

            const workspaceAgent = normalizeAgent({ id: '__chat__', name: 'Grok Chat', origin: 'local' });
            // Base: agent tools if chatting as an agent; else empty.
            const tools = agent
              ? getToolDefinitions(agent.integrations, false, agent.origin === 'cloud' ? 'cloud' : 'local')
              : [];
            // Always merge chat-core research tools so plain Grok Chat can look things up.
            {
              const core = getToolDefinitions(workspaceAgent.integrations, false, 'local')
                .filter((t) => CHAT_CORE_TOOL_NAMES.has(t.function.name));
              const have = new Set(tools.map((t) => t.function.name));
              tools.push(...core.filter((t) => !have.has(t.function.name)));
            }
            if (workspaceDir) {
              const codingTools = getToolDefinitions(workspaceAgent.integrations, false, 'local')
                .filter((t) => WORKSPACE_TOOL_NAMES.has(t.function.name));
              const have = new Set(tools.map((t) => t.function.name));
              tools.push(...codingTools.filter((t) => !have.has(t.function.name)));
            }
            // Strip tools the user disabled in Capabilities → Tools.
            const { filterToolsByDisabled } = await import('@/lib/disabled-tools');
            {
              const enabled = filterToolsByDisabled(tools, cfg.disabledTools);
              tools.length = 0;
              tools.push(...enabled);
            }
            const workDir = workspaceDir
              || (agent ? resolveWorkspace(agent.workspace.path) : resolveWorkspace(''));
            // Browser tools drive the annotation sub-browser's page, so the
            // user can watch or take over with /annotate at any time.
            const { SUBBROWSER_RUN_ID, browserViewportShot } = await import('@/lib/browser');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msgs: any[] = messages.map((m) => ({ role: m.role, content: m.content }));
            const toolsUsed: string[] = [];
            let browserUsed = false;
            let wroteContent = false;
            let completionNudges = 0;

            if (workspaceDir) {
              send({
                type: 'thinking',
                delta: `Working in workspace \`${workspaceDir}\` — exploring and applying changes before the final answer…\n`,
              });
            } else if (agent) {
              send({
                type: 'thinking',
                delta: `Using agent tools for ${agentName || agent.name}…\n`,
              });
            } else {
              send({
                type: 'thinking',
                delta: 'Ready to use tools (web search, etc.) — will finish a complete answer before stopping…\n',
              });
            }

            for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
              // Near the limit: force a final answer so we don't hang mid-task.
              const lastTurn = turn === MAX_TOOL_TURNS - 1;
              const allowTools = !lastTurn && tools.length > 0;
              let resp;
              try {
                resp = await grokChat({
                  model,
                  messages: msgs,
                  tools: allowTools ? tools : undefined,
                  tool_choice: allowTools ? 'auto' : undefined,
                  temperature: body.temperature,
                  max_tokens: body.max_tokens ?? 4096,
                });
              } catch (toolErr: unknown) {
                // Local servers that reject tools: fall back to plain completion once.
                const errText = toolErr instanceof Error ? toolErr.message : String(toolErr);
                const toolsRejected = /tool|function.?call|unsupported|invalid.?param/i.test(errText)
                  && turn === 0
                  && tools.length > 0;
                if (!toolsRejected) throw toolErr;
                send({
                  type: 'thinking',
                  delta: `This model rejected tool calling (${errText.slice(0, 120)}). Falling back to text-only…\n`,
                });
                resp = await grokChat({
                  model,
                  messages: msgs,
                  temperature: body.temperature,
                  max_tokens: body.max_tokens ?? 4096,
                });
              }

              const msg = resp.choices?.[0]?.message;
              if (!msg) throw new Error('Empty model response');

              const toolCalls = msg.tool_calls || [];
              if (toolCalls.length === 0) {
                const text = (msg.content || '').trim();

                // Incomplete "I'll check…" without tools → nudge to actually finish.
                if (
                  !lastTurn
                  && completionNudges < MAX_COMPLETION_NUDGES
                  && looksIncompleteReply(text)
                ) {
                  completionNudges += 1;
                  send({
                    type: 'thinking',
                    delta: `Reply looked incomplete (“${text.slice(0, 80)}${text.length > 80 ? '…' : ''}”) — continuing until a full answer…\n`,
                  });
                  msgs.push({ role: 'assistant', content: msg.content ?? '' });
                  msgs.push({
                    role: 'user',
                    content:
                      'Continue and finish your answer completely. '
                      + 'If you still need facts, call web_search or web_fetch now. '
                      + 'Do not only promise to check — return the actual results, fixtures, or findings in your next final message. '
                      + (toolsUsed.length
                        ? `Tool results are already in the conversation (${[...new Set(toolsUsed)].join(', ')}); synthesize them into a clear answer.`
                        : 'Use tools first if needed, then answer.'),
                  });
                  continue;
                }

                // Final answer only — never emit mid-loop prose as the user reply.
                if (text) {
                  send({ type: 'content', delta: msg.content || '' });
                  wroteContent = true;
                } else if (toolsUsed.length && !wroteContent && completionNudges < MAX_COMPLETION_NUDGES) {
                  // Empty final after tools — force a synthesis turn.
                  completionNudges += 1;
                  send({
                    type: 'thinking',
                    delta: 'Model returned an empty final after tools — requesting a full answer…\n',
                  });
                  msgs.push({ role: 'assistant', content: '' });
                  msgs.push({
                    role: 'user',
                    content:
                      'You used tools but returned no user-facing answer. '
                      + 'Write a complete final answer now based on the tool results above. Do not call more tools unless essential.',
                  });
                  continue;
                } else if (toolsUsed.length && !wroteContent) {
                  send({
                    type: 'content',
                    delta: `I looked this up with ${[...new Set(toolsUsed)].join(', ')} but could not format a final summary. Please ask me to continue.`,
                  });
                  wroteContent = true;
                } else if (!wroteContent) {
                  send({
                    type: 'content',
                    delta: text || 'I could not complete that answer. Please try again.',
                  });
                  wroteContent = true;
                }
                // Show the page the agent ended on — proof over promises.
                if (browserUsed) {
                  const shot = await browserViewportShot(SUBBROWSER_RUN_ID).catch(() => null);
                  if (shot?.dataUrl) {
                    send({
                      type: 'content',
                      delta: `\n\n![Browser view — ${shot.title || shot.url}](${shot.dataUrl})\n*Live page: ${shot.url} — open \`/annotate\` to interact.*`,
                    });
                  }
                }
                if (resp.usage) send({ type: 'usage', usage: resp.usage as unknown as Record<string, unknown> });
                break;
              }

              // Intermediate reasoning from the model while tools are pending → thinking, not final content.
              if (msg.content?.trim()) {
                send({ type: 'thinking', delta: `${msg.content.trim()}\n` });
              }
              send({
                type: 'thinking',
                delta: `Step ${turn + 1}/${MAX_TOOL_TURNS}: ${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'}\n`,
              });

              // "" not null — local servers reject null content on tool-call turns.
              msgs.push({ role: 'assistant', content: msg.content ?? '', tool_calls: toolCalls });
              for (const tc of toolCalls) {
                const fn = tc.function;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let args: any = {};
                try { args = JSON.parse(fn.arguments || '{}'); } catch { args = { raw: fn.arguments }; }
                send({ type: 'thinking', delta: `⚙ ${toolLabel(fn.name, args)}\n` });
                const execAgent = !agent || WORKSPACE_TOOL_NAMES.has(fn.name) || CHAT_CORE_TOOL_NAMES.has(fn.name)
                  ? workspaceAgent
                  : agent;
                const out = await executeAgentTool(fn.name, args, execAgent, {}, workDir, SUBBROWSER_RUN_ID);
                toolsUsed.push(fn.name);
                if (BROWSER_TOOL_NAMES.has(fn.name)) browserUsed = true;
                send({ type: 'thinking', delta: `${resultPreview(fn.name, out.result)}\n` });
                msgs.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: fn.name,
                  content: JSON.stringify(out.result).slice(0, 8000),
                });
              }
            }

            if (!wroteContent) {
              // Last-resort synthesis: one more completion with tools off.
              try {
                send({ type: 'thinking', delta: 'Forcing a final answer before closing the stream…\n' });
                msgs.push({
                  role: 'user',
                  content:
                    'Stop using tools. Write your complete final answer to the user now based on everything so far. '
                    + 'If you lack data, say clearly what is unknown — do not promise to check later.',
                });
                const finalResp = await grokChat({
                  model,
                  messages: msgs,
                  temperature: body.temperature,
                  max_tokens: body.max_tokens ?? 4096,
                });
                const finalText = finalResp.choices?.[0]?.message?.content?.trim();
                if (finalText) {
                  send({ type: 'content', delta: finalText });
                  wroteContent = true;
                }
              } catch { /* fall through */ }
            }

            if (!wroteContent) {
              send({
                type: 'content',
                delta: toolsUsed.length
                  ? `I started looking this up (${[...new Set(toolsUsed)].join(', ')}) but ran out of steps before finishing. Ask me to continue and I’ll complete the answer.`
                  : 'I could not finish that answer in time. Please try again or rephrase.',
              });
            }

            if (toolsUsed.length) {
              audit('chat', 'agent chat used tools', toolsUsed.join(', '), {
                model, agent: agentName, agentId: agent?.id ?? null, tools: toolsUsed,
                workspace: workspaceDir || null,
              });
            }
            send({ type: 'done', model });
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Stream failed';
            controller.enqueue(encoder.encode(encodeSseEvent({ type: 'error', message: msg })));
          } finally {
            controller.close();
          }
        },
      })
    : new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of grokChatStream({
          model,
          messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          reasoningEffort: body.reasoningEffort,
          usageContext: { source: 'chat' },
        })) {
          controller.enqueue(encoder.encode(encodeSseEvent(event)));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Stream failed';
        controller.enqueue(encoder.encode(encodeSseEvent({ type: 'error', message: msg })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}