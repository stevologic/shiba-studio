import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getDb } from './db';
import { loadAgents } from './persistence';
import {
  assignTaskExecution,
  createTaskInOpenTransaction,
  getTask,
  getTaskDetails,
  listAttention,
  publishTaskChanges,
  recordTaskEvidence,
  requestTaskAttention,
  resolveAttention,
  transitionTask,
  transitionTaskInOpenTransaction,
} from './task-ledger';
import type { CreateTaskInput, TaskRecord, TaskWorkspaceRoot } from './task-types';
import type { Agent } from './types';
import { isAutomationMaintenanceActive } from './automation-maintenance';

export interface TeamWorkerSpec {
  key: string;
  title: string;
  instructions: string;
  agentId: string;
  dependsOn?: string[];
  workspaceRootIds: string[];
  readOnly?: boolean;
  required?: boolean;
  maxTurns?: number;
  tokenCap?: number;
  timeoutSeconds?: number;
  integrationScopes?: string[];
  /** Optional exact tool-name allowlist. Omitted means the normal worker tools. */
  allowedTools?: string[];
}

export interface TeamGraphNode {
  task: TaskRecord;
  key: string;
  dependencies: string[];
  claim?: { ownerId: string; leaseUntil: string; attempt: number };
}

interface DependencyRow { taskId: string; dependsOnTaskId: string }
interface ClaimRow {
  taskId: string;
  ownerId: string;
  leaseUntil: string;
  attempt: number;
  status: string;
  createdAt: string;
  parentId?: string | null;
}

export interface TeamWorkerClaimReconciliation {
  released: number;
  errors: number;
  parentTaskIds: string[];
  redispatchedParents: number;
}

interface TeamWorkerGlobals {
  __shibaTeamWorkerControllers?: Map<string, AbortController>;
  __shibaTeamWorkerInstanceId?: string;
  __shibaTeamRedispatchTimers?: Map<string, ReturnType<typeof setTimeout>>;
  __shibaTeamClaimReconciler?: ReturnType<typeof setInterval>;
  __shibaTeamClaimReconcilePromise?: Promise<TeamWorkerClaimReconciliation>;
  __shibaTeamWorkerDispatches?: Set<Promise<void>>;
}

const teamGlobals = globalThis as typeof globalThis & TeamWorkerGlobals;
const workerControllers = teamGlobals.__shibaTeamWorkerControllers
  ?? (teamGlobals.__shibaTeamWorkerControllers = new Map<string, AbortController>());
const instanceId = teamGlobals.__shibaTeamWorkerInstanceId
  ?? (teamGlobals.__shibaTeamWorkerInstanceId = `${process.pid}-${randomUUID()}`);
const redispatchTimers = teamGlobals.__shibaTeamRedispatchTimers
  ?? (teamGlobals.__shibaTeamRedispatchTimers = new Map<string, ReturnType<typeof setTimeout>>());
const workerDispatches = teamGlobals.__shibaTeamWorkerDispatches
  ?? (teamGlobals.__shibaTeamWorkerDispatches = new Set<Promise<void>>());

function scheduleTeamRedispatch(parentTaskId: string): void {
  if (redispatchTimers.has(parentTaskId) || isAutomationMaintenanceActive()) return;
  const timer = setTimeout(() => {
    redispatchTimers.delete(parentTaskId);
    if (isAutomationMaintenanceActive()) return;
    void dispatchReadyTeamWorkers(parentTaskId).catch((error) => {
      console.error('[task-teams] deferred worker dispatch failed', error);
    });
  }, 1_000);
  timer.unref?.();
  redispatchTimers.set(parentTaskId, timer);
}

function ensureSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      dependsOnTaskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL,
      PRIMARY KEY(taskId, dependsOnTaskId),
      CHECK(taskId <> dependsOnTaskId)
    );
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_parent ON task_dependencies(dependsOnTaskId);
    CREATE TABLE IF NOT EXISTS task_worker_claims (
      taskId TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      ownerId TEXT NOT NULL,
      status TEXT NOT NULL,
      leaseUntil TEXT NOT NULL,
      heartbeatAt TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      releasedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_worker_claims_lease ON task_worker_claims(status, leaseUntil);
  `);
}

function validateSpecs(specs: TeamWorkerSpec[]): void {
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > 12) throw new Error('A team requires between 1 and 12 workers');
  const keys = new Set<string>();
  for (const worker of specs) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(worker.key)) throw new Error(`Invalid worker key: ${worker.key}`);
    if (keys.has(worker.key)) throw new Error(`Duplicate worker key: ${worker.key}`);
    keys.add(worker.key);
    if (!worker.title.trim() || !worker.instructions.trim()) throw new Error(`Worker ${worker.key} needs a title and instructions`);
    if (!worker.agentId.trim()) throw new Error(`Worker ${worker.key} needs an agent`);
    if (!worker.workspaceRootIds?.length) throw new Error(`Worker ${worker.key} needs at least one workspace root`);
    const integrationScopes = worker.integrationScopes || [];
    for (const scope of integrationScopes) {
      if (!/^(github|slack|googledrive|discord|x|reddit|obsidian|vercel|netlify|browser|native|web|mcp(?::[A-Za-z0-9._-]{1,160})?)$/.test(String(scope).trim().toLowerCase())) {
        throw new Error(`Worker ${worker.key} requested invalid integration scope: ${scope}`);
      }
    }
    for (const tool of worker.allowedTools || []) {
      if (!/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(String(tool).trim())) throw new Error(`Worker ${worker.key} requested invalid tool name: ${tool}`);
    }
  }
  for (const worker of specs) {
    for (const dependency of worker.dependsOn || []) {
      if (!keys.has(dependency)) throw new Error(`Worker ${worker.key} depends on unknown worker ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(specs.map((worker) => [worker.key, worker]));
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error('Worker dependency graph contains a cycle');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn || []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const worker of specs) visit(worker.key);
}

