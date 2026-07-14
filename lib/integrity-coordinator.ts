import { randomUUID } from 'node:crypto';
import { listBoardTasks, reconcileBoardReferences, type BoardReferenceIntegrityReport } from './board';
import {
  reconcileChatSessionReferences,
  type ChatReferenceIntegrityReport,
  listChatSessions,
} from './chat-sessions';
import {
  processPendingCloudSyncDeletions,
  reconcileCloudSyncOwnership,
  type CloudSyncOwnershipReport,
} from './cloud-sync';
import { reconcileDataIntegrity, type DataIntegrityReport } from './data-integrity';
import { getDb } from './db';
import {
  reconcileManagedStorage,
  type ManagedStorageReconcileReport,
} from './managed-storage-integrity';
import {
  loadAgents,
  loadConfig,
  mutateAgents,
  updateIntegrationConfig,
  withAgentOwnershipSnapshot,
} from './persistence';
import { clearProjectDefaultAgentIfMatches, listProjects } from './projects';
import type { SandboxReconciliationReport } from './agent-sandbox';
import {
  reconcileBinaryStorageIntegrity,
  type BinaryStorageIntegrityReport,
} from './binary-storage-integrity';
import { reconcileAgentSkillReferences } from './custom-skills';
import {
  reconcileTransientResources,
  type TransientResourceIntegrityReport,
} from './transient-resource-integrity';
import type { WorktreeIntegrityReport } from './worktree-integrity';
import {
  reconcileOwnedXaiResources,
  type OwnedXaiCleanupReport,
} from './external-resource-integrity';
import {
  reconcileXurlCredentialHomes,
  type XurlCredentialIntegrityReport,
} from './mcp';
import type { CapabilityPackRegistryIntegrityReport } from './capability-packs';

const ACTIVE_TASK_STATUSES = [
  'queued',
  'running',
  'paused',
  'waiting_for_input',
  'waiting_for_approval',
  'blocked',
] as const;
const ACTIVE_TASK_SQL = ACTIVE_TASK_STATUSES.map(() => '?').join(', ');
const DEFAULT_INTERVAL_MS = 60 * 60_000;
const DEFAULT_STORAGE_INTERVAL_MS = 24 * 60 * 60_000;
const LEASE_NAME = 'all-data-integrity';
const LEASE_MS = 30 * 60_000;
const REQUEST_LEASE_MS = 30_000;
const ownerId = `${process.pid}:${randomUUID()}`;

interface IntegrityCoordinatorGlobals {
  __shibaIntegrityCoordinatorPass?: Promise<CoordinatedIntegrityReport>;
  __shibaIntegrityCoordinatorTimer?: ReturnType<typeof setInterval>;
  __shibaIntegrityLastStorageAt?: number;
  __shibaIntegrityRepairRetryTimer?: ReturnType<typeof setTimeout>;
  __shibaIntegrityRetryNeedsStorage?: boolean;
  __shibaIntegrityRetryNeedsWorktrees?: boolean;
  __shibaIntegrityRetryNeedsExternal?: boolean;
  __shibaFinishedIntegrityRequests?: Map<string, string | null>;
}

const globals = globalThis as typeof globalThis & IntegrityCoordinatorGlobals;

export interface CoordinatedIntegrityOptions {
  reason?: string;
  includeStorage?: boolean;
  /** Reconcile owned worktrees without running the full managed-storage sweep. */
  includeWorktrees?: boolean;
  nowMs?: number;
  minOrphanAgeMs?: number;
  minTemporaryAgeMs?: number;
  /** Disable network/external mutations during transactional validation. */
  includeExternalCleanup?: boolean;
}

