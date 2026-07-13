import { NextRequest } from 'next/server';
import { loadAgents } from '@/lib/persistence';
import { runAgentStream } from '@/lib/agent-runtime';
import { encodeAgentSseEvent } from '@/lib/agent-stream-types';
import { resolveProjectRunScope } from '@/lib/project-run';

export async function POST(req: NextRequest) {
  const {
    agentId,
    prompt,
    scheduled,
    scheduleId,
    scheduleInstructions,
    projectId,
    projectContext,
  } = await req.json();
  if (!agentId || !prompt) {
    return new Response(JSON.stringify({ error: 'agentId + prompt required' }), { status: 400 });
  }

  const agents = await loadAgents();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    return new Response(JSON.stringify({ error: 'agent not found' }), { status: 404 });
  }

  let resolvedProjectContext = projectContext ? String(projectContext) : undefined;
  let resolvedWorkspace: string | undefined;
  let effectivePrompt = String(prompt);

  if (projectId) {
    const scope = await resolveProjectRunScope(String(projectId), effectivePrompt);
    if (scope) {
      resolvedWorkspace = scope.workspacePathOverride;
      resolvedProjectContext = resolvedProjectContext || scope.projectContext;
      effectivePrompt = scope.effectivePrompt;
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of runAgentStream(agent, effectivePrompt, {
          scheduled: !!scheduled,
          scheduleId: scheduleId || undefined,
          scheduleInstructions: scheduleInstructions || undefined,
          projectContext: resolvedProjectContext,
          workspacePathOverride: resolvedWorkspace,
          projectId: projectId ? String(projectId) : undefined,
          signal: req.signal,
        })) {
          controller.enqueue(encoder.encode(encodeAgentSseEvent(event)));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Stream failed';
        controller.enqueue(encoder.encode(encodeAgentSseEvent({ type: 'error', message: msg })));
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
