/** Side-effect-free v1 intent router for Dispatch. The user always overrides it. */

export type DispatchMode = 'quick' | 'work' | 'code' | 'routine';

export interface DispatchRecommendation {
  recommendedMode: DispatchMode;
  reason: string;
  confidence: number;
  recommendationVersion: 'v1';
  signals: string[];
}

const ROUTINE_PATTERNS = [
  /\b(schedule|scheduled|every (day|week|hour|month)|daily|weekly|hourly|cron)\b/i,
  /\b(monitor|watch for|when .* changes?|on (push|webhook|mention)|remind me|in \d+ (minutes?|hours?|days?))\b/i,
];

const CODE_PATTERNS = [
  /\b(fix|debug|refactor|implement|code|repository|repo|pull request|commit|branch|test suite|typecheck|lint|build)\b/i,
  /\b(src\/|app\/|lib\/|\.tsx?\b|\.jsx?\b|package\.json|git\b)/i,
];

const WORK_PATTERNS = [
  /\b(research|analy[sz]e|compare|investigate|audit|report|brief|presentation|spreadsheet|document|pdf|deliverable)\b/i,
  /\b(multiple sources|deep dive|comprehensive|thorough|long-running)\b/i,
];

function collect(patterns: RegExp[], text: string, label: string): string[] {
  return patterns.flatMap((pattern) => pattern.test(text) ? [label] : []);
}

export function recommendTaskMode(input: {
  outcome: string;
  attachmentNames?: string[];
  hasWorkspace?: boolean;
}): DispatchRecommendation {
  const outcome = typeof input.outcome === 'string' ? input.outcome.slice(0, 20_000) : '';
  const attachmentNames = Array.isArray(input.attachmentNames)
    ? input.attachmentNames.slice(0, 100).map((name) => String(name).slice(0, 300))
    : [];
  const text = `${outcome}\n${attachmentNames.join('\n')}`;
  const routine = collect(ROUTINE_PATTERNS, text, 'schedule-or-monitor language');
  const code = collect(CODE_PATTERNS, text, 'code-or-repository language');
  const work = collect(WORK_PATTERNS, text, 'research-or-deliverable language');
  if (input.hasWorkspace) code.push('workspace attached');
  if (attachmentNames.some((name) => /\.(tsx?|jsx?|py|go|rs|java|cs|rb|php|vue|svelte)$/i.test(name))) {
    code.push('source-code attachment');
  }
  if (routine.length) {
    return {
      recommendedMode: 'routine',
      reason: 'The outcome describes work that should run later, repeat, or react to a change.',
      confidence: Math.min(0.98, 0.72 + routine.length * 0.08),
      recommendationVersion: 'v1',
      signals: [...new Set(routine)],
    };
  }
  if (code.length) {
    return {
      recommendedMode: 'code',
      reason: 'The outcome appears to require repository-aware editing, commands, or verification.',
      confidence: Math.min(0.96, 0.68 + code.length * 0.08),
      recommendationVersion: 'v1',
      signals: [...new Set(code)],
    };
  }
  if (work.length) {
    return {
      recommendedMode: 'work',
      reason: 'The outcome asks for multi-step research, analysis, or a finished deliverable.',
      confidence: Math.min(0.94, 0.64 + work.length * 0.08),
      recommendationVersion: 'v1',
      signals: [...new Set(work)],
    };
  }
  return {
    recommendedMode: 'quick',
    reason: 'The outcome looks like a focused question or short conversational task.',
    confidence: 0.62,
    recommendationVersion: 'v1',
    signals: [],
  };
}
