import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-task-ledger-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '44'.repeat(32);

  const dbModule = await import('../lib/db');
  const ledger = await import('../lib/task-ledger');
  const runs = await import('../lib/agent-runs-store');
  const delivery = await import('../lib/task-delivery');
  const chats = await import('../lib/chat-sessions');

  try {
    const db = dbModule.getDb();
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.ok(version.user_version >= 7, 'task control-plane migrations should reach at least v7');
    const runColumns = new Set((db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((row) => row.name));
    assert(runColumns.has('taskId'));
    assert(runColumns.has('attemptNo'));

    const parent = ledger.createTask({
      id: 'task-parent',
      kind: 'code',
      title: 'Ship the durable task system',
      description: 'Implement and verify one canonical task ledger.',
      originType: 'manual',
      workspaceRoots: [
        { id: 'frontend', path: path.join(root, 'frontend'), permission: 'write' },
        { id: 'docs', path: path.join(root, 'docs'), permission: 'read' },
      ],
      maxRetries: 2,
      contract: {
        outcome: 'The task ledger is proven.',
        constraints: ['No duplicate terminal delivery'],
        requiredArtifacts: ['task-report.json'],
        requirements: [{
          id: 'tests',
          label: 'Task tests pass',
          acceptedKinds: ['test'],
          scope: 'task-control-plane',
          maxAgeMinutes: 30,
        }],
      },
    });
    assert.equal(parent.status, 'queued');
    assert.equal(parent.workspaceRoots.length, 2);

    const child = ledger.createTask({
      id: 'task-child',
      kind: 'work',
      title: 'Research one dependency',
      parentId: parent.id,
      originType: 'manual',
      metadata: { required: false },
    });
    assert.equal(ledger.getTaskDetails(parent.id)?.children[0]?.id, child.id);
    ledger.transitionTask({ taskId: child.id, status: 'running' });
    const optionalRunning = ledger.getTask(child.id)!;
    ledger.transitionTask({ taskId: child.id, status: 'failed', expectedVersion: optionalRunning.version, error: 'Optional research was unavailable.' });
    for (const item of ledger.claimOutbox()) ledger.finishOutbox(item.id, { delivered: true });
    assert.equal(ledger.listTasks({ kinds: ['code'], q: 'durable' }).total, 1);

    const running = ledger.transitionTask({
      taskId: parent.id,
      status: 'running',
      expectedVersion: parent.version,
      progress: 0.25,
      currentStep: 'Running verification',
    });
    assert.equal(running.status, 'running');
    assert.equal(running.progress, 0.25);
    await assert.rejects(
      async () => ledger.transitionTask({ taskId: parent.id, status: 'queued' }),
      /Invalid task transition/,
    );
    await assert.rejects(
      async () => ledger.transitionTask({ taskId: parent.id, status: 'paused', expectedVersion: parent.version }),
      /concurrently/,
    );

    ledger.recordTaskEvidence({
      taskId: parent.id,
      requirementId: 'tests',
      kind: 'test',
      status: 'failed',
      label: 'First test attempt',
      summary: 'One assertion failed.',
      scope: 'task-control-plane',
      recordedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.throws(() => ledger.recordTaskEvidence({
      taskId: parent.id,
      kind: 'assertion',
      status: 'passed',
      label: 'Evidence from the future',
      summary: 'A client-supplied timestamp must not extend evidence freshness indefinitely.',
      recordedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }), /more than five minutes in the future/);
    const skewedEvidence = ledger.recordTaskEvidence({
      taskId: parent.id,
      kind: 'assertion',
      status: 'informational',
      label: 'Evidence with tolerated clock skew',
      summary: 'The server clock remains the upper bound for freshness.',
      recordedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert(Date.parse(skewedEvidence.recordedAt) <= Date.now(), 'accepted clock skew must be clamped to server time');
    assert.equal(ledger.evaluateTaskCompletion(parent.id).complete, false);
    await assert.rejects(
      async () => ledger.transitionTask({ taskId: parent.id, status: 'succeeded' }),
      /not proven/,
    );
    ledger.recordTaskEvidence({
      taskId: parent.id,
      requirementId: 'tests',
      kind: 'test',
      status: 'passed',
      label: 'Task tests',
      summary: 'All task-ledger assertions passed.',
      scope: 'task-control-plane',
    });
    ledger.recordTaskEvidence({
      taskId: parent.id,
      kind: 'artifact',
      status: 'passed',
      label: 'task-report.json',
      summary: 'Generated verification report.',
      uri: 'task-report.json',
      metadata: { artifact: 'task-report.json' },
    });
    assert.equal(ledger.evaluateTaskCompletion(parent.id).complete, true);
    assert.equal(ledger.evaluateTaskCompletion(parent.id).requirements.some((item) => item.requirementId === `child:${child.id}`), false,
      'an optional failed child is excluded from the parent completion gate');

    const finished = ledger.transitionTask({
      taskId: parent.id,
      status: 'succeeded',
      result: 'Task control plane shipped.',
    });
    assert.equal(finished.status, 'succeeded');
    const attention = ledger.listAttention({ taskId: parent.id, status: 'open' });
    assert.equal(attention.total, 1, 'terminal transition should create exactly one attention item');
    const claimed = ledger.claimOutbox();
    assert.equal(claimed.length, 1, 'terminal transition should atomically enqueue one delivery');
    assert.equal(ledger.claimOutbox().length, 0, 'claimed delivery must not be claimed twice');
    ledger.finishOutbox(claimed[0].id, { delivered: true });
    assert.equal(ledger.resolveAttention(attention.items[0].id).status, 'resolved');

    const session = await chats.createChatSession({ title: 'Outbox delivery test' });
    const chatTask = ledger.createTask({
      id: 'chat-delivery-task',
      kind: 'work',
      title: 'Deliver once',
      description: 'The outbox should not duplicate chat messages.',
      sessionId: session.id,
      originType: 'chat',
      originId: session.id,
    });
    ledger.transitionTask({ taskId: chatTask.id, status: 'running' });
    ledger.transitionTask({ taskId: chatTask.id, status: 'succeeded', result: 'Delivered.' });
    assert.equal(await delivery.processTaskOutbox(), 1);
    let deliveredSession = await chats.getChatSession(session.id);
    assert.equal(deliveredSession?.messages.length, 1);
    db.prepare(`
      UPDATE task_outbox SET status = 'failed', deliveredAt = NULL, availableAt = ?
      WHERE taskId = ?
    `).run(new Date().toISOString(), chatTask.id);
    assert.equal(await delivery.processTaskOutbox(), 1);
    deliveredSession = await chats.getChatSession(session.id);
    assert.equal(deliveredSession?.messages.length, 1, 'a retried outbox item must reuse its stable message id');
    await chats.updateChatSession(session.id, { messages: [] });
    deliveredSession = await chats.getChatSession(session.id);
    assert.equal(deliveredSession?.messages.length, 1, 'a stale client PATCH must not erase an acknowledged task delivery');

    const commandTask = ledger.createTask({
      id: 'command-task',
      kind: 'work',
      title: 'Exercise commands',
      status: 'running',
      maxRetries: 1,
    });
    const pause = ledger.enqueueTaskCommand({
      taskId: commandTask.id,
      kind: 'pause',
      idempotencyKey: 'pause-once',
      expectedVersion: commandTask.version,
    });
    ledger.applyTaskCommand(pause.id);
    const duplicate = ledger.enqueueTaskCommand({
      taskId: commandTask.id,
      kind: 'pause',
      idempotencyKey: 'pause-once',
      expectedVersion: commandTask.version,
    });
    assert.equal(duplicate.id, pause.id, 'command retries must deduplicate before revision checks');
    assert.equal(ledger.getTask(commandTask.id)?.status, 'paused');
    const pausedTask = ledger.getTask(commandTask.id)!;
    const resume = ledger.enqueueTaskCommand({
      taskId: commandTask.id,
      kind: 'resume',
      idempotencyKey: 'resume-once',
      expectedVersion: pausedTask.version,
    });
    ledger.applyTaskCommand(resume.id);
    assert.equal(ledger.getTask(commandTask.id)?.status, 'running');
    const resumedTask = ledger.getTask(commandTask.id)!;
    const steer = ledger.enqueueTaskCommand({
      taskId: commandTask.id,
      kind: 'steer',
      payload: { instruction: 'Verify the revised acceptance criterion.' },
      idempotencyKey: 'steer-once',
      expectedVersion: resumedTask.version,
    });
    assert.equal(ledger.applyTaskCommand(steer.id).status, 'applied');
    const steeredTask = ledger.getTask(commandTask.id)!;
    const cancel = ledger.enqueueTaskCommand({
      taskId: commandTask.id,
      kind: 'cancel',
      idempotencyKey: 'cancel-once',
      expectedVersion: steeredTask.version,
    });
    ledger.applyTaskCommand(cancel.id);
    assert.equal(ledger.getTask(commandTask.id)?.status, 'cancelled');

    const retryTask = ledger.createTask({
      id: 'retry-command-task',
      kind: 'work',
      title: 'Retry exactly once',
      status: 'failed',
      maxRetries: 1,
    });
    const retry = ledger.enqueueTaskCommand({
      taskId: retryTask.id,
      kind: 'retry',
      idempotencyKey: 'retry-command-once',
      expectedVersion: retryTask.version,
    });
    const firstRetryApply = ledger.applyTaskCommand(retry.id);
    const replayedRetryApply = ledger.applyTaskCommand(retry.id);
    assert.equal(firstRetryApply.appliedNow, true, 'the claimant must report that it applied the retry');
    assert.equal(replayedRetryApply.appliedNow, false, 'a replay must not report another dispatchable apply');
    assert.equal(ledger.getTask(retryTask.id)?.retryCount, 1, 'replaying a retry command must not increment twice');
    assert.equal(ledger.getTask(retryTask.id)?.status, 'queued');

    const pauseRaceTask = ledger.createTask({ id: 'pause-race-task', kind: 'work', title: 'Pause race', status: 'running' });
    const pauseRace = ledger.enqueueTaskCommand({
      taskId: pauseRaceTask.id,
      kind: 'pause',
      idempotencyKey: 'pause-race-once',
      expectedVersion: pauseRaceTask.version,
    });
    ledger.applyTaskCommand(pauseRace.id);
    ledger.syncTaskFromRun({
      id: 'pause-race-run',
      taskId: pauseRaceTask.id,
      attemptNo: 1,
      agentId: 'agent-1',
      agentName: 'Verifier',
      model: 'local:test',
      prompt: 'Finish while pause arrives',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'completed',
      trace: [],
      finalOutput: 'Finished before the cooperative pause boundary.',
      sideEffects: [],
    });
    assert.equal(ledger.getTask(pauseRaceTask.id)?.status, 'succeeded', 'a final run result must win a cooperative pause race');

    const runTaskId = 'run-backed-task';
    await runs.persistAgentRun({
      id: 'run-ledger-1',
      taskId: runTaskId,
      attemptNo: 1,
      agentId: 'agent-1',
      agentName: 'Verifier',
      prompt: 'Verify run projection',
      model: 'local:test',
      startedAt: new Date().toISOString(),
      status: 'running',
      trace: [],
      sideEffects: [],
    });
    const rowBefore = db.prepare('SELECT rowid FROM runs WHERE id = ?').get('run-ledger-1') as { rowid: number };
    assert.equal(ledger.getTask(runTaskId)?.status, 'running');
    await runs.persistAgentRun({
      id: 'run-ledger-1',
      taskId: runTaskId,
      attemptNo: 1,
      agentId: 'agent-1',
      agentName: 'Verifier',
      prompt: 'Verify run projection',
      model: 'local:test',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'completed',
      trace: [],
      finalOutput: 'Projected.',
      sideEffects: [],
    });
    const rowAfter = db.prepare('SELECT rowid FROM runs WHERE id = ?').get('run-ledger-1') as { rowid: number };
    assert.equal(rowAfter.rowid, rowBefore.rowid, 'run UPSERT must preserve row identity');
    assert.equal(ledger.getTask(runTaskId)?.status, 'succeeded');

    ledger.createTask({ id: 'restart-task', kind: 'work', title: 'Interrupted task', status: 'running' });
    assert.equal(ledger.reconcileOrphanedTasks(), 1);
    assert.equal(ledger.getTask('restart-task')?.status, 'lost');

    console.log('Task ledger verification passed');
  } finally {
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Task ledger verification failed', error);
  process.exit(1);
});
