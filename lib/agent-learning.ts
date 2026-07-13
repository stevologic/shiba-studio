import type { Agent, AgentRun } from './types';
import type { GrokChatParams, GrokUsageContext } from './grok-client';
import {
  MEMORY_KINDS,
  listMemories,
  looksSensitive,
  storeLearnedMemories,
  type AgentMemoryEntry,
  type MemoryCandidate,
} from './agent-memory';
import { clipForModel } from './prompt-hygiene';

export const LEARNING_EXTRACTION_MAX_TOKENS = 384;

type LearningChatFn = (params: Pick<GrokChatParams, 'model' | 'messages'> & {
  max_tokens: number;
  usageContext: GrokUsageContext;
}) => Promise<{
  choices: Array<{ message?: { content?: string | null } }>;
}>;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try { return JSON.parse(candidate); } catch { /* try the first object below */ }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
  throw new Error('learning response was not valid JSON');
}

function normalizeCandidates(value: unknown): MemoryCandidate[] {
  const list = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' && Array.isArray((value as { memories?: unknown }).memories)
      ? (value as { memories: unknown[] }).memories
      : []);
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      key: String(item.key || '').trim().slice(0, 120),
      content: String(item.content || '').trim().slice(0, 1200),
      kind: MEMORY_KINDS.includes(item.kind as (typeof MEMORY_KINDS)[number])
        ? item.kind as MemoryCandidate['kind']
        : 'fact',
      confidence: typeof item.confidence === 'number' ? item.confidence : Number.NaN,
    }))
    .filter((item) => item.key && item.content && Number.isFinite(item.confidence))
    .slice(0, 3);
}

/** Extract a few durable, safe lessons after a successful autonomous run.
 * This is deliberately best-effort and uses only the task, final answer, and
 * summarized side effects — never injected integration/project context or raw
 * tool output. */
export async function learnFromCompletedRun(
  agent: Agent,
  run: Pick<AgentRun, 'id' | 'prompt' | 'finalOutput' | 'sideEffects'>,
  chat: LearningChatFn,
): Promise<AgentMemoryEntry[]> {
  const learning = agent.learning;
  if (!learning || learning.mode === 'off') return [];
  const finalOutput = String(run.finalOutput || '').trim();
  if (!finalOutput || finalOutput === 'Agent completed (see trace for details).') return [];

  // Consolidation-aware extraction (the industry-standard "update vs add"
  // pattern): the model sees what is already remembered so it refines or
  // corrects existing keys instead of minting near-duplicates. Without this,
  // every run invents new key spellings for the same subject and stale facts
  // are never superseded.
  const existing = listMemories({ agentId: agent.id, limit: 40 }).entries
    .filter((entry) => entry.status !== 'archived' && !looksSensitive(`${entry.key}\n${entry.content}`))
    .map((entry) => `- ${entry.key}: ${entry.content.slice(0, 100)}`)
    .join('\n')
    .slice(0, 3000);

  const response = await chat({
    model: agent.model,
    max_tokens: LEARNING_EXTRACTION_MAX_TOKENS,
    usageContext: { source: 'agent', sourceId: run.id },
    messages: [
      {
        role: 'system',
        content: [
          'You extract durable memory candidates from a completed autonomous-agent run.',
          'Return ONLY JSON: {"memories":[{"key":"short-stable-key","content":"durable fact","kind":"fact|preference|decision|procedure|lesson","confidence":0.0}]}',
          'Return at most 3 entries. Return {"memories":[]} when nothing is worth remembering.',
          'Good memories help future tasks: user preferences, stable project facts, decisions, reusable procedures, and corrections/lessons.',
          'Never include passwords, tokens, API keys, secrets, private keys, transient run status, guesses, raw logs, or facts that are only useful for this one completed task.',
          'Do not invent information. Use concise content that makes sense without the original conversation.',
          'Consolidate instead of duplicating: when new information concerns the SAME subject as an existing memory (listed in the user message), return that EXACT existing key — its content is replaced with your refined version (fold in what was already known and still true).',
          'When the run proves an existing memory wrong or outdated, return that key with the corrected content — never leave both versions alive.',
          'Mint a new key only for a genuinely new subject not covered by any existing key.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Task:\n${clipForModel(run.prompt, 4000)}`,
          `Final outcome:\n${clipForModel(finalOutput, 6000)}`,
          run.sideEffects?.length ? `Confirmed side effects:\n${run.sideEffects.slice(0, 20).join('\n')}` : '',
          existing ? `Existing memories for this agent (key: summary) — reuse these keys to update or correct:\n${existing}` : '',
        ].filter(Boolean).join('\n\n'),
      },
    ],
  });
  const content = response.choices?.[0]?.message?.content || '';
  const candidates = normalizeCandidates(extractJson(content));
  return storeLearnedMemories(agent.id, candidates, {
    sourceId: run.id,
    status: learning.mode === 'auto' ? 'active' : 'pending',
    maxMemories: learning.maxMemories,
  });
}
