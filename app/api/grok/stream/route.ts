import { NextRequest } from 'next/server';
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
  const auth = await resolveCloudBearer(cfg);
  if (auth.token) setApiKey(auth.token);
  if (body.key) setApiKey(body.key);

  const rawModel = (body.model && String(body.model).trim()) || cfg.defaultGrokModel || 'cloud:grok-4';
  const model = parseModelRef(rawModel).encoded;

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
  if (body.agentId) {
    try {
      const { loadAgents } = await import('@/lib/persistence');
      const agent = (await loadAgents()).find((a) => a.id === String(body.agentId));
      if (agent) {
        agentName = agent.name;
        const { buildIntegrationContext } = await import('@/lib/integration-context');
        const integrationContext = await buildIntegrationContext(agent.integrations);
        if (integrationContext) systemParts.push(integrationContext);
      }
    } catch {
      /* integration context is best-effort */
    }
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
  });

  const stream = new ReadableStream({
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