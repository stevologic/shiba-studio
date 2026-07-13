// Idempotent SQLite ownership reconciliation. Cross-store callers may provide
// the IDs loaded from the JSON-backed stores, but this module never reads or
// writes those stores itself.

import { getDb } from './db';
import { transitionTaskInOpenTransaction } from './task-ledger';

type Db = ReturnType<typeof getDb>;
type SqlValue = string | number | null;
type CountBucket = Record<string, number>;

const ACTIVE_TASK_STATUSES = [
  'queued',
  'running',
  'paused',
  'waiting_for_input',
  'waiting_for_approval',
  'blocked',
] as const;
const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'cancelled', 'lost'] as const;
const ACTIVE_TASK_SQL = ACTIVE_TASK_STATUSES.map(() => '?').join(', ');
const TERMINAL_TASK_SQL = TERMINAL_TASK_STATUSES.map(() => '?').join(', ');

export interface ReconcileDataIntegrityOptions {
  /** Human-readable caller provenance for diagnostics. */
  reason?: string;
  /** Stable clock injection for verification. */
  now?: Date | string;
  /** Omit a set when that JSON-backed store was not loaded by the caller. */
  validAgentIds?: Iterable<string>;
  validBoardIds?: Iterable<string>;
  validProjectIds?: Iterable<string>;
  validSessionIds?: Iterable<string>;
}

export interface DataIntegrityReport {
  reason: string;
  startedAt: string;
  completedAt: string;
  foreignKeysEnabled: boolean;
  deleted: CountBucket;
  detached: CountBucket;
  updated: CountBucket;
  stateTransitions: CountBucket;
  deferred: CountBucket;
  preservedHistorical: CountBucket;
  ftsRebuilt: string[];
  constraintsInstalled: string[];
  foreignKeyViolations: number;
  totalChanges: number;
}

interface IntegrityGlobals {
  __shibaDataIntegrityPromise?: Promise<DataIntegrityReport>;
  __shibaDataIntegrityOptions?: ReconcileDataIntegrityOptions;
}

const globals = globalThis as typeof globalThis & IntegrityGlobals;

function normalizedSet(values: Iterable<string> | undefined): Set<string> | undefined {
  if (values === undefined) return undefined;
  const result = new Set<string>();
  for (const value of values) {
    const id = String(value || '').trim();
    if (id) result.add(id);
  }
  return result;
}

function normalizedNow(value: Date | string | undefined): Date {
  const now = value instanceof Date ? new Date(value.getTime()) : value ? new Date(value) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid data-integrity timestamp');
  return now;
}

function add(bucket: CountBucket, key: string, value: number | bigint): number {
  const count = Number(value) || 0;
  if (count > 0) bucket[key] = (bucket[key] || 0) + count;
  return count;
}

function changed(
  db: Db,
  bucket: CountBucket,
  key: string,
  sql: string,
  values: readonly SqlValue[] = [],
): number {
  return add(bucket, key, db.prepare(sql).run(...values).changes);
}

function scalarCount(db: Db, sql: string, values: readonly SqlValue[] = []): number {
  const row = db.prepare(sql).get(...values) as { count: number | bigint } | undefined;
  return Number(row?.count) || 0;
}

function sqliteObjects(db: Db): Set<string> {
  return new Set((db.prepare(`
    SELECT name FROM sqlite_master WHERE type IN ('table', 'view')
  `).all() as Array<{ name: string }>).map((row) => row.name));
}

function hasAll(objects: ReadonlySet<string>, ...names: string[]): boolean {
  return names.every((name) => objects.has(name));
}

