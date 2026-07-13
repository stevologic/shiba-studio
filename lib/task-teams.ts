import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { loadAgents } from './persistence';
import {
  assignTaskExecution,
  createTask,
  getTask,
  getTaskDetails,
  recordTaskEvidence,
  requestTaskAttention,
  transitionTask,
} from './task-ledger';
import type { TaskRecord, TaskWorkspaceRoot } from './task-types';
import type { Agent } from './types';

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
interface ClaimRow { taskId: string; ownerId: string; leaseUntil: string; attempt: number; status: string; createdAt: string }

const workerControllers = new Map<string, AbortController>();
const instanceId = `${process.pid}-${randomUUID()}`;

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
      if (!/^(github|slack|googledrive|discord|x|obsidian|vercel|netlify|browser|native|web|mcp(?::[A-Za-z0-9._-]{1,160})?)$/.test(String(scope).trim().toLowerCase())) {
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
  const agentIds = new Set(agents.map((agent) => agent.id));
  const roots = new Map(parent.workspaceRoots.map((root) => [root.id, root]));
  const childByKey = new Map<string, TaskRecord>();
  for (const spec of specs) {
    if (!agentIds.has(spec.agentId)) throw new Error(`Worker agent not found: ${spec.agentId}`);
    const workerRoots: TaskWorkspaceRoot[] = spec.workspaceRootIds.map((id) => {
      const root = roots.get(id);
      if (!root) throw new Error(`Worker ${spec.key} requested unknown workspace root ${id}`);
      if (!spec.readOnly && root.permission !== 'write') throw new Error(`Writer ${spec.key} cannot claim read-only root ${id}`);
      return { ...root, permission: spec.readOnly ? 'read' : root.permission };
    });
    const child = createTask({
      id: `worker-${randomUUID()}`,
      kind: spec.readOnly ? 'work' : 'code',
      parentId: parent.id,
      title: spec.title,
      description: spec.instructions,
      status: 'queued',
      originType: 'system',
      originId: parent.id,
      agentId: spec.agentId,
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
    childByKey.set(spec.key, child);
  }
  const now = new Date().toISOString();
  const insertDependency = getDb().prepare(`
    INSERT OR IGNORE INTO task_dependencies (taskId, dependsOnTaskId, createdAt) VALUES (?, ?, ?)
  `);
  for (const spec of specs) {
    for (const dependency of spec.dependsOn || []) {
      insertDependency.run(childByKey.get(spec.key)!.id, childByKey.get(dependency)!.id, now);
    }
  }
  if (parent.status === 'queued') transitionTask({ taskId: parent.id, status: 'running', expectedVersion: parent.version, currentStep: 'Coordinating specialist workers' });
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
    SELECT c.* FROM task_worker_claims c JOIN tasks t ON t.id = c.taskId WHERE t.parentId = ? AND c.status = 'active'
  `).all(parentTaskId) as ClaimRow[];
  return details.children.filter((task) => typeof task.metadata.teamWorkerKey === 'string').map((task) => ({
    task,
    key: String(task.metadata.teamWorkerKey || task.id),
    dependencies: dependencies.filter((row) => row.taskId === task.id).map((row) => row.dependsOnTaskId),
    ...(claims.find((row) => row.taskId === task.id)
      ? { claim: (() => { const row = claims.find((item) => item.taskId === task.id)!; return { ownerId: row.ownerId, leaseUntil: row.leaseUntil, attempt: row.attempt }; })() }
      : {}),
  }));
}

function claimWorker(task: TaskRecord): boolean {
  ensureSchema();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 2 * 60_000).toISOString();
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT * FROM task_worker_claims WHERE taskId = ?').get(task.id) as ClaimRow | undefined;
    if (existing?.status === 'active' && Date.parse(existing.leaseUntil) > now.getTime()) {
      db.exec('COMMIT');
      return false;
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
    return true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
    throw error;
  }
}

function releaseWorker(taskId: string): void {
  getDb().prepare("UPDATE task_worker_claims SET status = 'released', releasedAt = ? WHERE taskId = ? AND ownerId = ?")
    .run(new Date().toISOString(), taskId, instanceId);
}

async function runWorker(parentId: string, task: TaskRecord): Promise<void> {
  if (!claimWorker(task)) return;
  const agents = await loadAgents();
  const baseAgent = agents.find((agent) => agent.id === task.agentId);
  if (!baseAgent) {
    transitionTask({ taskId: task.id, status: 'failed', error: 'Assigned worker agent no longer exists.' });
    releaseWorker(task.id);
    return;
  }
  if (String(baseAgent.model).startsWith('cli:')) {
    transitionTask({
      taskId: task.id,
      status: 'failed',
      error: 'CLI-model agents cannot enforce per-worker workspace, tool, and integration grants; use the scoped external harness instead.',
    });
    releaseWorker(task.id);
    await dispatchReadyTeamWorkers(parentId);
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
    obsidian: baseAgent.integrations.obsidian && grantedIntegrationScopes.has('obsidian'),
    vercel: baseAgent.integrations.vercel && grantedIntegrationScopes.has('vercel'),
    netlify: baseAgent.integrations.netlify && grantedIntegrationScopes.has('netlify'),
  };
  const runId = randomUUID();
  const workerAgent: Agent = readOnly
    ? { ...baseAgent, integrations: scopedIntegrations, workspace: { ...baseAgent.workspace, path: task.workspaceRoots[0]?.path || baseAgent.workspace.path, useWorktree: false } }
    : { ...baseAgent, id: `${baseAgent.id}-${task.id.slice(-8)}`, integrations: scopedIntegrations, workspace: { ...baseAgent.workspace, path: task.workspaceRoots[0]?.path || baseAgent.workspace.path, useWorktree: true } };
  const controller = new AbortController();
  workerControllers.set(task.id, controller);
  const timeout = setTimeout(() => controller.abort(new Error('Worker time budget exceeded')), Number(task.metadata.timeoutSeconds || 900) * 1_000);
  const assigned = assignTaskExecution({ taskId: task.id, runId, agentId: baseAgent.id, expectedVersion: task.version });
  const running = transitionTask({ taskId: task.id, status: 'running', expectedVersion: assigned.version, currentStep: 'Starting specialist worker' });
  const renewLease = setInterval(() => {
    const now = new Date();
    getDb().prepare(`
      UPDATE task_worker_claims SET leaseUntil = ?, heartbeatAt = ?
      WHERE taskId = ? AND ownerId = ? AND status = 'active'
    `).run(new Date(now.getTime() + 2 * 60_000).toISOString(), now.toISOString(), task.id, instanceId);
  }, 30_000);
  try {
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
    if (current && !['succeeded', 'failed', 'cancelled', 'lost'].includes(current.status)) {
      transitionTask({ taskId: task.id, status: controller.signal.aborted ? 'lost' : 'failed', error: message });
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(renewLease);
    workerControllers.delete(task.id);
    releaseWorker(task.id);
    await dispatchReadyTeamWorkers(parentId);
  }
}

export async function dispatchReadyTeamWorkers(parentTaskId: string): Promise<string[]> {
  const graph = getTaskTeam(parentTaskId);
  const byId = new Map(graph.map((node) => [node.task.id, node.task]));
  const started: string[] = [];
  for (const node of graph) {
    if (node.task.status !== 'queued' || node.claim) continue;
    const dependenciesReady = node.dependencies.every((id) => byId.get(id)?.status === 'succeeded');
    const dependencyFailed = node.dependencies.some((id) => {
      const status = byId.get(id)?.status;
      return status === 'failed' || status === 'lost' || status === 'cancelled';
    });
    if (dependencyFailed) {
      transitionTask({ taskId: node.task.id, status: 'blocked', error: 'A required dependency did not succeed.' });
      continue;
    }
    if (!dependenciesReady) continue;
    started.push(node.task.id);
    void runWorker(parentTaskId, node.task);
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
  return started;
}

export function reconcileTeamWorkerClaims(): number {
  ensureSchema();
  const now = new Date().toISOString();
  const expired = getDb().prepare("SELECT * FROM task_worker_claims WHERE status = 'active' AND leaseUntil <= ?").all(now) as ClaimRow[];
  for (const claim of expired) {
    getDb().prepare("UPDATE task_worker_claims SET status = 'released', releasedAt = ? WHERE taskId = ?").run(now, claim.taskId);
    const task = getTask(claim.taskId);
    if (task?.status === 'running') transitionTask({ taskId: task.id, status: 'lost', error: 'Worker claim lease expired before completion.' });
  }
  return expired.length;
}

export function cancelTeamWorker(taskId: string): void {
  workerControllers.get(taskId)?.abort(new Error('Worker cancelled by coordinator'));
}
