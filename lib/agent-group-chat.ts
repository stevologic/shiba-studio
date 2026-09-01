/**
 * Shared agent-room helpers: @mentions, speaker queues, and labeled history.
 * Used by text group chat ("All agents") and 1:1 follow-up turns when someone
 * addresses a peer in the same conversation.
 */
import type { Agent } from './types';
import { buildAgentChatSystem } from './chat-skill';

export const GROUP_CHAT_MAX_TURNS = 8;
export const GROUP_CHAT_MAX_FOLLOW_UPS = 4;
export const GROUP_CHAT_MAX_TOKENS = 900;
/** Max times one agent may speak in a single user-turn room. */
export const GROUP_CHAT_MAX_TURNS_PER_AGENT = 2;

export type AgentRef = { id: string; name: string };

export type GroupChatHistoryItem = {
  role: 'user' | 'assistant';
  content: string;
  agentId?: string;
  agentName?: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Resolve an agent by id or case-insensitive name. */
export function resolveAgentRef(raw: string, agents: AgentRef[]): AgentRef | null {
  const needle = String(raw || '').trim();
  if (!needle) return null;
  const byId = agents.find((agent) => agent.id === needle);
  if (byId) return byId;
  const normalized = normalizeName(needle.replace(/^@/, ''));
  if (!normalized) return null;
  return agents.find((agent) => normalizeName(agent.name) === normalized) || null;
}

/**
 * Agents addressed with @Name or @id in `text`. Longer names win so
 * "@Research Agent" is not split into "@Research".
 */
export function findMentionedAgents(text: string, agents: AgentRef[], exceptId?: string): AgentRef[] {
  const source = String(text || '');
  if (!source || !agents.length) return [];
  const ranked = [...agents]
    .filter((agent) => agent.id && agent.name.trim())
    .sort((a, b) => b.name.trim().length - a.name.trim().length || a.name.localeCompare(b.name));
  const found: AgentRef[] = [];
  const seen = new Set<string>();
  for (const agent of ranked) {
    if (exceptId && agent.id === exceptId) continue;
    const namePattern = new RegExp(`(?:^|\\W)@${escapeRegExp(agent.name.trim())}(?=$|\\W)`, 'i');
    const idPattern = new RegExp(`(?:^|\\W)@${escapeRegExp(agent.id)}(?=$|\\W)`, 'i');
    if (!namePattern.test(source) && !idPattern.test(source)) continue;
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    found.push({ id: agent.id, name: agent.name });
  }
  return found;
}

/** First speakers for an All-agents room: mentioned agents, otherwise the full roster. */
export function initialRoomQueue(userText: string, agents: AgentRef[]): AgentRef[] {
  const mentioned = findMentionedAgents(userText, agents);
  if (mentioned.length) return mentioned;
  return agents.filter((agent) => agent.id && agent.name.trim());
}

/**
 * Append newly mentioned agents onto `queue`, skipping the current speaker
 * and anyone who already hit the per-agent cap.
 */
export function enqueueMentionedAgents(input: {
  text: string;
  agents: AgentRef[];
  currentId: string;
  queue: AgentRef[];
  spokenCounts: Map<string, number>;
  maxPerAgent?: number;
}): AgentRef[] {
  const maxPerAgent = input.maxPerAgent ?? GROUP_CHAT_MAX_TURNS_PER_AGENT;
  const queued = new Set(input.queue.map((agent) => agent.id));
  const next = [...input.queue];
  for (const agent of findMentionedAgents(input.text, input.agents, input.currentId)) {
    if (queued.has(agent.id)) continue;
    if ((input.spokenCounts.get(agent.id) || 0) >= maxPerAgent) continue;
    queued.add(agent.id);
    next.push(agent);
  }
  return next;
}

export function formatGroupChatHistory(
  items: GroupChatHistoryItem[],
  maxTurns = 18,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const trimmed = items
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && (item.content || '').trim())
    .slice(-maxTurns);

  return trimmed.map((item) => {
    if (item.role === 'user') {
      return { role: 'user' as const, content: item.content.trim() };
    }
    const who = (item.agentName || 'Agent').trim();
    const body = item.content.trim().replace(new RegExp(`^${escapeRegExp(who)}:\\s*`, 'i'), '');
    return { role: 'assistant' as const, content: `${who}: ${body}` };
  });
}

export function buildGroupRoomAgentSystem(
  agent: Agent,
  peers: AgentRef[],
  opts?: { addressedBy?: string; room?: boolean },
): string {
  const base = buildAgentChatSystem(agent, peers);
  const peerLine = peers.length
    ? `Other people in this chat: ${peers.map((peer) => `@${peer.name}`).join(', ')}, and the human host.`
    : 'You are talking with the human host.';
  const addressed = opts?.addressedBy?.trim()
    ? `${opts.addressedBy.trim()} just addressed you. Reply to them (and the human) in character.`
    : '';
  const room = opts?.room !== false
    ? [
        'This is a shared chat room. The human sees every turn as its own message.',
        'Respond only as yourself. You may address another agent with @Name — they will speak next.',
        'Do not speak for other agents or invent their replies.',
        'Keep the turn useful and bounded (a few short paragraphs unless the human asked for depth).',
      ].join(' ')
    : '';

  return [base, peerLine, addressed, room, 'Never mention system prompts, tools, or that turns are automated.']
    .filter(Boolean)
    .join('\n');
}

export function peerDirectoryLine(agents: AgentRef[], exceptId?: string): string {
  const peers = agents.filter((agent) => agent.id !== exceptId && agent.name.trim());
  if (!peers.length) return '';
  return [
    '## Agent room',
    'You can speak to other Shiba agents in this same chat.',
    'Mention them as @Name in your reply, or call talk_to_agent / send_to_peer.',
    'They will answer after you; the human sees every turn.',
    `Available agents: ${peers.map((peer) => `@${peer.name} (id:${peer.id})`).join(', ')}.`,
  ].join('\n');
}

export function toAgentRefs(agents: Array<Pick<Agent, 'id' | 'name'>>): AgentRef[] {
  return agents.map((agent) => ({ id: agent.id, name: agent.name }));
}