export async function createTaskTeam(parentTaskId: string, specs: TeamWorkerSpec[]): Promise<TeamGraphNode[]> {
  ensureSchema();
  validateSpecs(specs);
  const parent = getTask(parentTaskId);
  if (!parent) throw new Error('Parent task not found');
  if (['succeeded', 'failed', 'cancelled', 'lost'].includes(parent.status)) throw new Error('Cannot add a team to a terminal task');
  const agents = await loadAgents();
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const roots = new Map(parent.workspaceRoots.map((root) => [root.id, root]));

  // Validate every external grant before the first durable mutation. This is
  // intentionally a separate pass: a bad later spec must not leave earlier
  // workers attached to the parent.
  const taskInputs = new Map<string, CreateTaskInput>();
  for (const spec of specs) {
    const agentId = spec.agentId.trim();
    const agent = agentsById.get(agentId);
    if (!agent) throw new Error(`Worker agent not found: ${spec.agentId}`);
    if (String(agent.model).startsWith('cli:')) {
      throw new Error(`Worker ${spec.key} uses a CLI-model agent that cannot enforce team grants`);
    }
    const workerRoots: TaskWorkspaceRoot[] = spec.workspaceRootIds.map((id) => {
      const root = roots.get(id);
      if (!root) throw new Error(`Worker ${spec.key} requested unknown workspace root ${id}`);
      if (!spec.readOnly && root.permission !== 'write') throw new Error(`Writer ${spec.key} cannot claim read-only root ${id}`);
      return { ...root, permission: spec.readOnly ? 'read' : root.permission };
    });
    taskInputs.set(spec.key, {
      id: `worker-${randomUUID()}`,
      kind: spec.readOnly ? 'work' : 'code',
      parentId: parent.id,
      title: spec.title,
      description: spec.instructions,
      status: 'queued',
      originType: 'system',
      originId: parent.id,
      agentId,
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      workspaceRoots: workerRoots,
      maxRetries: 2,
      metadata: {
        teamWorkerKey: spec.key,
        required: spec.required !== false,
        readOnly: !!spec.readOnly,
        maxTurns: Math.max(1, Math.min(18, Number(spec.maxTurns) || 12)),
        tokenCap: Math.max(0, Math.floor(Number(spec.tokenCap) || 0)),
        timeoutSeconds: Math.max(30, Math.min(3_600, Number(spec.timeoutSeconds) || 900)),
        integrationScopes: [...new Set((spec.integrationScopes || []).map((scope) => String(scope).trim().toLowerCase()))].slice(0, 30),
        ...(spec.allowedTools
          ? { allowedTools: [...new Set(spec.allowedTools.map((tool) => String(tool).trim().toLowerCase()))].slice(0, 100) }
          : {}),
      },
    });
  }

  const db = getDb();
  const childByKey = new Map<string, TaskRecord>();
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentParent = getTask(parent.id);
    if (!currentParent) throw new Error('Parent task not found');
    if (currentParent.version !== parent.version) throw new Error('Parent task changed concurrently; reload and retry');
    if (['succeeded', 'failed', 'cancelled', 'lost'].includes(currentParent.status)) {
      throw new Error('Cannot add a team to a terminal task');
    }
    for (const spec of specs) {
      childByKey.set(spec.key, createTaskInOpenTransaction(taskInputs.get(spec.key)!));
    }
    const now = new Date().toISOString();
    const insertDependency = db.prepare(`
      INSERT INTO task_dependencies (taskId, dependsOnTaskId, createdAt) VALUES (?, ?, ?)
    `);
    for (const spec of specs) {
      for (const dependency of spec.dependsOn || []) {
        insertDependency.run(childByKey.get(spec.key)!.id, childByKey.get(dependency)!.id, now);
      }
    }
    if (currentParent.status === 'queued') {
      transitionTaskInOpenTransaction({
        taskId: currentParent.id,
        status: 'running',
        expectedVersion: currentParent.version,
        currentStep: 'Coordinating specialist workers',
      });
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
  publishTaskChanges();
  return getTaskTeam(parent.id);
}

export function getTaskTeam(parentTaskId: string): TeamGraphNode[] {
  ensureSchema();
  const details = getTaskDetails(parentTaskId);
  if (!details) throw new Error('Parent task not found');
  const dependencies = getDb().prepare(`
    SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.taskId WHERE t.parentId = ?
  `).all(parentTaskId) as DependencyRow[];
  const claims = getDb().prepare(`
    SELECT c.* FROM task_worker_claims c JOIN tasks t ON t.id = c.taskId
    WHERE t.parentId = ? AND c.status = 'active' AND c.leaseUntil > ?
  `).all(parentTaskId, new Date().toISOString()) as ClaimRow[];
  return details.children.filter((task) => typeof task.metadata.teamWorkerKey === 'string').map((task) => ({
    task,
    key: String(task.metadata.teamWorkerKey || task.id),
    dependencies: dependencies.filter((row) => row.taskId === task.id).map((row) => row.dependsOnTaskId),
    ...(claims.find((row) => row.taskId === task.id)
      ? { claim: (() => { const row = claims.find((item) => item.taskId === task.id)!; return { ownerId: row.ownerId, leaseUntil: row.leaseUntil, attempt: row.attempt }; })() }
      : {}),
  }));
}

function claimWorker(task: TaskRecord): number | null {
  if (isAutomationMaintenanceActive()) return null;
  ensureSchema();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 2 * 60_000).toISOString();
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT * FROM task_worker_claims WHERE taskId = ?').get(task.id) as ClaimRow | undefined;
    if (existing?.status === 'active' && Date.parse(existing.leaseUntil) > now.getTime()) {
      db.exec('COMMIT');
      return null;
    }
    const attempt = (existing?.attempt || 0) + 1;
    db.prepare(`
      INSERT INTO task_worker_claims (taskId, ownerId, status, leaseUntil, heartbeatAt, attempt, createdAt, releasedAt)
      VALUES (?, ?, 'active', ?, ?, ?, ?, NULL)
      ON CONFLICT(taskId) DO UPDATE SET ownerId = excluded.ownerId, status = 'active',
        leaseUntil = excluded.leaseUntil, heartbeatAt = excluded.heartbeatAt,
        attempt = excluded.attempt, releasedAt = NULL
    `).run(task.id, instanceId, leaseUntil, now.toISOString(), attempt, existing ? existing.createdAt : now.toISOString());
    db.exec('COMMIT');
    return attempt;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
}

