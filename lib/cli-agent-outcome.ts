export type CliAgentCompletionReason = 'substantive' | 'empty' | 'intent-only' | 'blocked';

export interface CliAgentCompletionAssessment {
  complete: boolean;
  reason: CliAgentCompletionReason;
}

const LEADING_MARKDOWN = /^(?:(?:[#>*-]|\d+[.)])\s*)+/;
const POLITE_LEAD_IN = /^(?:(?:okay|ok|sure|certainly|absolutely)[,!.:\s—-]*)+/i;
const INTENT_OPENING = /^(?:(?:first|next|to (?:begin|start))[,:\s—-]*)?(?:(?:i|we)(?:['’]ll|\s+will)\b|(?:i['’]m|i am|we['’]re|we are)\s+(?:going to|about to|starting|beginning)\b|let me\b)/i;

/**
 * Evidence that an initially future-tense answer went on to report work that
 * already happened. Keep this list deliberately concrete: words such as
 * "completion" in "so we can work it to completion" are not evidence.
 */
const DELIVERED_WORK = /\b(?:completed|implemented|added|fixed|updated|created|changed|modified|removed|renamed|refactored|configured|migrated|generated|built|resolved|delivered|patched|wrote|ran|tested|verified|confirmed|analy[sz]ed|reviewed|found|identified|discovered)\b/i;
const RESULT_SECTION = /(?:^|\n)\s*(?:[-*]\s*)?(?:result|outcome|summary|changes? made|files? (?:changed|updated)|verification|tests? run)\s*:/i;
const PASSING_CHECK = /\b(?:tests?|checks?|build|lint|typecheck)\s*(?::|—|-)\s*(?:pass(?:ed|ing)?|ok|successful|clean|\d+\s+pass)/i;
const CONCRETE_DIAGNOSIS = /\b(?:root cause|cause|issue|bug|problem)\s+(?:is|was)\b/i;
const BLOCKED_OUTCOME = /\b(?:unable to (?:continue|complete|finish|proceed|implement|change|edit|write|run)|cannot (?:continue|complete|finish|proceed|implement|change|edit|write|run)|can't (?:continue|complete|finish|proceed|implement|change|edit|write|run)|blocked by|permission denied|read[- ]only|requires? (?:additional )?(?:access|permission|credentials?))\b/i;

function normalizedOpening(output: string): string {
  let normalized = output.trim();
  normalized = normalized.replace(LEADING_MARKDOWN, '').trimStart();
  normalized = normalized.replace(POLITE_LEAD_IN, '').trimStart();
  return normalized;
}

/**
 * Rejects empty answers, explicit blockers, and the narrow failure mode where
 * a headless CLI returns only a promise to begin the task (for example,
 * "I'll pull the card details...") and exits successfully. It is intentionally
 * not a broad semantic judge beyond those terminally incomplete outcomes.
 */
export function assessCliAgentCompletion(output: string): CliAgentCompletionAssessment {
  const text = String(output || '').trim();
  if (!text) return { complete: false, reason: 'empty' };

  const containsDeliveredWork = DELIVERED_WORK.test(text)
    || RESULT_SECTION.test(text)
    || PASSING_CHECK.test(text)
    || CONCRETE_DIAGNOSIS.test(text);
  if (BLOCKED_OUTCOME.test(text)) {
    return { complete: false, reason: 'blocked' };
  }

  const opensWithIntent = INTENT_OPENING.test(normalizedOpening(text));
  if (!opensWithIntent) return { complete: true, reason: 'substantive' };

  return containsDeliveredWork
    ? { complete: true, reason: 'substantive' }
    : { complete: false, reason: 'intent-only' };
}

export function isIncompleteCliAgentOutput(output: string): boolean {
  return !assessCliAgentCompletion(output).complete;
}
