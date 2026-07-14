import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-task-checkpoints-'));
  const workspace = path.join(root, 'workspace');
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '55'.repeat(32);

  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'owned.txt'), 'baseline\n');
  await fs.writeFile(path.join(workspace, 'unrelated.txt'), 'committed\n');
  git(workspace, 'init');
  git(workspace, 'config', 'user.email', 'checkpoint@example.invalid');
  git(workspace, 'config', 'user.name', 'Checkpoint Verifier');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', 'baseline');
  await fs.writeFile(path.join(workspace, 'unrelated.txt'), 'user dirty bytes\n');

  const dbModule = await import('../lib/db');
  const ledger = await import('../lib/task-ledger');
  const checkpoints = await import('../lib/task-checkpoints');

  try {
    const db = dbModule.getDb();
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, 14);
    for (const table of ['task_checkpoints', 'task_checkpoint_files', 'task_checkpoint_restores']) {
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { n: number }).n,
        1,
        `${table} migration exists`,
      );
    }

    const task = ledger.createTask({
      id: 'checkpoint-task',
      kind: 'code',
      title: 'Safely mutate owned paths',
      originType: 'manual',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'write' }],
      plan: [{ id: 'edit', title: 'Edit owned files', status: 'in_progress' }],
    });

    const mutation = await checkpoints.withTaskCheckpoint({
      taskId: task.id,
      reason: 'Before editing task-owned files',
      files: [
        { workspaceRootId: 'repo', path: 'owned.txt' },
        { workspaceRootId: 'repo', path: 'new.txt' },
      ],
      context: { messageCursor: { count: 12, lastMessageId: 'message-12' }, approvalIds: ['approval-1'] },
    }, async () => {
      await fs.writeFile(path.join(workspace, 'owned.txt'), 'task bytes\n');
      await fs.writeFile(path.join(workspace, 'new.txt'), 'task new file\n');
      return 'mutated';
    });
    assert.equal(mutation.value, 'mutated');
    assert.equal(mutation.checkpoint.state, 'ready');
    assert.equal(mutation.checkpoint.files.length, 2);
    assert.equal(mutation.checkpoint.context.messageCursor instanceof Object, true);
    assert.equal(ledger.getTask(task.id)?.checkpointId, mutation.checkpoint.id, 'checkpoint is linked from task metadata');
    assert.equal(checkpoints.listTaskCheckpoints(task.id)[0].id, mutation.checkpoint.id);
    assert.equal(checkpoints.getTaskCheckpoint(mutation.checkpoint.id, task.id)?.taskSnapshot.plan[0].id, 'edit');

    db.exec(`
      CREATE TEMP TRIGGER fail_checkpoint_task_commit
      BEFORE UPDATE ON tasks
      WHEN OLD.id = 'checkpoint-task' AND NEW.status = 'queued'
      BEGIN
        SELECT RAISE(ABORT, 'simulated checkpoint task commit failure');
      END
    `);
    try {
      await assert.rejects(
        () => checkpoints.restoreTaskCheckpoint(task.id, mutation.checkpoint.id),
        /database commit failed/i,
      );
    } finally {
      db.exec('DROP TRIGGER fail_checkpoint_task_commit');
    }
    assert.equal(
      await fs.readFile(path.join(workspace, 'owned.txt'), 'utf8'),
      'task bytes\n',
      'a failed task commit compensates file bytes to the pre-restore generation',
    );
    assert.equal(await fs.readFile(path.join(workspace, 'new.txt'), 'utf8'), 'task new file\n');

    const blockingRestoreId = 'already-processing-restore';
    db.prepare(`
      INSERT INTO task_checkpoint_restores
        (id, checkpointId, taskId, status, restoredPaths, conflicts, startedAt, completedAt, error, conversationSnapshot)
      VALUES (?, ?, ?, 'processing', '[]', '{}', ?, NULL, NULL, NULL)
    `).run(blockingRestoreId, mutation.checkpoint.id, task.id, new Date().toISOString());
    try {
      await assert.rejects(
        () => checkpoints.restoreTaskCheckpoint(task.id, mutation.checkpoint.id),
        /already has a checkpoint restore in progress/i,
      );
      assert.equal(
        await fs.readFile(path.join(workspace, 'owned.txt'), 'utf8'),
        'task bytes\n',
        'a competing restore is rejected before it can touch file bytes',
      );
    } finally {
      db.prepare('DELETE FROM task_checkpoint_restores WHERE id = ?').run(blockingRestoreId);
    }

    const unrelatedBefore = await fs.readFile(path.join(workspace, 'unrelated.txt'));
    const restored = await checkpoints.restoreTaskCheckpoint(task.id, mutation.checkpoint.id);
    assert.equal(restored.status, 'restored');
    assert.deepEqual(restored.restoredPaths.sort(), ['repo/new.txt', 'repo/owned.txt']);
    assert.equal(await fs.readFile(path.join(workspace, 'owned.txt'), 'utf8'), 'baseline\n');
    await assert.rejects(() => fs.stat(path.join(workspace, 'new.txt')), /ENOENT/);
    assert.deepEqual(
      await fs.readFile(path.join(workspace, 'unrelated.txt')),
      unrelatedBefore,
      'unrelated pre-existing dirty file remains byte-for-byte intact',
    );
    assert.equal(git(workspace, 'status', '--porcelain'), 'M unrelated.txt');
    const idempotent = await checkpoints.restoreTaskCheckpoint(task.id, mutation.checkpoint.id);
    assert.deepEqual(idempotent.restoredPaths, [], 'repeat restore is an idempotent no-op');

    const interruptedIdempotentRestoreId = 'interrupted-idempotent-restore';
    db.prepare(`
      INSERT INTO task_checkpoint_restores
        (id, checkpointId, taskId, status, restoredPaths, conflicts, startedAt, completedAt, error, conversationSnapshot)
      VALUES (?, ?, ?, 'processing', '[]', ?, ?, NULL, NULL, NULL)
    `).run(
      interruptedIdempotentRestoreId,
      mutation.checkpoint.id,
      task.id,
      JSON.stringify({ originalSides: { 'repo/owned.txt': 'before', 'repo/new.txt': 'before' } }),
      new Date(Date.now() - 60_000).toISOString(),
    );
    const idempotentRecovery = await checkpoints.reconcileInterruptedCheckpointRestores();
    assert.deepEqual(idempotentRecovery, { inspected: 1, compensated: 1, attention: 0, errors: [] });
    assert.equal(await fs.readFile(path.join(workspace, 'owned.txt'), 'utf8'), 'baseline\n');
    await assert.rejects(() => fs.stat(path.join(workspace, 'new.txt')), /ENOENT/);

    // Simulate a process stopping after file rewind but before the task commit.
    // The durable processing row must drive startup compensation back to the
    // sealed post-mutation generation.
    await fs.writeFile(path.join(workspace, 'owned.txt'), 'baseline\n');
    await fs.rm(path.join(workspace, 'new.txt'), { force: true });
    const interruptedRestoreId = 'interrupted-checkpoint-restore';
    db.prepare(`
      INSERT INTO task_checkpoint_restores
        (id, checkpointId, taskId, status, restoredPaths, conflicts, startedAt, completedAt, error, conversationSnapshot)
      VALUES (?, ?, ?, 'processing', ?, '[]', ?, NULL, NULL, NULL)
    `).run(
      interruptedRestoreId,
      mutation.checkpoint.id,
      task.id,
      JSON.stringify(['repo/owned.txt', 'repo/new.txt']),
      new Date(Date.now() - 60_000).toISOString(),
    );
    const interruptedRecovery = await checkpoints.reconcileInterruptedCheckpointRestores();
    assert.deepEqual(interruptedRecovery, { inspected: 1, compensated: 1, attention: 0, errors: [] });
    assert.equal(await fs.readFile(path.join(workspace, 'owned.txt'), 'utf8'), 'task bytes\n');
    assert.equal(await fs.readFile(path.join(workspace, 'new.txt'), 'utf8'), 'task new file\n');
    assert.equal(checkpoints.getTaskCheckpointRestore(interruptedRestoreId)?.status, 'failed');
    await checkpoints.restoreTaskCheckpoint(task.id, mutation.checkpoint.id);

    await fs.writeFile(path.join(workspace, 'second-owned.txt'), 'second before\n');
    const conflictCheckpoint = await checkpoints.withTaskCheckpoint({
      taskId: task.id,
      reason: 'Conflict guard',
      files: [
        { workspaceRootId: 'repo', path: 'owned.txt' },
        { workspaceRootId: 'repo', path: 'second-owned.txt' },
      ],
    }, async () => {
      await fs.writeFile(path.join(workspace, 'owned.txt'), 'task second edit\n');
      await fs.writeFile(path.join(workspace, 'second-owned.txt'), 'second task edit\n');
    });
    await fs.writeFile(path.join(workspace, 'owned.txt'), 'another actor bytes\n');
    await assert.rejects(
      () => checkpoints.restoreTaskCheckpoint(task.id, conflictCheckpoint.checkpoint.id),
      (error: unknown) => error instanceof checkpoints.CheckpointConflictError
        && error.restore.status === 'conflict'
        && error.restore.conflicts.some((item) => item.includes('repo/owned.txt')),
    );
    assert.equal(
      await fs.readFile(path.join(workspace, 'owned.txt'), 'utf8'),
      'another actor bytes\n',
      'conflict refusal does not overwrite newer bytes',
    );
    assert.equal(
      await fs.readFile(path.join(workspace, 'second-owned.txt'), 'utf8'),
      'second task edit\n',
      'one conflict refuses the whole restore before any safe path is changed',
    );

    const open = await checkpoints.createTaskCheckpoint({
      taskId: task.id,
      reason: 'Open checkpoint cannot restore',
      files: [{ workspaceRootId: 'repo', path: 'owned.txt' }],
    });
    await assert.rejects(() => checkpoints.restoreTaskCheckpoint(task.id, open.id), /not sealed/);

    const failedBefore = checkpoints.listTaskCheckpoints(task.id).length;
    await assert.rejects(
      () => checkpoints.withTaskCheckpoint({
        taskId: task.id,
        reason: 'Partial failed mutation',
        files: [{ workspaceRootId: 'repo', path: 'partial.txt' }],
      }, async () => {
        await fs.writeFile(path.join(workspace, 'partial.txt'), 'partial bytes\n');
        throw new Error('simulated mutation failure');
      }),
      /simulated mutation failure/,
    );
    const failedMutationCheckpoint = checkpoints.listTaskCheckpoints(task.id)
      .find((item) => item.reason === 'Partial failed mutation');
    assert(failedMutationCheckpoint && failedMutationCheckpoint.state === 'ready');
    assert.equal(checkpoints.listTaskCheckpoints(task.id).length, failedBefore + 1);
    await checkpoints.restoreTaskCheckpoint(task.id, failedMutationCheckpoint.id);
    await assert.rejects(() => fs.stat(path.join(workspace, 'partial.txt')), /ENOENT/);

    const readOnly = ledger.createTask({
      id: 'checkpoint-readonly',
      kind: 'work',
      title: 'Cannot checkpoint read-only root',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'read' }],
    });
    await assert.rejects(
      () => checkpoints.createTaskCheckpoint({
        taskId: readOnly.id,
        reason: 'Should fail',
        files: [{ workspaceRootId: 'repo', path: 'owned.txt' }],
      }),
      /read-only/,
    );
    await assert.rejects(
      () => checkpoints.createTaskCheckpoint({
        taskId: task.id,
        reason: 'Traversal should fail',
        files: [{ workspaceRootId: 'repo', path: '../outside.txt' }],
      }),
      /escapes/,
    );

    // Exercise the App Router handlers with async params, explicit sealing,
    // cache-safe reads, and checkpoint-bound destructive confirmation.
    const apiTask = ledger.createTask({
      id: 'checkpoint-api-task',
      kind: 'code',
      title: 'Checkpoint API',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'write' }],
    });
    await fs.writeFile(path.join(workspace, 'api.txt'), 'api before\n');
    const collectionRoute = await import('../app/api/tasks/[id]/checkpoints/route');
    const itemRoute = await import('../app/api/tasks/[id]/checkpoints/[checkpointId]/route');
    const restoreRoute = await import('../app/api/tasks/[id]/checkpoints/[checkpointId]/restore/route');
    const createdResponse = await collectionRoute.POST(new Request('http://localhost/api/tasks/checkpoint-api-task/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'API pre-mutation', files: [{ workspaceRootId: 'repo', path: 'api.txt' }] }),
    }), { params: Promise.resolve({ id: apiTask.id }) });
    assert.equal(createdResponse.status, 201);
    const createdJson = await createdResponse.json() as { checkpoint: { id: string; state: string } };
    await fs.writeFile(path.join(workspace, 'api.txt'), 'api after\n');
    const sealedResponse = await itemRoute.PATCH(new Request('http://localhost/checkpoint', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'seal' }),
    }), { params: Promise.resolve({ id: apiTask.id, checkpointId: createdJson.checkpoint.id }) });
    assert.equal(sealedResponse.status, 200);
    const readResponse = await itemRoute.GET(new Request('http://localhost/checkpoint'), {
      params: Promise.resolve({ id: apiTask.id, checkpointId: createdJson.checkpoint.id }),
    });
    assert.equal(readResponse.status, 200);
    assert.equal(readResponse.headers.get('cache-control'), 'no-store');
    const readJson = await readResponse.json() as { checkpoint: { files: Array<Record<string, unknown>> } };
    assert.equal('beforeContent' in readJson.checkpoint.files[0], false, 'checkpoint bytes are never exposed by the API');
    const unconfirmed = await restoreRoute.POST(new Request('http://localhost/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), { params: Promise.resolve({ id: apiTask.id, checkpointId: createdJson.checkpoint.id }) });
    assert.equal(unconfirmed.status, 428);
    const apiRestore = await restoreRoute.POST(new Request('http://localhost/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmCheckpointId: createdJson.checkpoint.id }),
    }), { params: Promise.resolve({ id: apiTask.id, checkpointId: createdJson.checkpoint.id }) });
    assert.equal(apiRestore.status, 200);
    assert.equal(await fs.readFile(path.join(workspace, 'api.txt'), 'utf8'), 'api before\n');

    const evidence = ledger.getTaskDetails(task.id)?.evidence
      .filter((item) => item.metadata.checkpointId === mutation.checkpoint.id) ?? [];
    assert.equal(evidence.length >= 1, true, 'successful restore writes task evidence');
    console.log('Task checkpoint verification passed');
  } finally {
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
