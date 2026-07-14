import { NextRequest } from 'next/server';
import { projectRoot } from '@/lib/data-paths';
import { encodeSseEvent } from '@/lib/sse-events';
import type { ChatMessagePayload } from '@/lib/chat-types';
import { resolveChatToolsEnabled } from '@/lib/chat-tool-mode';

import { buildCliPromptFromMessages, streamGrokCli } from '@/lib/grok-cli';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const requestChatSession = body.sessionId
    ? await (await import('@/lib/chat-sessions')).getChatSession(String(body.sessionId))
    : null;
  const toolsEnabled = resolveChatToolsEnabled(body.toolsEnabled, requestChatSession?.toolsEnabled);
  let messages: ChatMessagePayload[] = Array.isArray(body.messages) ? body.messages : [];

  const systemParts: string[] = [];
  if (body.system) systemParts.push(String(body.system));
  const globalUploadsContext = body.globalUploadsContext
    ? String(body.globalUploadsContext)
    : await (await import('@/lib/workspace')).buildGlobalUploadsChatContext();
  systemParts.push(globalUploadsContext);
  if (body.projectContext) systemParts.push(String(body.projectContext));

  if (messages.length) {
    const projectId = requestChatSession?.projectId || null;
    const { prepareSessionContext } = await import('@/lib/context-engine');
    const prepared = prepareSessionContext({
      sessionId: body.sessionId ? String(body.sessionId) : null,
      projectId,
      messages,
      model: body.model ? String(body.model) : undefined,
    });
    messages = prepared.replayMessages;
    if (prepared.systemContext) systemParts.push(prepared.systemContext);
  }

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

  // Prefer chat/project workspace so CLI coding runs where the user is working.
  let cwd = projectRoot();
  if (body.workspaceDir) {
    const requested = String(body.workspaceDir).trim();
    try {
      const fs = await import('fs');
      if (requested && fs.statSync(requested).isDirectory()) cwd = requested;
    } catch { /* stale path — fall back to project root */ }
  }
  if (cwd !== projectRoot() && toolsEnabled) {
    systemParts.push([
      '## Workspace',
      `You are working in \`${cwd}\` on the user's machine.`,
      'Use your tools to explore, edit, and verify code there.',
      'Do not give a final answer until coding changes are complete (or blocked).',
      'Stream progress via your normal reasoning; implement first, then summarize.',
    ].join('\n'));
  }
  if (!toolsEnabled) {
    systemParts.push([
      '## Tools disabled for this chat',
      'Answer only from the conversation and supplied context.',
      'Do not claim to browse, inspect files, run commands, use memory, or delegate work. The user can run `/tools on` to restore those capabilities.',
    ].join('\n'));
  }

  const prompt = buildCliPromptFromMessages(chatMessages, systemParts);
  const ac = new AbortController();
  req.signal.addEventListener('abort', () => ac.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        if (cwd !== projectRoot() && toolsEnabled) {
          controller.enqueue(encoder.encode(encodeSseEvent({
            type: 'thinking',
            delta: `Working in workspace \`${cwd}\` via Grok CLI…\n`,
          })));
        }
        for await (const event of streamGrokCli({
          prompt,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
          cwd,
          toolsEnabled,
          // More turns when coding in a bound workspace so work finishes before the reply.
          maxTurns: toolsEnabled ? (body.maxTurns ?? (cwd !== projectRoot() ? 20 : undefined)) : 1,
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