export interface CoordinatedIntegrityReport {
  reason: string;
  startedAt: string;
  completedAt: string;
  skippedBecauseLeaseHeld: boolean;
  agentPeersDetached: number;
  agentSkillsDetached: number;
  integrationMentionAgentsDetached: number;
  projectDefaultAgentsDetached: number;
  database: DataIntegrityReport | null;
  board: BoardReferenceIntegrityReport | null;
  chats: ChatReferenceIntegrityReport | null;
  storage: ManagedStorageReconcileReport | null;
  binaryStorage: BinaryStorageIntegrityReport | null;
  sandboxes: SandboxReconciliationReport | null;
  cloudOwnership: CloudSyncOwnershipReport | null;
  cloudCleanup: { removed: number; pending: number } | null;
  externalXai: OwnedXaiCleanupReport | null;
  xMcpCredentials: XurlCredentialIntegrityReport | null;
  transientResources: TransientResourceIntegrityReport | null;
  worktrees: WorktreeIntegrityReport | null;
  capabilityPackRegistry: CapabilityPackRegistryIntegrityReport | null;
  runTaskProjectionsRepaired: number;
  meetingTaskProjectionsRepaired: number;
  nativeNodeLifecycleRepairs: number;
  harnessGrantLifecycleRepairs: number;
  routineLifecycleRepairs: number;
  integrityRequestsCompleted: number;
}