function loadTempIds(db: Db, table: string, ids: ReadonlySet<string> | undefined): void {
  if (ids === undefined) return;
  if (!/^integrity_valid_(agents|boards|projects|sessions)$/.test(table)) {
    throw new Error(`Unsafe data-integrity temporary table: ${table}`);
  }
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY); DELETE FROM ${table};`);
  const insert = db.prepare(`INSERT INTO ${table} (id) VALUES (?)`);
  for (const id of ids) insert.run(id);
}

function foreignKeyViolations(db: Db): Array<{
  table: string;
  rowid: number | bigint | null;
  parent: string;
  fkid: number | bigint;
}> {
  return db.prepare('PRAGMA foreign_key_check').all() as Array<{
    table: string;
    rowid: number | bigint | null;
    parent: string;
    fkid: number | bigint;
  }>;
}

function failForForeignKeyViolations(db: Db): void {
  const violations = foreignKeyViolations(db);
  if (!violations.length) return;
  const detail = violations.slice(0, 12).map((row) =>
    `${row.table}[rowid=${String(row.rowid)}] -> ${row.parent} (fk ${String(row.fkid)})`).join('; ');
  throw new Error(`SQLite foreign-key violations remain after reconciliation: ${detail}`);
}

function reconcileCoreTaskOwnership(db: Db, objects: ReadonlySet<string>, report: DataIntegrityReport): void {
  if (!objects.has('tasks')) return;

  for (const table of ['task_evidence', 'task_attention', 'task_commands', 'task_events', 'task_outbox']) {
    if (!objects.has(table)) continue;
    changed(db, report.deleted, table, `
      DELETE FROM ${table}
      WHERE NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = ${table}.taskId)
    `);
  }

  if (hasAll(objects, 'task_dependencies')) {
    changed(db, report.deleted, 'task_dependencies', `
      DELETE FROM task_dependencies
      WHERE NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = task_dependencies.taskId)
         OR NOT EXISTS (SELECT 1 FROM tasks dependency WHERE dependency.id = task_dependencies.dependsOnTaskId)
    `);
  }
  if (hasAll(objects, 'task_worker_claims')) {
    changed(db, report.deleted, 'task_worker_claims', `
      DELETE FROM task_worker_claims
      WHERE NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = task_worker_claims.taskId)
    `);
  }

  if (hasAll(objects, 'task_checkpoint_files', 'task_checkpoints')) {
    changed(db, report.deleted, 'task_checkpoint_files', `
      DELETE FROM task_checkpoint_files
      WHERE NOT EXISTS (
        SELECT 1 FROM task_checkpoints checkpoint
        WHERE checkpoint.id = task_checkpoint_files.checkpointId
      )
    `);
  }
  if (hasAll(objects, 'task_checkpoint_restores', 'task_checkpoints')) {
    changed(db, report.deleted, 'task_checkpoint_restores', `
      DELETE FROM task_checkpoint_restores
      WHERE NOT EXISTS (
        SELECT 1 FROM task_checkpoints checkpoint
        JOIN tasks owner ON owner.id = checkpoint.taskId
        WHERE checkpoint.id = task_checkpoint_restores.checkpointId
          AND checkpoint.taskId = task_checkpoint_restores.taskId
      )
    `);
  }
  if (objects.has('task_checkpoints')) {
    changed(db, report.deleted, 'task_checkpoints', `
      DELETE FROM task_checkpoints
      WHERE NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = task_checkpoints.taskId)
    `);
  }
  // A checkpoint delete above can expose descendants that were valid at the
  // beginning of the pass. Sweep them once more in the same transaction.
  if (hasAll(objects, 'task_checkpoint_files', 'task_checkpoints')) {
    changed(db, report.deleted, 'task_checkpoint_files', `
      DELETE FROM task_checkpoint_files
      WHERE NOT EXISTS (SELECT 1 FROM task_checkpoints checkpoint WHERE checkpoint.id = task_checkpoint_files.checkpointId)
    `);
  }
  if (hasAll(objects, 'task_checkpoint_restores', 'task_checkpoints')) {
    changed(db, report.deleted, 'task_checkpoint_restores', `
      DELETE FROM task_checkpoint_restores
      WHERE NOT EXISTS (SELECT 1 FROM task_checkpoints checkpoint WHERE checkpoint.id = task_checkpoint_restores.checkpointId)
         OR NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = task_checkpoint_restores.taskId)
    `);
  }

  changed(db, report.detached, 'tasks.parentId', `
    UPDATE tasks SET parentId = NULL, version = version + 1, updatedAt = ?
    WHERE parentId IS NOT NULL
      AND (parentId = id OR NOT EXISTS (SELECT 1 FROM tasks parent WHERE parent.id = tasks.parentId))
  `, [report.startedAt]);

  if (objects.has('task_checkpoints')) {
    changed(db, report.detached, 'tasks.checkpointId', `
      UPDATE tasks SET checkpointId = NULL, version = version + 1, updatedAt = ?
      WHERE checkpointId IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM task_checkpoints checkpoint
        WHERE checkpoint.id = tasks.checkpointId AND checkpoint.taskId = tasks.id
      )
    `, [report.startedAt]);
  }

  if (objects.has('runs')) {
    changed(db, report.detached, 'runs.taskId', `
      UPDATE runs SET taskId = NULL
      WHERE taskId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = runs.taskId)
    `);
    changed(db, report.detached, 'terminalTasks.runId', `
      UPDATE tasks SET runId = NULL, version = version + 1, updatedAt = ?
      WHERE runId IS NOT NULL AND status IN (${TERMINAL_TASK_SQL})
        AND NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = tasks.runId)
    `, [report.startedAt, ...TERMINAL_TASK_STATUSES]);
    add(report.deferred, 'activeTasks.missingRun', scalarCount(db, `
      SELECT COUNT(*) AS count FROM tasks
      WHERE runId IS NOT NULL AND status IN (${ACTIVE_TASK_SQL})
        AND NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = tasks.runId)
    `, ACTIVE_TASK_STATUSES));
  }

  if (hasAll(objects, 'task_run_controls', 'task_commands')) {
    changed(db, report.deleted, 'task_run_controls.invalidOwner', `
      DELETE FROM task_run_controls
      WHERE NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = task_run_controls.taskId)
         OR NOT EXISTS (
           SELECT 1 FROM task_commands command
           JOIN tasks owner ON owner.id = command.taskId
           WHERE command.id = task_run_controls.commandId
             AND command.taskId = task_run_controls.taskId
             AND owner.runId = task_run_controls.runId
         )
    `);
    if (objects.has('runs')) {
      changed(db, report.deleted, 'task_run_controls.missingRun', `
        DELETE FROM task_run_controls
        WHERE NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = task_run_controls.runId)
          AND (
            status = 'acknowledged'
            OR EXISTS (
              SELECT 1 FROM tasks task
              WHERE task.id = task_run_controls.taskId
                AND task.status IN (${TERMINAL_TASK_SQL})
            )
          )
      `, TERMINAL_TASK_STATUSES);
      add(report.deferred, 'activeRunControls.missingRun', scalarCount(db, `
        SELECT COUNT(*) AS count FROM task_run_controls control
        JOIN tasks task ON task.id = control.taskId
        WHERE task.status IN (${ACTIVE_TASK_SQL})
          AND NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = control.runId)
      `, ACTIVE_TASK_STATUSES));
    }
  }
}

function reconcileArtifacts(db: Db, objects: ReadonlySet<string>, report: DataIntegrityReport): void {
  if (!hasAll(objects, 'artifacts', 'artifact_versions')) return;

  if (objects.has('artifact_annotations')) {
    changed(db, report.deleted, 'artifact_annotations', `
      DELETE FROM artifact_annotations
      WHERE NOT EXISTS (SELECT 1 FROM artifacts artifact WHERE artifact.id = artifact_annotations.artifactId)
         OR NOT EXISTS (
           SELECT 1 FROM artifact_versions version
           WHERE version.id = artifact_annotations.versionId
             AND version.artifactId = artifact_annotations.artifactId
         )
    `);
  }
  if (objects.has('artifact_publications')) {
    changed(db, report.deleted, 'artifact_publications', `
      DELETE FROM artifact_publications
      WHERE NOT EXISTS (SELECT 1 FROM artifacts artifact WHERE artifact.id = artifact_publications.artifactId)
         OR NOT EXISTS (
           SELECT 1 FROM artifact_versions version
           WHERE version.id = artifact_publications.versionId
             AND version.artifactId = artifact_publications.artifactId
         )
    `);
  }
  changed(db, report.deleted, 'artifact_versions.missingArtifact', `
    DELETE FROM artifact_versions
    WHERE NOT EXISTS (SELECT 1 FROM artifacts artifact WHERE artifact.id = artifact_versions.artifactId)
  `);
  if (objects.has('task_checkpoints')) {
    changed(db, report.deleted, 'artifact_versions.missingCheckpoint', `
      DELETE FROM artifact_versions
      WHERE NOT EXISTS (
        SELECT 1 FROM task_checkpoints checkpoint
        JOIN artifacts artifact ON artifact.id = artifact_versions.artifactId
        WHERE checkpoint.id = artifact_versions.checkpointId
          AND checkpoint.taskId = artifact.taskId
      )
    `);
  }
  if (objects.has('task_evidence')) {
    changed(db, report.detached, 'artifact_versions.evidenceId', `
      UPDATE artifact_versions SET evidenceId = NULL
      WHERE evidenceId IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM task_evidence evidence
          JOIN artifacts artifact ON artifact.id = artifact_versions.artifactId
          WHERE evidence.id = artifact_versions.evidenceId
            AND evidence.taskId = artifact.taskId
        )
    `);
  }
  if (objects.has('tasks')) {
    changed(db, report.deleted, 'artifacts.missingTask', `
      DELETE FROM artifacts
      WHERE NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = artifacts.taskId)
    `);
  }
  changed(db, report.updated, 'artifacts.currentVersionId', `
    UPDATE artifacts
    SET currentVersionId = (
      SELECT version.id FROM artifact_versions version
      WHERE version.artifactId = artifacts.id
      ORDER BY version.version DESC, version.createdAt DESC LIMIT 1
    ), updatedAt = ?
    WHERE NOT EXISTS (
      SELECT 1 FROM artifact_versions current
      WHERE current.id = artifacts.currentVersionId AND current.artifactId = artifacts.id
    ) AND EXISTS (SELECT 1 FROM artifact_versions version WHERE version.artifactId = artifacts.id)
  `, [report.startedAt]);
  changed(db, report.deleted, 'artifacts.empty', `
    DELETE FROM artifacts
    WHERE NOT EXISTS (SELECT 1 FROM artifact_versions version WHERE version.artifactId = artifacts.id)
  `);

  // Version removal can invalidate annotation/publication rows when foreign
  // keys were disabled in an older process.
  for (const table of ['artifact_annotations', 'artifact_publications']) {
    if (!objects.has(table)) continue;
    changed(db, report.deleted, table, `
      DELETE FROM ${table}
      WHERE NOT EXISTS (SELECT 1 FROM artifacts artifact WHERE artifact.id = ${table}.artifactId)
         OR NOT EXISTS (
           SELECT 1 FROM artifact_versions version
           WHERE version.id = ${table}.versionId AND version.artifactId = ${table}.artifactId
         )
    `);
  }
}

function reconcileOptionalRelations(db: Db, objects: ReadonlySet<string>, report: DataIntegrityReport): void {
  if (hasAll(objects, 'harness_grants', 'tasks')) {
    changed(db, report.deleted, 'harness_grants', `
      DELETE FROM harness_grants
      WHERE NOT EXISTS (SELECT 1 FROM tasks parent WHERE parent.id = harness_grants.taskId)
         OR NOT EXISTS (
           SELECT 1 FROM tasks child
           WHERE child.id = harness_grants.childTaskId
             AND child.parentId = harness_grants.taskId
             AND child.id != harness_grants.taskId
             AND EXISTS (
               SELECT 1 FROM tasks parent, json_each(
                 CASE WHEN json_valid(parent.workspaceRoots) THEN
                   CASE WHEN json_type(parent.workspaceRoots) = 'array'
                     THEN parent.workspaceRoots ELSE '[]' END
                 ELSE '[]' END
               ) root
               WHERE parent.id = harness_grants.taskId
                 AND json_extract(root.value, '$.id') = harness_grants.workspaceRootId
                 AND json_extract(root.value, '$.path') = harness_grants.workspacePath
                 AND json_extract(root.value, '$.permission') = 'write'
             )
         )
    `);
  }

  if (hasAll(objects, 'routine_step_runs', 'routine_invocations')) {
    changed(db, report.deleted, 'routine_step_runs.missingInvocation', `
      DELETE FROM routine_step_runs
      WHERE NOT EXISTS (SELECT 1 FROM routine_invocations owner WHERE owner.id = routine_step_runs.invocationId)
    `);
  }
  if (hasAll(objects, 'routine_invocations', 'routines')) {
    if (objects.has('routine_step_runs')) {
      changed(db, report.deleted, 'routine_step_runs.missingRoutine', `
        DELETE FROM routine_step_runs
        WHERE EXISTS (
          SELECT 1 FROM routine_invocations invocation
          WHERE invocation.id = routine_step_runs.invocationId
            AND NOT EXISTS (SELECT 1 FROM routines owner WHERE owner.id = invocation.routineId)
        )
      `);
    }
    changed(db, report.deleted, 'routine_invocations.missingRoutine', `
      DELETE FROM routine_invocations
      WHERE NOT EXISTS (SELECT 1 FROM routines owner WHERE owner.id = routine_invocations.routineId)
    `);
  }
  if (hasAll(objects, 'routine_trigger_state', 'routines')) {
    changed(db, report.deleted, 'routine_trigger_state', `
      DELETE FROM routine_trigger_state
      WHERE NOT EXISTS (SELECT 1 FROM routines owner WHERE owner.id = routine_trigger_state.routineId)
    `);
    changed(db, report.deleted, 'routine_trigger_state.missingTrigger', `
      DELETE FROM routine_trigger_state
      WHERE NOT EXISTS (
        SELECT 1 FROM routines owner, json_each(
          CASE WHEN json_valid(owner.triggers) THEN owner.triggers ELSE '[]' END
        ) trigger
        WHERE owner.id = routine_trigger_state.routineId
          AND json_extract(
            CASE WHEN trigger.type = 'object' THEN trigger.value ELSE '{}' END,
            '$.id'
          ) = routine_trigger_state.triggerId
      )
    `);
  }
  if (hasAll(objects, 'routine_invocations', 'tasks')) {
    changed(db, report.detached, 'routineInvocations.taskId', `
      UPDATE routine_invocations SET taskId = NULL
      WHERE taskId IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = routine_invocations.taskId)
    `);
  }
  if (hasAll(objects, 'routine_step_runs', 'tasks')) {
    changed(db, report.stateTransitions, 'routineSteps.failedMissingTask', `
      UPDATE routine_step_runs
      SET status = 'failed', error = COALESCE(error, 'The linked task no longer exists.'), updatedAt = ?
      WHERE taskId IS NOT NULL AND status = 'processing'
        AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = routine_step_runs.taskId)
    `, [report.startedAt]);
    changed(db, report.detached, 'routineSteps.taskId', `
      UPDATE routine_step_runs SET taskId = NULL
      WHERE taskId IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = routine_step_runs.taskId)
    `);
  }

  if (hasAll(objects, 'meeting_outputs', 'meetings')) {
    changed(db, report.deleted, 'meeting_outputs.missingMeeting', `
      DELETE FROM meeting_outputs
      WHERE NOT EXISTS (SELECT 1 FROM meetings owner WHERE owner.id = meeting_outputs.meetingId)
    `);
  }
  if (hasAll(objects, 'meeting_outputs', 'tasks')) {
    changed(db, report.detached, 'meeting_outputs.taskId', `
      UPDATE meeting_outputs SET taskId = NULL
      WHERE taskId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = meeting_outputs.taskId)
    `);
  }
  if (hasAll(objects, 'meetings', 'tasks')) {
    add(report.preservedHistorical, 'meetings.taskId', scalarCount(db, `
      SELECT COUNT(*) AS count FROM meetings
      WHERE NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = meetings.taskId)
    `));
  }

  if (hasAll(objects, 'native_node_grants', 'native_nodes')) {
    changed(db, report.deleted, 'native_node_grants', `
      DELETE FROM native_node_grants
      WHERE NOT EXISTS (SELECT 1 FROM native_nodes owner WHERE owner.id = native_node_grants.nodeId)
    `);
  }
  if (hasAll(objects, 'native_node_events', 'native_nodes')) {
    changed(db, report.deleted, 'native_node_events', `
      DELETE FROM native_node_events
      WHERE NOT EXISTS (SELECT 1 FROM native_nodes owner WHERE owner.id = native_node_events.nodeId)
    `);
  }
  if (hasAll(objects, 'native_node_jobs', 'native_nodes')) {
    changed(db, report.deleted, 'native_node_jobs.missingNode', `
      DELETE FROM native_node_jobs
      WHERE NOT EXISTS (SELECT 1 FROM native_nodes owner WHERE owner.id = native_node_jobs.nodeId)
    `);
  }
  if (hasAll(objects, 'native_node_jobs', 'native_node_grants')) {
    changed(db, report.stateTransitions, 'nativeNodeJobs.failedMissingGrant', `
      UPDATE native_node_jobs SET status = 'failed',
        error = COALESCE(error, 'The native-node grant no longer exists.'),
        leaseTokenHash = NULL, leaseExpiresAt = NULL, completedAt = COALESCE(completedAt, ?), updatedAt = ?
      WHERE grantId IS NOT NULL AND status IN ('queued', 'processing')
        AND NOT EXISTS (
          SELECT 1 FROM native_node_grants owner
          WHERE owner.id = native_node_jobs.grantId
            AND owner.nodeId = native_node_jobs.nodeId
            AND owner.revision = native_node_jobs.grantRevision
            AND owner.appId = native_node_jobs.targetAppId
            AND owner.appRevision = native_node_jobs.targetAppRevision
        )
    `, [report.startedAt, report.startedAt]);
    changed(db, report.detached, 'terminalNativeNodeJobs.grantId', `
      UPDATE native_node_jobs SET grantId = NULL, grantRevision = NULL, updatedAt = ?
      WHERE grantId IS NOT NULL AND status NOT IN ('queued', 'processing')
        AND NOT EXISTS (
          SELECT 1 FROM native_node_grants owner
          WHERE owner.id = native_node_jobs.grantId AND owner.nodeId = native_node_jobs.nodeId
        )
    `, [report.startedAt]);
  }

  if (hasAll(objects, 'agent_memory', 'runs')) {
    changed(db, report.detached, 'agent_memory.learnedSourceId', `
      UPDATE agent_memory SET sourceId = NULL, updatedAt = ?
      WHERE source = 'learned' AND sourceId IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = agent_memory.sourceId)
    `, [report.startedAt]);
  }

  if (hasAll(objects, 'companion_action_receipts', 'companion_devices')) {
    changed(db, report.deleted, 'companion_action_receipts', `
      DELETE FROM companion_action_receipts
      WHERE NOT EXISTS (SELECT 1 FROM companion_devices owner WHERE owner.id = companion_action_receipts.deviceId)
    `);
  }

  if (hasAll(objects, 'capability_pack_versions', 'capability_packs')) {
    changed(db, report.deleted, 'capability_pack_versions', `
      DELETE FROM capability_pack_versions
      WHERE NOT EXISTS (SELECT 1 FROM capability_packs owner WHERE owner.id = capability_pack_versions.packId)
    `);
    changed(db, report.stateTransitions, 'capabilityPacks.disabledMissingActiveVersion', `
      UPDATE capability_packs SET activeVersion = NULL, status = 'disabled', updatedAt = ?
      WHERE activeVersion IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM capability_pack_versions version
        WHERE version.packId = capability_packs.id AND version.version = capability_packs.activeVersion
      )
    `, [report.startedAt]);
    changed(db, report.detached, 'capabilityPacks.previousVersion', `
      UPDATE capability_packs SET previousVersion = NULL, updatedAt = ?
      WHERE previousVersion IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM capability_pack_versions version
        WHERE version.packId = capability_packs.id AND version.version = capability_packs.previousVersion
      )
    `, [report.startedAt]);
  }
  if (hasAll(objects, 'capability_packs', 'runs')) {
    changed(db, report.detached, 'capabilityPacks.lastSuccessRunId', `
      UPDATE capability_packs SET lastSuccessRunId = NULL, updatedAt = ?
      WHERE lastSuccessRunId IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = capability_packs.lastSuccessRunId)
    `, [report.startedAt]);
  }

  if (objects.has('schedule_execution_intents')) {
    if (objects.has('runs')) {
      changed(db, report.detached, 'terminalScheduleIntents.runId', `
        UPDATE schedule_execution_intents SET runId = NULL, updatedAt = ?
        WHERE runId IS NOT NULL AND status NOT IN ('pending', 'processing')
          AND NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = schedule_execution_intents.runId)
      `, [report.startedAt]);
      add(report.deferred, 'activeScheduleIntents.missingRun', scalarCount(db, `
        SELECT COUNT(*) AS count FROM schedule_execution_intents
        WHERE runId IS NOT NULL AND status IN ('pending', 'processing')
          AND NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = schedule_execution_intents.runId)
      `));
    }
    if (objects.has('tasks')) {
      changed(db, report.detached, 'terminalScheduleIntents.taskId', `
        UPDATE schedule_execution_intents SET taskId = NULL, updatedAt = ?
        WHERE taskId IS NOT NULL AND status NOT IN ('pending', 'processing')
          AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = schedule_execution_intents.taskId)
      `, [report.startedAt]);
      add(report.deferred, 'activeScheduleIntents.missingTask', scalarCount(db, `
        SELECT COUNT(*) AS count FROM schedule_execution_intents
        WHERE taskId IS NOT NULL AND status IN ('pending', 'processing')
          AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = schedule_execution_intents.taskId)
      `));
    }
  }
}

function reconcileContext(db: Db, objects: ReadonlySet<string>, report: DataIntegrityReport, options: {
  validProjects: ReadonlySet<string> | undefined;
  validSessions: ReadonlySet<string> | undefined;
}): void {
  const contextTables = ['context_compactions', 'context_sources', 'context_scope_state']
    .filter((table) => objects.has(table));
  if (!contextTables.length) return;

  for (const table of contextTables) {
    changed(db, report.deleted, `${table}.invalidScope`, `
      DELETE FROM ${table} WHERE scopeType NOT IN ('session', 'project', 'run')
    `);
  }
  if (objects.has('runs')) {
    for (const table of contextTables) {
      changed(db, report.deleted, `${table}.run`, `
        DELETE FROM ${table}
        WHERE scopeType = 'run'
          AND NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = ${table}.scopeId)
      `);
    }
  }
  if (options.validProjects !== undefined) {
    for (const table of contextTables) {
      changed(db, report.deleted, `${table}.project`, `
        DELETE FROM ${table}
        WHERE scopeType = 'project' AND NOT EXISTS (
          SELECT 1 FROM integrity_valid_projects owner WHERE owner.id = ${table}.scopeId
        )
      `);
    }
  }
  if (options.validSessions !== undefined) {
    for (const table of contextTables) {
      changed(db, report.deleted, `${table}.session`, `
        DELETE FROM ${table}
        WHERE scopeType = 'session' AND NOT EXISTS (
          SELECT 1 FROM integrity_valid_sessions owner WHERE owner.id = ${table}.scopeId
        )
      `);
    }
  }

  if (objects.has('context_sources')) {
    if (objects.has('runs')) {
      changed(db, report.detached, 'context_sources.runId', `
        UPDATE context_sources SET runId = NULL, updatedAt = ?
        WHERE runId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs owner WHERE owner.id = context_sources.runId)
      `, [report.startedAt]);
    }
    if (options.validProjects !== undefined) {
      changed(db, report.detached, 'context_sources.projectId', `
        UPDATE context_sources SET projectId = NULL, updatedAt = ?
        WHERE projectId IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM integrity_valid_projects owner WHERE owner.id = context_sources.projectId
        )
      `, [report.startedAt]);
    }
  }

  if (hasAll(objects, 'context_compactions', 'context_sources')) {
    changed(db, report.deleted, 'context_compactions.invalidSources', `
      DELETE FROM context_compactions
      WHERE NOT json_valid(sourceIds)
         OR json_type(CASE WHEN json_valid(sourceIds) THEN sourceIds ELSE '[]' END) != 'array'
         OR EXISTS (
           SELECT 1
           FROM json_each(
             CASE WHEN json_valid(sourceIds) THEN
               CASE WHEN json_type(sourceIds) = 'array' THEN sourceIds ELSE '[]' END
             ELSE '[]' END
           ) item
           WHERE item.type != 'text'
              OR NOT EXISTS (
                SELECT 1 FROM context_sources source
                WHERE source.id = item.value
                  AND source.scopeType = context_compactions.scopeType
                  AND source.scopeId = context_compactions.scopeId
              )
         )
    `);
  }
  if (objects.has('context_scope_state')) {
    const sourceExpression = objects.has('context_sources')
      ? `(SELECT COUNT(*) FROM context_sources source
          WHERE source.scopeType = context_scope_state.scopeType
            AND source.scopeId = context_scope_state.scopeId AND source.active = 1)`
      : '0';
    const summaryExpression = objects.has('context_compactions')
      ? `(SELECT COUNT(*) FROM context_compactions compaction
          WHERE compaction.scopeType = context_scope_state.scopeType
            AND compaction.scopeId = context_scope_state.scopeId)`
      : '0';
    changed(db, report.updated, 'context_scope_state.counts', `
      UPDATE context_scope_state
      SET sourceCount = ${sourceExpression}, summaryCount = ${summaryExpression}
      WHERE sourceCount != ${sourceExpression} OR summaryCount != ${summaryExpression}
    `);
  }
}

function reconcileCrossStoreIds(db: Db, objects: ReadonlySet<string>, report: DataIntegrityReport, options: {
  validAgents: ReadonlySet<string> | undefined;
  validBoards: ReadonlySet<string> | undefined;
  validProjects: ReadonlySet<string> | undefined;
  validSessions: ReadonlySet<string> | undefined;
}): void {
  if (objects.has('tasks')) {
    const rows = db.prepare(`
      SELECT id, version, agentId, projectId, sessionId, originType, originId, metadata FROM tasks
      WHERE status IN (${ACTIVE_TASK_SQL})
      ORDER BY createdAt ASC
    `).all(...ACTIVE_TASK_STATUSES) as Array<{
      id: string;
      version: number;
      agentId: string | null;
      projectId: string | null;
      sessionId: string | null;
      originType: string;
      originId: string | null;
      metadata: string;
    }>;
    for (const row of rows) {
      const detachProject = row.projectId !== null
        && options.validProjects !== undefined
        && !options.validProjects.has(row.projectId);
      const detachSession = row.sessionId !== null
        && options.validSessions !== undefined
        && !options.validSessions.has(row.sessionId);
      const detachBoardOrigin = row.originType === 'board'
        && row.originId !== null
        && options.validBoards !== undefined
        && !options.validBoards.has(row.originId);
      let version = Number(row.version);
      if (detachProject || detachSession || detachBoardOrigin) {
        let metadata: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(row.metadata) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch { /* replace malformed metadata with a valid recovery snapshot */ }
        if (detachBoardOrigin) {
          metadata = {
            ...metadata,
            integrityReconciled: true,
            orphanedBoardOriginId: row.originId,
          };
        }
        const result = db.prepare(`
          UPDATE tasks SET projectId = ?, sessionId = ?, originId = ?, metadata = ?,
            version = version + 1, updatedAt = ?
          WHERE id = ? AND version = ?
        `).run(
          detachProject ? null : row.projectId,
          detachSession ? null : row.sessionId,
          detachBoardOrigin ? null : row.originId,
          JSON.stringify(metadata),
          report.startedAt,
          row.id,
          version,
        );
        if (Number(result.changes) !== 1) throw new Error(`Task ${row.id} changed during data-integrity reconciliation`);
        if (detachProject) add(report.detached, 'activeTasks.projectId', 1);
        if (detachSession) add(report.detached, 'activeTasks.sessionId', 1);
        if (detachBoardOrigin) add(report.detached, 'activeTasks.boardOriginId', 1);
        version += 1;
        if (objects.has('task_events')) {
          db.prepare(`
            INSERT INTO task_events (taskId, type, ts, data) VALUES (?, 'integrity_reconciled', ?, ?)
          `).run(row.id, report.startedAt, JSON.stringify({
            detachedProjectId: detachProject ? row.projectId : undefined,
            detachedSessionId: detachSession ? row.sessionId : undefined,
            detachedBoardOriginId: detachBoardOrigin ? row.originId : undefined,
          }));
        }
      }

      const missingAgent = row.agentId !== null
        && !row.agentId.startsWith('bg-')
        && options.validAgents !== undefined
        && !options.validAgents.has(row.agentId);
      if (missingAgent || detachBoardOrigin) {
        const missing = [
          detachBoardOrigin ? 'Board card' : '',
          missingAgent ? 'assigned agent' : '',
        ].filter(Boolean).join(' and ');
        transitionTaskInOpenTransaction({
          taskId: row.id,
          status: 'lost',
          expectedVersion: version,
          currentStep: `${missing} no longer available`,
          nextAction: null,
          error: `${missing} no longer exists.`,
          metadata: {
            integrityReconciled: true,
            ...(missingAgent ? { missingAgentId: row.agentId } : {}),
            ...(detachBoardOrigin ? { orphanedBoardOriginId: row.originId } : {}),
          },
        });
        add(report.stateTransitions, detachBoardOrigin
          ? 'activeTasks.lostMissingBoard'
          : 'activeTasks.lostMissingAgent', 1);
      }
    }

    if (options.validBoards !== undefined) {
      const terminalRows = db.prepare(`
        SELECT id, version, originId, metadata FROM tasks
        WHERE status IN (${TERMINAL_TASK_SQL}) AND originType = 'board' AND originId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM integrity_valid_boards owner WHERE owner.id = tasks.originId)
      `).all(...TERMINAL_TASK_STATUSES) as Array<{
        id: string;
        version: number;
        originId: string;
        metadata: string;
      }>;
      for (const row of terminalRows) {
        let metadata: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(row.metadata) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch { /* replace malformed metadata with a valid recovery snapshot */ }
        const result = db.prepare(`
          UPDATE tasks SET originId = NULL, metadata = ?, version = version + 1, updatedAt = ?
          WHERE id = ? AND version = ?
        `).run(JSON.stringify({
          ...metadata,
          integrityReconciled: true,
          orphanedBoardOriginId: row.originId,
        }), report.startedAt, row.id, row.version);
        if (Number(result.changes) !== 1) throw new Error(`Task ${row.id} changed during data-integrity reconciliation`);
        add(report.detached, 'terminalTasks.boardOriginId', 1);
      }
    }

    if (options.validProjects !== undefined) {
      add(report.preservedHistorical, 'terminalTasks.projectId', scalarCount(db, `
        SELECT COUNT(*) AS count FROM tasks
        WHERE status IN (${TERMINAL_TASK_SQL}) AND projectId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM integrity_valid_projects owner WHERE owner.id = tasks.projectId)
      `, TERMINAL_TASK_STATUSES));
    }
    if (options.validSessions !== undefined) {
      add(report.preservedHistorical, 'terminalTasks.sessionId', scalarCount(db, `
        SELECT COUNT(*) AS count FROM tasks
        WHERE status IN (${TERMINAL_TASK_SQL}) AND sessionId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM integrity_valid_sessions owner WHERE owner.id = tasks.sessionId)
      `, TERMINAL_TASK_STATUSES));
    }
    if (options.validAgents !== undefined) {
      add(report.preservedHistorical, 'terminalTasks.agentId', scalarCount(db, `
        SELECT COUNT(*) AS count FROM tasks
        WHERE status IN (${TERMINAL_TASK_SQL}) AND agentId IS NOT NULL AND agentId NOT LIKE 'bg-%'
          AND NOT EXISTS (SELECT 1 FROM integrity_valid_agents owner WHERE owner.id = tasks.agentId)
      `, TERMINAL_TASK_STATUSES));
    }
  }

  if (objects.has('meeting_outputs')) {
    const interruptedBefore = new Date(Date.parse(report.startedAt) - 5 * 60_000).toISOString();
    if (options.validBoards !== undefined) {
      changed(db, report.stateTransitions, 'meetingOutputs.recoveredBoard', `
        UPDATE meeting_outputs
        SET status = 'ready', externalId = 'meeting-board-' || substr(id, 16), error = NULL
        WHERE type = 'board_card' AND status IN ('creating', 'failed')
          AND id LIKE 'meeting-output-%' AND createdAt <= ?
          AND EXISTS (
            SELECT 1 FROM integrity_valid_boards owner
            WHERE owner.id = 'meeting-board-' || substr(meeting_outputs.id, 16)
          )
      `, [interruptedBefore]);
      changed(db, report.stateTransitions, 'meetingOutputs.failedMissingBoard', `
        UPDATE meeting_outputs
        SET status = 'failed',
          error = 'The linked Board card no longer exists.', externalId = ''
        WHERE type = 'board_card' AND status = 'ready' AND externalId != ''
          AND NOT EXISTS (
            SELECT 1 FROM integrity_valid_boards owner WHERE owner.id = meeting_outputs.externalId
          )
      `);
      changed(db, report.stateTransitions, 'meetingOutputs.failedInterruptedBoard', `
        UPDATE meeting_outputs
        SET status = 'failed', error = 'Board-card creation was interrupted; retry the confirmed output.'
        WHERE type = 'board_card' AND status = 'creating' AND createdAt <= ?
      `, [interruptedBefore]);
    }
    if (objects.has('routines')) {
      changed(db, report.stateTransitions, 'meetingOutputs.recoveredRoutine', `
        UPDATE meeting_outputs
        SET status = 'ready', externalId = 'meeting-routine-' || substr(id, 16), error = NULL
        WHERE type = 'routine' AND status IN ('creating', 'failed')
          AND id LIKE 'meeting-output-%' AND createdAt <= ?
          AND EXISTS (
            SELECT 1 FROM routines owner
            WHERE owner.id = 'meeting-routine-' || substr(meeting_outputs.id, 16)
              AND owner.deletedAt IS NULL
          )
      `, [interruptedBefore]);
      changed(db, report.stateTransitions, 'meetingOutputs.failedMissingRoutine', `
        UPDATE meeting_outputs
        SET status = 'failed',
          error = 'The linked Automation no longer exists.', externalId = ''
        WHERE type = 'routine' AND status = 'ready' AND externalId != ''
          AND NOT EXISTS (
            SELECT 1 FROM routines owner
            WHERE owner.id = meeting_outputs.externalId AND owner.deletedAt IS NULL
          )
      `);
      changed(db, report.stateTransitions, 'meetingOutputs.failedInterruptedRoutine', `
        UPDATE meeting_outputs
        SET status = 'failed', error = 'Automation creation was interrupted; retry the confirmed output.'
        WHERE type = 'routine' AND status = 'creating' AND createdAt <= ?
      `, [interruptedBefore]);
    }
  }

  if (options.validAgents !== undefined && objects.has('agent_memory')) {
    changed(db, report.deleted, 'agent_memory.missingAgent', `
      DELETE FROM agent_memory
      WHERE agentId != '__chat__' AND agentId NOT LIKE 'bg-%'
        AND NOT EXISTS (SELECT 1 FROM integrity_valid_agents owner WHERE owner.id = agent_memory.agentId)
    `);
  }

  if (options.validAgents !== undefined && objects.has('routines')) {
    if (objects.has('routine_invocations')) {
      changed(db, report.stateTransitions, 'routineInvocations.skippedMissingAgent', `
        UPDATE routine_invocations SET status = 'skipped',
          error = 'The assigned agent no longer exists.', result = NULL,
          leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
        WHERE status = 'pending' AND routineId IN (
          SELECT routine.id FROM routines routine
          WHERE NOT EXISTS (SELECT 1 FROM integrity_valid_agents owner WHERE owner.id = routine.agentId)
        )
      `, [report.startedAt, report.startedAt]);
      add(report.deferred, 'processingRoutineInvocations.missingAgent', scalarCount(db, `
        SELECT COUNT(*) AS count FROM routine_invocations invocation
        JOIN routines routine ON routine.id = invocation.routineId
        WHERE invocation.status = 'processing'
          AND NOT EXISTS (SELECT 1 FROM integrity_valid_agents owner WHERE owner.id = routine.agentId)
      `));
    }
    if (objects.has('routine_trigger_state')) {
      changed(db, report.deleted, 'routine_trigger_state.missingAgent', `
        DELETE FROM routine_trigger_state
        WHERE routineId IN (
          SELECT routine.id FROM routines routine
          WHERE NOT EXISTS (SELECT 1 FROM integrity_valid_agents owner WHERE owner.id = routine.agentId)
        )
      `);
    }
    changed(db, report.stateTransitions, 'routines.disabledMissingAgent', `
      UPDATE routines SET enabled = 0, deletedAt = COALESCE(deletedAt, ?),
        version = version + 1, updatedAt = ?
      WHERE (enabled != 0 OR deletedAt IS NULL)
        AND NOT EXISTS (SELECT 1 FROM integrity_valid_agents owner WHERE owner.id = routines.agentId)
    `, [report.startedAt, report.startedAt]);
    if (objects.has('meeting_outputs')) {
      changed(db, report.stateTransitions, 'meetingOutputs.failedNewlyDeletedRoutine', `
        UPDATE meeting_outputs
        SET status = 'failed', error = 'The linked Automation no longer exists.', externalId = ''
        WHERE type = 'routine' AND status = 'ready' AND externalId != ''
          AND NOT EXISTS (
            SELECT 1 FROM routines owner
            WHERE owner.id = meeting_outputs.externalId AND owner.deletedAt IS NULL
          )
      `);
    }
  }

  if (options.validAgents !== undefined && objects.has('schedule_execution_intents')) {
    changed(db, report.stateTransitions, 'scheduleIntents.skippedMissingAgent', `
      UPDATE schedule_execution_intents SET status = 'skipped',
        error = 'The assigned agent no longer exists.', result = NULL,
        leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ?, completedAt = ?
      WHERE status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM integrity_valid_agents owner WHERE owner.id = schedule_execution_intents.agentId)
    `, [report.startedAt, report.startedAt]);
    add(report.deferred, 'processingScheduleIntents.missingAgent', scalarCount(db, `
      SELECT COUNT(*) AS count FROM schedule_execution_intents
      WHERE status = 'processing'
        AND NOT EXISTS (SELECT 1 FROM integrity_valid_agents owner WHERE owner.id = schedule_execution_intents.agentId)
    `));
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

function ftsMappingDrift(db: Db, base: string, fts: string): boolean {
  const baseName = quoteIdentifier(base);
  const docsizeName = quoteIdentifier(`${fts}_docsize`);
  const row = db.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM ${docsizeName} index_row
      LEFT JOIN ${baseName} content_row ON content_row.rowid = index_row.id
      WHERE content_row.rowid IS NULL LIMIT 1
    ) OR EXISTS (
      SELECT 1 FROM ${baseName} content_row
      LEFT JOIN ${docsizeName} index_row ON index_row.id = content_row.rowid
      WHERE index_row.id IS NULL LIMIT 1
    ) AS drift
  `).get() as { drift: number | bigint };
  return Boolean(Number(row.drift));
}

