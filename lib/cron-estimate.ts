// Pure cron-frequency estimation — no Node imports, safe in client bundles.
// Used for the "this schedule runs N times/day" cost warning.

/** Schedules that fire more often than this per day get a UI warning. */
export const SCHEDULE_RUNS_PER_DAY_WARN = 24;

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    const stepSplit = part.split('/');
    const base = stepSplit[0];
    const step = stepSplit[1] ? parseInt(stepSplit[1], 10) : 1;
    if (!Number.isFinite(step) || step < 1) continue;
    let lo = min;
    let hi = max;
    if (base !== '*' && base !== '') {
      const range = base.split('-');
      lo = parseInt(range[0], 10);
      hi = range[1] !== undefined ? parseInt(range[1], 10) : (stepSplit[1] ? max : lo);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    }
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}

/**
 * Estimate how many times a 5-field cron expression fires per day by walking
 * every minute of a representative day. Returns null for expressions we can't
 * parse (6-field with seconds, month/day names). Day-of-month/month/dow are
 * treated as a typical "matching day" — the estimate answers "on a day it
 * runs, how many times does it run?", which is what the cost warning needs.
 */
export function estimateCronRunsPerDay(expr: string): number | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF] = fields;
  if (/[a-zA-Z]/.test(minF + hourF)) return null;
  let count = 0;
  for (let h = 0; h < 24; h++) {
    if (!fieldMatches(hourF, h, 0, 23)) continue;
    for (let m = 0; m < 60; m++) {
      if (fieldMatches(minF, m, 0, 59)) count++;
    }
  }
  return count;
}
