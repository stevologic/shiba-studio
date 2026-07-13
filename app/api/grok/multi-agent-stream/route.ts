import { NextRequest } from 'next/server';
import { encodeSseEvent, multiAgentChatStream } from '@/lib/multi-agent-chat';
import { parseModelRef } from '@/lib/model-providers';
import type { ChatMessagePayload } from '@/lib/chat-types';
import { loadAgents, loadConfig } from '@/lib/persistence';
import { buildGlobalUploadsChatContext } from '@/lib/workspace';
import { normalizeAgent } from '@/lib/types';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const cfg = await loadConfig();
  const rawModel = (body.model && String(body.model).trim()) || cfg.defaultGrokModel || 'cloud:grok-4';
  const model = parseModelRef(rawModel).encoded;

  const messages: ChatMessagePayload[] = [];
  const globalUploadsContext = body.globalUploadsContext
    ? String(body.globalUploadsContext)
    : await buildGlobalUploadsChatContext();
  messages.push({ role: 'system', content: globalUploadsContext });
  if (body.projectContext) {
    messages.push({ role: 'system', content: String(body.projectContext) });
  }
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    for (const m of body.messages) {
      if (!m?.role) continue;
      if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
      messages.push({
        role: m.role,
        content: String(m.content || ''),
        attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
      });
    }
  }

  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: 'No messages provided' }), { status: 400 });
  }

  const agents = (await loadAgents()).map(normalizeAgent);
  if (!agents.length) {
    return new Response(JSON.stringify({ error: 'No agents configured' }), { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of multiAgentChatStream({
          model,
          cloudKey: body.key || undefined,
          signal: req.signal,
          agents,
          messages,
          reasoningEffort: body.reasoningEffort,
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