function releaseWorker(taskId: string, attempt: number): void {
  getDb().prepare("UPDATE task_worker_claims SET status = 'released', releasedAt = ? WHERE taskId = ? AND ownerId = ? AND attempt = ?")
    .run(new Date().toISOString(), taskId, instanceId, attempt);
}

/**
 * Abort a worker after its active-time budget is exhausted. Durable
 * cooperative pauses do not consume the budget, so a user can inspect or
 * steer a paused worker without turning the pause itself into a failure.
 */
export function startPauseAwareWorkerBudget(
  taskId: string,
  controller: AbortController,
  budgetMs: number,
  pollIntervalMs = 250,
): () => void {
  let remainingMs = Math.max(1, Math.floor(Number(budgetMs) || 1));
  const period = Math.max(10, Math.min(1_000, Math.floor(Number(pollIntervalMs) || 250)));
  let previousAt = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const elapsed = Math.max(0, now - previousAt);
    previousAt = now;
    if (controller.signal.aborted) {
      clearInterval(timer);
      return;
    }
    let paused = false;
    try {
      paused = getTask(taskId)?.status === 'paused';
    } catch {
      // A maintenance fence can temporarily make the projection unavailable.
      // Conservatively preserve budget until it can be read again.
      return;
    }
    if (paused) return;
    remainingMs -= elapsed;
    if (remainingMs <= 0) {
      clearInterval(timer);
      controller.abort(new Error('Worker time budget exceeded'));
    }
  }, period);
  timer.unref?.();
  return () => clearInterval(timer);
}

function deferWorkerForCapacity(taskId: string): boolean {
  let current = getTask(taskId);
  if (!current || ['succeeded', 'cancelled'].includes(current.status)) return false;
  if (!['queued', 'failed', 'lost'].includes(current.status)) {
    current = transitionTask({
      taskId: current.id,
      status: 'failed',
      expectedVersion: current.version,
      error: 'Concurrent-run limit reached; waiting for an available worker slot.',
    });
  }
  if (current.status === 'failed' || current.status === 'lost') {
    transitionTask({
      taskId: current.id,
      status: 'queued',
      expectedVersion: current.version,
      error: null,
      currentStep: 'Waiting for an available worker slot',
    });
  }
  return true;
}

