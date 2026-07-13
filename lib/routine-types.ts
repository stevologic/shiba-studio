export type RoutineTriggerType =
  | 'schedule'
  | 'one_time'
  | 'webhook'
  | 'manual'
  | 'health'
  | 'filesystem'
  | 'integration_event';

interface RoutineTriggerBase {
  id: string;
  type: RoutineTriggerType;
  enabled: boolean;
}

export interface ScheduleRoutineTrigger extends RoutineTriggerBase {
  type: 'schedule';
  cron: string;
  timezone?: string;
}

export interface OneTimeRoutineTrigger extends RoutineTriggerBase {
  type: 'one_time';
  at: string;
}

export interface WebhookRoutineTrigger extends RoutineTriggerBase {
  type: 'webhook';
  /** Accepted on writes, encrypted at rest, and always redacted from reads/exports. */
  secret?: string;
}

export interface ManualRoutineTrigger extends RoutineTriggerBase {
  type: 'manual';
}

export interface HealthRoutineTrigger extends RoutineTriggerBase {
  type: 'health';
  intervalSeconds: number;
  timeoutMs?: number;
  url?: string;
  expectedStatus?: number;
  processPid?: number;
}

export interface FilesystemRoutineTrigger extends RoutineTriggerBase {
  type: 'filesystem';
  path: string;
  intervalSeconds: number;
}

export interface IntegrationEventRoutineTrigger extends RoutineTriggerBase {
  type: 'integration_event';
  integration: string;
  event: string;
}

export type RoutineTrigger =
  | ScheduleRoutineTrigger
  | OneTimeRoutineTrigger
  | WebhookRoutineTrigger
  | ManualRoutineTrigger
  | HealthRoutineTrigger
  | FilesystemRoutineTrigger
  | IntegrationEventRoutineTrigger;

export interface RoutineCondition {
  path: string;
  operator: 'exists' | 'equals' | 'not_equals' | 'contains' | 'matches';
  value?: unknown;
}

export interface RoutineStep {
  id: string;
  name: string;
  prompt: string;
  kind?: 'work' | 'code';
  dependsOn?: string[];
}

export interface RoutineRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}

/**
 * Immutable execution inputs captured when an invocation is queued. Trigger
 * and circuit-breaker state intentionally remain live operational state.
 */
export interface RoutineExecutionSnapshot {
  schema: 1;
  definitionVersion: number;
  name: string;
  agentId: string;
  prompt: string;
  parameters: Record<string, unknown>;
  retryPolicy: RoutineRetryPolicy;
  timeoutMs: number;
  concurrencyKey: string;
  steps: RoutineStep[];
}

export interface RoutineCircuitBreaker {
  failureThreshold: number;
  cooldownSeconds: number;
}

export type RoutineCatchUpPolicy = 'run_once' | 'skip';
export type RoutineCircuitState = 'closed' | 'open';

export interface RoutineDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  agentId: string;
  prompt: string;
  triggers: RoutineTrigger[];
  conditions: RoutineCondition[];
  parameters: Record<string, unknown>;
  retryPolicy: RoutineRetryPolicy;
  timeoutMs: number;
  concurrencyKey: string;
  catchUpPolicy: RoutineCatchUpPolicy;
  circuitBreaker: RoutineCircuitBreaker;
  steps: RoutineStep[];
  failureStreak: number;
  circuitState: RoutineCircuitState;
  circuitOpenedAt?: string;
  circuitOpenUntil?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoutineInput {
  id?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  agentId: string;
  prompt: string;
  triggers: RoutineTrigger[];
  conditions?: RoutineCondition[];
  parameters?: Record<string, unknown>;
  retryPolicy?: Partial<RoutineRetryPolicy>;
  timeoutMs?: number;
  concurrencyKey?: string;
  catchUpPolicy?: RoutineCatchUpPolicy;
  circuitBreaker?: Partial<RoutineCircuitBreaker>;
  steps?: RoutineStep[];
}

export type RoutineInvocationStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped';

export interface RoutineInvocation {
  id: string;
  routineId: string;
  triggerId: string;
  triggerType: RoutineTriggerType;
  dedupeKey: string;
  concurrencyKey: string;
  status: RoutineInvocationStatus;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  taskId?: string;
  error?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
