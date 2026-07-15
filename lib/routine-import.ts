import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { CreateRoutineInput, RoutineTrigger } from './routine-types';

export const ROUTINE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const ROUTINE_PORTABLE_SCHEMA = 'shiba.routine/v1' as const;

export type RoutineImportFormat = 'json' | 'yaml';

export interface RoutineImportSource {
  schema: typeof ROUTINE_PORTABLE_SCHEMA;
  format: RoutineImportFormat;
  originalId: string;
}

export interface RoutineImportResult {
  draft: CreateRoutineInput;
  warnings: string[];
  source: RoutineImportSource;
}

export class RoutineImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutineImportError';
  }
}

const idSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/);

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
}

const jsonValueSchema = z.custom<unknown>((value) => isJsonValue(value), {
  message: 'must contain only JSON-compatible values',
});

const triggerBase = {
  id: idSchema,
  enabled: z.boolean(),
};

const triggerSchema = z.discriminatedUnion('type', [
  z.object({ ...triggerBase, type: z.literal('manual') }).strict(),
  z.object({
    ...triggerBase,
    type: z.literal('schedule'),
    cron: z.string().trim().min(1).max(200),
    timezone: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  z.object({
    ...triggerBase,
    type: z.literal('one_time'),
    at: z.string().trim().min(1).max(100),
  }).strict(),
  z.object({
    ...triggerBase,
    type: z.literal('webhook'),
    secret: z.string().max(10_000).optional(),
  }).strict(),
  z.object({
    ...triggerBase,
    type: z.literal('health'),
    intervalSeconds: z.number().int().positive(),
    timeoutMs: z.number().int().positive().optional(),
    url: z.string().trim().min(1).max(2_000).optional(),
    expectedStatus: z.number().int().min(100).max(599).optional(),
    processPid: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    ...triggerBase,
    type: z.literal('filesystem'),
    path: z.string().trim().min(1).max(2_000),
    intervalSeconds: z.number().int().positive(),
  }).strict(),
  z.object({
    ...triggerBase,
    type: z.literal('integration_event'),
    integration: z.string().trim().min(1).max(200),
    event: z.string().trim().min(1).max(300),
  }).strict(),
]);

const conditionSchema = z.object({
  path: z.string().trim().min(1).max(300),
  operator: z.enum(['exists', 'equals', 'not_equals', 'contains', 'matches']),
  value: jsonValueSchema.optional(),
}).strict();

const stepSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(20_000),
  kind: z.enum(['work', 'code']).optional(),
  dependsOn: z.array(idSchema).max(50).optional(),
}).strict();

const portableRoutineSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  description: z.string().max(5_000),
  enabled: z.boolean(),
  agentId: idSchema,
  prompt: z.string().trim().min(1).max(20_000),
  triggers: z.array(triggerSchema).min(1).max(50),
  conditions: z.array(conditionSchema).max(50),
  parameters: z.record(z.string(), jsonValueSchema),
  retryPolicy: z.object({
    maxAttempts: z.number().int().positive(),
    baseDelayMs: z.number().int().nonnegative(),
    multiplier: z.number().min(1),
    maxDelayMs: z.number().int().nonnegative(),
  }).strict(),
  timeoutMs: z.number().int().positive(),
  concurrencyKey: z.string().trim().min(1).max(300),
  catchUpPolicy: z.enum(['run_once', 'skip']),
  circuitBreaker: z.object({
    failureThreshold: z.number().int().positive(),
    cooldownSeconds: z.number().int().positive(),
  }).strict(),
  steps: z.array(stepSchema).max(50),
}).strict();

const portableEnvelopeSchema = z.object({
  schema: z.literal(ROUTINE_PORTABLE_SCHEMA),
  routine: portableRoutineSchema,
}).strict();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseSource(source: string, format: RoutineImportFormat): unknown {
  if (!source.trim()) throw new RoutineImportError('The selected automation file is empty');
  if (format === 'json') {
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new RoutineImportError('The selected file is not valid JSON');
    }
  }

  try {
    const document = parseDocument(source, {
      schema: 'core',
      customTags: [],
      merge: false,
      prettyErrors: true,
      stringKeys: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new RoutineImportError(`The selected file is not valid YAML: ${document.errors[0].message}`);
    }
    if (document.warnings.length > 0) {
      throw new RoutineImportError(`The selected YAML file is not portable: ${document.warnings[0].message}`);
    }
    return document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    if (error instanceof RoutineImportError) throw error;
    throw new RoutineImportError(`The selected file is not valid YAML: ${error instanceof Error ? error.message : 'parse failed'}`);
  }
}

function issueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'The automation definition is invalid';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

export function routineImportFormat(filename: string): RoutineImportFormat | null {
  const normalized = filename.trim().toLowerCase();
  if (normalized.endsWith('.json')) return 'json';
  if (normalized.endsWith('.yaml') || normalized.endsWith('.yml')) return 'yaml';
  return null;
}

export function parseRoutineImport(
  source: string,
  format: RoutineImportFormat,
  options: { availableAgentIds?: ReadonlySet<string> } = {},
): RoutineImportResult {
  const raw = parseSource(source, format);
  if (!isPlainRecord(raw)) throw new RoutineImportError('The file must contain one exported automation object');
  if (raw.schema !== ROUTINE_PORTABLE_SCHEMA) {
    throw new RoutineImportError(`Unsupported automation schema; expected ${ROUTINE_PORTABLE_SCHEMA}`);
  }
  if (!isPlainRecord(raw.routine)) throw new RoutineImportError('The export is missing its automation definition');

  const validated = portableEnvelopeSchema.safeParse(raw);
  if (!validated.success) {
    throw new RoutineImportError(`The automation export is invalid: ${issueMessage(validated.error)}`);
  }

  const original = validated.data.routine;
  const id = randomUUID();
  const warnings: string[] = [];
  const ownerAvailable = options.availableAgentIds === undefined || options.availableAgentIds.has(original.agentId);
  if (!ownerAvailable) {
    warnings.push('The assigned agent is not available here. Choose an agent before saving.');
  }
  if (original.enabled) {
    warnings.push('The imported automation is paused until you review and enable it.');
  }

  let removedWebhookSecrets = false;
  const triggers: RoutineTrigger[] = original.triggers.map((trigger) => {
    if (trigger.type !== 'webhook') return trigger;
    removedWebhookSecrets = true;
    return { ...trigger, enabled: false, secret: '' };
  });
  if (removedWebhookSecrets) {
    warnings.push('Webhook secrets are never imported. Add a new secret for each webhook trigger before saving.');
  }

  const draft: CreateRoutineInput = {
    id,
    name: original.name,
    description: original.description,
    enabled: false,
    agentId: ownerAvailable ? original.agentId : '',
    prompt: original.prompt,
    triggers,
    conditions: original.conditions,
    parameters: original.parameters as Record<string, unknown>,
    retryPolicy: original.retryPolicy,
    timeoutMs: original.timeoutMs,
    concurrencyKey: original.concurrencyKey === `routine:${original.id}`
      ? `routine:${id}`
      : original.concurrencyKey,
    catchUpPolicy: original.catchUpPolicy,
    circuitBreaker: original.circuitBreaker,
    steps: original.steps,
  };

  return {
    draft,
    warnings,
    source: { schema: ROUTINE_PORTABLE_SCHEMA, format, originalId: original.id },
  };
}
