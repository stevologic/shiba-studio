/** Curated agent skills — installable capability tags injected into system prompts. */

export const SKILL_CATEGORIES = ['coding', 'research', 'automation', 'communication', 'creative'] as const;
export type SkillCategory = typeof SKILL_CATEGORIES[number];

export interface SkillPreset {
  id: string;
  name: string;
  description: string;
  category: 'coding' | 'research' | 'automation' | 'communication' | 'creative';
  /** Extra system-prompt guidance when this skill is active */
  promptHint: string;
}

export const SKILL_PRESETS: SkillPreset[] = [
  {
    id: 'coder',
    name: 'Coder',
    description: 'Write, refactor, and debug code with tests',
    category: 'coding',
    promptHint: 'Prefer small diffs, run tests after edits, explain trade-offs briefly.',
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Gather sources, summarize findings, cite evidence',
    category: 'research',
    promptHint: 'Search broadly, synthesize clearly, flag uncertainty.',
  },
  {
    id: 'browser-automation',
    name: 'Browser Automation',
    description: 'Navigate sites, extract data, capture screenshots',
    category: 'automation',
    promptHint: 'Use browser tools for web tasks; prefer selectors over blind clicks.',
  },
  {
    id: 'devops',
    name: 'DevOps',
    description: 'Shell, git, CI, deploy scripts',
    category: 'coding',
    promptHint: 'Keep shell commands safe and idempotent; prefer git worktrees for isolation.',
  },
  {
    id: 'writer',
    name: 'Writer',
    description: 'Docs, READMEs, changelogs, user-facing copy',
    category: 'creative',
    promptHint: 'Clear prose, active voice, match project tone.',
  },
  {
    id: 'reviewer',
    name: 'Code Reviewer',
    description: 'Review diffs for bugs, security, and style',
    category: 'coding',
    promptHint: 'Focus on correctness and maintainability; suggest concrete fixes.',
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Break goals into steps and track progress',
    category: 'research',
    promptHint: 'Decompose tasks, estimate risk, propose next actions.',
  },
  {
    id: 'slack-ops',
    name: 'Slack Ops',
    description: 'Post updates and triage channel messages',
    category: 'communication',
    promptHint: 'Concise updates; use Slack integration when enabled.',
  },
  {
    id: 'data-analyst',
    name: 'Data Analyst',
    description: 'Parse CSV/JSON, compute aggregates, chart insights',
    category: 'research',
    promptHint: 'Validate data shapes; show sample outputs before bulk transforms.',
  },
  {
    id: 'security',
    name: 'Security',
    description: 'Audit dependencies and flag risky patterns',
    category: 'coding',
    promptHint: 'Never exfiltrate secrets; prefer read-only inspection first.',
  },
];

export function skillPresetById(id: string): SkillPreset | undefined {
  return SKILL_PRESETS.find((s) => s.id === id);
}

/**
 * Build the skills section of an agent's system prompt. Pass a merged catalog
 * (built-ins + user-created skills from lib/custom-skills) so custom skill
 * guidance is injected too; defaults to the built-in presets.
 */
export function buildSkillsPrompt(skills: string[], catalog: SkillPreset[] = SKILL_PRESETS): string {
  const ids = skills?.length ? skills : ['general-purpose'];
  const hints = ids
    .map((id) => catalog.find((s) => s.id === id)?.promptHint)
    .filter(Boolean);
  const base = `Your specialized skills: ${ids.join(', ')}. Use these to guide tool selection and behavior.`;
  if (!hints.length) return base;
  return `${base}\nSkill guidance:\n${hints.map((h) => `- ${h}`).join('\n')}`;
}