function ftsIntegrityCheck(db: Db, fts: string): boolean {
  const name = quoteIdentifier(fts);
  try {
    db.exec(`INSERT INTO ${name}(${name}, rank) VALUES ('integrity-check', 1)`);
    return true;
  } catch {
    return false;
  }
}

function reconcileFts(db: Db, objects: ReadonlySet<string>, report: DataIntegrityReport): void {
  for (const [base, fts] of [
    ['runs', 'runs_fts'],
    ['tasks', 'tasks_fts'],
    ['audit_log', 'audit_fts'],
  ] as const) {
    if (!hasAll(objects, base, fts, `${fts}_docsize`)) continue;
    const drifted = ftsMappingDrift(db, base, fts) || !ftsIntegrityCheck(db, fts);
    if (!drifted) continue;
    const name = quoteIdentifier(fts);
    db.exec(`INSERT INTO ${name}(${name}) VALUES ('rebuild')`);
    if (ftsMappingDrift(db, base, fts) || !ftsIntegrityCheck(db, fts)) {
      throw new Error(`FTS index ${fts} is still inconsistent after rebuild`);
    }
    report.ftsRebuilt.push(fts);
  }
}

function installTrigger(db: Db, report: DataIntegrityReport, name: string, sql: string): void {
  const exists = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?
  `).get(name));
  // Definitions are versioned by code, not by SQLite's IF NOT EXISTS. Always
  // replace an older/weaker trigger during a successful integrity transaction.
  db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(name)}`);
  db.exec(sql);
  if (!exists) report.constraintsInstalled.push(name);
}

