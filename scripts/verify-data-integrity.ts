import './verify-isolate';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-data-integrity-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = 'd1'.repeat(32);

  const dbModule = await import('../lib/db');
  const ledger = await import('../lib/task-ledger');
  const context = await import('../lib/context-engine');
  const memory = await import('../lib/agent-memory');
  const artifacts = await import('../lib/artifacts');
  const capabilityPacks = await import('../lib/capability-packs');
  const companion = await import('../lib/companion-auth');
  const harness = await import('../lib/harness-grants');
  const meetings = await import('../lib/meetings');
  const nativeNodes = await import('../lib/native-nodes');
  const routines = await import('../lib/routines');
  const taskTeams = await import('../lib/task-teams');
  const integrity = await import('../lib/data-integrity');

  try {
    const db = dbModule.getDb();
    const now = '2026-07-13T12:00:00.000Z';
    // Materialize every lazy SQLite ownership schema before the integrity pass
    // so this verifier covers the complete relational graph, not only the core
    // migration tables.
    artifacts.listArtifacts();
    capabilityPacks.ensureCapabilityPackSchema();
    companion.ensureCompanionSchema();
    harness.listHarnessGrants();
    nativeNodes.ensureNativeNodeSchema();

    ledger.createTask({
      id: 'broken-parent-task',
      kind: 'work',
      title: 'Task with a deleted parent',
      originType: 'manual',
    });
    taskTeams.getTaskTeam('broken-parent-task');
    db.prepare("UPDATE tasks SET parentId = 'missing-parent' WHERE id = 'broken-parent-task'").run();

    ledger.createTask({
      id: 'active-missing-agent',
      kind: 'agent',
      title: 'Active task with missing cross-store owners',
      status: 'running',
      originType: 'manual',
      agentId: 'gone-agent',
      projectId: 'gone-project',
      sessionId: 'gone-session',
      runId: 'missing-agent-run',
    });
    db.prepare(`
      INSERT INTO runs (
        id, agentId, agentName, model, status, prompt, startedAt, completedAt,
        finalOutput, sideEffects, trace, taskId, attemptNo
      ) VALUES ('missing-agent-run', 'gone-agent', 'Gone Agent', 'test', 'running',
        'cancel me', ?, NULL, NULL, '[]', '[]', 'active-missing-agent', 1)
    `).run(now);
    ledger.createTask({
      id: 'active-missing-project-session',
      kind: 'work',
      title: 'Detach stale active scopes',
      originType: 'manual',
      agentId: 'good-agent',
      projectId: 'gone-project',
      sessionId: 'gone-session',
    });
    ledger.createTask({
      id: 'terminal-provenance',
      kind: 'work',
      title: 'Preserve terminal provenance',
      status: 'failed',
      originType: 'manual',
      agentId: 'gone-agent',
      projectId: 'gone-project',
      sessionId: 'gone-session',
    });
    ledger.createTask({
      id: 'ephemeral-background-task',
      kind: 'agent',
      title: 'Background agent survives JSON validation',
      originType: 'system',
      agentId: 'bg-transient-worker',
    });
    ledger.createTask({
      id: 'active-missing-board',
      kind: 'board',
      title: 'Board task whose card was deleted',
      originType: 'board',
      originId: 'gone-card',
      agentId: 'good-agent',
    });
    ledger.createTask({
      id: 'terminal-missing-board',
      kind: 'board',
      title: 'Historical Board task whose card was deleted',
      status: 'succeeded',
      originType: 'board',
      originId: 'gone-card',
      agentId: 'good-agent',
    });

    ledger.createTask({
      id: 'artifact-owner-task', kind: 'artifact', title: 'Artifact owner', originType: 'manual',
    });
    ledger.createTask({
      id: 'artifact-other-task', kind: 'artifact', title: 'Other artifact owner', originType: 'manual',
    });
    const otherEvidence = ledger.recordTaskEvidence({
      taskId: 'artifact-other-task', kind: 'assertion', status: 'passed',
      label: 'Other task evidence', summary: 'Must not be attachable to another task artifact.',
    });
    const insertCheckpoint = db.prepare(`
      INSERT INTO task_checkpoints
        (id, taskId, reason, state, taskSnapshot, context, createdAt, sealedAt)
      VALUES (?, ?, 'artifact verification', 'sealed', '{}', '{}', ?, ?)
    `);
    insertCheckpoint.run('artifact-owner-checkpoint', 'artifact-owner-task', now, now);
    insertCheckpoint.run('artifact-other-checkpoint', 'artifact-other-task', now, now);
    const insertArtifact = db.prepare(`
      INSERT INTO artifacts (
        id, taskId, name, kind, mimeType, status, currentVersionId,
        sourceLineage, liveSource, createdAt, updatedAt
      ) VALUES (?, ?, ?, 'document', 'text/plain', 'draft', ?, '{}', NULL, ?, ?)
    `);
    insertArtifact.run(
      'artifact-a', 'artifact-owner-task', 'Artifact A', 'artifact-a-cross-checkpoint', now, now,
    );
    insertArtifact.run(
      'artifact-b', 'artifact-other-task', 'Artifact B', 'artifact-b-version', now, now,
    );
    const insertVersion = db.prepare(`
      INSERT INTO artifact_versions (
        id, artifactId, checkpointId, version, filePath, relativePath,
        sha256, bytes, renderStatus, renderReport, evidenceId, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'passed', '{}', ?, ?)
    `);
    insertVersion.run(
      'artifact-a-version', 'artifact-a', 'artifact-owner-checkpoint', 1,
      'C:\\artifact-a.txt', 'artifact-a.txt', 'a'.repeat(64), otherEvidence.id, now,
    );
    insertVersion.run(
      'artifact-a-cross-checkpoint', 'artifact-a', 'artifact-other-checkpoint', 2,
      'C:\\artifact-a-bad.txt', 'artifact-a-bad.txt', 'b'.repeat(64), null, now,
    );
    insertVersion.run(
      'artifact-b-version', 'artifact-b', 'artifact-other-checkpoint', 1,
      'C:\\artifact-b.txt', 'artifact-b.txt', 'c'.repeat(64), otherEvidence.id, now,
    );
    db.prepare(`
      INSERT INTO artifact_annotations
        (id, artifactId, versionId, locator, comment, status, createdAt, resolvedAt)
      VALUES ('cross-artifact-annotation', 'artifact-a', 'artifact-b-version', '{}',
        'wrong owner', 'open', ?, NULL)
    `).run(now);
    db.prepare(`
      INSERT INTO artifact_publications
        (id, artifactId, versionId, tokenHash, audience, expiresAt, createdAt, revokedAt)
      VALUES ('cross-artifact-publication', 'artifact-a', 'artifact-b-version',
        'cross-artifact-token', 'private', NULL, ?, NULL)
    `).run(now);

    ledger.createTask({
      id: 'harness-parent', kind: 'work', title: 'Harness parent', originType: 'manual',
      workspaceRoots: [{ id: 'root', path: root, permission: 'write' }],
    });
    ledger.createTask({
      id: 'harness-other-parent', kind: 'work', title: 'Other harness parent', originType: 'manual',
    });
    ledger.createTask({
      id: 'harness-wrong-child', kind: 'external', title: 'Wrong harness child',
      originType: 'manual', parentId: 'harness-other-parent',
    });
    db.prepare(`
      INSERT INTO harness_grants (
        id, taskId, childTaskId, provider, workspaceRootId, workspacePath,
        allowedTools, tokenHash, status, expiresAt, createdAt, usedAt, revokedAt
      ) VALUES ('cross-owned-harness', 'harness-parent', 'harness-wrong-child',
        'codex', 'root', ?, '[]', 'cross-owned-harness-token', 'issued', ?, ?, NULL, NULL)
    `).run(root, '2026-07-14T12:00:00.000Z', now);

    companion.ensureCompanionSchema();
    db.prepare(`
      INSERT INTO companion_action_receipts (
        id, deviceId, idempotencyKey, requestHash, kind, targetId,
        status, result, createdAt, completedAt
      ) VALUES ('orphan-companion-receipt', 'missing-device', 'orphan:receipt',
        'hash', 'command', NULL, 'completed', '{}', ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO capability_pack_versions (
        packId, version, manifest, sourceHash, approvedPermissionKeys, proposalId, createdAt
      ) VALUES ('capability-main', '1.0.0', '{}', 'hash-main', '[]', 'proposal-main', ?),
        ('capability-orphan', '1.0.0', '{}', 'hash-orphan', '[]', 'proposal-orphan', ?)
    `).run(now, now);
    const insertCapabilityPack = db.prepare(`
      INSERT INTO capability_packs (
        id, name, description, status, activeVersion, previousVersion,
        grantedPermissionKeys, sourceType, sourceRef, sourceHash, usageCount,
        lastUsedAt, lastSuccessAt, lastSuccessRunId, staleAt, pinned, archived,
        createdAt, updatedAt
      ) VALUES (?, ?, '', ?, ?, NULL, '[]', 'folder', 'test', ?, 0,
        NULL, NULL, NULL, NULL, 0, 0, ?, ?)
    `);
    insertCapabilityPack.run('capability-main', 'Main capability', 'active', '1.0.0', 'hash-main', now, now);
    insertCapabilityPack.run('capability-broken', 'Broken capability', 'active', 'missing', 'hash-broken', now, now);

    db.prepare(`
      INSERT INTO task_events (taskId, type, ts, data)
      VALUES ('ghost-task', 'orphan', ?, '{}')
    `).run(now);
    db.prepare(`
      INSERT INTO task_checkpoints
        (id, taskId, reason, state, taskSnapshot, context, createdAt, sealedAt)
      VALUES ('orphan-checkpoint', 'ghost-task', 'test', 'open', '{}', '{}', ?, NULL)
    `).run(now);
    db.prepare(`
      INSERT INTO task_checkpoint_files
        (checkpointId, workspaceRootId, workspacePath, relativePath, beforeExists)
      VALUES ('orphan-checkpoint', 'root', ?, 'orphan.txt', 0)
    `).run(root);

    // Create the lazy control table, then inject a control with neither owner.
    ledger.claimTaskRunControlSignals('schema-only-run', 'integrity-verifier');
    db.prepare(`
      INSERT INTO task_run_controls (
        id, commandId, taskId, runId, kind, status, attempts, availableAt, createdAt
      ) VALUES ('orphan-control', 'missing-command', 'ghost-task', 'missing-run',
        'cancel', 'pending', 0, ?, ?)
    `).run(now, now);

    context.indexSessionMessages('gone-session', [{
      id: 'gone-message',
      role: 'user',
      content: 'This context scope no longer has a session owner.',
    }]);
    context.indexSessionMessages('good-session', [{
      id: 'good-message',
      role: 'user',
      content: 'This context scope remains valid.',
    }]);
    db.prepare(`
      INSERT INTO context_compactions (
        id, scopeType, scopeId, fromOrdinal, toOrdinal, sourceIds, sourceDigest,
        summary, tokenEstimate, algorithm, createdAt, updatedAt
      ) VALUES ('bad-compaction', 'session', 'good-session', 0, 0,
        '["missing-source"]', 'bad', 'bad', 1, 'extractive-v1', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO context_compactions (
        id, scopeType, scopeId, fromOrdinal, toOrdinal, sourceIds, sourceDigest,
        summary, tokenEstimate, algorithm, createdAt, updatedAt
      ) VALUES ('malformed-compaction', 'session', 'good-session', 1, 1,
        '{broken', 'bad', 'bad', 1, 'malformed-test', ?, ?)
    `).run(now, now);
    db.prepare(`
      UPDATE context_scope_state SET sourceCount = 99, summaryCount = 99
      WHERE scopeType = 'session' AND scopeId = 'good-session'
    `).run();
    memory.saveMemory('gone-agent', 'orphan-memory', 'This memory has no persisted agent.');
    memory.saveMemory('good-agent', 'dangling-learned-source', 'Keep the learned fact, detach its missing run.', {
      source: 'learned', sourceId: 'missing-learning-run',
    });

    db.prepare(`
      INSERT INTO runs (
        id, agentId, agentName, model, status, prompt, startedAt, completedAt,
        finalOutput, sideEffects, trace, taskId, attemptNo
      ) VALUES ('guarded-run', 'good-agent', 'Good Agent', 'test', 'running',
        'keep me', ?, NULL, NULL, '[]', '[]', NULL, 1)
    `).run(now);
    ledger.createTask({
      id: 'active-run-owner',
      kind: 'agent',
      title: 'Active task protects its run',
      status: 'running',
      originType: 'run',
      originId: 'guarded-run',
      runId: 'guarded-run',
      agentId: 'good-agent',
    });
    db.prepare("UPDATE runs SET taskId = 'active-run-owner' WHERE id = 'guarded-run'").run();
    db.prepare(`
      INSERT INTO runs (
        id, agentId, agentName, model, status, prompt, startedAt, completedAt,
        finalOutput, sideEffects, trace, taskId, attemptNo
      ) VALUES ('other-control-run', 'good-agent', 'Good Agent', 'test', 'completed',
        'other run', ?, ?, 'done', '[]', '[]', NULL, 1)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_commands (
        id, taskId, kind, status, payload, idempotencyKey, expectedVersion, createdAt, appliedAt
      ) VALUES ('cross-run-command', 'active-run-owner', 'cancel', 'applied', '{}',
        'cross-run-command', 1, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_run_controls (
        id, commandId, taskId, runId, kind, status, attempts, availableAt, createdAt
      ) VALUES ('cross-run-control', 'cross-run-command', 'active-run-owner',
        'other-control-run', 'cancel', 'pending', 0, ?, ?)
    `).run(now, now);

    meetings.ensureMeetingSchema();
    routines.createRoutine({
      id: 'meeting-routine-recover',
      name: 'Recovered meeting output',
      agentId: 'good-agent',
      prompt: 'Verify output ownership.',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
    });
    db.prepare(`
      INSERT INTO routine_invocations (
        id, routineId, triggerId, triggerType, dedupeKey, concurrencyKey, status,
        payload, definitionSnapshot, attempt, maxAttempts, availableAt, leaseOwner,
        leaseExpiresAt, taskId, error, result, createdAt, updatedAt, completedAt
      ) VALUES ('dangling-routine-invocation', 'meeting-routine-recover', 'manual',
        'manual', 'dangling-task', 'routine:integrity', 'processing', '{}', '{}',
        1, 2, ?, 'integrity-worker', ?, 'missing-routine-task', NULL, NULL, ?, ?, NULL)
    `).run(now, '2026-07-13T13:00:00.000Z', now, now);
    db.prepare(`
      INSERT INTO routine_step_runs (
        invocationId, stepId, status, attempt, taskId, output, error, updatedAt
      ) VALUES ('dangling-routine-invocation', 'step', 'processing', 1,
        'missing-routine-step-task', NULL, NULL, ?)
    `).run(now);
    db.prepare(`
      INSERT INTO routine_trigger_state (routineId, triggerId, nextDueAt, lastCheckedAt, state)
      VALUES ('meeting-routine-recover', 'missing-trigger', ?, NULL, '{}')
    `).run(now);

    nativeNodes.ensureNativeNodeSchema();
    const insertNativeNode = db.prepare(`
      INSERT INTO native_nodes (
        id, name, keyHash, platform, releaseId, releaseDigest, capabilities,
        captureState, createdAt, expiresAt, lastSeenAt, revokedAt
      ) VALUES (?, ?, ?, 'test', 'release', 'digest', '["notify"]',
        'idle', ?, ?, ?, NULL)
    `);
    insertNativeNode.run('native-node-a', 'Node A', 'node-key-a', now, '2026-07-14T12:00:00.000Z', now);
    insertNativeNode.run('native-node-b', 'Node B', 'node-key-b', now, '2026-07-14T12:00:00.000Z', now);
    db.prepare(`
      INSERT INTO native_node_grants (
        id, nodeId, appId, appLabel, appRevision, capabilities, constraints,
        revision, createdAt, expiresAt, revokedAt
      ) VALUES ('native-grant-b', 'native-node-b', 'app', 'App', 'v1',
        '["notify"]', '{}', 1, ?, ?, NULL)
    `).run(now, '2026-07-14T12:00:00.000Z');
    const insertNativeJob = db.prepare(`
      INSERT INTO native_node_jobs (
        id, nodeId, action, status, args, targetAppId, targetAppRevision,
        grantId, grantRevision, actionDigest, leaseTokenHash, leaseExpiresAt,
        result, error, securityScan, createdAt, updatedAt, completedAt
      ) VALUES (?, 'native-node-a', 'notify', ?, '{}', NULL, NULL,
        'native-grant-b', 1, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
    `);
    insertNativeJob.run('native-cross-job-active', 'queued', 'digest-active', now, now, null);
    insertNativeJob.run('native-cross-job-terminal', 'succeeded', 'digest-terminal', now, now, now);
    db.prepare(`
      INSERT INTO meetings (
        id, title, source, status, consentAt, consentVersion, originalFilename,
        audioMime, audioBytes, audioSha256, retentionDays, taskId, createdAt, updatedAt
      ) VALUES (
        'integrity-meeting', 'Integrity meeting', 'upload', 'ready', ?, 'test',
        'test.webm', 'audio/webm', 1, 'hash', 30, 'broken-parent-task', ?, ?
      )
    `).run(now, now, now);
    const insertMeetingOutput = db.prepare(`
      INSERT INTO meeting_outputs (
        id, meetingId, actionItemId, type, status, externalId, taskId, error, createdAt
      ) VALUES (?, 'integrity-meeting', ?, ?, ?, ?, 'broken-parent-task', NULL, ?)
    `);
    const old = '2026-07-13T11:00:00.000Z';
    insertMeetingOutput.run('meeting-output-board-recover', 'board-recover', 'board_card', 'creating', '', old);
    insertMeetingOutput.run('missing-board-link', 'board-missing', 'board_card', 'ready', 'gone-output-card', old);
    insertMeetingOutput.run('legacy-board-claim', 'board-interrupted', 'board_card', 'creating', '', old);
    insertMeetingOutput.run('meeting-output-recover', 'routine-recover', 'routine', 'creating', '', old);
    insertMeetingOutput.run('missing-routine-link', 'routine-missing', 'routine', 'ready', 'gone-routine', old);
    insertMeetingOutput.run('legacy-routine-claim', 'routine-interrupted', 'routine', 'creating', '', old);

    // External-content FTS can accumulate shadow rows even while quick_check
    // remains healthy. Seed exactly that historical failure mode.
    db.prepare(`
      INSERT INTO runs_fts(rowid, prompt, finalOutput, agentName)
      VALUES (999999, 'ghost prompt', 'ghost output', 'ghost agent')
    `).run();
    assert(db.prepare('SELECT 1 FROM runs_fts_docsize WHERE id = 999999').get());
    assert.equal((db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok');

    const options = {
      reason: 'verification',
      now,
      validAgentIds: new Set(['good-agent']),
      validBoardIds: new Set(['good-card', 'meeting-board-board-recover']),
      validProjectIds: new Set(['good-project']),
      validSessionIds: new Set(['good-session']),
    };
    const firstPromise = integrity.reconcileDataIntegrity({ reason: 'lightweight-retention-pass', now });
    const concurrentPromise = integrity.reconcileDataIntegrity(options);
    assert.strictEqual(concurrentPromise, firstPromise, 'concurrent callers must share one process-wide pass');
    const first = await firstPromise;

    assert.equal(first.foreignKeysEnabled, true);
    assert.equal(first.reason, 'verification', 'a simultaneous full pass must enrich a lightweight request');
    assert.equal(first.foreignKeyViolations, 0);
    assert(first.ftsRebuilt.includes('runs_fts'), 'the shadow-row drift must rebuild runs_fts');
    assert(first.constraintsInstalled.length > 0, 'ownership constraints should be installed');
    assert(first.totalChanges > 0);
    assert.equal(db.prepare('SELECT 1 FROM task_events WHERE taskId = ?').get('ghost-task'), undefined);
    assert.equal(db.prepare('SELECT 1 FROM task_checkpoints WHERE id = ?').get('orphan-checkpoint'), undefined);
    assert.equal(db.prepare('SELECT 1 FROM task_checkpoint_files WHERE checkpointId = ?').get('orphan-checkpoint'), undefined);
    assert.equal(db.prepare('SELECT 1 FROM task_run_controls WHERE id = ?').get('orphan-control'), undefined);
    assert.equal(db.prepare('SELECT 1 FROM task_run_controls WHERE id = ?').get('cross-run-control'), undefined);
    assert.equal((db.prepare('SELECT parentId FROM tasks WHERE id = ?').get('broken-parent-task') as { parentId: string | null }).parentId, null);
    assert.equal(db.prepare('SELECT 1 FROM runs_fts_docsize WHERE id = 999999').get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM context_sources WHERE scopeType = 'session' AND scopeId = 'gone-session'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM context_compactions WHERE id = 'bad-compaction'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM context_compactions WHERE id = 'malformed-compaction'").get(), undefined);
    const contextCounts = db.prepare(`
      SELECT sourceCount, summaryCount FROM context_scope_state
      WHERE scopeType = 'session' AND scopeId = 'good-session'
    `).get() as { sourceCount: number; summaryCount: number };
    assert.equal(contextCounts.sourceCount, 1);
    assert.equal(contextCounts.summaryCount, 0);
    assert.equal(db.prepare("SELECT 1 FROM agent_memory WHERE agentId = 'gone-agent'").get(), undefined);
    assert.equal(
      (db.prepare("SELECT sourceId FROM agent_memory WHERE key = 'dangling-learned-source'").get() as { sourceId: string | null }).sourceId,
      null,
    );
    assert.equal(db.prepare("SELECT 1 FROM harness_grants WHERE id = 'cross-owned-harness'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM companion_action_receipts WHERE id = 'orphan-companion-receipt'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM capability_pack_versions WHERE packId = 'capability-orphan'").get(), undefined);
    assert.deepEqual(
      { ...(db.prepare("SELECT status, activeVersion FROM capability_packs WHERE id = 'capability-broken'").get() as Record<string, unknown>) },
      { status: 'disabled', activeVersion: null },
    );
    assert.equal(db.prepare("SELECT 1 FROM artifact_versions WHERE id = 'artifact-a-cross-checkpoint'").get(), undefined);
    assert.equal(
      (db.prepare("SELECT currentVersionId FROM artifacts WHERE id = 'artifact-a'").get() as { currentVersionId: string }).currentVersionId,
      'artifact-a-version',
    );
    assert.equal(
      (db.prepare("SELECT evidenceId FROM artifact_versions WHERE id = 'artifact-a-version'").get() as { evidenceId: string | null }).evidenceId,
      null,
    );
    assert.equal(db.prepare("SELECT 1 FROM artifact_annotations WHERE id = 'cross-artifact-annotation'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM artifact_publications WHERE id = 'cross-artifact-publication'").get(), undefined);
    assert.equal(
      (db.prepare("SELECT taskId FROM routine_invocations WHERE id = 'dangling-routine-invocation'").get() as { taskId: string | null }).taskId,
      null,
    );
    assert.deepEqual(
      { ...(db.prepare("SELECT status, taskId FROM routine_step_runs WHERE invocationId = 'dangling-routine-invocation'").get() as Record<string, unknown>) },
      { status: 'failed', taskId: null },
    );
    assert.equal(
      db.prepare("SELECT 1 FROM routine_trigger_state WHERE triggerId = 'missing-trigger'").get(),
      undefined,
    );
    assert.deepEqual(
      { ...(db.prepare("SELECT status, grantId, grantRevision FROM native_node_jobs WHERE id = 'native-cross-job-active'").get() as Record<string, unknown>) },
      { status: 'failed', grantId: null, grantRevision: null },
    );
    assert.deepEqual(
      { ...(db.prepare("SELECT status, grantId, grantRevision FROM native_node_jobs WHERE id = 'native-cross-job-terminal'").get() as Record<string, unknown>) },
      { status: 'succeeded', grantId: null, grantRevision: null },
    );

    const cancelled = ledger.getTask('active-missing-agent')!;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.projectId, undefined);
    assert.equal(cancelled.sessionId, undefined);
    assert.equal(
      (db.prepare(`
        SELECT kind FROM task_run_controls
        WHERE taskId = 'active-missing-agent' AND runId = 'missing-agent-run'
      `).get() as { kind: string } | undefined)?.kind,
      'cancel',
    );
    const detached = ledger.getTask('active-missing-project-session')!;
    assert.equal(detached.status, 'queued');
    assert.equal(detached.projectId, undefined);
    assert.equal(detached.sessionId, undefined);
    const historical = ledger.getTask('terminal-provenance')!;
    assert.equal(historical.agentId, 'gone-agent');
    assert.equal(historical.projectId, 'gone-project');
    assert.equal(historical.sessionId, 'gone-session');
    assert.equal(ledger.getTask('ephemeral-background-task')!.status, 'queued');
    const boardCancelled = ledger.getTask('active-missing-board')!;
    assert.equal(boardCancelled.status, 'cancelled');
    assert.equal(boardCancelled.originId, undefined);
    assert.equal(boardCancelled.metadata.orphanedBoardOriginId, 'gone-card');
    const boardHistorical = ledger.getTask('terminal-missing-board')!;
    assert.equal(boardHistorical.originId, undefined);
    assert.equal(boardHistorical.metadata.orphanedBoardOriginId, 'gone-card');

    const output = (id: string) => {
      const row = db.prepare(`
        SELECT status, externalId FROM meeting_outputs WHERE id = ?
      `).get(id) as { status: string; externalId: string };
      return { status: row.status, externalId: row.externalId };
    };
    assert.deepEqual(output('meeting-output-board-recover'), {
      status: 'ready', externalId: 'meeting-board-board-recover',
    });
    assert.deepEqual(output('missing-board-link'), { status: 'failed', externalId: '' });
    assert.deepEqual(output('legacy-board-claim'), { status: 'failed', externalId: '' });
    assert.deepEqual(output('meeting-output-recover'), {
      status: 'ready', externalId: 'meeting-routine-recover',
    });
    assert.deepEqual(output('missing-routine-link'), { status: 'failed', externalId: '' });
    assert.deepEqual(output('legacy-routine-claim'), { status: 'failed', externalId: '' });

    assert.throws(() => db.prepare(`
      INSERT INTO task_events (taskId, type, ts, data) VALUES ('another-ghost', 'bad', ?, '{}')
    `).run(now), /requires an existing task/);
    assert.throws(() => db.prepare(`
      INSERT INTO task_run_controls (
        id, commandId, taskId, runId, kind, status, attempts, availableAt, createdAt
      ) VALUES ('another-cross-run-control', 'cross-run-command', 'active-run-owner',
        'other-control-run', 'cancel', 'pending', 0, ?, ?)
    `).run(now, now), /requires a matching task command/);
    assert.throws(() => db.prepare(`
      INSERT INTO harness_grants (
        id, taskId, childTaskId, provider, workspaceRootId, workspacePath,
        allowedTools, tokenHash, status, expiresAt, createdAt, usedAt, revokedAt
      ) VALUES ('another-cross-harness', 'harness-parent', 'harness-wrong-child',
        'codex', 'root', ?, '[]', 'another-cross-harness-token', 'issued', ?, ?, NULL, NULL)
    `).run(root, '2026-07-14T12:00:00.000Z', now), /child and workspace must belong/);
    assert.throws(() => insertVersion.run(
      'artifact-a-another-cross-checkpoint', 'artifact-a', 'artifact-other-checkpoint', 3,
      'C:\\artifact-a-another-bad.txt', 'artifact-a-another-bad.txt', 'd'.repeat(64), null, now,
    ), /owners must belong to the same task/);
    assert.throws(() => db.prepare(`
      INSERT INTO artifact_annotations
        (id, artifactId, versionId, locator, comment, status, createdAt, resolvedAt)
      VALUES ('another-cross-artifact-annotation', 'artifact-a', 'artifact-b-version',
        '{}', 'wrong owner', 'open', ?, NULL)
    `).run(now), /version must belong to its artifact/);
    assert.throws(() => db.prepare("UPDATE artifacts SET currentVersionId = 'artifact-b-version' WHERE id = 'artifact-a'").run(),
      /currentVersionId must belong to the artifact/);
    assert.throws(() => db.prepare(`
      INSERT INTO companion_action_receipts (
        id, deviceId, idempotencyKey, requestHash, kind, targetId,
        status, result, createdAt, completedAt
      ) VALUES ('another-orphan-receipt', 'missing-device', 'another:receipt',
        'hash', 'command', NULL, 'completed', '{}', ?, ?)
    `).run(now, now), /requires an existing device/);
    assert.throws(() => insertNativeJob.run(
      'another-native-cross-job', 'queued', 'digest-another', now, now, null,
    ), /owners must belong to the same node/);
    assert.throws(() => db.prepare(`
      UPDATE routine_invocations SET taskId = 'still-missing-routine-task'
      WHERE id = 'dangling-routine-invocation'
    `).run(), /task must exist/);
    assert.throws(() => db.prepare(`
      INSERT INTO routine_trigger_state (routineId, triggerId, nextDueAt, lastCheckedAt, state)
      VALUES ('meeting-routine-recover', 'still-missing-trigger', ?, NULL, '{}')
    `).run(now), /requires a trigger owned by the routine/);
    assert.throws(() => db.prepare("DELETE FROM runs WHERE id = 'guarded-run'").run(), /active task/);

    db.prepare('DELETE FROM task_evidence WHERE id = ?').run(otherEvidence.id);
    assert.equal(
      (db.prepare("SELECT evidenceId FROM artifact_versions WHERE id = 'artifact-b-version'").get() as { evidenceId: string | null }).evidenceId,
      null,
    );
    db.prepare("DELETE FROM task_checkpoints WHERE id = 'artifact-owner-checkpoint'").run();
    assert.equal(db.prepare("SELECT 1 FROM artifact_versions WHERE id = 'artifact-a-version'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM artifacts WHERE id = 'artifact-a'").get(), undefined);

    ledger.createTask({
      id: 'routine-trigger-cleanup-task', kind: 'routine', title: 'Routine cleanup task', originType: 'manual',
    });
    db.prepare(`
      UPDATE routine_invocations SET taskId = ? WHERE id = 'dangling-routine-invocation'
    `).run('routine-trigger-cleanup-task');
    db.prepare(`
      UPDATE routine_step_runs SET status = 'processing', taskId = ?, error = NULL
      WHERE invocationId = 'dangling-routine-invocation' AND stepId = 'step'
    `).run('routine-trigger-cleanup-task');
    db.prepare("DELETE FROM tasks WHERE id = 'routine-trigger-cleanup-task'").run();
    assert.equal(
      (db.prepare("SELECT taskId FROM routine_invocations WHERE id = 'dangling-routine-invocation'").get() as { taskId: string | null }).taskId,
      null,
    );
    assert.deepEqual(
      { ...(db.prepare("SELECT status, taskId FROM routine_step_runs WHERE invocationId = 'dangling-routine-invocation'").get() as Record<string, unknown>) },
      { status: 'failed', taskId: null },
    );

    ledger.createTask({
      id: 'meeting-output-cleanup-task', kind: 'artifact', title: 'Meeting output cleanup', originType: 'manual',
    });
    db.prepare(`
      INSERT INTO meeting_outputs (
        id, meetingId, actionItemId, type, status, externalId, taskId, error, createdAt, actionItemSnapshot
      ) VALUES ('meeting-output-task-cleanup', 'integrity-meeting', 'cleanup-action',
        'board_card', 'failed', '', 'meeting-output-cleanup-task', 'test', ?, '{}')
    `).run(now);
    db.prepare("DELETE FROM tasks WHERE id = 'meeting-output-cleanup-task'").run();
    assert.equal(
      (db.prepare("SELECT taskId FROM meeting_outputs WHERE id = 'meeting-output-task-cleanup'").get() as { taskId: string | null }).taskId,
      null,
    );

    db.prepare(`
      INSERT INTO companion_devices (
        id, name, keyHash, scopes, createdAt, expiresAt, lastSeenAt, revokedAt
      ) VALUES ('cleanup-device', 'Cleanup device', 'cleanup-device-key', '[]', ?, ?, ?, NULL)
    `).run(now, '2026-07-14T12:00:00.000Z', now);
    db.prepare(`
      INSERT INTO companion_action_receipts (
        id, deviceId, idempotencyKey, requestHash, kind, targetId,
        status, result, createdAt, completedAt
      ) VALUES ('cleanup-device-receipt', 'cleanup-device', 'cleanup:receipt',
        'hash', 'command', NULL, 'completed', '{}', ?, ?)
    `).run(now, now);
    db.prepare("DELETE FROM companion_devices WHERE id = 'cleanup-device'").run();
    assert.equal(db.prepare("SELECT 1 FROM companion_action_receipts WHERE id = 'cleanup-device-receipt'").get(), undefined);

    assert.throws(() => db.prepare(`
      UPDATE capability_packs SET activeVersion = 'does-not-exist'
      WHERE id = 'capability-main'
    `).run(), /versions must exist for the pack/);
    db.prepare("DELETE FROM capability_packs WHERE id = 'capability-main'").run();
    assert.equal(db.prepare("SELECT 1 FROM capability_pack_versions WHERE packId = 'capability-main'").get(), undefined);
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      INSERT INTO capability_pack_versions (
        packId, version, manifest, sourceHash, approvedPermissionKeys, proposalId, createdAt
      ) VALUES ('capability-version-delete', '1.0.0', '{}', 'hash-delete', '[]', 'proposal-delete', ?)
    `).run(now);
    insertCapabilityPack.run(
      'capability-version-delete', 'Version delete capability', 'active', '1.0.0', 'hash-delete', now, now,
    );
    db.exec('COMMIT');
    db.prepare(`
      DELETE FROM capability_pack_versions
      WHERE packId = 'capability-version-delete' AND version = '1.0.0'
    `).run();
    assert.deepEqual(
      { ...(db.prepare("SELECT status, activeVersion FROM capability_packs WHERE id = 'capability-version-delete'").get() as Record<string, unknown>) },
      { status: 'disabled', activeVersion: null },
    );

    db.prepare(`
      INSERT INTO native_node_grants (
        id, nodeId, appId, appLabel, appRevision, capabilities, constraints,
        revision, createdAt, expiresAt, revokedAt
      ) VALUES ('native-grant-a', 'native-node-a', 'app', 'App', 'v1',
        '["notify"]', '{}', 1, ?, ?, NULL)
    `).run(now, '2026-07-14T12:00:00.000Z');
    db.prepare(`
      INSERT INTO native_node_events (id, nodeId, type, payload, createdAt)
      VALUES ('native-event-a', 'native-node-a', 'test', '{}', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO native_node_jobs (
        id, nodeId, action, status, args, targetAppId, targetAppRevision,
        grantId, grantRevision, actionDigest, leaseTokenHash, leaseExpiresAt,
        result, error, securityScan, createdAt, updatedAt, completedAt
      ) VALUES ('native-job-a', 'native-node-a', 'notify', 'queued', '{}', NULL, NULL,
        NULL, NULL, 'digest-cleanup', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
    `).run(now, now);
    db.prepare("DELETE FROM native_nodes WHERE id = 'native-node-a'").run();
    assert.equal(db.prepare("SELECT 1 FROM native_node_grants WHERE nodeId = 'native-node-a'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM native_node_jobs WHERE nodeId = 'native-node-a'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM native_node_events WHERE nodeId = 'native-node-a'").get(), undefined);

    db.prepare(`
      INSERT INTO runs (
        id, agentId, agentName, model, status, prompt, startedAt, completedAt,
        finalOutput, sideEffects, trace, taskId, attemptNo
      ) VALUES ('learned-source-run', 'good-agent', 'Good Agent', 'test', 'completed',
        'learned source', ?, ?, 'done', '[]', '[]', NULL, 1)
    `).run(now, now);
    memory.saveMemory('good-agent', 'deletion-clears-source', 'Preserve this memory after retention.', {
      source: 'learned', sourceId: 'learned-source-run',
    });
    db.prepare("DELETE FROM runs WHERE id = 'learned-source-run'").run();
    assert.equal(
      (db.prepare("SELECT sourceId FROM agent_memory WHERE key = 'deletion-clears-source'").get() as { sourceId: string | null }).sourceId,
      null,
    );

    const cascadeParent = ledger.createTask({
      id: 'cascade-parent', kind: 'work', title: 'Cascade parent', originType: 'manual',
    });
    ledger.createTask({
      id: 'cascade-child', kind: 'work', title: 'Cascade child', originType: 'manual', parentId: cascadeParent.id,
    });
    db.prepare(`
      INSERT INTO task_dependencies (taskId, dependsOnTaskId, createdAt)
      VALUES ('cascade-child', 'cascade-parent', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO task_worker_claims (
        taskId, ownerId, status, leaseUntil, heartbeatAt, attempt, createdAt, releasedAt
      ) VALUES ('cascade-parent', 'worker', 'active', ?, ?, 1, ?, NULL)
    `).run('2026-07-13T13:00:00.000Z', now, now);
    db.prepare("DELETE FROM tasks WHERE id = 'cascade-parent'").run();
    assert.equal((db.prepare("SELECT parentId FROM tasks WHERE id = 'cascade-child'").get() as { parentId: string | null }).parentId, null);
    assert.equal(db.prepare("SELECT 1 FROM task_events WHERE taskId = 'cascade-parent'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM task_dependencies WHERE dependsOnTaskId = 'cascade-parent'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM task_worker_claims WHERE taskId = 'cascade-parent'").get(), undefined);

    const second = await integrity.reconcileDataIntegrity(options);
    assert.equal(second.totalChanges, 0, 'a converged second pass must not rewrite data');
    assert.deepEqual(second.ftsRebuilt, []);
    assert.deepEqual(second.constraintsInstalled, []);
    assert.equal((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0);

    console.log('data-integrity: 91 passed, 0 failed');
  } finally {
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('data-integrity: failed', error);
  process.exit(1);
});
