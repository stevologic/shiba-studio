// Kanban board types — shared between the store, API, agent tools, and UI.

export const BOARD_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
] as const;

export type BoardStatus = (typeof BOARD_STATUSES)[number];

export function isBoardStatus(v: unknown): v is BoardStatus {
  return typeof v === 'string' && (BOARD_STATUSES as readonly string[]).includes(v);
}

export const BOARD_STATUS_LABELS: Record<BoardStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Linear-style priorities: 0 none, 1 urgent … 4 low. */
export const BOARD_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type BoardPriority = (typeof BOARD_PRIORITIES)[number];

export const BOARD_PRIORITY_LABELS: Record<BoardPriority, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

export function clampPriority(v: unknown): BoardPriority {
  const n = Number(v);
  return (Number.isInteger(n) && n >= 0 && n <= 4 ? n : 0) as BoardPriority;
}

export interface BoardActivity {
  ts: string;
  /** 'system' for lifecycle events, 'agent' for agent updates, 'user' for user notes. */
  kind: 'system' | 'agent' | 'user';
  text: string;
  /** Agent run behind this event (links to the Automations trace). */
  runId?: string;
  agentName?: string;
}

export type BoardExternalProvider = 'linear' | 'jira';
export type BoardSyncField = 'title' | 'description' | 'status' | 'priority' | 'labels';

/** Stable link between one local card and one remote issue. */
export interface BoardExternalRef {
  provider: BoardExternalProvider;
  /** Stable non-secret identity for the connected workspace/site. */
  connectionId?: string;
  /** Team, project, or Jira board identity used for this sync connection. */
  containerId: string;
  containerName?: string;
  remoteId: string;
  remoteKey: string;
  url: string;
  remoteUpdatedAt: string;
  lastSyncedAt: string;
  /** Fingerprints cover syncable card fields only, never activity/run state. */
  lastLocalFingerprint: string;
  lastRemoteFingerprint: string;
  fingerprintMode?: 'tasks' | 'board';
  /** Per-field baselines let pushes update only fields changed in Shiba. */
  lastLocalFieldFingerprints?: Partial<Record<BoardSyncField, string>>;
  lastRemoteFieldFingerprints?: Partial<Record<BoardSyncField, string>>;
}

export interface BoardSyncState {
  provider: BoardExternalProvider;
  containerId: string;
  containerName?: string;
  direction: 'pull' | 'push' | 'bidirectional';
  mode: 'tasks' | 'board';
  completedAt: string;
  imported: number;
  exported: number;
  updatedLocal: number;
  updatedRemote: number;
  skipped: number;
  conflicts: number;
  errors: number;
}

/**
 * Durable reaction to one assignee change. A new id is minted every time the
 * card is assigned to a different agent, so a reload can resume the reaction
 * without ever accepting the same assignment twice.
 */
export interface BoardAutoAssignment {
  id: string;
  agentId: string;
  status: 'pending' | 'disabled' | 'accepted';
  requestedAt: string;
  updatedAt: string;
}

/** The exact durable task currently executing this card. */
export interface BoardWorkClaim {
  id: string;
  taskId: string;
  agentId: string;
  mode: 'manual' | 'automatic' | 'refinement';
  assignmentId?: string;
  feedback?: string;
  requestedAt: string;
  /**
   * Cancellation is a durable two-phase handoff. The Board retains this
   * claim (and therefore the agent-wide busy fence) until the task ledger has
   * accepted the cancellation and projected a terminal state back here.
   */
  cancelRequestId?: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
}

export interface BoardTask {
  id: string;
  /** Human key like SHIB-12 — stable, never reused. */
  key: string;
  title: string;
  description: string;
  status: BoardStatus;
  priority: BoardPriority;
  /** Agent assigned to work this card (null = unassigned). */
  assigneeAgentId: string | null;
  /** Project this card belongs to (null = none). Drives the run's workspace
   *  and context when the card is dispatched. */
  projectId?: string | null;
  labels: string[];
  /** Sort position within the column (fractional inserts allowed). */
  order: number;
  activity: BoardActivity[];
  /** Agent runs dispatched for this card. */
  runIds: string[];
  /** True while a dispatched run is executing. */
  working?: boolean;
  /** Pending/settled reaction for the current assignee generation. */
  autoAssignment?: BoardAutoAssignment;
  /** Fences run completion to the exact accepted work generation. */
  activeWork?: BoardWorkClaim;
  /** Changes only when a provider-syncable field changes. */
  syncUpdatedAt?: string;
  /** A card can be mirrored to Linear, Jira, or both. */
  externalRefs?: BoardExternalRef[];
  createdAt: string;
  updatedAt: string;
}

export interface BoardStore {
  /** Monotonic counter behind the SHIB-# keys. */
  nextNumber: number;
  tasks: BoardTask[];
  syncState?: Partial<Record<BoardExternalProvider, BoardSyncState>>;
}