function installCoreOwnershipConstraints(db: Db, objects: ReadonlySet<string>, report: DataIntegrityReport): void {
  if (!objects.has('tasks')) return;
  db.exec('DROP TRIGGER IF EXISTS integrity_tasks_owned_cascade_ad');
  for (const table of ['task_evidence', 'task_attention', 'task_commands', 'task_events', 'task_outbox', 'task_checkpoints']) {
    if (!objects.has(table)) continue;
    const insertName = `integrity_${table}_owner_bi`;
    const updateName = `integrity_${table}_owner_bu`;
    installTrigger(db, report, insertName, `
      CREATE TRIGGER IF NOT EXISTS ${insertName}
      BEFORE INSERT ON ${table}
      WHEN NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = NEW.taskId)
      BEGIN SELECT RAISE(ABORT, '${table} requires an existing task'); END
    `);
    installTrigger(db, report, updateName, `
      CREATE TRIGGER IF NOT EXISTS ${updateName}
      BEFORE UPDATE OF taskId ON ${table}
      WHEN NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = NEW.taskId)
      BEGIN SELECT RAISE(ABORT, '${table} requires an existing task'); END
    `);
  }

  installTrigger(db, report, 'integrity_tasks_parent_bi', `
    CREATE TRIGGER IF NOT EXISTS integrity_tasks_parent_bi
    BEFORE INSERT ON tasks
    WHEN NEW.parentId IS NOT NULL AND (
      NEW.parentId = NEW.id OR NOT EXISTS (SELECT 1 FROM tasks parent WHERE parent.id = NEW.parentId)
    )
    BEGIN SELECT RAISE(ABORT, 'tasks.parentId requires an existing, different task'); END
  `);
  installTrigger(db, report, 'integrity_tasks_parent_bu', `
    CREATE TRIGGER IF NOT EXISTS integrity_tasks_parent_bu
    BEFORE UPDATE OF parentId ON tasks
    WHEN NEW.parentId IS NOT NULL AND (
      NEW.parentId = NEW.id OR NOT EXISTS (SELECT 1 FROM tasks parent WHERE parent.id = NEW.parentId)
    )
    BEGIN SELECT RAISE(ABORT, 'tasks.parentId requires an existing, different task'); END
  `);

  if (objects.has('task_checkpoints')) {
    installTrigger(db, report, 'integrity_tasks_checkpoint_bi', `
      CREATE TRIGGER IF NOT EXISTS integrity_tasks_checkpoint_bi
      BEFORE INSERT ON tasks
      WHEN NEW.checkpointId IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM task_checkpoints checkpoint
        WHERE checkpoint.id = NEW.checkpointId AND checkpoint.taskId = NEW.id
      )
      BEGIN SELECT RAISE(ABORT, 'tasks.checkpointId requires a checkpoint owned by the task'); END
    `);
    installTrigger(db, report, 'integrity_tasks_checkpoint_bu', `
      CREATE TRIGGER IF NOT EXISTS integrity_tasks_checkpoint_bu
      BEFORE UPDATE OF checkpointId ON tasks
      WHEN NEW.checkpointId IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM task_checkpoints checkpoint
        WHERE checkpoint.id = NEW.checkpointId AND checkpoint.taskId = NEW.id
      )
      BEGIN SELECT RAISE(ABORT, 'tasks.checkpointId requires a checkpoint owned by the task'); END
    `);
  }

  if (hasAll(objects, 'task_checkpoint_files', 'task_checkpoints')) {
    for (const operation of ['INSERT', 'UPDATE OF checkpointId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_task_checkpoint_files_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON task_checkpoint_files
        WHEN NOT EXISTS (SELECT 1 FROM task_checkpoints owner WHERE owner.id = NEW.checkpointId)
        BEGIN SELECT RAISE(ABORT, 'task_checkpoint_files requires an existing checkpoint'); END
      `);
    }
  }
  if (hasAll(objects, 'task_checkpoint_restores', 'task_checkpoints')) {
    for (const operation of ['INSERT', 'UPDATE OF checkpointId, taskId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_task_checkpoint_restores_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON task_checkpoint_restores
        WHEN NOT EXISTS (
          SELECT 1 FROM task_checkpoints owner
          WHERE owner.id = NEW.checkpointId AND owner.taskId = NEW.taskId
        )
        BEGIN SELECT RAISE(ABORT, 'task_checkpoint_restores requires a matching task checkpoint'); END
      `);
    }
  }

  for (const table of ['task_evidence', 'task_attention', 'task_commands', 'task_events', 'task_outbox']) {
    if (!objects.has(table)) continue;
    const name = `integrity_tasks_${table}_cascade_ad`;
    installTrigger(db, report, name, `
      CREATE TRIGGER IF NOT EXISTS ${name}
      AFTER DELETE ON tasks BEGIN
        DELETE FROM ${table} WHERE taskId = OLD.id;
      END
    `);
  }
  if (objects.has('task_checkpoints')) {
    const statements = [
      objects.has('task_checkpoint_files')
        ? 'DELETE FROM task_checkpoint_files WHERE checkpointId IN (SELECT id FROM task_checkpoints WHERE taskId = OLD.id);'
        : '',
      objects.has('task_checkpoint_restores')
        ? 'DELETE FROM task_checkpoint_restores WHERE taskId = OLD.id OR checkpointId IN (SELECT id FROM task_checkpoints WHERE taskId = OLD.id);'
        : '',
      'DELETE FROM task_checkpoints WHERE taskId = OLD.id;',
    ].filter(Boolean).join('\n');
    installTrigger(db, report, 'integrity_tasks_checkpoints_cascade_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_tasks_checkpoints_cascade_ad
      AFTER DELETE ON tasks BEGIN ${statements} END
    `);
    const checkpointStatements = [
      objects.has('task_checkpoint_files') ? 'DELETE FROM task_checkpoint_files WHERE checkpointId = OLD.id;' : '',
      objects.has('task_checkpoint_restores') ? 'DELETE FROM task_checkpoint_restores WHERE checkpointId = OLD.id;' : '',
      `UPDATE tasks SET checkpointId = NULL, version = version + 1,
        updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE checkpointId = OLD.id;`,
    ].filter(Boolean).join('\n');
    installTrigger(db, report, 'integrity_task_checkpoints_cascade_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_task_checkpoints_cascade_ad
      AFTER DELETE ON task_checkpoints BEGIN ${checkpointStatements} END
    `);
  }
  installTrigger(db, report, 'integrity_tasks_parent_cascade_ad', `
    CREATE TRIGGER IF NOT EXISTS integrity_tasks_parent_cascade_ad
    AFTER DELETE ON tasks BEGIN
      UPDATE tasks SET parentId = NULL, version = version + 1,
        updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE parentId = OLD.id;
    END
  `);
  if (objects.has('runs')) {
    installTrigger(db, report, 'integrity_tasks_runs_cascade_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_tasks_runs_cascade_ad
      AFTER DELETE ON tasks BEGIN UPDATE runs SET taskId = NULL WHERE taskId = OLD.id; END
    `);
  }

  if (hasAll(objects, 'task_run_controls', 'task_commands')) {
    for (const operation of ['INSERT', 'UPDATE OF commandId, taskId, runId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_task_run_controls_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON task_run_controls
        WHEN NOT EXISTS (
           SELECT 1 FROM task_commands command
           JOIN tasks owner ON owner.id = command.taskId
           WHERE command.id = NEW.commandId AND command.taskId = NEW.taskId
             AND owner.runId = NEW.runId
         )
        ${objects.has('runs') ? `OR (NEW.runId IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM runs run WHERE run.id = NEW.runId
        ))` : ''}
        BEGIN SELECT RAISE(ABORT, 'task_run_controls requires a matching task command'); END
      `);
    }
    installTrigger(db, report, 'integrity_task_commands_controls_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_task_commands_controls_ad
      AFTER DELETE ON task_commands BEGIN
        DELETE FROM task_run_controls WHERE commandId = OLD.id;
      END
    `);
    installTrigger(db, report, 'integrity_tasks_controls_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_tasks_controls_ad
      AFTER DELETE ON tasks BEGIN
        DELETE FROM task_run_controls WHERE taskId = OLD.id;
      END
    `);
    installTrigger(db, report, 'integrity_tasks_controls_run_au', `
      CREATE TRIGGER IF NOT EXISTS integrity_tasks_controls_run_au
      AFTER UPDATE OF runId ON tasks BEGIN
        DELETE FROM task_run_controls
        WHERE taskId = NEW.id AND runId IS NOT NEW.runId;
      END
    `);
  }

  if (objects.has('task_dependencies')) {
    installTrigger(db, report, 'integrity_tasks_dependencies_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_tasks_dependencies_ad
      AFTER DELETE ON tasks BEGIN
        DELETE FROM task_dependencies WHERE taskId = OLD.id OR dependsOnTaskId = OLD.id;
      END
    `);
  }
  if (objects.has('task_worker_claims')) {
    installTrigger(db, report, 'integrity_tasks_worker_claims_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_tasks_worker_claims_ad
      AFTER DELETE ON tasks BEGIN
        DELETE FROM task_worker_claims WHERE taskId = OLD.id;
      END
    `);
  }

  if (hasAll(objects, 'capability_packs', 'capability_pack_versions')) {
    for (const operation of ['INSERT', 'UPDATE OF activeVersion, previousVersion'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_capability_packs_versions_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON capability_packs
        WHEN (${operation === 'INSERT' ? '' : 'NEW.activeVersion IS NOT OLD.activeVersion AND '}
          NEW.activeVersion IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM capability_pack_versions version
          WHERE version.packId = NEW.id AND version.version = NEW.activeVersion
        )) OR (${operation === 'INSERT' ? '' : 'NEW.previousVersion IS NOT OLD.previousVersion AND '}
          NEW.previousVersion IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM capability_pack_versions version
          WHERE version.packId = NEW.id AND version.version = NEW.previousVersion
        ))
        BEGIN SELECT RAISE(ABORT, 'capability pack versions must exist for the pack'); END
      `);
    }
    installTrigger(db, report, 'integrity_capability_packs_id_bu', `
      CREATE TRIGGER IF NOT EXISTS integrity_capability_packs_id_bu
      BEFORE UPDATE OF id ON capability_packs
      WHEN NEW.id != OLD.id
      BEGIN SELECT RAISE(ABORT, 'capability pack id is immutable'); END
    `);
    installTrigger(db, report, 'integrity_capability_pack_versions_key_bu', `
      CREATE TRIGGER IF NOT EXISTS integrity_capability_pack_versions_key_bu
      BEFORE UPDATE OF packId, version ON capability_pack_versions
      WHEN NEW.packId != OLD.packId OR NEW.version != OLD.version
      BEGIN SELECT RAISE(ABORT, 'capability pack version identity is immutable'); END
    `);
    installTrigger(db, report, 'integrity_capability_pack_versions_packs_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_capability_pack_versions_packs_ad
      AFTER DELETE ON capability_pack_versions BEGIN
        UPDATE capability_packs SET
          activeVersion = CASE WHEN activeVersion = OLD.version THEN NULL ELSE activeVersion END,
          previousVersion = CASE WHEN previousVersion = OLD.version THEN NULL ELSE previousVersion END,
          status = CASE WHEN activeVersion = OLD.version THEN 'disabled' ELSE status END,
          updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = OLD.packId
          AND (activeVersion = OLD.version OR previousVersion = OLD.version);
      END
    `);
    installTrigger(db, report, 'integrity_capability_packs_versions_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_capability_packs_versions_ad
      AFTER DELETE ON capability_packs BEGIN
        DELETE FROM capability_pack_versions WHERE packId = OLD.id;
      END
    `);
  }

  if (objects.has('runs')) {
    installTrigger(db, report, 'integrity_runs_active_task_guard_bd', `
      CREATE TRIGGER IF NOT EXISTS integrity_runs_active_task_guard_bd
      BEFORE DELETE ON runs
      WHEN EXISTS (
        SELECT 1 FROM tasks task WHERE task.runId = OLD.id
          AND task.status IN ('queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked')
      )
      BEGIN SELECT RAISE(ABORT, 'cannot delete a run referenced by an active task'); END
    `);
    installTrigger(db, report, 'integrity_runs_terminal_tasks_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_runs_terminal_tasks_ad
      AFTER DELETE ON runs BEGIN
        UPDATE tasks SET runId = NULL, version = version + 1,
          updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE runId = OLD.id AND status IN ('succeeded', 'failed', 'cancelled', 'lost');
      END
    `);
    if (objects.has('task_run_controls')) {
      installTrigger(db, report, 'integrity_runs_controls_ad', `
        CREATE TRIGGER IF NOT EXISTS integrity_runs_controls_ad
        AFTER DELETE ON runs BEGIN
          DELETE FROM task_run_controls WHERE runId = OLD.id;
        END
      `);
    }
  }
}

