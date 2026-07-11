import type { BoardStatus, BoardSyncField, BoardTask } from './board-types';
import type { IntegrationCreds } from './types';

export const BOARD_SYNC_PROVIDERS = ['linear', 'jira'] as const;
export type BoardSyncProvider = (typeof BOARD_SYNC_PROVIDERS)[number];

export const BOARD_SYNC_DIRECTIONS = ['pull', 'push', 'bidirectional'] as const;
export type BoardSyncDirection = (typeof BOARD_SYNC_DIRECTIONS)[number];

export const BOARD_SYNC_MODES = ['tasks', 'board'] as const;
export type BoardSyncMode = (typeof BOARD_SYNC_MODES)[number];

export const BOARD_SYNC_CONFLICT_POLICIES = ['newest', 'local', 'remote'] as const;
export type BoardSyncConflictPolicy = (typeof BOARD_SYNC_CONFLICT_POLICIES)[number];

export interface BoardSyncTarget {
  provider: BoardSyncProvider;
  /** Stable non-secret identity for the connected workspace/site. */
  connectionId?: string;
  /** Stable container identity stored on every external task reference. */
  id: string;
  name: string;
  kind: 'team' | 'project' | 'board';
  key?: string;
  projectKey?: string;
  projectName?: string;
}

/** Provider-neutral remote issue shape used by the sync engine. */
export interface RemoteBoardTask {
  id: string;
  key: string;
  title: string;
  description: string;
  status: BoardStatus;
  statusName: string;
  priority: 0 | 1 | 2 | 3 | 4;
  labels: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardProviderSession {
  provider: BoardSyncProvider;
  target: BoardSyncTarget;
  listTasks(): Promise<RemoteBoardTask[]>;
  createTask(
    task: BoardTask,
    mode: BoardSyncMode,
    /** Lets providers persist a newly-created remote ID before best-effort follow-up work. */
    onCreated?: (task: RemoteBoardTask, pendingFields: BoardSyncField[]) => Promise<void>,
  ): Promise<RemoteBoardTask>;
  updateTask(
    remoteId: string,
    task: BoardTask,
    mode: BoardSyncMode,
    changedFields: BoardSyncField[],
  ): Promise<RemoteBoardTask>;
}

export interface BoardProviderAdapter {
  provider: BoardSyncProvider;
  testConnection(creds: IntegrationCreds): Promise<Record<string, unknown> & { ok: boolean; error?: string }>;
  discoverTargets(creds: IntegrationCreds): Promise<BoardSyncTarget[]>;
  createSession(creds: IntegrationCreds, target: BoardSyncTarget): Promise<BoardProviderSession>;
}

export interface BoardSyncItemError {
  key: string;
  message: string;
}

export interface BoardSyncResult {
  ok: boolean;
  provider: BoardSyncProvider;
  target: BoardSyncTarget;
  direction: BoardSyncDirection;
  mode: BoardSyncMode;
  imported: number;
  exported: number;
  updatedLocal: number;
  updatedRemote: number;
  skipped: number;
  conflicts: number;
  errors: BoardSyncItemError[];
  completedAt: string;
}
