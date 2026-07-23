import { NextRequest } from 'next/server';
import { projectRoot } from '@/lib/data-paths';
import { encodeSseEvent } from '@/lib/sse-events';
import type { ChatMessagePayload } from '@/lib/chat-types';
import { resolveChatToolsEnabled } from '@/lib/chat-tool-mode';
import { loadConfig } from '@/lib/persistence';

import { buildCliPromptFromMessages, streamGrokCli } from '@/lib/grok-cli';

export const maxDuration = 3600;
export const dynamic = 'force-dynamic';

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
  if (requestChatSession?.chatTarget === 'all') {
    return new Response(JSON.stringify({ error: 'Chat target now requires multi-agent mode' }), { status: 409 });
  }
  const durableSessionHistory = (await import('@/lib/context-engine')).modelRequestChatHistory(
    requestChatSession?.messages || null,
    body.messages,
  );
  const toolsEnabled = requestChatSession
    ? requestChatSession.toolsEnabled !== false
    : resolveChatToolsEnabled(body.toolsEnabled);
  let messages: ChatMessagePayload[] = durableSessionHistory;
  const projectId = requestChatSession?.projectId || null;
  let verifiedProjectContext = '';
  let verifiedWorkspaceDir = requestChatSession?.workspaceDir?.trim() || '';
  if (projectId) {
    const { buildProjectChatContext, getProject, resolveProjectWorkspace } = await import('@/lib/projects');
    const project = await getProject(projectId);
    if (!project) {
      return new Response(JSON.stringify({ error: 'Chat project not found' }), { status: 409 });
    }
    verifiedProjectContext = await buildProjectChatContext(project, cfg.defaultWorkspace);
    if (!verifiedWorkspaceDir) verifiedWorkspaceDir = resolveProjectWorkspace(project, cfg.defaultWorkspace);
  }

  const systemParts: string[] = [];
  if (!requestChatSession && body.system) systemParts.push(String(body.system));
  if (requestChatSession) {
    const target = requestChatSession.chatTarget?.trim();
    if (target && target !== 'grok' && target !== 'all') {
      const { loadAgents } = await import('@/lib/persistence');
      const agent = (await loadAgents()).find((candidate) => candidate.id === target);
      if (!agent) {
        return new Response(JSON.stringify({ error: 'Chat agent no longer exists' }), { status: 409 });
      }
      const { buildAgentChatSystem } = await import('@/lib/chat-skill');
      systemParts.push(buildAgentChatSystem(agent));
    }
  }
  const globalUploadsContext = !requestChatSession && body.globalUploadsContext
    ? String(body.globalUploadsContext)
    : await (await import('@/lib/workspace')).buildGlobalUploadsChatContext();
  systemParts.push(globalUploadsContext);
  const projectContext = requestChatSession ? verifiedProjectContext : String(body.projectContext || '');
  if (projectContext) systemParts.push(projectContext);

  if (messages.length) {
    const { prepareSessionContext } = await import('@/lib/context-engine');
    const prepared = prepareSessionContext({
      sessionId: requestChatSession?.id || null,
      projectId,
      messages,
      model: requestChatSession?.chatModel || (body.model ? String(body.model) : undefined),
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
  const requestedWorkspace = requestChatSession ? verifiedWorkspaceDir : String(body.workspaceDir || '').trim();
  if (requestedWorkspace) {
    try {
      const fs = await import('fs');
      if (fs.statSync(requestedWorkspace).isDirectory()) cwd = requestedWorkspace;
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
  } else if (cfg.toolApprovalMode !== 'yolo') {
    systemParts.push([
      '## Headless approval mode',
      'Shiba is in Ask-before-act mode. Read-only operations and existing explicit Grok permission rules may run.',
      'Any tool call that would require an interactive approval is denied because this headless process cannot display approval prompts.',
      'The user can explicitly enable YOLO in Settings to authorize unattended coding actions.',
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
          model: requestChatSession?.chatModel || body.model,
          reasoningEffort: requestChatSession?.reasoningEffort || body.reasoningEffort,
          cwd,
          toolsEnabled,
          // Headless runs cannot display approval prompts. The legacy
          // tools-enabled default is capability, not unattended consent.
          permissionMode: toolsEnabled && cfg.toolApprovalMode === 'yolo'
            ? 'bypassPermissions'
            : 'default',
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