function installOptionalOwnershipConstraints(db: Db, objects: ReadonlySet<string>, report: DataIntegrityReport): void {
  if (hasAll(objects, 'artifact_versions', 'artifacts', 'task_checkpoints')) {
    for (const operation of ['INSERT', 'UPDATE OF artifactId, checkpointId, evidenceId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_artifact_versions_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON artifact_versions
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts artifact
          JOIN task_checkpoints checkpoint ON checkpoint.id = NEW.checkpointId
          WHERE artifact.id = NEW.artifactId AND checkpoint.taskId = artifact.taskId
        ) ${objects.has('task_evidence') ? `OR (
          NEW.evidenceId IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM artifacts artifact
            JOIN task_evidence evidence ON evidence.id = NEW.evidenceId
            WHERE artifact.id = NEW.artifactId AND evidence.taskId = artifact.taskId
          )
        )` : ''}
        BEGIN SELECT RAISE(ABORT, 'artifact version owners must belong to the same task'); END
      `);
    }
    installTrigger(db, report, 'integrity_artifacts_current_version_bu', `
      CREATE TRIGGER IF NOT EXISTS integrity_artifacts_current_version_bu
      BEFORE UPDATE OF currentVersionId ON artifacts
      WHEN NOT EXISTS (
        SELECT 1 FROM artifact_versions version
        WHERE version.id = NEW.currentVersionId AND version.artifactId = NEW.id
      )
      BEGIN SELECT RAISE(ABORT, 'artifact currentVersionId must belong to the artifact'); END
    `);
    installTrigger(db, report, 'integrity_checkpoints_artifact_versions_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_checkpoints_artifact_versions_ad
      AFTER DELETE ON task_checkpoints BEGIN
        DELETE FROM artifact_versions WHERE checkpointId = OLD.id;
        UPDATE artifacts SET currentVersionId = (
          SELECT version.id FROM artifact_versions version
          WHERE version.artifactId = artifacts.id
          ORDER BY version.version DESC, version.createdAt DESC LIMIT 1
        ), updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE NOT EXISTS (
          SELECT 1 FROM artifact_versions current
          WHERE current.id = artifacts.currentVersionId AND current.artifactId = artifacts.id
        ) AND EXISTS (
          SELECT 1 FROM artifact_versions remaining WHERE remaining.artifactId = artifacts.id
        );
        DELETE FROM artifacts
        WHERE NOT EXISTS (SELECT 1 FROM artifact_versions version WHERE version.artifactId = artifacts.id);
      END
    `);
    if (objects.has('task_evidence')) {
      installTrigger(db, report, 'integrity_evidence_artifact_versions_ad', `
        CREATE TRIGGER IF NOT EXISTS integrity_evidence_artifact_versions_ad
        AFTER DELETE ON task_evidence BEGIN
          UPDATE artifact_versions SET evidenceId = NULL WHERE evidenceId = OLD.id;
        END
      `);
    }
  }

  if (hasAll(objects, 'artifact_versions', 'artifacts')) {
    for (const table of ['artifact_annotations', 'artifact_publications']) {
      if (!objects.has(table)) continue;
      for (const operation of ['INSERT', 'UPDATE OF artifactId, versionId'] as const) {
        const suffix = operation === 'INSERT' ? 'bi' : 'bu';
        const name = `integrity_${table}_owner_${suffix}`;
        installTrigger(db, report, name, `
          CREATE TRIGGER IF NOT EXISTS ${name}
          BEFORE ${operation} ON ${table}
          WHEN NOT EXISTS (
            SELECT 1 FROM artifact_versions version
            WHERE version.id = NEW.versionId AND version.artifactId = NEW.artifactId
          )
          BEGIN SELECT RAISE(ABORT, '${table} version must belong to its artifact'); END
        `);
      }
    }
  }

  if (hasAll(objects, 'harness_grants', 'tasks')) {
    for (const operation of ['INSERT', 'UPDATE OF taskId, childTaskId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_harness_grants_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON harness_grants
        WHEN NOT EXISTS (
          SELECT 1 FROM tasks parent JOIN tasks child ON child.parentId = parent.id
          WHERE parent.id = NEW.taskId AND child.id = NEW.childTaskId AND child.id != parent.id
            AND EXISTS (
              SELECT 1 FROM json_each(
                CASE WHEN json_valid(parent.workspaceRoots) THEN
                  CASE WHEN json_type(parent.workspaceRoots) = 'array'
                    THEN parent.workspaceRoots ELSE '[]' END
                ELSE '[]' END
              ) root
              WHERE json_extract(root.value, '$.id') = NEW.workspaceRootId
                AND json_extract(root.value, '$.path') = NEW.workspacePath
                AND json_extract(root.value, '$.permission') = 'write'
            )
        )
        BEGIN SELECT RAISE(ABORT, 'harness grant child and workspace must belong to its parent task'); END
      `);
    }
    installTrigger(db, report, 'integrity_tasks_harness_parent_au', `
      CREATE TRIGGER IF NOT EXISTS integrity_tasks_harness_parent_au
      AFTER UPDATE OF parentId, workspaceRoots ON tasks BEGIN
        DELETE FROM harness_grants
        WHERE (childTaskId = NEW.id OR taskId = NEW.id) AND NOT EXISTS (
          SELECT 1 FROM tasks parent JOIN tasks child ON child.parentId = parent.id
          WHERE parent.id = harness_grants.taskId AND child.id = harness_grants.childTaskId
            AND child.id != parent.id AND EXISTS (
              SELECT 1 FROM json_each(
                CASE WHEN json_valid(parent.workspaceRoots) THEN
                  CASE WHEN json_type(parent.workspaceRoots) = 'array'
                    THEN parent.workspaceRoots ELSE '[]' END
                ELSE '[]' END
              ) root
              WHERE json_extract(root.value, '$.id') = harness_grants.workspaceRootId
                AND json_extract(root.value, '$.path') = harness_grants.workspacePath
                AND json_extract(root.value, '$.permission') = 'write'
            )
        );
      END
    `);
  }

  if (hasAll(objects, 'routine_invocations', 'tasks')) {
    for (const operation of ['INSERT', 'UPDATE OF taskId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_routine_invocations_task_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON routine_invocations
        WHEN NEW.taskId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = NEW.taskId)
        BEGIN SELECT RAISE(ABORT, 'routine invocation task must exist'); END
      `);
    }
  }
  if (hasAll(objects, 'routine_step_runs', 'tasks')) {
    for (const operation of ['INSERT', 'UPDATE OF taskId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_routine_step_runs_task_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON routine_step_runs
        WHEN NEW.taskId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = NEW.taskId)
        BEGIN SELECT RAISE(ABORT, 'routine step task must exist'); END
      `);
    }
  }
  if (hasAll(objects, 'routine_step_runs', 'routine_invocations')) {
    installTrigger(db, report, 'integrity_routine_invocations_steps_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_routine_invocations_steps_ad
      AFTER DELETE ON routine_invocations BEGIN
        DELETE FROM routine_step_runs WHERE invocationId = OLD.id;
      END
    `);
  }
  if (hasAll(objects, 'routine_trigger_state', 'routines')) {
    for (const operation of ['INSERT', 'UPDATE OF routineId, triggerId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_routine_trigger_state_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON routine_trigger_state
        WHEN NOT EXISTS (
          SELECT 1 FROM routines owner, json_each(
            CASE WHEN json_valid(owner.triggers) THEN owner.triggers ELSE '[]' END
          ) trigger
          WHERE owner.id = NEW.routineId
            AND json_extract(
              CASE WHEN trigger.type = 'object' THEN trigger.value ELSE '{}' END,
              '$.id'
            ) = NEW.triggerId
        )
        BEGIN SELECT RAISE(ABORT, 'routine trigger state requires a trigger owned by the routine'); END
      `);
    }
    installTrigger(db, report, 'integrity_routines_trigger_state_au', `
      CREATE TRIGGER IF NOT EXISTS integrity_routines_trigger_state_au
      AFTER UPDATE OF triggers ON routines BEGIN
        DELETE FROM routine_trigger_state
        WHERE routineId = NEW.id AND NOT EXISTS (
          SELECT 1 FROM json_each(
            CASE WHEN json_valid(NEW.triggers) THEN NEW.triggers ELSE '[]' END
          ) trigger
          WHERE json_extract(
            CASE WHEN trigger.type = 'object' THEN trigger.value ELSE '{}' END,
            '$.id'
          ) = routine_trigger_state.triggerId
        );
      END
    `);
  }

  if (objects.has('tasks')) {
    const statements = [
      objects.has('routine_step_runs') ? `UPDATE routine_step_runs
        SET status = CASE WHEN status = 'processing' THEN 'failed' ELSE status END,
          error = CASE WHEN status = 'processing' THEN COALESCE(error, 'The linked task was deleted.') ELSE error END,
          taskId = NULL, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE taskId = OLD.id;` : '',
      objects.has('routine_invocations')
        ? `UPDATE routine_invocations SET taskId = NULL, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE taskId = OLD.id;`
        : '',
      objects.has('meeting_outputs') ? 'UPDATE meeting_outputs SET taskId = NULL WHERE taskId = OLD.id;' : '',
      objects.has('schedule_execution_intents')
        ? `UPDATE schedule_execution_intents SET taskId = NULL, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE taskId = OLD.id;`
        : '',
    ].filter(Boolean).join('\n');
    if (statements) {
      installTrigger(db, report, 'integrity_tasks_optional_refs_ad', `
        CREATE TRIGGER IF NOT EXISTS integrity_tasks_optional_refs_ad
        AFTER DELETE ON tasks BEGIN ${statements} END
      `);
    }
  }

  if (hasAll(objects, 'meeting_outputs', 'tasks')) {
    for (const operation of ['INSERT', 'UPDATE OF taskId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_meeting_outputs_task_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON meeting_outputs
        WHEN NEW.taskId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tasks owner WHERE owner.id = NEW.taskId)
        BEGIN SELECT RAISE(ABORT, 'meeting output task must exist'); END
      `);
    }
  }

  if (hasAll(objects, 'native_node_grants', 'native_nodes')) {
    for (const operation of ['INSERT', 'UPDATE OF nodeId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_native_node_grants_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON native_node_grants
        WHEN NOT EXISTS (SELECT 1 FROM native_nodes owner WHERE owner.id = NEW.nodeId)
        BEGIN SELECT RAISE(ABORT, 'native-node grant requires an existing node'); END
      `);
    }
  }
  if (hasAll(objects, 'native_node_jobs', 'native_nodes')) {
    for (const operation of [
      'INSERT',
      'UPDATE OF nodeId, grantId, grantRevision, targetAppId, targetAppRevision',
    ] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_native_node_jobs_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON native_node_jobs
        WHEN NOT EXISTS (SELECT 1 FROM native_nodes owner WHERE owner.id = NEW.nodeId)
          ${objects.has('native_node_grants') ? `OR (NEW.grantId IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM native_node_grants grantRow
            WHERE grantRow.id = NEW.grantId AND grantRow.nodeId = NEW.nodeId
              AND grantRow.revision = NEW.grantRevision
              AND grantRow.appId = NEW.targetAppId
              AND grantRow.appRevision = NEW.targetAppRevision
          ))` : ''}
        BEGIN SELECT RAISE(ABORT, 'native-node job owners must belong to the same node'); END
      `);
    }
  }
  if (hasAll(objects, 'native_node_events', 'native_nodes')) {
    for (const operation of ['INSERT', 'UPDATE OF nodeId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_native_node_events_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON native_node_events
        WHEN NOT EXISTS (SELECT 1 FROM native_nodes owner WHERE owner.id = NEW.nodeId)
        BEGIN SELECT RAISE(ABORT, 'native-node event requires an existing node'); END
      `);
    }
  }
  if (objects.has('native_nodes')) {
    const statements = [
      objects.has('native_node_events') ? 'DELETE FROM native_node_events WHERE nodeId = OLD.id;' : '',
      objects.has('native_node_jobs') ? 'DELETE FROM native_node_jobs WHERE nodeId = OLD.id;' : '',
      objects.has('native_node_grants') ? 'DELETE FROM native_node_grants WHERE nodeId = OLD.id;' : '',
    ].filter(Boolean).join('\n');
    if (statements) {
      installTrigger(db, report, 'integrity_native_nodes_owned_ad', `
        CREATE TRIGGER IF NOT EXISTS integrity_native_nodes_owned_ad
        AFTER DELETE ON native_nodes BEGIN ${statements} END
      `);
    }
  }
  if (hasAll(objects, 'native_node_grants', 'native_node_jobs')) {
    installTrigger(db, report, 'integrity_native_node_grants_jobs_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_native_node_grants_jobs_ad
      AFTER DELETE ON native_node_grants BEGIN
        UPDATE native_node_jobs SET status = CASE
            WHEN status IN ('queued', 'processing') THEN 'failed' ELSE status END,
          error = CASE WHEN status IN ('queued', 'processing')
            THEN COALESCE(error, 'The native-node grant was deleted.') ELSE error END,
          leaseTokenHash = CASE WHEN status IN ('queued', 'processing') THEN NULL ELSE leaseTokenHash END,
          leaseExpiresAt = CASE WHEN status IN ('queued', 'processing') THEN NULL ELSE leaseExpiresAt END,
          completedAt = CASE WHEN status IN ('queued', 'processing')
            THEN COALESCE(completedAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE completedAt END,
          grantId = NULL, grantRevision = NULL,
          updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE grantId = OLD.id;
      END
    `);
  }

  if (hasAll(objects, 'companion_action_receipts', 'companion_devices')) {
    for (const operation of ['INSERT', 'UPDATE OF deviceId'] as const) {
      const suffix = operation === 'INSERT' ? 'bi' : 'bu';
      const name = `integrity_companion_action_receipts_owner_${suffix}`;
      installTrigger(db, report, name, `
        CREATE TRIGGER IF NOT EXISTS ${name}
        BEFORE ${operation} ON companion_action_receipts
        WHEN NOT EXISTS (SELECT 1 FROM companion_devices owner WHERE owner.id = NEW.deviceId)
        BEGIN SELECT RAISE(ABORT, 'companion action receipt requires an existing device'); END
      `);
    }
    installTrigger(db, report, 'integrity_companion_devices_receipts_ad', `
      CREATE TRIGGER IF NOT EXISTS integrity_companion_devices_receipts_ad
      AFTER DELETE ON companion_devices BEGIN
        DELETE FROM companion_action_receipts WHERE deviceId = OLD.id;
      END
    `);
  }

  if (objects.has('runs')) {
    const statements = [
      objects.has('agent_memory') ? `UPDATE agent_memory SET sourceId = NULL,
        updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE source = 'learned' AND sourceId = OLD.id;` : '',
      objects.has('context_compactions')
        ? `DELETE FROM context_compactions WHERE scopeType = 'run' AND scopeId = OLD.id;`
        : '',
      objects.has('context_scope_state')
        ? `DELETE FROM context_scope_state WHERE scopeType = 'run' AND scopeId = OLD.id;`
        : '',
      objects.has('context_sources') ? `DELETE FROM context_sources WHERE scopeType = 'run' AND scopeId = OLD.id;
        UPDATE context_sources SET runId = NULL, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE runId = OLD.id;` : '',
      objects.has('capability_packs') ? `UPDATE capability_packs SET lastSuccessRunId = NULL,
        updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE lastSuccessRunId = OLD.id;` : '',
      objects.has('schedule_execution_intents') ? `UPDATE schedule_execution_intents SET runId = NULL,
        updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE runId = OLD.id;` : '',
    ].filter(Boolean).join('\n');
    if (statements) {
      installTrigger(db, report, 'integrity_runs_optional_refs_ad', `
        CREATE TRIGGER IF NOT EXISTS integrity_runs_optional_refs_ad
        AFTER DELETE ON runs BEGIN ${statements} END
      `);
    }
  }
}

