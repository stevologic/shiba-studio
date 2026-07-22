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
  const suppliedSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const requestChatSession = suppliedSessionId
    ? await (await import('@/lib/chat-sessions')).getChatSession(suppliedSessionId)
    : null;
  if (suppliedSessionId && !requestChatSession) {
    return new Response(JSON.stringify({ error: 'Chat session not found' }), { status: 404 });
  }
  if (requestChatSession && requestChatSession.chatTarget !== 'all') {
    return new Response(JSON.stringify({ error: 'Chat target no longer uses multi-agent mode' }), { status: 409 });
  }
  const durableSessionHistory = (await import('@/lib/context-engine')).modelRequestChatHistory(
    requestChatSession?.messages || null,
    body.messages,
  );
  const rawModel = requestChatSession?.chatModel
    || (body.model && String(body.model).trim())
    || cfg.defaultGrokModel
    || 'cloud:grok-4';
  const model = parseModelRef(rawModel).encoded;
  const projectId = requestChatSession?.projectId || null;
  let verifiedProjectContext = '';
  if (projectId) {
    const { buildProjectChatContext, getProject } = await import('@/lib/projects');
    const project = await getProject(projectId);
    if (!project) {
      return new Response(JSON.stringify({ error: 'Chat project not found' }), { status: 409 });
    }
    verifiedProjectContext = await buildProjectChatContext(project, cfg.defaultWorkspace);
  }

  const messages: ChatMessagePayload[] = [];
  const globalUploadsContext = !requestChatSession && body.globalUploadsContext
    ? String(body.globalUploadsContext)
    : await buildGlobalUploadsChatContext();
  messages.push({ role: 'system', content: globalUploadsContext });
  const projectContext = requestChatSession ? verifiedProjectContext : String(body.projectContext || '');
  if (projectContext) {
    messages.push({ role: 'system', content: projectContext });
  }
  const trustedHistory = durableSessionHistory;
  if (Array.isArray(trustedHistory) && trustedHistory.length > 0) {
    const { prepareSessionContext } = await import('@/lib/context-engine');
    const prepared = prepareSessionContext({
      sessionId: requestChatSession?.id || null,
      projectId,
      messages: trustedHistory,
      model,
    });
    if (prepared.systemContext) messages.push({ role: 'system', content: prepared.systemContext });
    for (const m of prepared.replayMessages) {
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
          reasoningEffort: requestChatSession?.reasoningEffort || body.reasoningEffort,
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
