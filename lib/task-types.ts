/** Shared, serializable types for Shiba's universal task control plane. */

export const TASK_STATUSES = [
  'queued',
  'running',
  'paused',
  'waiting_for_input',
  'waiting_for_approval',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
  'lost',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'lost',
]);

export type TaskKind =
  | 'chat'
  | 'work'
  | 'code'
  | 'routine'
  | 'agent'
  | 'board'
  | 'integration'
  | 'artifact'
  | 'external';

export type TaskOriginType =
  | 'chat'
  | 'run'
  | 'schedule'
  | 'board'
  | 'integration'
  | 'manual'
  | 'api'
  | 'system';

export interface TaskWorkspaceRoot {
  id: string;
  path: string;
  label?: string;
  permission: 'read' | 'write';
  gitRef?: string;
}

export interface TaskPlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  ownerTaskId?: string;
  evidenceIds?: string[];
}

export type EvidenceKind =
  | 'command'
  | 'test'
  | 'build'
  | 'diff'
  | 'artifact'
  | 'screenshot'
  | 'deployment'
  | 'integration'
  | 'human_approval'
  | 'assertion'
  | 'other';

export type EvidenceStatus = 'passed' | 'failed' | 'informational';

export interface CompletionRequirement {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
  acceptedKinds?: EvidenceKind[];
  /** Exact scope this evidence must cover, such as `repo:frontend` or `all-routes`. */
  scope?: string;
  /** Reject evidence older than this many minutes at evaluation time. */
  maxAgeMinutes?: number;
}

export interface CompletionContract {
  outcome: string;
  constraints: string[];
  requiredArtifacts: string[];
  requirements: CompletionRequirement[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvidence {
  id: string;
  taskId: string;
  requirementId?: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  label: string;
  summary: string;
  uri?: string;
  command?: string;
  exitCode?: number;
  scope?: string;
  recordedAt: string;
  metadata: Record<string, unknown>;
}

export interface RequirementEvaluation {
  requirementId: string;
  label: string;
  status: 'proven' | 'failed' | 'missing' | 'stale' | 'scope_mismatch';
  evidenceIds: string[];
  detail?: string;
}

export interface CompletionEvaluation {
  complete: boolean;
  evaluatedAt: string;
  requirements: RequirementEvaluation[];
}

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  title: string;
  description: string;
  parentId?: string;
  originType: TaskOriginType;
  originId?: string;
  agentId?: string;
  projectId?: string;
  runId?: string;
  sessionId?: string;
  workspaceRoots: TaskWorkspaceRoot[];
  plan: TaskPlanStep[];
  progress: number;
  currentStep?: string;
  nextAction?: string;
  retryCount: number;
  maxRetries: number;
  heartbeatAt?: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  contract?: CompletionContract;
  completion?: CompletionEvaluation;
  checkpointId?: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskCheckpointState = 'open' | 'ready';

export interface TaskCheckpointFile {
  workspaceRootId: string;
  workspacePath: string;
  relativePath: string;
  beforeExists: boolean;
  beforeHash?: string;
  beforeBytes: number;
  afterExists?: boolean;
  afterHash?: string;
  afterBytes?: number;
}

export interface TaskCheckpointSnapshot {
  status: TaskStatus;
  plan: TaskPlanStep[];
  progress: number;
  currentStep?: string;
  nextAction?: string;
  taskVersion: number;
  sessionId?: string;
}

/** Immutable pre/post file state for one bounded task mutation. */
export interface TaskCheckpoint {
  id: string;
  taskId: string;
  reason: string;
  state: TaskCheckpointState;
  taskSnapshot: TaskCheckpointSnapshot;
  /** Optional cursors/approval/artifact/browser metadata; never file bytes. */
  context: Record<string, unknown>;
  files: TaskCheckpointFile[];
  createdAt: string;
  sealedAt?: string;
}

export interface TaskCheckpointRestore {
  id: string;
  checkpointId: string;
  taskId: string;
  status: 'restored' | 'conflict' | 'failed';
  restoredPaths: string[];
  conflicts: string[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export type AttentionKind =
  | 'question'
  | 'approval'
  | 'failure'
  | 'completion'
  | 'budget'
  | 'warning';

export type AttentionStatus = 'open' | 'resolved' | 'dismissed';

export interface AttentionItem {
  id: string;
  taskId: string;
  kind: AttentionKind;
  status: AttentionStatus;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  action: Record<string, unknown>;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export type TaskCommandKind =
  | 'steer'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry'
  | 'approve'
  | 'deny';

export interface TaskCommand {
  id: string;
  taskId: string;
  kind: TaskCommandKind;
  status: 'pending' | 'processing' | 'applied' | 'rejected';
  payload: Record<string, unknown>;
  idempotencyKey: string;
  expectedVersion: number;
  createdAt: string;
  appliedAt?: string;
}

export interface TaskOutboxItem {
  id: string;
  taskId: string;
  kind: string;
  target: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  attempts: number;
  availableAt: string;
  createdAt: string;
  deliveredAt?: string;
  lastError?: string;
  idempotencyKey: string;
}

export interface TaskDetails extends TaskRecord {
  children: TaskRecord[];
  evidence: TaskEvidence[];
  attention: AttentionItem[];
  commands: TaskCommand[];
}

export interface CreateTaskInput {
  id?: string;
  kind: TaskKind;
  title: string;
  description?: string;
  status?: TaskStatus;
  parentId?: string;
  originType?: TaskOriginType;
  originId?: string;
  agentId?: string;
  projectId?: string;
  runId?: string;
  sessionId?: string;
  workspaceRoots?: TaskWorkspaceRoot[];
  plan?: TaskPlanStep[];
  maxRetries?: number;
  contract?: Omit<CompletionContract, 'createdAt' | 'updatedAt'> | CompletionContract;
  metadata?: Record<string, unknown>;
}

export interface TaskListOptions {
  statuses?: TaskStatus[];
  kinds?: TaskKind[];
  parentId?: string;
  originType?: TaskOriginType;
  originId?: string;
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}
