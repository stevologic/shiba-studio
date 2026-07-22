import { getChatSession } from './chat-sessions';
import { modelRequestChatHistory } from './context-engine';
import { loadAgents, loadConfig } from './persistence';
import { buildProjectChatContext, getProject } from './projects';
import { normalizeAgent, type Agent, type AppConfig } from './types';
import type { VoiceGroupHistoryItem } from './voice-group-chat';

type VoiceGroupScopeFailure = {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
};

export type VoiceGroupSessionScope = {
  ok: true;
  sessionId: string;
  projectId: string | null;
  chatModel: string;
  config: AppConfig;
  agent: Agent;
  peers: Array<{ id: string; name: string }>;
  history: VoiceGroupHistoryItem[];
  projectContext: string;
};

/**
 * Resolve every durable ownership field for a voice-group turn on the server.
 * The client chooses which current participant speaks next, but cannot supply
 * the transcript, participant roster, project, model, or project context.
 */
export async function resolveVoiceGroupSessionScope(input: {
  sessionId: string;
  agentId: string;
}): Promise<VoiceGroupSessionScope | VoiceGroupScopeFailure> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return { ok: false, status: 400, error: 'sessionId required' };
  }

  const session = await getChatSession(sessionId);
  if (!session) {
    return { ok: false, status: 404, error: 'Chat session not found' };
  }
  if (session.chatTarget?.trim() !== 'all') {
    return { ok: false, status: 409, error: 'Chat session is not in voice-group mode' };
  }
  if (session.useGrokCli) {
    return { ok: false, status: 409, error: 'Voice-group mode cannot use Grok CLI' };
  }

  const agentId = input.agentId.trim();
  if (!agentId) {
    return { ok: false, status: 400, error: 'agentId required' };
  }

  const agents = (await loadAgents()).map(normalizeAgent);
  if (agents.length < 2) {
    return { ok: false, status: 409, error: 'Voice-group mode requires at least two current agents' };
  }
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return { ok: false, status: 409, error: 'Voice-group participant no longer exists' };
  }

  const config = await loadConfig();
  let projectContext = '';
  if (session.projectId) {
    const project = await getProject(session.projectId);
    if (!project) {
      return { ok: false, status: 409, error: 'Chat project not found' };
    }
    projectContext = await buildProjectChatContext(project, config.defaultWorkspace);
  }

  const history = modelRequestChatHistory(session.messages, null)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: String(message.content || ''),
      agentId: message.agentId,
      agentName: message.agentName,
    }));

  return {
    ok: true,
    sessionId: session.id,
    projectId: session.projectId,
    chatModel: session.chatModel,
    config,
    agent,
    peers: agents
      .filter((candidate) => candidate.id !== agent.id)
      .map((candidate) => ({ id: candidate.id, name: candidate.name })),
    history,
    projectContext,
  };
}
