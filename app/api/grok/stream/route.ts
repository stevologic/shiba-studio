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
        const { buildIntegrationContext } = await import('@/lib/integration-context');
        const integrationContext = await buildIntegrationContext(agent.integrations);
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
      '## Chat workspace',
      `This chat is bound to the folder \`${workspaceDir}\` on the user's machine.`,
      'Your filesystem tools (fs_list, fs_read, fs_write, fs_search) operate inside this folder — use paths relative to it.',
      'Explore with fs_list/fs_search and read files before answering questions about the code; write changes directly with fs_write when asked.',
    ].join('\n'));
  }

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

  // Chatting AS an agent: give the model the same toolbelt the agent has in
  // autonomous runs — LOCAL agents get their machine tools (files, shell,
  // browser) so "open a browser" actually browses instead of the model
  // pretending it did; cloud agents stay restricted to cloud capabilities.
  // A bound chat workspace additionally roots fs tools in that folder.
  // Attachments fall back to the plain vision stream.
  const hasAttachments = messages.some((m) => m.attachments?.length);
  const useAgentTools = (!!chatAgent || !!workspaceDir) && !hasAttachments && parseModelRef(model).provider !== 'local';

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
            // fs tools run as this synthetic local "agent" so a cloud-origin
            // chat agent can still touch the user-granted workspace folder.
            const WORKSPACE_TOOL_NAMES = new Set(['fs_list', 'fs_read', 'fs_write', 'fs_search']);
            const BROWSER_TOOL_NAMES = new Set(['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_extract']);
            const workspaceAgent = normalizeAgent({ id: '__chat__', name: 'Grok Chat', origin: 'local' });
            const tools = agent
              ? getToolDefinitions(agent.integrations, false, agent.origin === 'cloud' ? 'cloud' : 'local')
              : [];
            if (workspaceDir) {
              const fsTools = getToolDefinitions(workspaceAgent.integrations, false, 'local')
                .filter((t) => WORKSPACE_TOOL_NAMES.has(t.function.name));
              const have = new Set(tools.map((t) => t.function.name));
              tools.push(...fsTools.filter((t) => !have.has(t.function.name)));
            }
            const workDir = workspaceDir || resolveWorkspace(agent!.workspace.path);
            // Browser tools drive the annotation sub-browser's page, so the
            // user can watch or take over with /annotate at any time.
            const { SUBBROWSER_RUN_ID, browserViewportShot } = await import('@/lib/browser');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msgs: any[] = messages.map((m) => ({ role: m.role, content: m.content }));
            const toolsUsed: string[] = [];
            let browserUsed = false;

            for (let turn = 0; turn < 6; turn++) {
              const resp = await grokChat({
                model,
                messages: msgs,
                tools,
                tool_choice: 'auto',
                temperature: body.temperature,
                max_tokens: body.max_tokens,
              });
              const msg = resp.choices?.[0]?.message;
              if (!msg) throw new Error('Empty model response');

              const toolCalls = msg.tool_calls || [];
              if (toolCalls.length === 0) {
                send({ type: 'content', delta: msg.content || '' });
                // Show the page the agent ended on — proof over promises.
                if (browserUsed) {
                  const shot = await browserViewportShot(SUBBROWSER_RUN_ID).catch(() => null);
                  if (shot?.dataUrl) {
                    send({ type: 'content', delta: `\n\n![Browser view — ${shot.title || shot.url}](${shot.dataUrl})\n*Live page: ${shot.url} — open \`/annotate\` to interact.*` });
                  }
                }
                if (resp.usage) send({ type: 'usage', usage: resp.usage as unknown as Record<string, unknown> });
                break;
              }

              msgs.push({ role: 'assistant', content: msg.content ?? null, tool_calls: toolCalls });
              for (const tc of toolCalls) {
                const fn = tc.function;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let args: any = {};
                try { args = JSON.parse(fn.arguments || '{}'); } catch { args = { raw: fn.arguments }; }
                send({ type: 'thinking', delta: `⚙ ${fn.name}(${JSON.stringify(args).slice(0, 160)})\n` });
                const execAgent = !agent || (workspaceDir && WORKSPACE_TOOL_NAMES.has(fn.name)) ? workspaceAgent : agent;
                const out = await executeAgentTool(fn.name, args, execAgent, {}, workDir, SUBBROWSER_RUN_ID);
                toolsUsed.push(fn.name);
                if (BROWSER_TOOL_NAMES.has(fn.name)) browserUsed = true;
                send({ type: 'thinking', delta: `→ ${JSON.stringify(out.result).slice(0, 200)}\n` });
                msgs.push({ role: 'tool', tool_call_id: tc.id, name: fn.name, content: JSON.stringify(out.result).slice(0, 8000) });
              }
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