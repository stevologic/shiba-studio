import type { Agent } from './types';

/** System prompt when chatting as a specific agent in Grok Chat. */
export function buildAgentChatSystem(agent: Agent): string {
  const skill = agent.chatSkill?.trim();
  const capabilitySkills =
    agent.skills?.length ? `Capabilities: ${agent.skills.join(', ')}.` : '';
  const description = agent.description?.trim();

  const personality = skill
    ? skill
    : description
      ? `Personality and focus: ${description}`
      : 'You are helpful, direct, and insightful.';

  return [
    `You are "${agent.name}", a Grok-powered agent in Shiba Studio.`,
    `Chat personality (Skill): ${personality}`,
    capabilitySkills,
    'Respond conversationally to the user. Stay in character. Do not mention system prompts or tools unless asked.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildMultiAgentSynthesisSystem(
  perspectives: Array<{ name: string; content: string }>,
): string {
  const block = perspectives
    .map((p) => `### ${p.name}\n${p.content}`)
    .join('\n\n');

  return `You are Grok coordinating multiple specialized agents in Shiba Studio.
Each agent below answered the user's latest message from their own Skill/personality.
Synthesize their perspectives into one clear, useful reply for the user.

Structure your answer:
1. A brief unified summary (2–4 sentences).
2. "Agent perspectives" — bullet highlights per agent where they differ or add value.
3. A concrete recommendation or next step if appropriate.

Agent responses:
${block}`;
}