function ensureLeaseSchema(): void {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_integrity_leases (
      name TEXT PRIMARY KEY,
      ownerId TEXT NOT NULL,
      leaseUntil TEXT NOT NULL,
      acquiredAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS data_integrity_requests (
      id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      availableAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      committedAt TEXT,
      lastError TEXT,
      ownerId TEXT,
      leaseUntil TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_data_integrity_requests_due
      ON data_integrity_requests(status, availableAt, createdAt)
  `);
  const columns = new Set((db.prepare('PRAGMA table_info(data_integrity_requests)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has('ownerId')) db.exec('ALTER TABLE data_integrity_requests ADD COLUMN ownerId TEXT');
  if (!columns.has('leaseUntil')) db.exec('ALTER TABLE data_integrity_requests ADD COLUMN leaseUntil TEXT');
  db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

function claimEligibleIntegrityRequests(passStartedAt: string): string[] {
  const db = getDb();
  const ids = (db.prepare(`
    SELECT id FROM data_integrity_requests
    WHERE status = 'committed'
    ORDER BY createdAt, id
  `).all() as Array<{ id: string }>).map((row) => row.id);
  const prepared = db.prepare(`
    SELECT id, ownerId, leaseUntil, createdAt FROM data_integrity_requests
    WHERE status = 'prepared' AND createdAt <= ?
  `).all(passStartedAt) as Array<{
    id: string;
    ownerId: string | null;
    leaseUntil: string | null;
    createdAt: string;
  }>;
  for (const request of prepared) {
    // A prepared request means the process may still be crossing its JSON or
    // filesystem durability boundary. Only retire it after this successful
    // pass when its writer is legacy/unknown or both its lease and process are
    // gone. A live mutation can therefore run for arbitrarily long safely.
    const legacyLeaseExpired = !request.ownerId
      && request.createdAt <= new Date(new Date(passStartedAt).getTime() - REQUEST_LEASE_MS).toISOString();
    const abandoned = legacyLeaseExpired || (
      Boolean(request.ownerId)
      &&
      Boolean(request.leaseUntil)
      && request.leaseUntil! <= passStartedAt
      && !localOwnerIsAlive(request.ownerId!)
    );
    if (!abandoned) continue;
    ids.push(request.id);
  }
  return ids;
}

function completeClaimedIntegrityRequests(ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const remove = db.prepare('DELETE FROM data_integrity_requests WHERE id = ?');
  let completed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) completed += Number(remove.run(id).changes) || 0;
    db.exec('COMMIT');
    return completed;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

function localOwnerIsAlive(value: string): boolean {
  const pid = Number(value.split(':', 1)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function tryClaimLease(nowMs: number): boolean {
  ensureLeaseSchema();
  const db = getDb();
  const now = new Date(nowMs).toISOString();
  const until = new Date(nowMs + LEASE_MS).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT ownerId, leaseUntil FROM data_integrity_leases WHERE name = ?')
      .get(LEASE_NAME) as { ownerId: string; leaseUntil: string } | undefined;
    const claimable = !current
      || current.ownerId === ownerId
      || current.leaseUntil <= now
      || !localOwnerIsAlive(current.ownerId);
    if (claimable) {
      db.prepare(`
        INSERT INTO data_integrity_leases (name, ownerId, leaseUntil, acquiredAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          ownerId = excluded.ownerId,
          leaseUntil = excluded.leaseUntil,
          acquiredAt = excluded.acquiredAt
      `).run(LEASE_NAME, ownerId, until, now);
    }
    db.exec('COMMIT');
    return claimable;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
}

function releaseLease(): void {
  try {
    getDb().prepare('DELETE FROM data_integrity_leases WHERE name = ? AND ownerId = ?')
      .run(LEASE_NAME, ownerId);
  } catch {
    // A restore/close can already have replaced the handle. The lease has a
    // bounded expiry and a dead-owner check, so it cannot strand maintenance.
  }
}

function renewLease(): void {
  const nowMs = Date.now();
  const result = getDb().prepare(`
    UPDATE data_integrity_leases SET leaseUntil = ?
    WHERE name = ? AND ownerId = ? AND leaseUntil > ?
  `).run(new Date(nowMs + LEASE_MS).toISOString(), LEASE_NAME, ownerId, new Date(nowMs).toISOString());
  if (Number(result.changes) !== 1) throw new Error('Lost the data-integrity maintenance lease');
}

async function reconcileAgentPeers(): Promise<{ ids: Set<string>; detached: number }> {
  const snapshot = await loadAgents();
  const snapshotIds = new Set(snapshot.map((agent) => agent.id));
  const needsRepair = snapshot.some((agent) =>
    agent.peers.some((peerId) => peerId === agent.id || !snapshotIds.has(peerId)));
  if (!needsRepair) return { ids: snapshotIds, detached: 0 };
  return mutateAgents((agents) => {
    const ids = new Set(agents.map((agent) => agent.id));
    let detached = 0;
    for (const agent of agents) {
      const peers = [...new Set(agent.peers)].filter((peerId) => peerId !== agent.id && ids.has(peerId));
      detached += agent.peers.length - peers.length;
      if (peers.length !== agent.peers.length) {
        agent.peers = peers;
        agent.updatedAt = new Date().toISOString();
      }
    }
    return { ids, detached };
  });
}

async function detachMissingProjectDefaults(
  agentIds: ReadonlySet<string>,
): Promise<{ projectIds: Set<string>; detached: number }> {
  const projects = await listProjects();
  let detached = 0;
  for (const project of projects) {
    if (!project.defaultAgentId || agentIds.has(project.defaultAgentId)) continue;
    try {
      if (await clearProjectDefaultAgentIfMatches(
        project.id,
        project.defaultAgentId,
        project.updatedAt,
      )) detached += 1;
    } catch (error) {
      // A concurrent project delete already achieved the ownership invariant.
      if (!/Project not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  return { projectIds: new Set((await listProjects()).map((project) => project.id)), detached };
}

async function detachMissingIntegrationMentionAgents(
  agentIds: ReadonlySet<string>,
): Promise<number> {
  const config = await loadConfig();
  let detached = 0;
  if (config.integrations.slack?.mentionAgentId
    && !agentIds.has(config.integrations.slack.mentionAgentId)) {
    await updateIntegrationConfig('slack', (current) => {
      if (!current?.mentionAgentId || agentIds.has(current.mentionAgentId)) return current;
      const { mentionAgentId: _removed, ...next } = current;
      void _removed;
      detached += 1;
      return next;
    });
  }
  if (config.integrations.discord?.mentionAgentId
    && !agentIds.has(config.integrations.discord.mentionAgentId)) {
    await updateIntegrationConfig('discord', (current) => {
      if (!current?.mentionAgentId || agentIds.has(current.mentionAgentId)) return current;
      const { mentionAgentId: _removed, ...next } = current;
      void _removed;
      detached += 1;
      return next;
    });
  }
  return detached;
}

function liveReferenceSets(): {
  runIds: Set<string>;
  activeSessionIds: Set<string>;
  activeBoardOriginIds: Set<string>;
} {
  const db = getDb();
  const runIds = new Set(
    (db.prepare('SELECT id FROM runs').all() as Array<{ id: string }>).map((row) => row.id),
  );
  const activeRows = db.prepare(`
    SELECT sessionId, originType, originId FROM tasks
    WHERE status IN (${ACTIVE_TASK_SQL})
  `).all(...ACTIVE_TASK_STATUSES) as Array<{
    sessionId: string | null;
    originType: string;
    originId: string | null;
  }>;
  return {
    runIds,
    activeSessionIds: new Set(activeRows.flatMap((row) => row.sessionId ? [row.sessionId] : [])),
    activeBoardOriginIds: new Set(activeRows.flatMap((row) =>
      row.originType === 'board' && row.originId ? [row.originId] : [])),
  };
}

function collectAttachmentFileIds(
  owners: Array<{ messages?: Array<{ attachments?: Array<{ fileId?: string }> }> }>,
): Set<string> {
  const ids = new Set<string>();
  for (const owner of owners) {
    for (const message of owner.messages || []) {
      for (const attachment of message.attachments || []) {
        const id = attachment.fileId?.trim();
        if (id) ids.add(id);
      }
    }
  }
  return ids;
}

async function runCoordinatedIntegrity(
  options: CoordinatedIntegrityOptions,
): Promise<CoordinatedIntegrityReport> {
  const nowMs = options.nowMs ?? Date.now();
  const reason = options.reason?.trim() || 'manual';
  const report: CoordinatedIntegrityReport = {
    reason,
    startedAt: new Date(nowMs).toISOString(),
    completedAt: '',
    skippedBecauseLeaseHeld: false,
    agentPeersDetached: 0,
    agentSkillsDetached: 0,
    integrationMentionAgentsDetached: 0,
    projectDefaultAgentsDetached: 0,
    database: null,
    board: null,
    chats: null,
    storage: null,
    binaryStorage: null,
    sandboxes: null,
    cloudOwnership: null,
    cloudCleanup: null,
    externalXai: null,
    xMcpCredentials: null,
    transientResources: null,
    worktrees: null,
    capabilityPackRegistry: null,
    runTaskProjectionsRepaired: 0,
    meetingTaskProjectionsRepaired: 0,
    nativeNodeLifecycleRepairs: 0,
    harnessGrantLifecycleRepairs: 0,
    routineLifecycleRepairs: 0,
    integrityRequestsCompleted: 0,
  };
  if (!tryClaimLease(nowMs)) {
    report.skippedBecauseLeaseHeld = true;
    report.completedAt = new Date().toISOString();
    return report;
  }
  const claimedRequestIds = claimEligibleIntegrityRequests(report.startedAt);
  let leaseHeartbeatError: unknown;
  const leaseHeartbeat = setInterval(() => {
    try {
      renewLease();
    } catch (error) {
      leaseHeartbeatError = error;
    }
  }, Math.min(60_000, Math.floor(LEASE_MS / 3)));
  leaseHeartbeat.unref?.();
  const assertLease = () => {
    if (leaseHeartbeatError) throw leaseHeartbeatError;
    renewLease();
  };
  try {
    const skills = await reconcileAgentSkillReferences();
    report.agentSkillsDetached = skills.referencesDetached;
    assertLease();
    const agents = await reconcileAgentPeers();
    assertLease();
    report.agentPeersDetached = agents.detached;
    const ownership = await withAgentOwnershipSnapshot(async (currentAgentIds) => {
      const integrationMentionAgentsDetached = await detachMissingIntegrationMentionAgents(currentAgentIds);
      const projects = await detachMissingProjectDefaults(currentAgentIds);
      return { currentAgentIds, integrationMentionAgentsDetached, projects };
    });
    for (const id of ownership.currentAgentIds) agents.ids.add(id);
    report.integrationMentionAgentsDetached = ownership.integrationMentionAgentsDetached;
    const projects = ownership.projects;
    assertLease();
    report.projectDefaultAgentsDetached = projects.detached;
    const sessions = await listChatSessions({ includeArchived: true });
    const sessionIds = new Set(sessions.map((session) => session.id));
    const boardIds = new Set((await listBoardTasks()).map((task) => task.id));

    // Domain projections must be reconstructed before the generic anti-join
    // pass. Otherwise a recoverable run/meeting reference would be detached
    // and its richer lifecycle state would be lost.
    const runs = await import('./agent-runs-store');
    report.runTaskProjectionsRepaired += await runs.repairMissingActiveRunTaskProjections({
      duringMaintenance: true,
    });
    report.runTaskProjectionsRepaired += await runs.repairTerminalRunTaskProjections({
      duringMaintenance: true,
    });
    const meetings = await import('./meetings');
    report.meetingTaskProjectionsRepaired = meetings.repairMissingMeetingTaskProjections();
    report.meetingTaskProjectionsRepaired += meetings.repairMeetingTaskLifecycleProjections();
    const nativeNodes = await import('./native-nodes');
    const nativeNodeRepair = nativeNodes.repairNativeNodeLifecycleProjections(new Date(nowMs));
    report.nativeNodeLifecycleRepairs = nativeNodeRepair.grantsRevoked
      + nativeNodeRepair.jobsFailed
      + nativeNodeRepair.captureStatesReset;
    const harnessGrants = await import('./harness-grants');
    const harnessRepair = harnessGrants.repairHarnessGrantLifecycleProjections(new Date(nowMs));
    report.harnessGrantLifecycleRepairs = harnessRepair.grantsExpired
      + harnessRepair.grantsTerminalized
      + harnessRepair.tasksCancelled;
    const routines = await import('./routines');
    const routineRepair = routines.repairDeletedRoutineTaskProjections();
    report.routineLifecycleRepairs = routineRepair.invocationsSkipped + routineRepair.tasksSettled;
    assertLease();

    // Destructive anti-joins use the union of two snapshots. A concurrent
    // creation can therefore only defer cleanup for one pass; it can never be
    // mistaken for an orphan because it landed between our store reads.
    const latestAgents = await loadAgents();
    for (const agent of latestAgents) agents.ids.add(agent.id);
    const latestProjects = await listProjects();
    for (const project of latestProjects) projects.projectIds.add(project.id);
    const latestSessions = await listChatSessions({ includeArchived: true });
    for (const session of latestSessions) sessionIds.add(session.id);
    for (const task of await listBoardTasks()) boardIds.add(task.id);
    assertLease();

    report.database = await reconcileDataIntegrity({
      reason,
      validAgentIds: agents.ids,
      validBoardIds: boardIds,
      validProjectIds: projects.projectIds,
      validSessionIds: sessionIds,
    });

    const live = liveReferenceSets();
    const staleBefore = new Date(nowMs - 5 * 60_000).toISOString();
    report.board = await reconcileBoardReferences({
      agentIds: agents.ids,
      projectIds: projects.projectIds,
      runIds: live.runIds,
      activeOriginIds: live.activeBoardOriginIds,
      staleWorkingBefore: staleBefore,
    });
    report.chats = await reconcileChatSessionReferences({
      agentIds: agents.ids,
      projectIds: projects.projectIds,
      activeSessionIds: live.activeSessionIds,
      staleRunningBefore: staleBefore,
    });
    assertLease();
    if (options.includeExternalCleanup !== false) {
      report.cloudOwnership = await reconcileCloudSyncOwnership();
      report.cloudCleanup = await processPendingCloudSyncDeletions();
      const liveChatFileIds = collectAttachmentFileIds([
        ...sessions,
        ...latestSessions,
        ...latestProjects,
      ]);
      report.externalXai = await reconcileOwnedXaiResources({ liveChatFileIds, nowMs });
      report.xMcpCredentials = await reconcileXurlCredentialHomes();
      if (report.externalXai.chatFilesTombstoned || report.externalXai.entitySnapshotsTombstoned) {
        scheduleIntegrityRequestRetry(60_000);
      }
      if (report.externalXai.errors.length || report.xMcpCredentials.errors.length) {
        scheduleIntegrityRequestRetry(30_000);
      }
    }
    report.transientResources = await reconcileTransientResources({ nowMs });
    if (report.transientResources.errors.length) scheduleIntegrityRequestRetry(30_000);
    assertLease();

    if (options.includeStorage || options.includeWorktrees) {
      const { reconcileWorktreeResources } = await import('./worktree-integrity');
      const worktrees = await reconcileWorktreeResources();
      report.worktrees = worktrees;
      if (worktrees.errors.length) scheduleIntegrityRequestRetry(30_000, false, true, false);
      if (worktrees.pending > 0) scheduleIntegrityRequestRetry(30_000, false, true, false);
    }
    if (options.includeStorage) {
      const { reconcileCapabilityPackRegistry } = await import('./capability-packs');
      report.capabilityPackRegistry = await reconcileCapabilityPackRegistry({
        nowMs,
        minOrphanAgeMs: options.minOrphanAgeMs,
      });
      report.storage = await reconcileManagedStorage({
        nowMs,
        minOrphanAgeMs: options.minOrphanAgeMs,
        minTemporaryAgeMs: options.minTemporaryAgeMs,
      });
      report.binaryStorage = await reconcileBinaryStorageIntegrity({
        nowMs,
        minOrphanAgeMs: options.minOrphanAgeMs,
      });
      const { reconcileOrphanedSandboxResources } = await import('./agent-sandbox');
      report.sandboxes = await reconcileOrphanedSandboxResources(agents.ids);
      const storageClean = report.storage.errors.length === 0
        && report.binaryStorage.errors.length === 0
        && report.capabilityPackRegistry.errors.length === 0
        && (report.worktrees?.errors.length || 0) === 0
        && report.sandboxes.status === 'ok'
        && report.sandboxes.retryPending === 0;
      if (storageClean) globals.__shibaIntegrityLastStorageAt = nowMs;
      else scheduleIntegrityRequestRetry(30_000, true);
      assertLease();
    }
    report.integrityRequestsCompleted = completeClaimedIntegrityRequests(claimedRequestIds);
    report.completedAt = new Date().toISOString();
    return report;
  } finally {
    clearInterval(leaseHeartbeat);
    releaseLease();
  }
}

/**
 * Converge SQLite, JSON stores, and app-owned storage to their ownership
 * invariants. Concurrent module callers share one pass; a DB-backed lease
 * keeps separate Next server processes from sweeping the same data together.
 */
export function reconcileAllDataIntegrity(
  options: CoordinatedIntegrityOptions = {},
): Promise<CoordinatedIntegrityReport> {
  if (globals.__shibaIntegrityCoordinatorPass) return globals.__shibaIntegrityCoordinatorPass;
  const pass = runCoordinatedIntegrity(options).finally(() => {
    if (globals.__shibaIntegrityCoordinatorPass === pass) {
      globals.__shibaIntegrityCoordinatorPass = undefined;
    }
  });
  globals.__shibaIntegrityCoordinatorPass = pass;
  return pass;
}

/** Mutation hooks wait for a concurrent sweep instead of returning with a
 * short-lived dangling reference. */
export async function reconcileDataIntegrityAfterMutation(
  reason: string,
  options: Omit<CoordinatedIntegrityOptions, 'reason'> = {},
  waitMs = 30_000,
): Promise<CoordinatedIntegrityReport> {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    const report = await reconcileAllDataIntegrity({ ...options, reason });
    if (!report.skippedBecauseLeaseHeld) return report;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for data-integrity maintenance after ${reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export interface IntegrityMutationResult<T> {
  result: T;
  cleanupCompleted: boolean;
  requestId: string;
}

function markIntegrityRequestCommitted(id: string, error?: unknown): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE data_integrity_requests
    SET status = 'committed', committedAt = COALESCE(committedAt, ?),
        availableAt = ?, lastError = ?, leaseUntil = NULL
    WHERE id = ?
  `).run(
    now,
    now,
    error == null ? null : String(error instanceof Error ? error.message : error).slice(0, 4_000),
    id,
  );
}

function rememberFinishedIntegrityRequest(id: string, error?: unknown): void {
  globals.__shibaFinishedIntegrityRequests ??= new Map();
  globals.__shibaFinishedIntegrityRequests.set(
    id,
    error == null ? null : String(error instanceof Error ? error.message : error).slice(0, 4_000),
  );
}

function flushFinishedIntegrityRequests(): void {
  for (const [id, error] of globals.__shibaFinishedIntegrityRequests ?? []) {
    markIntegrityRequestCommitted(id, error);
    globals.__shibaFinishedIntegrityRequests?.delete(id);
  }
}

function scheduleIntegrityRequestRetry(
  delayMs = 5_000,
  includeStorage = false,
  includeWorktrees = false,
  includeExternalCleanup = true,
): void {
  if (includeStorage) globals.__shibaIntegrityRetryNeedsStorage = true;
  if (includeStorage || includeWorktrees) globals.__shibaIntegrityRetryNeedsWorktrees = true;
  if (includeExternalCleanup) globals.__shibaIntegrityRetryNeedsExternal = true;
  if (globals.__shibaIntegrityRepairRetryTimer) return;
  globals.__shibaIntegrityRepairRetryTimer = setTimeout(() => {
    globals.__shibaIntegrityRepairRetryTimer = undefined;
    const retryStorage = Boolean(globals.__shibaIntegrityRetryNeedsStorage);
    const retryWorktrees = Boolean(globals.__shibaIntegrityRetryNeedsWorktrees);
    const retryExternal = Boolean(globals.__shibaIntegrityRetryNeedsExternal);
    globals.__shibaIntegrityRetryNeedsStorage = false;
    globals.__shibaIntegrityRetryNeedsWorktrees = false;
    globals.__shibaIntegrityRetryNeedsExternal = false;
    try {
      flushFinishedIntegrityRequests();
    } catch (error) {
      console.error('[shiba-studio] queued mutation intent finalization failed', error);
      scheduleIntegrityRequestRetry(5_000, retryStorage, retryWorktrees, retryExternal);
      return;
    }
    void reconcileAllDataIntegrity({
      reason: 'queued mutation cleanup',
      includeStorage: retryStorage,
      includeWorktrees: retryWorktrees,
      includeExternalCleanup: retryExternal,
    })
      .then((report) => {
        const pending = Number((getDb().prepare('SELECT COUNT(*) AS count FROM data_integrity_requests')
          .get() as { count: number }).count) || 0;
        if (pending > 0 || report.skippedBecauseLeaseHeld) {
          scheduleIntegrityRequestRetry(5_000, retryStorage, retryWorktrees, retryExternal);
        }
      })
      .catch((error) => {
        console.error('[shiba-studio] queued mutation integrity repair failed', error);
        scheduleIntegrityRequestRetry(30_000, retryStorage, retryWorktrees, retryExternal);
      });
  }, Math.max(250, delayMs));
  globals.__shibaIntegrityRepairRetryTimer.unref?.();
}

/**
 * Queue the follow-up pass required by worktree cleanup's two-phase grace
 * period. Inventory routes use this after discovering a legacy worktree so
 * cleanup still converges when the hourly maintenance pass is not imminent.
 */
export function scheduleWorktreeIntegrityReconciliation(delayMs = 30_000): void {
  scheduleIntegrityRequestRetry(delayMs, false, true, false);
}

/**
 * Write a durable repair intent before a cross-store mutation, then reconcile
 * after it commits. Cleanup failure never turns a successful user mutation
 * into a false API failure; the retained request is retried automatically.
 */
export async function withIntegrityMutation<T>(
  reason: string,
  mutation: () => Promise<T>,
  options: Omit<CoordinatedIntegrityOptions, 'reason'> = {},
): Promise<IntegrityMutationResult<T>> {
  ensureLeaseSchema();
  const requestId = randomUUID();
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + REQUEST_LEASE_MS).toISOString();
  getDb().prepare(`
    INSERT INTO data_integrity_requests (
      id, reason, status, attempts, availableAt, createdAt, committedAt,
      lastError, ownerId, leaseUntil
    ) VALUES (?, ?, 'prepared', 0, ?, ?, NULL, NULL, ?, ?)
  `).run(requestId, reason.slice(0, 500), now, now, ownerId, leaseUntil);
  const heartbeat = setInterval(() => {
    try {
      getDb().prepare(`
        UPDATE data_integrity_requests SET leaseUntil = ?
        WHERE id = ? AND status = 'prepared' AND ownerId = ?
      `).run(new Date(Date.now() + REQUEST_LEASE_MS).toISOString(), requestId, ownerId);
    } catch {
      // The durable request remains; a restore/maintenance fence or the next
      // heartbeat/restart reconciliation will make its state explicit.
    }
  }, REQUEST_LEASE_MS / 3);
  heartbeat.unref?.();
  let result!: T;
  let mutationSucceeded = false;
  let mutationError: unknown;
  try {
    result = await mutation();
    mutationSucceeded = true;
  } catch (error) {
    mutationError = error;
    // The callback may have crossed a JSON/filesystem durability boundary
    // before throwing. Retaining the request is always safe and makes partial
    // completion recoverable.
  } finally {
    clearInterval(heartbeat);
  }
  try {
    markIntegrityRequestCommitted(requestId, mutationError);
  } catch {
    rememberFinishedIntegrityRequest(requestId, mutationError);
    scheduleIntegrityRequestRetry(
      5_000,
      !!options.includeStorage,
      !!options.includeWorktrees,
      options.includeExternalCleanup !== false,
    );
  }
  if (!mutationSucceeded) throw mutationError;
  let cleanupCompleted = false;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const repair = await reconcileDataIntegrityAfterMutation(reason, options);
      const requestRemains = Boolean(getDb().prepare(`
        SELECT 1 FROM data_integrity_requests WHERE id = ?
      `).get(requestId));
      cleanupCompleted = !repair.skippedBecauseLeaseHeld && !requestRemains;
      if (cleanupCompleted) break;
      // The mutation joined a pass that had already captured its exact request
      // set. Start the following pass inline so the API does not unnecessarily
      // return while its cleanup is merely queued.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!cleanupCompleted) {
      scheduleIntegrityRequestRetry(
        250,
        !!options.includeStorage,
        !!options.includeWorktrees,
        options.includeExternalCleanup !== false,
      );
    }
  } catch (error) {
    getDb().prepare(`
      UPDATE data_integrity_requests
      SET attempts = attempts + 1, availableAt = ?, lastError = ?
      WHERE id = ?
    `).run(
      new Date(Date.now() + 5_000).toISOString(),
      String(error instanceof Error ? error.message : error).slice(0, 4_000),
      requestId,
    );
    scheduleIntegrityRequestRetry(
      5_000,
      !!options.includeStorage,
      !!options.includeWorktrees,
      options.includeExternalCleanup !== false,
    );
  }
  return { result, cleanupCompleted, requestId };
}