function reportChangeTotal(report: DataIntegrityReport): number {
  const buckets = [report.deleted, report.detached, report.updated, report.stateTransitions];
  return buckets.reduce((total, bucket) =>
    total + Object.values(bucket).reduce((sum, value) => sum + value, 0), 0) + report.ftsRebuilt.length;
}

function runReconciliation(options: ReconcileDataIntegrityOptions): DataIntegrityReport {
  const now = normalizedNow(options.now);
  const startedAt = now.toISOString();
  const validAgents = normalizedSet(options.validAgentIds);
  const validBoards = normalizedSet(options.validBoardIds);
  const validProjects = normalizedSet(options.validProjectIds);
  const validSessions = normalizedSet(options.validSessionIds);
  const report: DataIntegrityReport = {
    reason: options.reason?.trim() || 'manual',
    startedAt,
    completedAt: '',
    foreignKeysEnabled: false,
    deleted: {},
    detached: {},
    updated: {},
    stateTransitions: {},
    deferred: {},
    preservedHistorical: {},
    ftsRebuilt: [],
    constraintsInstalled: [],
    foreignKeyViolations: 0,
    totalChanges: 0,
  };

  const db = getDb();
  // This is intentionally explicit even though modern node:sqlite enables
  // constraints by default. A restored/legacy handle must not inherit a lax
  // connection setting.
  db.exec('PRAGMA foreign_keys = ON');
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number | bigint };
  report.foreignKeysEnabled = Number(foreignKeys.foreign_keys) === 1;
  if (!report.foreignKeysEnabled) throw new Error('SQLite foreign-key enforcement could not be enabled');

  db.exec('BEGIN IMMEDIATE');
  try {
    loadTempIds(db, 'integrity_valid_agents', validAgents);
    loadTempIds(db, 'integrity_valid_boards', validBoards);
    loadTempIds(db, 'integrity_valid_projects', validProjects);
    loadTempIds(db, 'integrity_valid_sessions', validSessions);
    const objects = sqliteObjects(db);

    reconcileCrossStoreIds(db, objects, report, { validAgents, validBoards, validProjects, validSessions });
    // Cross-store loss transitions can make formerly active weak references
    // terminal. Run relational cleanup afterwards so one pass fully converges.
    reconcileCoreTaskOwnership(db, objects, report);
    reconcileArtifacts(db, objects, report);
    reconcileOptionalRelations(db, objects, report);
    reconcileContext(db, objects, report, { validProjects, validSessions });
    reconcileFts(db, objects, report);
    installCoreOwnershipConstraints(db, objects, report);
    installOptionalOwnershipConstraints(db, objects, report);
    failForForeignKeyViolations(db);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }

  // Verify again outside the transaction so callers never receive a success
  // report for a connection whose committed state violates a declared FK.
  const violations = foreignKeyViolations(db);
  report.foreignKeyViolations = violations.length;
  if (violations.length) failForForeignKeyViolations(db);
  report.totalChanges = reportChangeTotal(report);
  report.completedAt = new Date().toISOString();
  return report;
}

