import * as cron from 'node-cron';

/**
 * Automations intentionally use standard five-field cron expressions.
 * node-cron also accepts a leading seconds field, but durable deduplication
 * and catch-up operate at minute granularity.
 */
export function isSupportedAutomationCron(expression: unknown): boolean {
  if (typeof expression !== 'string') return false;
  const value = expression.trim();
  return value.split(/\s+/).length === 5 && cron.validate(value);
}

export function automationCronError(expression: unknown): string | null {
  return isSupportedAutomationCron(expression)
    ? null
    : 'Invalid cron expression. Automations require exactly five fields: minute hour day month weekday.';
}

export function automationTick(scheduledAt: Date): string {
  if (Number.isNaN(scheduledAt.getTime())) throw new Error('Scheduled execution date is invalid');
  return scheduledAt.toISOString().slice(0, 16);
}