function runTeamLeaseHeartbeatTick(controller: AbortController, renew: () => boolean): void {
  try {
    if (!renew()) controller.abort(new Error('Worker lease ownership was lost'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    controller.abort(new Error(`Worker lease heartbeat failed: ${message}`, { cause: error }));
  }
}

export const teamWorkerRuntimeTestHooks = { runTeamLeaseHeartbeatTick };

async function runWorker(parentId: string, task: TaskRecord): Promise<void> {
  if (isAutomationMaintenanceActive()) return;
  const claimAttempt = claimWorker(task);
  if (claimAttempt == null) return;
  let controller: AbortController | undefined;
  let stopTimeBudget: (() => void) | undefined;
  let renewLease: ReturnType<typeof setInterval> | undefined;
  let capacityDeferred = false;
  try {
    const agents = await loadAgents();
    const baseAgent = agents.find((agent) => agent.id === task.agentId);
    if (!baseAgent) {
      transitionTask({ taskId: task.id, status: 'failed', error: 'Assigned worker agent no longer exists.' });
      return;
    }
    if (String(baseAgent.model).startsWith('cli:')) {
      transitionTask({
        taskId: task.id,
        status: 'failed',
        error: 'CLI-model agents cannot enforce per-worker workspace, tool, and integration grants; use the scoped external harness instead.',
      });
      return;
    }
    const readOnly = !!task.metadata.readOnly;
    const grantedIntegrationScopes = new Set(
      (Array.isArray(task.metadata.integrationScopes) ? task.metadata.integrationScopes : [])
        .map(String).map((scope) => scope.toLowerCase()),
    );
    const scopedIntegrations: Agent['integrations'] = {
      github: baseAgent.integrations.github && grantedIntegrationScopes.has('github'),
      slack: baseAgent.integrations.slack && grantedIntegrationScopes.has('slack'),
      googledrive: baseAgent.integrations.googledrive && grantedIntegrationScopes.has('googledrive'),
      discord: baseAgent.integrations.discord && grantedIntegrationScopes.has('discord'),
      x: baseAgent.integrations.x && grantedIntegrationScopes.has('x'),
      reddit: baseAgent.integrations.reddit && grantedIntegrationScopes.has('reddit'),
      obsidian: baseAgent.integrations.obsidian && grantedIntegrationScopes.has('obsidian'),
      vercel: baseAgent.integrations.vercel && grantedIntegrationScopes.has('vercel'),
      netlify: baseAgent.integrations.netlify && grantedIntegrationScopes.has('netlify'),
    };
    const runId = randomUUID();
    const workerAgent: Agent = readOnly
      ? { ...baseAgent, integrations: scopedIntegrations, workspace: { ...baseAgent.workspace, path: task.workspaceRoots[0]?.path || baseAgent.workspace.path, useWorktree: false } }
      : { ...baseAgent, id: `${baseAgent.id}-${task.id.slice(-8)}`, integrations: scopedIntegrations, workspace: { ...baseAgent.workspace, path: task.workspaceRoots[0]?.path || baseAgent.workspace.path, useWorktree: true } };
    controller = new AbortController();
    workerControllers.set(task.id, controller);
    const assigned = assignTaskExecution({ taskId: task.id, runId, agentId: baseAgent.id, expectedVersion: task.version });
    const running = transitionTask({ taskId: task.id, status: 'running', expectedVersion: assigned.version, currentStep: 'Starting specialist worker' });
    stopTimeBudget = startPauseAwareWorkerBudget(
      task.id,
      controller,
      Number(task.metadata.timeoutSeconds || 900) * 1_000,
    );
    renewLease = setInterval(() => {
      runTeamLeaseHeartbeatTick(controller!, () => {
        const now = new Date();
        const renewed = getDb().prepare(`
          UPDATE task_worker_claims SET leaseUntil = ?, heartbeatAt = ?
          WHERE taskId = ? AND ownerId = ? AND attempt = ? AND status = 'active'
        `).run(new Date(now.getTime() + 2 * 60_000).toISOString(), now.toISOString(), task.id, instanceId, claimAttempt);
        return Number(renewed.changes) === 1;
      });
    }, 30_000);
    renewLease.unref?.();
    const { runAgentOnce } = await import('./agent-runtime');
    const run = await runAgentOnce(workerAgent, task.description, {
      taskId: task.id,
      runId,
      attemptNo: running.retryCount + 1,
      readOnly,
      maxTurns: Number(task.metadata.maxTurns || 12),
      tokenCap: Number(task.metadata.tokenCap || 0),
      signal: controller.signal,
      projectId: task.projectId,
    });
    if (run.status === 'error' && /Concurrent-run limit reached/i.test(run.finalOutput || '')) {
      capacityDeferred = deferWorkerForCapacity(task.id);
      return;
    }
    if (run.status === 'completed') {
      recordTaskEvidence({
        taskId: task.id,
        kind: 'assertion',
        status: 'passed',
        label: 'Specialist worker result',
        summary: (run.finalOutput || 'Worker completed with recorded tool evidence.').slice(0, 10_000),
        scope: task.workspaceRoots[0]?.id,
        metadata: { runId: run.id, workerKey: task.metadata.teamWorkerKey },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = getTask(task.id);
    if (/Concurrent-run limit reached/i.test(message)) {
      capacityDeferred = deferWorkerForCapacity(task.id);
    } else if (current && !['succeeded', 'failed', 'cancelled', 'lost'].includes(current.status)) {
      transitionTask({ taskId: task.id, status: controller?.signal.aborted ? 'lost' : 'failed', error: message });
    }
  } finally {
    stopTimeBudget?.();
    if (renewLease) clearInterval(renewLease);
    workerControllers.delete(task.id);
    try { releaseWorker(task.id, claimAttempt); } catch { /* maintenance/restart will expire the lease */ }
    if (capacityDeferred) scheduleTeamRedispatch(parentId);
    else await dispatchReadyTeamWorkers(parentId);
  }
}

function launchTrackedWorker(parentTaskId: string, task: TaskRecord): void {
  const operation = runWorker(parentTaskId, task).catch((error) => {
    console.error('[task-teams] worker dispatch failed', error);
    scheduleTeamRedispatch(parentTaskId);
  }).finally(() => {
    workerDispatches.delete(operation);
  });
  workerDispatches.add(operation);
}

export async function dispatchReadyTeamWorkers(parentTaskId: string): Promise<string[]> {
  if (isAutomationMaintenanceActive()) return [];
  let parentTask = getTask(parentTaskId);
  if (!parentTask || ['succeeded', 'failed', 'cancelled', 'lost'].includes(parentTask.status)) return [];
  let graph = getTaskTeam(parentTaskId);
  let byId = new Map(graph.map((node) => [node.task.id, node.task]));
  const dependenciesReady = (node: TeamGraphNode) => (
    node.dependencies.every((id) => byId.get(id)?.status === 'succeeded')
  );
  const recoverable = graph.some((node) => (
    (node.task.status === 'queued' || node.task.status === 'blocked') && dependenciesReady(node)
  ));
  if (parentTask.status === 'blocked' && recoverable) {
    parentTask = transitionTask({
      taskId: parentTask.id,
      status: 'running',
      expectedVersion: parentTask.version,
      error: null,
      currentStep: 'Coordinating retried specialist workers',
    });
    for (const item of listAttention({ taskId: parentTask.id, status: 'open' }).items) {
      if (item.dedupeKey === 'team-workers-blocked') resolveAttention(item.id);
    }
  }
  for (const node of graph) {
    if (node.task.status !== 'blocked' || !dependenciesReady(node)) continue;
    transitionTask({
      taskId: node.task.id,
      status: 'queued',
      expectedVersion: node.task.version,
      error: null,
      currentStep: 'Dependencies recovered; waiting to run',
    });
  }
  if (graph.some((node) => node.task.status === 'blocked' && dependenciesReady(node))) {
    graph = getTaskTeam(parentTaskId);
    byId = new Map(graph.map((node) => [node.task.id, node.task]));
  }
  const [{ activeRunCount, maxConcurrentRuns }, { loadConfig }] = await Promise.all([
    import('./run-guards'),
    import('./persistence'),
  ]);
  const config = await loadConfig();
  if (isAutomationMaintenanceActive()) return [];
  const availableSlots = Math.max(0, maxConcurrentRuns(config) - activeRunCount());
  const started: string[] = [];
  let capacityDeferred = false;
  for (const node of graph) {
    if (isAutomationMaintenanceActive()) break;
    if (node.task.status !== 'queued' || node.claim) continue;
    const nodeDependenciesReady = node.dependencies.every((id) => byId.get(id)?.status === 'succeeded');
    const dependencyFailed = node.dependencies.some((id) => {
      const status = byId.get(id)?.status;
      return status === 'failed' || status === 'lost' || status === 'cancelled';
    });
    if (dependencyFailed) {
      transitionTask({ taskId: node.task.id, status: 'blocked', error: 'A required dependency did not succeed.' });
      continue;
    }
    if (!nodeDependenciesReady) continue;
    if (started.length >= availableSlots) {
      capacityDeferred = true;
      break;
    }
    started.push(node.task.id);
    launchTrackedWorker(parentTaskId, node.task);
  }
  const refreshed = getTaskTeam(parentTaskId);
  const allTerminal = refreshed.length > 0 && refreshed.every((node) => ['succeeded', 'failed', 'cancelled', 'lost', 'blocked'].includes(node.task.status));
  if (allTerminal) {
    const parent = getTask(parentTaskId);
    const failed = refreshed.filter((node) => node.task.metadata.required !== false && node.task.status !== 'succeeded');
    const optionalFailed = refreshed.filter((node) => node.task.metadata.required === false && node.task.status !== 'succeeded');
    if (parent && !['succeeded', 'failed', 'cancelled', 'lost'].includes(parent.status)) {
      if (failed.length) {
        transitionTask({ taskId: parent.id, status: 'blocked', error: `${failed.length} required worker${failed.length === 1 ? '' : 's'} did not succeed.` });
        requestTaskAttention({
          taskId: parent.id,
          kind: 'failure',
          severity: 'critical',
          title: `${parent.title} has blocked workers`,
          body: failed.map((node) => `${node.key}: ${node.task.status}`).join('\n'),
          dedupeKey: 'team-workers-blocked',
        });
      } else {
        const evaluation = (await import('./task-ledger')).evaluateTaskCompletion(parent.id, true);
        if (evaluation.complete) transitionTask({
          taskId: parent.id,
          status: 'succeeded',
          result: `All required workers completed with evidence.${optionalFailed.length ? ` ${optionalFailed.length} optional worker${optionalFailed.length === 1 ? '' : 's'} did not complete.` : ''}`,
        });
        else transitionTask({ taskId: parent.id, status: 'waiting_for_approval', currentStep: 'Worker results collected', nextAction: 'Review remaining completion-contract evidence' });
      }
    }
  }
  if (capacityDeferred) scheduleTeamRedispatch(parentTaskId);
  return started;
}

function reconcileTeamWorkerClaimsDetailed(): TeamWorkerClaimReconciliation {
  if (isAutomationMaintenanceActive()) {
    return { released: 0, errors: 0, parentTaskIds: [], redispatchedParents: 0 };
  }
  ensureSchema();
  const now = new Date().toISOString();
  const expired = getDb().prepare(`
    SELECT c.*, t.parentId AS parentId FROM task_worker_claims c
    JOIN tasks t ON t.id = c.taskId
    WHERE c.status = 'active'
      AND (c.leaseUntil <= ? OR t.status IN ('succeeded', 'failed', 'cancelled', 'lost'))
  `).all(now) as ClaimRow[];
  let released = 0;
  let errors = 0;
  const parentTaskIds = new Set<string>();
  for (const claim of expired) {
    try {
      // Fence the update by ownership generation and re-check expiry. A live
      // worker may renew between the candidate SELECT and this UPDATE.
      const result = getDb().prepare(`
        UPDATE task_worker_claims SET status = 'released', releasedAt = ?
        WHERE taskId = ? AND ownerId = ? AND attempt = ? AND status = 'active'
          AND (
            leaseUntil <= ?
            OR EXISTS (
              SELECT 1 FROM tasks t
              WHERE t.id = task_worker_claims.taskId
                AND t.status IN ('succeeded', 'failed', 'cancelled', 'lost')
            )
          )
      `).run(now, claim.taskId, claim.ownerId, claim.attempt, now);
      if (Number(result.changes) !== 1) continue;
      released += 1;
      if (claim.parentId) parentTaskIds.add(claim.parentId);
      const task = getTask(claim.taskId);
      if (task && ['running', 'paused', 'waiting_for_input', 'waiting_for_approval'].includes(task.status)) {
        try {
          transitionTask({
            taskId: task.id,
            status: 'lost',
            expectedVersion: task.version,
            error: 'Worker claim lease expired before completion.',
          });
        } catch (error) {
          if (!/concurrently|Invalid task transition/i.test(error instanceof Error ? error.message : String(error))) {
            throw error;
          }
        }
      }
    } catch (error) {
      errors += 1;
      console.error('[task-teams] failed to reconcile worker claim', {
        taskId: claim.taskId,
        ownerId: claim.ownerId,
        attempt: claim.attempt,
        error,
      });
    }
  }
  // A process can die after queueing a worker (or after releasing a capacity-
  // deferred claim) but before its in-memory redispatch timer fires. Revisit
  // every unclaimed queued team parent so that intent remains durable even
  // when no lease has technically expired in this pass.
  const queuedCandidates = getDb().prepare(`
    SELECT t.id, t.parentId, t.metadata FROM tasks t
    WHERE t.status = 'queued' AND t.parentId IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM task_worker_claims c
        WHERE c.taskId = t.id AND c.status = 'active' AND c.leaseUntil > ?
      )
    LIMIT 500
  `).all(now) as Array<{ id: string; parentId: string; metadata: string }>;
  for (const candidate of queuedCandidates) {
    try {
      const metadata = JSON.parse(candidate.metadata || '{}') as Record<string, unknown>;
      if (typeof metadata.teamWorkerKey === 'string') parentTaskIds.add(candidate.parentId);
    } catch {
      // Invalid metadata is isolated to its task and cannot block other teams.
    }
  }
  return {
    released,
    errors,
    parentTaskIds: [...parentTaskIds],
    redispatchedParents: 0,
  };
}

/** Compatibility count for synchronous diagnostics. */
export function reconcileTeamWorkerClaims(): number {
  return reconcileTeamWorkerClaimsDetailed().released;
}

/** Release expired claims and immediately re-evaluate every affected team. */
export function reconcileAndRedispatchTeamWorkerClaims(): Promise<TeamWorkerClaimReconciliation> {
  if (isAutomationMaintenanceActive()) {
    return Promise.resolve({ released: 0, errors: 0, parentTaskIds: [], redispatchedParents: 0 });
  }
  if (teamGlobals.__shibaTeamClaimReconcilePromise) {
    return teamGlobals.__shibaTeamClaimReconcilePromise;
  }
  const operation = (async () => {
    const result = reconcileTeamWorkerClaimsDetailed();
    for (const parentTaskId of result.parentTaskIds) {
      if (isAutomationMaintenanceActive()) break;
      try {
        await dispatchReadyTeamWorkers(parentTaskId);
        result.redispatchedParents += 1;
      } catch (error) {
        result.errors += 1;
        console.error('[task-teams] failed to redispatch reconciled team', { parentTaskId, error });
      }
    }
    return result;
  })();
  teamGlobals.__shibaTeamClaimReconcilePromise = operation.finally(() => {
    teamGlobals.__shibaTeamClaimReconcilePromise = undefined;
  });
  return teamGlobals.__shibaTeamClaimReconcilePromise;
}

/** Periodically recover claims that were still unexpired during a quick restart. */
export function startTeamWorkerClaimReconciler(intervalMs = 15_000): void {
  if (teamGlobals.__shibaTeamClaimReconciler || isAutomationMaintenanceActive()) return;
  const period = Math.max(250, Math.floor(Number(intervalMs) || 15_000));
  void reconcileAndRedispatchTeamWorkerClaims().catch((error) => {
    console.error('[task-teams] initial worker claim reconciliation failed', error);
  });
  teamGlobals.__shibaTeamClaimReconciler = setInterval(() => {
    void reconcileAndRedispatchTeamWorkerClaims().catch((error) => {
      console.error('[task-teams] periodic worker claim reconciliation failed', error);
    });
  }, period);
  teamGlobals.__shibaTeamClaimReconciler.unref?.();
}

export async function stopTeamWorkerClaimReconciler(): Promise<void> {
  if (teamGlobals.__shibaTeamClaimReconciler) {
    clearInterval(teamGlobals.__shibaTeamClaimReconciler);
    teamGlobals.__shibaTeamClaimReconciler = undefined;
  }
  for (const [parentTaskId, timer] of redispatchTimers) {
    clearTimeout(timer);
    redispatchTimers.delete(parentTaskId);
  }
  const reconciliation = teamGlobals.__shibaTeamClaimReconcilePromise;
  if (reconciliation) await reconciliation;
  if (workerDispatches.size) await Promise.allSettled([...workerDispatches]);
}

export function cancelTeamWorker(taskId: string): void {
  workerControllers.get(taskId)?.abort(new Error('Worker cancelled by coordinator'));
}
