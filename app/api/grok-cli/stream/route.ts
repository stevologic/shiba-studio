import { NextRequest } from 'next/server';
import { projectRoot } from '@/lib/data-paths';
import { encodeSseEvent } from '@/lib/sse-events';
import type { ChatMessagePayload } from '@/lib/chat-types';

import { buildCliPromptFromMessages, streamGrokCli } from '@/lib/grok-cli';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const messages: ChatMessagePayload[] = Array.isArray(body.messages) ? body.messages : [];

  const systemParts: string[] = [];
  if (body.system) systemParts.push(String(body.system));
  const globalUploadsContext = body.globalUploadsContext
    ? String(body.globalUploadsContext)
    : await (await import('@/lib/workspace')).buildGlobalUploadsChatContext();
  systemParts.push(globalUploadsContext);
  if (body.projectContext) systemParts.push(String(body.projectContext));

  const chatMessages = messages
    .filter((m) => m?.role && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: String(m.content || ''),
    }));

  if (!chatMessages.length && body.prompt) {
    chatMessages.push({ role: 'user', content: String(body.prompt) });
  }

  if (!chatMessages.length) {
    return new Response(JSON.stringify({ error: 'No messages provided' }), { status: 400 });
  }

  const prompt = buildCliPromptFromMessages(chatMessages, systemParts);
  const ac = new AbortController();
  req.signal.addEventListener('abort', () => ac.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of streamGrokCli({
          prompt,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          cwd: projectRoot(),
          maxTurns: body.maxTurns,
          signal: ac.signal,
        })) {
          controller.enqueue(encoder.encode(encodeSseEvent(event)));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Grok CLI stream failed';
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