/** Run lightweight repair hourly and the managed-storage mark/sweep daily. */
export function startDataIntegritySchedule(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (globals.__shibaIntegrityCoordinatorTimer) return;
  const period = Math.max(60_000, Math.floor(Number(intervalMs) || DEFAULT_INTERVAL_MS));
  globals.__shibaIntegrityCoordinatorTimer = setInterval(() => {
    const nowMs = Date.now();
    const includeStorage = nowMs - (globals.__shibaIntegrityLastStorageAt || 0) >= DEFAULT_STORAGE_INTERVAL_MS;
    void reconcileAllDataIntegrity({ reason: 'periodic', includeStorage, includeWorktrees: true, nowMs }).catch((error) => {
      console.error('[shiba-studio] periodic data-integrity repair failed', error);
    });
  }, period);
  globals.__shibaIntegrityCoordinatorTimer.unref?.();
}

export async function stopDataIntegritySchedule(): Promise<void> {
  if (globals.__shibaIntegrityCoordinatorTimer) {
    clearInterval(globals.__shibaIntegrityCoordinatorTimer);
    globals.__shibaIntegrityCoordinatorTimer = undefined;
  }
  if (globals.__shibaIntegrityRepairRetryTimer) {
    clearTimeout(globals.__shibaIntegrityRepairRetryTimer);
    globals.__shibaIntegrityRepairRetryTimer = undefined;
  }
  await globals.__shibaIntegrityCoordinatorPass?.catch(() => undefined);
}
