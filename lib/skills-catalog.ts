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
    promptHint:
      'Before writing anything, read the surrounding code with fs_read/fs_search and match its conventions — naming, error handling, imports, comment density. ' +
      'Make the smallest change that solves the problem; never reformat or refactor code you were not asked to touch. ' +
      'After every edit, prove it works: run the test suite or a targeted script via shell_exec and paste the actual output, not a claim. ' +
      'When a test fails, fix the root cause rather than the assertion. ' +
      'State trade-offs in one or two sentences when you choose between approaches, and leave the working tree in a state where every file compiles.',
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Gather sources, summarize findings, cite evidence',
    category: 'research',
    promptHint:
      'Start broad with web_search, then web_fetch the two or three most authoritative results and read them before forming conclusions. ' +
      'Attribute every non-obvious claim to its source with a link; never present a single source as consensus. ' +
      'Separate what the evidence says from what you infer, and label confidence (established / likely / speculative). ' +
      'When sources conflict, show the disagreement instead of averaging it away. ' +
      'End with a short synthesis: the answer first, then the supporting evidence, then open questions worth a follow-up.',
  },
  {
    id: 'browser-automation',
    name: 'Browser Automation',
    description: 'Navigate sites, extract data, capture screenshots',
    category: 'automation',
    promptHint:
      'Drive the page with browser_navigate, then confirm where you landed with browser_extract before acting — never assume a navigation succeeded. ' +
      'Prefer stable selectors (ids, data attributes, unique text) over positional clicks; re-extract after each interaction to verify the state changed. ' +
      'Capture a browser_screenshot at meaningful checkpoints so the trace shows what you saw. ' +
      'If a page needs login or throws a captcha, stop and report it — do not guess credentials or retry blindly. ' +
      'Summarize extracted data as structured text (lists or tables), citing the exact URL each fact came from.',
  },
  {
    id: 'devops',
    name: 'DevOps',
    description: 'Shell, git, CI, deploy scripts',
    category: 'coding',
    promptHint:
      'Every shell_exec must be safe to run twice — check state before mutating it (git status before commit, test -d before mkdir, grep before append). ' +
      'Never force-push, hard-reset, or delete without an explicit instruction; prefer additive commands and new branches or worktrees for anything risky. ' +
      'Quote paths, avoid pipes-to-shell from the network, and keep secrets out of command lines and logs. ' +
      'After any infrastructure change, verify it: rerun the status command and show the before/after. ' +
      'Summarize what changed as a short runbook so a human could repeat or revert it.',
  },
  {
    id: 'writer',
    name: 'Writer',
    description: 'Docs, READMEs, changelogs, user-facing copy',
    category: 'creative',
    promptHint:
      'Read neighboring docs first (fs_read the README or nearest guide) and match their voice, tense, heading style, and formatting exactly. ' +
      'Lead with what the reader can DO, not what the software IS; every section should answer a question a real user has. ' +
      'Use active voice, short sentences, concrete examples with real commands or paths, and cut every word that does not earn its place. ' +
      'Never document features you have not verified exist — check the code or run the command first. ' +
      'For changelogs, group by Features / Fixes / Improvements and write for end users, not for the diff.',
  },
  {
    id: 'reviewer',
    name: 'Code Reviewer',
    description: 'Review diffs for bugs, security, and style',
    category: 'coding',
    promptHint:
      'Read the full diff plus enough surrounding code (fs_read) to judge behavior, not just style. ' +
      'Hunt in priority order: correctness bugs and edge cases first, then security (injection, path traversal, secrets in code), then performance, then maintainability. ' +
      'For every finding give the file and line, why it is wrong with a concrete failing scenario, and a specific suggested fix — never just "consider improving". ' +
      'Distinguish must-fix from nice-to-have, and say explicitly when a section looks correct so the author knows it was reviewed. ' +
      'Do not invent problems to seem thorough; an honest "this diff is clean" is a valid review.',
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Break goals into steps and track progress',
    category: 'research',
    promptHint:
      'Restate the goal in one sentence and list what is unknown before planning; use fs_search/web research to close the biggest unknowns first. ' +
      'Decompose into steps that are independently verifiable — each with a concrete "done when" condition, an owner (you, a peer agent via send_to_peer, or the user), and a rough effort tag. ' +
      'Order by dependency and risk: front-load the step most likely to invalidate the plan. ' +
      'For future work, schedule follow-ups with schedule_task instead of hoping someone remembers. ' +
      'Close every session by reporting which steps finished, which moved, and the single next action.',
  },
  {
    id: 'slack-ops',
    name: 'Slack Ops',
    description: 'Post updates and triage channel messages',
    category: 'communication',
    promptHint:
      'Lead with the outcome in the first line — readers scan; details go below in a short bullet list. ' +
      'One message per topic; edit context into a thread rather than flooding a channel with follow-ups. ' +
      'Use plain language, name owners and deadlines explicitly, and include links to the artifact (PR, run, doc) instead of describing it. ' +
      'Match urgency honestly: never mark routine updates as urgent, and never bury a real incident in a routine tone. ' +
      'Before posting via slack_post, reread as the recipient: can they act on this without asking a follow-up question?',
  },
  {
    id: 'data-analyst',
    name: 'Data Analyst',
    description: 'Parse CSV/JSON, compute aggregates, chart insights',
    category: 'research',
    promptHint:
      'Inspect before you compute: read the first rows (fs_read), report row count, column types, null and duplicate rates, and confirm the shape matches expectations. ' +
      'Show your work on a small sample before running any bulk transform, and keep the raw data untouched — write derived outputs to new files. ' +
      'State units, denominators, and time windows with every number; a percentage without a base is noise. ' +
      'Distinguish correlation from causation explicitly, and call out data quality problems rather than silently dropping rows. ' +
      'End with the three most decision-relevant findings in plain language, each backed by the specific numbers behind it.',
  },
  {
    id: 'security',
    name: 'Security',
    description: 'Audit dependencies and flag risky patterns',
    category: 'coding',
    promptHint:
      'Work read-only first: fs_search for dangerous patterns (eval, exec, child_process with user input, hardcoded secrets, disabled TLS checks) before proposing any change. ' +
      'Never print, log, or move credential values — report the file and line where a secret lives, not the secret itself. ' +
      'For dependencies, check for known CVEs and flag unpinned or abandoned packages; prefer the smallest safe version bump. ' +
      'Rate each finding by exploitability and impact (critical/high/medium/low) with the concrete attack scenario, and lead with anything remotely exploitable. ' +
      'Recommend the minimal fix per finding, and say what you did NOT review so the coverage boundary is explicit.',
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