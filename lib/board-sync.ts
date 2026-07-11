import crypto from 'crypto';
import {
  createBoardTask,
  getBoardTask,
  getBoardSyncState,
  listBoardTasks,
  recordBoardSyncState,
  updateBoardTask,
} from './board';
import type { BoardExternalRef, BoardSyncField, BoardSyncState, BoardTask } from './board-types';
import type {
  BoardProviderAdapter,
  BoardProviderSession,
  BoardSyncConflictPolicy,
  BoardSyncDirection,
  BoardSyncMode,
  BoardSyncProvider,
  BoardSyncResult,
  BoardSyncTarget,
  RemoteBoardTask,
} from './board-sync-types';
import { jiraBoardAdapter } from './jira';
import { linearBoardAdapter } from './linear';
import { loadConfig } from './persistence';
import type { IntegrationCreds } from './types';

const ADAPTERS: Record<BoardSyncProvider, BoardProviderAdapter> = {
  linear: linearBoardAdapter,
  jira: jiraBoardAdapter,
};

let activeSync = false;

interface FingerprintFields {
  title: string;
  description: string;
  status: BoardTask['status'];
  priority: BoardTask['priority'];
  labels: string[];
}

function normalizedFields(fields: FingerprintFields, mode: BoardSyncMode): Record<string, unknown> {
  return {
    title: fields.title.trim(),
    description: fields.description.replace(/\r\n/g, '\n').trim(),
    ...(mode === 'board' ? { status: fields.status } : {}),
    priority: fields.priority,
    labels: [...fields.labels].map((label) => label.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)),
  };
}

function syncFields(mode: BoardSyncMode): BoardSyncField[] {
  return mode === 'board'
    ? ['title', 'description', 'status', 'priority', 'labels']
    : ['title', 'description', 'priority', 'labels'];
}

