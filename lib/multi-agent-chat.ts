import { grokChat } from './grok-client';
import { buildAgentChatSystem, buildMultiAgentSynthesisSystem } from './chat-skill';
import type { ChatMessagePayload, ChatStreamEvent, ReasoningEffort } from './chat-types';
import { encodeSseEvent, grokChatStream } from './grok-chat-stream';
import type { Agent } from './types';

export interface MultiAgentChatParams {
  model: string;
  agents: Agent[];
  messages: ChatMessagePayload[];
  reasoningEffort?: ReasoningEffort;
}

function latestUserMessage(messages: ChatMessagePayload[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content?.trim()) {
      return messages[i].content.trim();
    }
  }
  return '';
}

function conversationContext(messages: ChatMessagePayload[], maxTurns = 6): ChatMessagePayload[] {
  const trimmed = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  return trimmed.slice(-maxTurns);
}

export async function* multiAgentChatStream(params: MultiAgentChatParams): AsyncGenerator<ChatStreamEvent> {
  const { agents, model, messages, reasoningEffort } = params;
  if (!agents.length) {
    yield { type: 'error', message: 'No agents configured. Create agents first.' };
    return;
  }

  const userMessage = latestUserMessage(messages);
  if (!userMessage) {
    yield { type: 'error', message: 'No user message to send.' };
    return;
  }

  const context = conversationContext(messages);
  yield {
    type: 'thinking',
    delta: `Consulting ${agents.length} agent${agents.length === 1 ? '' : 's'}…\n`,
  };

  const perspectives: Array<{ agentId: string; name: string; content: string }> = [];

  await Promise.all(
    agents.map(async (agent) => {
      try {
        // Each agent answers with live context from its own enabled integrations.
        const { buildIntegrationContext } = await import('./integration-context');
        const integrationContext = await buildIntegrationContext(agent.integrations, agent.driveFolders).catch(() => '');
        const resp = await grokChat({
          model: agent.model || model,
          messages: [
            {
              role: 'system',
              content: integrationContext
                ? `${buildAgentChatSystem(agent)}\n\n${integrationContext}`
                : buildAgentChatSystem(agent),
            },
            ...context.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: userMessage },
          ],
          max_tokens: 1200,
          temperature: 0.7,
          usageContext: { source: 'chat', sourceId: `agent:${agent.id}` },
        });
        const content = resp.choices?.[0]?.message?.content?.trim() || '(no response)';
        perspectives.push({ agentId: agent.id, name: agent.name, content });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'failed';
        perspectives.push({
          agentId: agent.id,
          name: agent.name,
          content: `(Error: ${msg})`,
        });
      }
    }),
  );

  perspectives.sort((a, b) => a.name.localeCompare(b.name));

  for (const p of perspectives) {
    yield { type: 'agent-perspective', agentId: p.agentId, name: p.name, content: p.content };
  }

  yield { type: 'thinking', delta: '\nSynthesizing unified answer…\n' };

  const synthesisMessages: ChatMessagePayload[] = [
    {
      role: 'system',
      content: buildMultiAgentSynthesisSystem(perspectives),
    },
    ...context,
    { role: 'user', content: userMessage },
  ];

  for await (const event of grokChatStream({
    model,
    messages: synthesisMessages,
    reasoningEffort,
    usageContext: { source: 'chat', sourceId: 'multi-agent' },
  })) {
    yield event;
  }
}

export { encodeSseEvent };