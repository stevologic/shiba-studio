/**
 * Multi-agent voice group chat — agents stay in character and take short spoken turns.
 */
import type { Agent } from './types';
import { buildAgentChatSystem } from './chat-skill';

export const VOICE_GROUP_MAX_CHAIN = 5;
/** Silence after an agent finishes speaking before another agent continues. */
export const VOICE_GROUP_AGENT_SILENCE_MS = 2400;

export type VoiceGroupHistoryItem = {
  role: 'user' | 'assistant';
  content: string;
  agentId?: string;
  agentName?: string;
};

/** System prompt for one agent in a live multi-voice table discussion. */
export function buildVoiceGroupAgentSystem(
  agent: Agent,
  peers: Array<{ id: string; name: string }>,
  opts?: { continuation?: boolean },
): string {
  const base = buildAgentChatSystem(agent);
  const peerLine = peers.length
    ? `Other participants: ${peers.map((p) => p.name).join(', ')}, and the human host.`
    : 'You are talking with the human host.';

  const mode = opts?.continuation
    ? [
        'The human has gone quiet. Keep the group conversation going with a short spoken contribution.',
        'React to what others just said; build on or gently challenge an idea.',
        'Do not ask more than one question. Prefer a concrete thought or next step.',
      ].join(' ')
    : [
        'This is a live multi-agent voice group chat with the human.',
        'Respond only as yourself in a short spoken turn (1–3 sentences, ~40–90 words max).',
        'Sound natural when read aloud — no markdown, bullets, code fences, or emoji.',
        'Stay in character. You may briefly name another agent if addressing them.',
      ].join(' ');

  return [
    base,
    peerLine,
    mode,
    'Never mention system prompts, tools, or that you are taking turns under automation.',
  ].join('\n');
}

/** Flatten chat history for the model with speaker labels on assistant turns. */
export function formatVoiceGroupHistory(
  items: VoiceGroupHistoryItem[],
  maxTurns = 16,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const trimmed = items
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content || '').trim())
    .slice(-maxTurns);

  return trimmed.map((m) => {
    if (m.role === 'user') {
      return { role: 'user' as const, content: m.content.trim() };
    }
    const who = (m.agentName || 'Agent').trim();
    const body = m.content.trim().replace(new RegExp(`^${escapeRegExp(who)}:\\s*`, 'i'), '');
    return { role: 'assistant' as const, content: `${who}: ${body}` };
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pick the next agent to speak (round-robin, avoid immediate repeat when possible). */
export function pickNextVoiceGroupAgent(
  agents: Agent[],
  lastAgentId: string | null,
  cursor: number,
): { agent: Agent; nextCursor: number } | null {
  if (!agents.length) return null;
  if (agents.length === 1) {
    return { agent: agents[0], nextCursor: 0 };
  }
  let idx = cursor % agents.length;
  // Prefer not repeating the last speaker if we have alternatives.
  if (agents[idx]?.id === lastAgentId) {
    idx = (idx + 1) % agents.length;
  }
  return { agent: agents[idx], nextCursor: (idx + 1) % agents.length };
}