function normalizedFieldValue(fields: FingerprintFields, field: BoardSyncField): unknown {
  if (field === 'title') return fields.title.trim();
  if (field === 'description') return fields.description.replace(/\r\n/g, '\n').trim();
  if (field === 'labels') {
    return [...fields.labels].map((label) => label.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }
  return fields[field];
}

function fieldFingerprints(
  fields: FingerprintFields,
  mode: BoardSyncMode,
): Partial<Record<BoardSyncField, string>> {
  return Object.fromEntries(syncFields(mode).map((field) => [
    field,
    crypto.createHash('sha256').update(JSON.stringify(normalizedFieldValue(fields, field))).digest('hex'),
  ]));
}

function hashFields(fields: FingerprintFields, mode: BoardSyncMode): string {
  return crypto.createHash('sha256').update(JSON.stringify(normalizedFields(fields, mode))).digest('hex');
}

export function boardTaskFingerprint(task: BoardTask, mode: BoardSyncMode): string {
  return hashFields(task, mode);
}

export function remoteTaskFingerprint(task: RemoteBoardTask, mode: BoardSyncMode): string {
  return hashFields(task, mode);
}

function matchingRef(task: BoardTask, provider: BoardSyncProvider, target: BoardSyncTarget): BoardExternalRef | undefined {
  return task.externalRefs?.find((ref) =>
    ref.provider === provider
    && ref.connectionId === target.connectionId
    && ref.containerId === target.id,
  );
}

function providerRef(
  task: BoardTask,
  provider: BoardSyncProvider,
  connectionId: string | undefined,
  remoteId?: string,
): BoardExternalRef | undefined {
  return task.externalRefs?.find((ref) =>
    ref.provider === provider
    && ref.connectionId === connectionId
    && (remoteId === undefined || ref.remoteId === remoteId),
  );
}

function changedLocalFields(ref: BoardExternalRef, local: BoardTask, mode: BoardSyncMode): BoardSyncField[] {
  const current = fieldFingerprints(local, mode);
  if (!ref.lastLocalFieldFingerprints) return syncFields(mode);
  return syncFields(mode).filter((field) => ref.lastLocalFieldFingerprints?.[field] !== current[field]);
}

function refFor(
  provider: BoardSyncProvider,
  target: BoardSyncTarget,
  local: BoardTask,
  remote: RemoteBoardTask,
  mode: BoardSyncMode,
  pendingFields: BoardSyncField[] = [],
): BoardExternalRef {
  const localFieldFingerprints = fieldFingerprints(local, mode);
  for (const field of pendingFields) localFieldFingerprints[field] = '';
  return {
    provider,
    connectionId: target.connectionId,
    containerId: target.id,
    containerName: target.name,
    remoteId: remote.id,
    remoteKey: remote.key,
    url: remote.url,
    remoteUpdatedAt: remote.updatedAt,
    lastSyncedAt: new Date().toISOString(),
    fingerprintMode: mode,
    lastLocalFingerprint: pendingFields.length ? '' : boardTaskFingerprint(local, mode),
    lastRemoteFingerprint: remoteTaskFingerprint(remote, mode),
    lastLocalFieldFingerprints: localFieldFingerprints,
    lastRemoteFieldFingerprints: fieldFingerprints(remote, mode),
  };
}

function taskWithRemoteFields(
  task: BoardTask,
  remote: RemoteBoardTask,
  mode: BoardSyncMode,
  fields: BoardSyncField[] = syncFields(mode),
): BoardTask {
  return {
    ...task,
    title: fields.includes('title') ? remote.title : task.title,
    description: fields.includes('description') ? remote.description : task.description,
    priority: fields.includes('priority') ? remote.priority : task.priority,
    labels: fields.includes('labels') ? remote.labels : task.labels,
    status: mode === 'board' && fields.includes('status') ? remote.status : task.status,
  };
}

async function importRemoteTask(
  provider: BoardSyncProvider,
  target: BoardSyncTarget,
  remote: RemoteBoardTask,
  mode: BoardSyncMode,
): Promise<BoardTask> {
  const draft = {
    title: remote.title,
    description: remote.description,
    status: mode === 'board' ? remote.status : 'backlog' as const,
    priority: remote.priority,
    labels: remote.labels,
  };
  const placeholder = {
    ...draft,
    id: '',
    key: '',
    assigneeAgentId: null,
    order: 0,
    activity: [],
    runIds: [],
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
  } as BoardTask;
  return createBoardTask({
    ...draft,
    createdBy: `${provider === 'linear' ? 'Linear' : 'Jira'} sync (${remote.key})`,
    createdAt: remote.createdAt,
    syncUpdatedAt: remote.updatedAt,
    externalRef: refFor(provider, target, placeholder, remote, mode),
  });
}

async function pullIntoTask(
  provider: BoardSyncProvider,
  target: BoardSyncTarget,
  local: BoardTask,
  remote: RemoteBoardTask,
  mode: BoardSyncMode,
  fields: BoardSyncField[] = syncFields(mode),
): Promise<BoardTask> {
  const next = taskWithRemoteFields(local, remote, mode, fields);
  return updateBoardTask(local.id, {
    expectedSyncUpdatedAt: local.syncUpdatedAt || local.updatedAt,
    ...(fields.includes('title') ? { title: next.title } : {}),
    ...(fields.includes('description') ? { description: next.description } : {}),
    ...(fields.includes('priority') ? { priority: next.priority } : {}),
    ...(fields.includes('labels') ? { labels: next.labels } : {}),
    ...(mode === 'board' && fields.includes('status') ? { status: next.status } : {}),
    syncUpdatedAt: remote.updatedAt,
    externalRef: refFor(provider, target, next, remote, mode),
    actor: provider === 'linear' ? 'Linear sync' : 'Jira sync',
    note: {
      kind: 'system',
      text: `Pulled changes from ${provider === 'linear' ? 'Linear' : 'Jira'} ${remote.key}`,
    },
  });
}

async function linkPushedTask(
  provider: BoardSyncProvider,
  target: BoardSyncTarget,
  local: BoardTask,
  remote: RemoteBoardTask,
  mode: BoardSyncMode,
  created: boolean,
  pendingFields: BoardSyncField[] = [],
): Promise<BoardTask> {
  return updateBoardTask(local.id, {
    externalRef: refFor(provider, target, local, remote, mode, pendingFields),
    note: {
      kind: 'system',
      text: `${created ? 'Created' : 'Updated'} ${provider === 'linear' ? 'Linear' : 'Jira'} issue ${remote.key}`,
    },
  });
}

async function refreshExternalRef(
  provider: BoardSyncProvider,
  target: BoardSyncTarget,
  local: BoardTask,
  remote: RemoteBoardTask,
  mode: BoardSyncMode,
): Promise<BoardTask> {
  return updateBoardTask(local.id, {
    externalRef: refFor(provider, target, local, remote, mode),
  });
}

async function rebindExternalRef(
  target: BoardSyncTarget,
  local: BoardTask,
  existing: BoardExternalRef,
  remote: RemoteBoardTask,
): Promise<BoardTask> {
  return updateBoardTask(local.id, {
    externalRef: {
      ...existing,
      connectionId: target.connectionId,
      containerId: target.id,
      containerName: target.name,
      remoteId: remote.id,
      remoteKey: remote.key,
      url: remote.url,
      remoteUpdatedAt: remote.updatedAt,
      lastSyncedAt: new Date().toISOString(),
    },
  });
}

async function createAndLinkTask(
  session: BoardProviderSession,
  provider: BoardSyncProvider,
  target: BoardSyncTarget,
  local: BoardTask,
  mode: BoardSyncMode,
  result: BoardSyncResult,
): Promise<BoardTask> {
  let linkedEarly = false;
  const remote = await session.createTask(local, mode, async (createdRemote, pendingFields) => {
    await linkPushedTask(provider, target, local, createdRemote, mode, true, pendingFields);
    linkedEarly = true;
    result.exported += 1;
  });
  if (!linkedEarly) {
    result.exported += 1;
    return linkPushedTask(provider, target, local, remote, mode, true);
  }
  return refreshExternalRef(provider, target, local, remote, mode);
}

function bidirectionalFieldChanges(
  ref: BoardExternalRef,
  local: BoardTask,
  remote: RemoteBoardTask,
  mode: BoardSyncMode,
): { local: BoardSyncField[]; remote: BoardSyncField[] } {
  const localFields = fieldFingerprints(local, mode);
  const remoteFields = fieldFingerprints(remote, mode);
  if (ref.lastLocalFieldFingerprints && ref.lastRemoteFieldFingerprints) {
    const localChanged: BoardSyncField[] = [];
    const remoteChanged: BoardSyncField[] = [];
    for (const field of syncFields(mode)) {
      const localBaseline = ref.lastLocalFieldFingerprints[field];
      const remoteBaseline = ref.lastRemoteFieldFingerprints[field];
      if (localBaseline === undefined || remoteBaseline === undefined) {
        // A field newly included by a mode change is only ambiguous when the
        // two current values actually differ.
        if (localFields[field] !== remoteFields[field]) {
          localChanged.push(field);
          remoteChanged.push(field);
        }
      } else {
        if (localBaseline !== localFields[field]) localChanged.push(field);
        if (remoteBaseline !== remoteFields[field]) remoteChanged.push(field);
      }
    }
    return { local: localChanged, remote: remoteChanged };
  }
  if (ref.fingerprintMode && ref.fingerprintMode !== mode) {
    // A newly-included status is only a conflict when the two systems really
    // differ; merely changing modes must not manufacture a conflict.
    const differs = syncFields(mode).filter((field) => localFields[field] !== remoteFields[field]);
    return { local: differs, remote: differs };
  }
  const fields = syncFields(mode);
  return {
    local: ref.lastLocalFingerprint !== boardTaskFingerprint(local, mode) ? fields : [],
    remote: ref.lastRemoteFingerprint !== remoteTaskFingerprint(remote, mode) ? fields : [],
  };
}

function configuredTarget(provider: BoardSyncProvider, creds: IntegrationCreds): string | undefined {
  if (provider === 'linear') return creds.linear?.teamId;
  if (creds.jira?.boardId) return `board:${creds.jira.boardId}`;
  if (creds.jira?.projectKey) return `project:${creds.jira.projectKey.toUpperCase()}`;
  return undefined;
}

export async function discoverBoardSyncTargets(
  provider: BoardSyncProvider,
  creds?: IntegrationCreds,
): Promise<BoardSyncTarget[]> {
  const effective = creds || (await loadConfig()).integrations;
  return ADAPTERS[provider].discoverTargets(effective);
}

export async function resolveBoardSyncTarget(
  provider: BoardSyncProvider,
  targetId?: string,
  creds?: IntegrationCreds,
): Promise<BoardSyncTarget> {
  const effective = creds || (await loadConfig()).integrations;
  const wanted = targetId || configuredTarget(provider, effective);
  if (!wanted) throw new Error(`Select a ${provider === 'linear' ? 'Linear team' : 'Jira project or Kanban board'} before syncing.`);
  const targets = await discoverBoardSyncTargets(provider, effective);
  const target = targets.find((item) => item.id === wanted);
  if (!target) throw new Error('The selected sync target is no longer accessible. Test the connection and choose it again.');
  return target;
}

export async function getBoardSyncOverview(): Promise<{
  providers: Record<BoardSyncProvider, {
    configured: boolean;
    targetId?: string;
    targetName?: string;
    direction: BoardSyncDirection;
    mode: BoardSyncMode;
    linkedTasks: number;
    lastSync?: BoardSyncState;
  }>;
}> {
  const [cfg, tasks, state] = await Promise.all([loadConfig(), listBoardTasks(), getBoardSyncState()]);
  const linearTargetId = configuredTarget('linear', cfg.integrations);
  const jiraTargetId = configuredTarget('jira', cfg.integrations);
  return {
    providers: {
      linear: {
        configured: !!cfg.integrations.linear?.apiKey?.trim(),
        targetId: linearTargetId,
        targetName: cfg.integrations.linear?.teamName,
        direction: cfg.integrations.linear?.syncDirection || 'pull',
        mode: cfg.integrations.linear?.syncMode || 'board',
        linkedTasks: tasks.filter((task) => task.externalRefs?.some((ref) => ref.provider === 'linear')).length,
        lastSync: state?.linear,
      },
      jira: {
        configured: !!(
          cfg.integrations.jira?.baseUrl?.trim()
          && cfg.integrations.jira.email?.trim()
          && cfg.integrations.jira.apiToken?.trim()
        ),
        targetId: jiraTargetId,
        targetName: cfg.integrations.jira?.boardName || cfg.integrations.jira?.projectName,
        direction: cfg.integrations.jira?.syncDirection || 'pull',
        mode: cfg.integrations.jira?.syncMode || 'board',
        linkedTasks: tasks.filter((task) => task.externalRefs?.some((ref) => ref.provider === 'jira')).length,
        lastSync: state?.jira,
      },
    },
  };
}

export async function syncBoard(options: {
  provider: BoardSyncProvider;
  target: BoardSyncTarget;
  direction: BoardSyncDirection;
  mode: BoardSyncMode;
  conflictPolicy?: BoardSyncConflictPolicy;
  creds?: IntegrationCreds;
}): Promise<BoardSyncResult> {
  const { provider, target, direction, mode } = options;
  const conflictPolicy = options.conflictPolicy || 'newest';
  if (activeSync) throw new Error('Another Board sync is already running.');
  activeSync = true;

  const result: BoardSyncResult = {
    ok: true,
    provider,
    target,
    direction,
    mode,
    imported: 0,
    exported: 0,
    updatedLocal: 0,
    updatedRemote: 0,
    skipped: 0,
    conflicts: 0,
    errors: [],
    completedAt: '',
  };

  try {
    const creds = options.creds || (await loadConfig()).integrations;
    const session = await ADAPTERS[provider].createSession(creds, target);
    result.target = session.target;
    const localTasks = await listBoardTasks();
    const linkedByRemoteId = new Map<string, BoardTask>();
    for (const task of localTasks) {
      for (const ref of task.externalRefs || []) {
        if (ref.provider === provider && ref.connectionId === session.target.connectionId) {
          linkedByRemoteId.set(ref.remoteId, task);
        }
      }
    }

    const reportError = (key: string, error: unknown) => {
      result.errors.push({
        key,
        message: error instanceof Error
          ? error.message.slice(0, 300)
          : typeof error === 'string'
            ? error.slice(0, 300)
            : 'Sync item failed.',
      });
    };

    if (direction === 'pull') {
      const remoteTasks = await session.listTasks();
      for (const remote of remoteTasks) {
        try {
          const snapshot = linkedByRemoteId.get(remote.id);
          if (!snapshot) {
            await importRemoteTask(provider, session.target, remote, mode);
            result.imported += 1;
            continue;
          }
          const local = await getBoardTask(snapshot.id);
          if (!local) throw new Error('The linked Board card was deleted while sync was running.');
          const ref = providerRef(local, provider, session.target.connectionId, remote.id);
          if (!ref) throw new Error('The external issue link changed while sync was running.');
          if (
            ref.fingerprintMode === mode
            && ref.lastRemoteFingerprint === remoteTaskFingerprint(remote, mode)
          ) {
            if (ref.containerId !== session.target.id) {
              await rebindExternalRef(session.target, local, ref, remote);
            }
            result.skipped += 1;
            continue;
          }
          if ((snapshot.syncUpdatedAt || snapshot.updatedAt) !== (local.syncUpdatedAt || local.updatedAt)) {
            throw new Error('This Board card changed while sync was reading the provider. Run sync again.');
          }
          await pullIntoTask(provider, session.target, local, remote, mode);
          result.updatedLocal += 1;
        } catch (error) {
          reportError(remote.key, error);
        }
      }
    } else if (direction === 'push') {
      for (const snapshot of localTasks) {
        try {
          const local = await getBoardTask(snapshot.id);
          if (!local) continue;
          const ref = matchingRef(local, provider, session.target);
          if (!ref) {
            const otherRef = local.externalRefs?.find((item) => item.provider === provider);
            if (otherRef) {
              throw new Error(
                `Already linked to ${provider} issue ${otherRef.remoteKey} in another site or target; pull the overlapping target to rebind it safely.`,
              );
            }
            await createAndLinkTask(session, provider, session.target, local, mode, result);
            continue;
          }
          if (
            ref.fingerprintMode === mode
            && ref.lastLocalFingerprint === boardTaskFingerprint(local, mode)
          ) {
            result.skipped += 1;
            continue;
          }
          const changedFields = changedLocalFields(ref, local, mode);
          if (!changedFields.length) {
            result.skipped += 1;
            continue;
          }
          const remote = await session.updateTask(ref.remoteId, local, mode, changedFields);
          await linkPushedTask(provider, session.target, local, remote, mode, false);
          result.updatedRemote += 1;
        } catch (error) {
          reportError(snapshot.key, error);
        }
      }
    } else {
      const remoteTasks = await session.listTasks();
      const processedLocalIds = new Set<string>();
      for (const remote of remoteTasks) {
        try {
          const snapshot = linkedByRemoteId.get(remote.id);
          if (!snapshot) {
            const created = await importRemoteTask(provider, session.target, remote, mode);
            processedLocalIds.add(created.id);
            result.imported += 1;
            continue;
          }
          const local = await getBoardTask(snapshot.id);
          if (!local) throw new Error('The linked Board card was deleted while sync was running.');
          processedLocalIds.add(local.id);
          const ref = providerRef(local, provider, session.target.connectionId, remote.id);
          if (!ref) throw new Error('The external issue link changed while sync was running.');
          const changes = bidirectionalFieldChanges(ref, local, remote, mode);
          if (!changes.local.length && !changes.remote.length) {
            if (
              ref.containerId !== session.target.id
              || ref.fingerprintMode !== mode
              || !ref.lastLocalFieldFingerprints
            ) {
              await refreshExternalRef(provider, session.target, local, remote, mode);
            }
            result.skipped += 1;
            continue;
          }

          const localNow = fieldFingerprints(local, mode);
          const remoteNow = fieldFingerprints(remote, mode);
          const shared = changes.local.filter((field) => changes.remote.includes(field));
          const converged = shared.filter((field) => localNow[field] === remoteNow[field]);
          const conflictFields = shared.filter((field) => localNow[field] !== remoteNow[field]);
          let winner: 'local' | 'remote' = 'local';
          if (conflictFields.length) {
            result.conflicts += 1;
            if (conflictPolicy === 'local' || conflictPolicy === 'remote') winner = conflictPolicy;
            else {
              const localAt = Date.parse(local.syncUpdatedAt || local.updatedAt) || 0;
              const remoteAt = Date.parse(remote.updatedAt) || 0;
              winner = localAt > remoteAt ? 'local' : 'remote';
            }
          }

          const pushFields = changes.local.filter((field) =>
            !converged.includes(field)
            && (!conflictFields.includes(field) || winner === 'local'),
          );
          const pullFields = changes.remote.filter((field) =>
            !converged.includes(field)
            && (!conflictFields.includes(field) || winner === 'remote'),
          );
          let finalRemote = remote;
          if (pushFields.length) {
            finalRemote = await session.updateTask(remote.id, local, mode, pushFields);
            result.updatedRemote += 1;
          }
          if (pullFields.length) {
            await pullIntoTask(provider, session.target, local, finalRemote, mode, pullFields);
            result.updatedLocal += 1;
          } else if (pushFields.length) {
            await linkPushedTask(provider, session.target, local, finalRemote, mode, false);
          } else {
            await refreshExternalRef(provider, session.target, local, finalRemote, mode);
            result.skipped += 1;
          }
        } catch (error) {
          reportError(remote.key, error);
        }
      }

      for (const snapshot of localTasks) {
        if (processedLocalIds.has(snapshot.id)) continue;
        const local = await getBoardTask(snapshot.id);
        if (!local) continue;
        try {
          const staleRef = matchingRef(local, provider, session.target);
          if (staleRef) {
            throw new Error(`Linked ${provider} issue ${staleRef.remoteKey} was not returned by the selected target.`);
          }
          const otherRef = local.externalRefs?.find((item) => item.provider === provider);
          if (otherRef) {
            throw new Error(
              `Already linked to ${provider} issue ${otherRef.remoteKey} in another site or target; pull the overlapping target to rebind it safely.`,
            );
          }
          await createAndLinkTask(session, provider, session.target, local, mode, result);
        } catch (error) {
          reportError(local.key, error);
        }
      }
    }

    result.ok = result.errors.length === 0;
    result.completedAt = new Date().toISOString();
    await recordBoardSyncState({
      provider,
      containerId: session.target.id,
      containerName: session.target.name,
      direction,
      mode,
      completedAt: result.completedAt,
      imported: result.imported,
      exported: result.exported,
      updatedLocal: result.updatedLocal,
      updatedRemote: result.updatedRemote,
      skipped: result.skipped,
      conflicts: result.conflicts,
      errors: result.errors.length,
    });
    return result;
  } finally {
    activeSync = false;
  }
}
