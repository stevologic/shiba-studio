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
  const approvals = await import('../lib/tool-approval');
  const maintenance = await import('../lib/automation-maintenance');
  const taskCommandRoute = await import('../app/api/tasks/[id]/commands/route');

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
    const heartbeat = ledger.heartbeatTask(parent.id, {
      progress: 0.4,
      currentStep: 'Heartbeat fenced by revision',
      expectedVersion: running.version,
    });
    assert.equal(heartbeat.progress, 0.4);
    assert.throws(() => ledger.heartbeatTask(parent.id, {
      progress: 0.5,
      expectedVersion: running.version,
    }), /concurrently/);
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
    const terminalReplay = ledger.transitionTask({
      taskId: parent.id,
      status: 'succeeded',
      result: 'A late replay must not replace the durable result.',
      metadata: { lateReplay: true },
    });
    assert.equal(terminalReplay.version, finished.version, 'an exact terminal replay must not mutate the row');
    assert.equal(terminalReplay.result, finished.result);
    assert.equal(terminalReplay.completedAt, finished.completedAt);
    assert.equal(terminalReplay.metadata.lateReplay, undefined);
    const attention = ledger.listAttention({ taskId: parent.id, status: 'open' });
    assert.equal(attention.total, 1, 'terminal transition should create exactly one attention item');
    const claimed = ledger.claimOutbox();
    assert.equal(claimed.length, 1, 'terminal transition should atomically enqueue one delivery');
    assert.equal(ledger.claimOutbox().length, 0, 'claimed delivery must not be claimed twice');
    db.prepare("UPDATE task_outbox SET availableAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), claimed[0].id);
    const reclaimed = ledger.claimOutbox();
    assert.equal(reclaimed.length, 1, 'an expired outbox lease should be reclaimable');
    assert.equal(reclaimed[0].attempts, claimed[0].attempts + 1);
    assert.throws(() => ledger.finishOutbox(claimed[0].id, {
      delivered: true,
      expectedAttempts: claimed[0].attempts,
    }), /claim is no longer current/);
    ledger.finishOutbox(reclaimed[0].id, {
      delivered: true,
      expectedAttempts: reclaimed[0].attempts,
    });
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

    const cascadeParent = ledger.createTask({
      id: 'cascade-parent-task',
      kind: 'routine',
      title: 'Cascade lifecycle commands',
      status: 'running',
    });
    const cascadeChild = ledger.createTask({
      id: 'cascade-running-child',
      kind: 'agent',
      title: 'Active routine invocation',
      parentId: cascadeParent.id,
      runId: 'cascade-running-run',
      status: 'running',
      metadata: { suppressTerminalSignals: true },
    });
    ledger.createTask({
      id: 'cascade-queued-child',
      kind: 'agent',
      title: 'Queued routine invocation',
      parentId: cascadeParent.id,
      runId: 'cascade-queued-run',
      metadata: { suppressTerminalSignals: true },
    });
    const remainingCancelableChildren = [
      ['cascade-paused-child', 'paused'],
      ['cascade-input-child', 'waiting_for_input'],
      ['cascade-approval-child', 'waiting_for_approval'],
      ['cascade-blocked-child', 'blocked'],
    ] as const;
    for (const [id, status] of remainingCancelableChildren) {
      ledger.createTask({
        id,
        kind: 'agent',
        title: `Cancelable ${status} invocation`,
        parentId: cascadeParent.id,
        status,
        metadata: { suppressTerminalSignals: true },
      });
    }
    const cascadePause = ledger.enqueueTaskCommand({
      taskId: cascadeParent.id,
      kind: 'pause',
      idempotencyKey: 'cascade-pause',
      expectedVersion: cascadeParent.version,
    });
    ledger.applyTaskCommand(cascadePause.id);
    assert.equal(ledger.getTask(cascadeChild.id)?.status, 'paused', 'parent pause must pause its active child');
    const pausedCascadeParent = ledger.getTask(cascadeParent.id)!;
    const cascadeResume = ledger.enqueueTaskCommand({
      taskId: cascadeParent.id,
      kind: 'resume',
      idempotencyKey: 'cascade-resume',
      expectedVersion: pausedCascadeParent.version,
    });
    ledger.applyTaskCommand(cascadeResume.id);
    assert.equal(ledger.getTask(cascadeChild.id)?.status, 'running', 'parent resume must resume its paused child');
    const resumedCascadeParent = ledger.getTask(cascadeParent.id)!;
    const cascadeCancel = ledger.enqueueTaskCommand({
      taskId: cascadeParent.id,
      kind: 'cancel',
      idempotencyKey: 'cascade-cancel',
      expectedVersion: resumedCascadeParent.version,
    });
    ledger.applyTaskCommand(cascadeCancel.id);
    assert.equal(ledger.getTask(cascadeChild.id)?.status, 'cancelled', 'parent cancel must cancel an active child');
    assert.equal(ledger.getTask('cascade-queued-child')?.status, 'cancelled', 'parent cancel must cancel a queued child');
    for (const [id, previousStatus] of remainingCancelableChildren) {
      assert.equal(ledger.getTask(id)?.status, 'cancelled', `parent cancel must cancel a ${previousStatus} child`);
    }

    const atomicParent = ledger.createTask({
      id: 'atomic-command-parent',
      kind: 'routine',
      title: 'Atomic parent command',
      status: 'running',
    });
    const atomicChild = ledger.createTask({
      id: 'atomic-command-child',
      kind: 'agent',
      title: 'Atomic child command',
      parentId: atomicParent.id,
      status: 'running',
      metadata: { suppressTerminalSignals: true },
    });
    const atomicCancel = ledger.enqueueTaskCommand({
      taskId: atomicParent.id,
      kind: 'cancel',
      idempotencyKey: 'atomic-cascade-cancel',
      expectedVersion: atomicParent.version,
    });
    db.exec(`
      CREATE TRIGGER fail_atomic_child_update BEFORE UPDATE ON tasks
      WHEN OLD.id = 'atomic-command-child'
      BEGIN SELECT RAISE(ABORT, 'forced child transition failure'); END
    `);
    assert.throws(() => ledger.applyTaskCommand(atomicCancel.id), /forced child transition failure/);
    db.exec('DROP TRIGGER fail_atomic_child_update');
    assert.equal(ledger.getTask(atomicParent.id)?.status, 'running', 'failed child cascade must roll back the parent transition');
    assert.equal(ledger.getTask(atomicChild.id)?.status, 'running');
    assert.equal(ledger.getTaskDetails(atomicParent.id)?.commands.find((item) => item.id === atomicCancel.id)?.status, 'rejected');
    assert.equal(ledger.listAttention({ taskId: atomicParent.id, status: 'open' }).total, 0,
      'rolled-back cancellation must not leak terminal attention');
    ledger.transitionTask({ taskId: atomicChild.id, status: 'cancelled' });
    ledger.transitionTask({ taskId: atomicParent.id, status: 'cancelled' });

    const recoveredParent = ledger.createTask({
      id: 'recovered-command-parent',
      kind: 'routine',
      title: 'Recover committed parent command',
      runId: 'recovered-parent-run',
      status: 'running',
    });
    const recoveredChild = ledger.createTask({
      id: 'recovered-command-child',
      kind: 'agent',
      title: 'Recover child cascade',
      parentId: recoveredParent.id,
      runId: 'recovered-child-run',
      status: 'running',
      metadata: { suppressTerminalSignals: true },
    });
    const recoveredCancel = ledger.enqueueTaskCommand({
      taskId: recoveredParent.id,
      kind: 'cancel',
      idempotencyKey: 'recover-committed-cancel',
      expectedVersion: recoveredParent.version,
    });
    ledger.transitionTask({
      taskId: recoveredParent.id,
      status: 'cancelled',
      expectedVersion: recoveredParent.version,
    });
    db.prepare("UPDATE task_commands SET status = 'processing', appliedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), recoveredCancel.id);
    const completedRecovery = ledger.applyTaskCommand(recoveredCancel.id);
    assert.equal(completedRecovery.status, 'applied', 'durably committed parent state must recover as applied');
    assert.equal(completedRecovery.appliedNow, true);
    assert.equal(ledger.getTask(recoveredChild.id)?.status, 'cancelled', 'recovery must finish the child cascade');
    const parentControls = ledger.claimTaskRunControlSignals('recovered-parent-run', 'ledger-verifier');
    const childControls = ledger.claimTaskRunControlSignals('recovered-child-run', 'first-consumer');
    assert.equal(parentControls[0]?.kind, 'cancel');
    assert.equal(childControls[0]?.kind, 'cancel', 'recovered command must persist child run control');
    assert.equal(ledger.claimTaskRunControlSignals('recovered-child-run', 'second-consumer').length, 0,
      'an active control claim must not be double-claimed');
    db.prepare("UPDATE task_run_controls SET leaseUntil = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), childControls[0].id);
    const reclaimedControl = ledger.claimTaskRunControlSignals('recovered-child-run', 'second-consumer');
    assert.equal(reclaimedControl[0]?.attempts, childControls[0].attempts + 1);
    assert.equal(ledger.finishTaskRunControlSignal({
      id: childControls[0].id,
      runId: 'recovered-child-run',
      consumerId: 'first-consumer',
      expectedAttempts: childControls[0].attempts,
      delivered: true,
    }), false, 'a stale run-control claimant must not acknowledge a newer claim');
    assert.equal(ledger.finishTaskRunControlSignal({
      id: reclaimedControl[0].id,
      runId: 'recovered-child-run',
      consumerId: 'second-consumer',
      expectedAttempts: reclaimedControl[0].attempts,
      delivered: true,
    }), true);

    const retryTask = ledger.createTask({
      id: 'retry-command-task',
      kind: 'work',
      title: 'Retry exactly once',
      maxRetries: 1,
    });
    const retryRunning = ledger.transitionTask({ taskId: retryTask.id, status: 'running' });
    const retryFailed = ledger.transitionTask({
      taskId: retryTask.id,
      status: 'failed',
      expectedVersion: retryRunning.version,
      error: 'Transient failure.',
    });
    assert.equal(ledger.listAttention({ taskId: retryTask.id, status: 'open' }).total, 1);
    const retry = ledger.enqueueTaskCommand({
      taskId: retryTask.id,
      kind: 'retry',
      idempotencyKey: 'retry-command-once',
      expectedVersion: retryFailed.version,
    });
    const firstRetryApply = ledger.applyTaskCommand(retry.id);
    const replayedRetryApply = ledger.applyTaskCommand(retry.id);
    assert.equal(firstRetryApply.appliedNow, true, 'the claimant must report that it applied the retry');
    assert.equal(replayedRetryApply.appliedNow, false, 'a replay must not report another dispatchable apply');
    assert.equal(ledger.getTask(retryTask.id)?.retryCount, 1, 'replaying a retry command must not increment twice');
    assert.equal(ledger.getTask(retryTask.id)?.status, 'queued');
    assert.equal(ledger.listAttention({ taskId: retryTask.id, status: 'open' }).total, 0,
      'retrying must resolve stale terminal attention');
    const retryOutbox = db.prepare("SELECT status FROM task_outbox WHERE taskId = ? AND kind = 'task_terminal'")
      .get(retryTask.id) as { status: string };
    assert.equal(retryOutbox.status, 'delivered', 'retrying must supersede the stale terminal delivery');

    const routeRetryTask = ledger.createTask({
      id: 'route-retry-recovery-task', kind: 'work', title: 'Retry through recovery', maxRetries: 1,
    });
    const routeRetryRunning = ledger.transitionTask({ taskId: routeRetryTask.id, status: 'running' });
    const routeRetryFailed = ledger.transitionTask({
      taskId: routeRetryTask.id,
      status: 'failed',
      expectedVersion: routeRetryRunning.version,
      error: 'Retry after maintenance.',
    });
    const releaseMaintenance = maintenance.beginAutomationMaintenance('verify retry fast-path failure');
    try {
      const response = await taskCommandRoute.POST(new Request('http://localhost/api/tasks/route-retry-recovery-task/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'retry',
          idempotencyKey: 'route-retry-durable-intent',
          expectedVersion: routeRetryFailed.version,
        }),
      }), { params: Promise.resolve({ id: routeRetryTask.id }) });
      const payload = await response.json() as {
        ok: boolean;
        command: { status: string };
        retryDispatch?: { state: string };
      };
      assert.equal(response.status, 202);
      assert.equal(payload.ok, true, 'a committed retry must not be reported as failed when fast dispatch is fenced');
      assert.equal(payload.command.status, 'applied');
      assert.equal(payload.retryDispatch?.state, 'queued_for_recovery');
      assert.equal(ledger.getTask(routeRetryTask.id)?.status, 'queued',
        'the durable recovery pump must retain ownership of the accepted retry');
      const replay = await taskCommandRoute.POST(new Request('http://localhost/api/tasks/route-retry-recovery-task/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'retry',
          idempotencyKey: 'route-retry-durable-intent',
          expectedVersion: routeRetryFailed.version,
        }),
      }), { params: Promise.resolve({ id: routeRetryTask.id }) });
      const replayPayload = await replay.json() as { ok: boolean; retryDispatch?: { state: string } };
      assert.equal(replay.status, 202);
      assert.equal(replayPayload.ok, true);
      assert.equal(replayPayload.retryDispatch?.state, 'queued_for_recovery',
        'an idempotent replay must report the durable recovery state instead of silently dropping dispatch');
    } finally {
      releaseMaintenance();
    }
    ledger.transitionTask({ taskId: routeRetryTask.id, status: 'cancelled' });

    const atomicRetryTask = ledger.createTask({
      id: 'atomic-retry-task',
      kind: 'work',
      title: 'Rollback a partial retry',
      maxRetries: 2,
    });
    const atomicRetryRunning = ledger.transitionTask({ taskId: atomicRetryTask.id, status: 'running' });
    const atomicRetryFailed = ledger.transitionTask({
      taskId: atomicRetryTask.id,
      status: 'failed',
      expectedVersion: atomicRetryRunning.version,
      error: 'Keep this failure if retry cannot commit.',
    });
    const atomicRetry = ledger.enqueueTaskCommand({
      taskId: atomicRetryTask.id,
      kind: 'retry',
      idempotencyKey: 'atomic-retry-rollback',
      expectedVersion: atomicRetryFailed.version,
    });
    db.exec(`
      CREATE TRIGGER fail_retry_queue_transition BEFORE UPDATE ON tasks
      WHEN OLD.id = 'atomic-retry-task' AND NEW.status = 'queued'
      BEGIN SELECT RAISE(ABORT, 'forced retry transition failure'); END
    `);
    assert.throws(() => ledger.applyTaskCommand(atomicRetry.id), /forced retry transition failure/);
    db.exec('DROP TRIGGER fail_retry_queue_transition');
    const rolledBackRetry = ledger.getTask(atomicRetryTask.id)!;
    assert.equal(rolledBackRetry.status, 'failed');
    assert.equal(rolledBackRetry.retryCount, 0, 'failed retry transaction must not consume retry budget');
    assert.equal(rolledBackRetry.version, atomicRetryFailed.version);
    assert.equal(rolledBackRetry.error, atomicRetryFailed.error);

    const halfRetryTask = ledger.createTask({
      id: 'half-applied-retry-task',
      kind: 'work',
      title: 'Repair a legacy half retry',
      maxRetries: 2,
    });
    const halfRetryRunning = ledger.transitionTask({ taskId: halfRetryTask.id, status: 'running' });
    const halfRetryFailed = ledger.transitionTask({
      taskId: halfRetryTask.id,
      status: 'failed',
      expectedVersion: halfRetryRunning.version,
      error: 'Legacy retry failure.',
    });
    const halfRetryCommand = ledger.enqueueTaskCommand({
      taskId: halfRetryTask.id,
      kind: 'retry',
      idempotencyKey: 'repair-half-retry',
      expectedVersion: halfRetryFailed.version,
    });
    db.prepare(`
      UPDATE tasks SET retryCount = retryCount + 1, result = NULL, error = NULL,
        completion = NULL, version = version + 1, updatedAt = ? WHERE id = ?
    `).run(new Date().toISOString(), halfRetryTask.id);
    db.prepare("UPDATE task_commands SET status = 'processing', appliedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), halfRetryCommand.id);
    const repairedRetry = ledger.applyTaskCommand(halfRetryCommand.id);
    assert.equal(repairedRetry.status, 'applied');
    assert.equal(ledger.getTask(halfRetryTask.id)?.status, 'queued');
    assert.equal(ledger.getTask(halfRetryTask.id)?.retryCount, 1, 'recovery must not double-increment retry count');

    const noTerminalSignals = ledger.createTask({
      id: 'suppressed-terminal-task',
      kind: 'agent',
      title: 'Child with parent-owned signals',
      status: 'running',
      metadata: { suppressTerminalSignals: true },
    });
    ledger.transitionTask({ taskId: noTerminalSignals.id, status: 'failed', error: 'Reported by parent.' });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_attention WHERE taskId = ?').get(noTerminalSignals.id) as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_outbox WHERE taskId = ?').get(noTerminalSignals.id) as { n: number }).n, 0);

    const suppressFailures = ledger.createTask({
      id: 'suppressed-failure-task',
      kind: 'agent',
      title: 'Child with parent-owned failure',
      status: 'running',
      metadata: { suppressFailureSignals: true },
    });
    ledger.transitionTask({ taskId: suppressFailures.id, status: 'failed', error: 'Reported by parent.' });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_attention WHERE taskId = ?').get(suppressFailures.id) as { n: number }).n, 0);

    const preservedSuccess = ledger.createTask({
      id: 'preserved-success-task',
      kind: 'agent',
      title: 'Child success remains visible',
      status: 'running',
      metadata: { suppressFailureSignals: true },
    });
    ledger.transitionTask({ taskId: preservedSuccess.id, status: 'succeeded', result: 'Done.' });
    assert.equal(ledger.listAttention({ taskId: preservedSuccess.id, status: 'open' }).total, 1,
      'failure-only suppression must retain successful completion signals');

    const heartbeatOnlyRunning = ledger.createTask({
      id: 'heartbeat-running-only',
      kind: 'work',
      title: 'Heartbeat only while running',
      status: 'running',
    });
    const heartbeatPause = ledger.transitionTask({
      taskId: heartbeatOnlyRunning.id,
      status: 'paused',
      expectedVersion: heartbeatOnlyRunning.version,
    });
    assert.throws(() => ledger.heartbeatTask(heartbeatOnlyRunning.id, {
      expectedVersion: heartbeatPause.version,
    }), /Only a running task/);

    const { approvalId, wait } = approvals.beginToolApproval('global-registry-run', 'shell_exec', {}, 1_000);
    const approvalRegistry = (globalThis as unknown as {
      __shibaPendingToolApprovals?: Map<string, unknown>;
    }).__shibaPendingToolApprovals;
    assert.equal(approvalRegistry?.has(approvalId), true, 'approval waiters must use the process-wide registry');
    assert.equal(approvals.resolveToolApproval(approvalId, true), true);
    assert.equal(await wait, true);

    const abandonedCommandTask = ledger.createTask({
      id: 'abandoned-command-task',
      kind: 'work',
      title: 'Recover an abandoned command claim',
      status: 'running',
    });
    const abandonedCommand = ledger.enqueueTaskCommand({
      taskId: abandonedCommandTask.id,
      kind: 'pause',
      idempotencyKey: 'abandoned-command-replay',
      expectedVersion: abandonedCommandTask.version,
    });
    db.prepare("UPDATE task_commands SET status = 'processing', appliedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), abandonedCommand.id);
    const recoveredCommand = ledger.applyTaskCommand(abandonedCommand.id);
    assert.equal(recoveredCommand.appliedNow, true, 'an expired processing claim must be recovered by an idempotent replay');
    assert.equal(ledger.getTask(abandonedCommandTask.id)?.status, 'paused');

    const startupRequeueTask = ledger.createTask({
      id: 'startup-command-requeue-task',
      kind: 'work',
      title: 'Requeue an untouched startup command',
      status: 'running',
    });
    const startupRequeueCommand = ledger.enqueueTaskCommand({
      taskId: startupRequeueTask.id,
      kind: 'pause',
      idempotencyKey: 'startup-safe-requeue',
      expectedVersion: startupRequeueTask.version,
    });
    db.prepare("UPDATE task_commands SET status = 'processing', appliedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), startupRequeueCommand.id);
    const startupApprovalTask = ledger.createTask({
      id: 'startup-approval-reject-task',
      kind: 'work',
      title: 'Never replay an approval after restart',
      status: 'waiting_for_approval',
    });
    const startupApprovalWaiter = approvals.beginToolApproval('startup-approval-run', 'shell_exec', {}, 5_000);
    const startupApprovalCommand = ledger.enqueueTaskCommand({
      taskId: startupApprovalTask.id,
      kind: 'approve',
      payload: { approvalId: startupApprovalWaiter.approvalId },
      idempotencyKey: 'startup-approval-no-replay',
      expectedVersion: startupApprovalTask.version,
    });
    db.prepare("UPDATE task_commands SET status = 'processing', appliedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), startupApprovalCommand.id);
    const startupRecovery = await ledger.reconcileProcessingTaskCommands(0);
    assert.equal(startupRecovery.requeued, 0);
    assert.equal(startupRecovery.applied, 1);
    assert.equal(startupRecovery.rejected, 1);
    assert.equal(ledger.getTaskDetails(startupRequeueTask.id)?.commands[0]?.status, 'applied');
    assert.equal(ledger.getTask(startupRequeueTask.id)?.status, 'paused',
      'startup recovery must finish an unchanged non-approval command instead of stranding it pending');
    assert.equal(ledger.getTaskDetails(startupApprovalTask.id)?.commands[0]?.status, 'rejected');
    assert.equal(approvals.resolveToolApproval(startupApprovalWaiter.approvalId, false), true,
      'startup recovery must not resolve or re-authorize an in-memory approval');
    assert.equal(await startupApprovalWaiter.wait, false);
    ledger.transitionTask({ taskId: startupRequeueTask.id, status: 'cancelled' });

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
      prompt: 'Persist the initial running projection after pause',
      startedAt: new Date().toISOString(),
      status: 'running',
      trace: [],
      sideEffects: [],
    });
    assert.equal(ledger.getTask(pauseRaceTask.id)?.status, 'paused',
      'a late initial running projection must not erase a cooperative pause');
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
    assert.equal(ledger.getTaskByRunId('run-ledger-1')?.id, runTaskId);
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

    ledger.createTask({ id: 'orphaned-run-start', kind: 'work', title: 'Missing run row', runId: 'missing-start-run', status: 'running' });
    ledger.createTask({ id: 'live-run-start', kind: 'work', title: 'Existing run row', runId: 'existing-start-run', status: 'running' });
    ledger.createTask({ id: 'fresh-run-start', kind: 'work', title: 'Fresh missing run row', runId: 'fresh-start-run', status: 'running' });
    await runs.persistAgentRun({
      id: 'existing-start-run',
      taskId: 'live-run-start',
      attemptNo: 1,
      agentId: 'agent-1',
      agentName: 'Verifier',
      prompt: 'Existing run row',
      model: 'local:test',
      startedAt: new Date().toISOString(),
      status: 'running',
      trace: [],
      sideEffects: [],
    });
    const oldHeartbeat = new Date(Date.now() - 60_000).toISOString();
    db.prepare('UPDATE tasks SET heartbeatAt = ?, updatedAt = ? WHERE id IN (?, ?)')
      .run(oldHeartbeat, oldHeartbeat, 'orphaned-run-start', 'live-run-start');
    assert.deepEqual(
      ledger.markStaleRunningTasksWithoutRunsLost(
        ['orphaned-run-start', 'live-run-start', 'fresh-run-start'],
        new Date(Date.now() - 10_000).toISOString(),
      ),
      ['orphaned-run-start'],
      'start-gap reconciliation must fence on staleness and matching run-row absence',
    );
    assert.equal(ledger.getTask('orphaned-run-start')?.status, 'lost');
    assert.equal(ledger.listAttention({ taskId: 'orphaned-run-start', status: 'open' }).total, 1,
      'start-gap loss must preserve normal terminal attention');
    assert.equal(ledger.getTask('live-run-start')?.status, 'running');
    assert.equal(ledger.getTask('fresh-run-start')?.status, 'running');
    ledger.transitionTask({ taskId: 'live-run-start', status: 'cancelled' });
    ledger.transitionTask({ taskId: 'fresh-run-start', status: 'cancelled' });

    ledger.createTask({ id: 'interrupted-running', kind: 'work', title: 'Interrupted running task', runId: 'interrupted-run-1', status: 'running' });
    ledger.createTask({ id: 'interrupted-paused', kind: 'work', title: 'Interrupted paused task', runId: 'interrupted-run-2', status: 'paused' });
    ledger.createTask({ id: 'interrupted-approval', kind: 'work', title: 'Interrupted approval task', runId: 'interrupted-run-3', status: 'waiting_for_approval' });
    ledger.createTask({ id: 'live-other-run', kind: 'work', title: 'Another instance owns this task', runId: 'live-run', status: 'running' });
    ledger.createTask({ id: 'durable-approval', kind: 'work', title: 'Durable approval without interrupted run', status: 'waiting_for_approval' });
    assert.equal(ledger.reconcileOrphanedTasks(['interrupted-run-1', 'interrupted-run-2', 'interrupted-run-3']), 3);
    assert.equal(ledger.getTask('interrupted-running')?.status, 'lost');
    assert.equal(ledger.getTask('interrupted-paused')?.status, 'lost');
    assert.equal(ledger.getTask('interrupted-approval')?.status, 'lost');
    assert.equal(ledger.getTask('live-other-run')?.status, 'running', 'exact run reconciliation must not steal another instance\'s lease');
    assert.equal(ledger.getTask('durable-approval')?.status, 'waiting_for_approval', 'durable approvals must survive unrelated restarts');
    assert.equal(ledger.reconcileOrphanedTasks([]), 0);
    ledger.transitionTask({ taskId: 'live-other-run', status: 'cancelled' });

    ledger.createTask({ id: 'restart-task', kind: 'work', title: 'Interrupted legacy task', status: 'running' });
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