/**
 * Converge every loaded SQLite ownership invariant. Concurrent callers in this
 * process receive the exact same Promise and therefore cannot interleave two
 * repair transactions. Re-running after convergence is a no-op.
 */
export function reconcileDataIntegrity(
  options: ReconcileDataIntegrityOptions = {},
): Promise<DataIntegrityReport> {
  if (globals.__shibaDataIntegrityPromise) {
    // Calls can coalesce during the microtask before the synchronous SQLite
    // pass begins. Preserve any already-supplied validation set, while a newer
    // supplied snapshot replaces an older one. This prevents a lightweight
    // retention call from swallowing a simultaneous full coordinator pass.
    const queued = globals.__shibaDataIntegrityOptions || {};
    globals.__shibaDataIntegrityOptions = {
      ...queued,
      ...options,
      validAgentIds: options.validAgentIds ?? queued.validAgentIds,
      validBoardIds: options.validBoardIds ?? queued.validBoardIds,
      validProjectIds: options.validProjectIds ?? queued.validProjectIds,
      validSessionIds: options.validSessionIds ?? queued.validSessionIds,
    };
    return globals.__shibaDataIntegrityPromise;
  }
  globals.__shibaDataIntegrityOptions = options;
  const promise = Promise.resolve().then(() => {
    const queued = globals.__shibaDataIntegrityOptions || options;
    globals.__shibaDataIntegrityOptions = undefined;
    return runReconciliation(queued);
  });
  globals.__shibaDataIntegrityPromise = promise;
  void promise.finally(() => {
    if (globals.__shibaDataIntegrityPromise === promise) {
      globals.__shibaDataIntegrityPromise = undefined;
      globals.__shibaDataIntegrityOptions = undefined;
    }
  }).catch(() => undefined);
  return promise;
}
