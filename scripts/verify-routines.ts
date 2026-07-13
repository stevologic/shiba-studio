import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-routines-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '55'.repeat(32);

  const dbModule = await import('../lib/db');
  const routines = await import('../lib/routines');
  const ledger = await import('../lib/task-ledger');
  try {
    routines.ensureRoutineSchema();
    const db = dbModule.getDb();
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    assert(tables.has('routines'));
    assert(tables.has('routine_invocations'));
    assert(tables.has('routine_trigger_state'));
    assert(tables.has('routine_step_runs'));
    const invocationColumns = new Set((db.prepare('PRAGMA table_info(routine_invocations)').all() as Array<{ name: string }>).map((row) => row.name));
    assert(invocationColumns.has('definitionSnapshot'));

    const activeBudget = new routines.routineRuntimeTestHooks.RoutineActiveTimeBudget(100, 0);
    activeBudget.sample(false, 40);
    assert.equal(activeBudget.remainingMs, 60);
    activeBudget.sample(true, 200);
    assert.equal(activeBudget.signal.aborted, false, 'a pause longer than the remaining wall time must not consume active time');
    activeBudget.sample(false, 300);
    assert.equal(activeBudget.signal.aborted, false, 'resume must not cause an immediate timeout');
    activeBudget.sample(false, 359);
    assert.equal(activeBudget.signal.aborted, false);
    activeBudget.sample(false, 361);
    assert.equal(activeBudget.signal.aborted, true, 'active execution eventually exhausts the remaining budget');

    const heartbeatController = new AbortController();
    assert.doesNotThrow(() => routines.routineRuntimeTestHooks.runRoutineLeaseHeartbeatTick(
      heartbeatController,
      () => { throw new Error('simulated sqlite failure'); },
    ));
    assert.equal(heartbeatController.signal.aborted, true);
    assert.match(String((heartbeatController.signal.reason as Error).message), /heartbeat.*simulated sqlite failure/i);
    assert.equal(routines.routineWorkerTestHooks.availableRoutineExecutionSlots(
      4,
      [{ routineId: 'paused-routine', agentId: 'routine-agent' }],
      [{ scheduleKey: 'routine-agent:paused-routine' }],
    ), 3, 'a paused routine must not hold slots freed by completed batch siblings');
    assert.equal(routines.routineWorkerTestHooks.availableRoutineExecutionSlots(
      4,
      [{ routineId: 'paused-routine', agentId: 'routine-agent' }],
      [{ scheduleKey: 'routine-agent:paused-routine' }, { scheduleKey: 'other-agent:other-schedule' }],
    ), 2, 'non-routine active runs still consume global capacity');
    let detachedFailure = '';
    await routines.routineWorkerTestHooks.observeDetachedRoutineExecution(
      Promise.reject(new Error('simulated detached worker failure')),
      (error) => { detachedFailure = error instanceof Error ? error.message : String(error); },
    );
    assert.equal(detachedFailure, 'simulated detached worker failure', 'detached workers must always observe rejections');

    const scheduler = await import('../lib/scheduler');
    assert.equal(scheduler.isSupportedAutomationCron('*/5 * * * *'), true);
    assert.equal(scheduler.isSupportedAutomationCron('0 0 L * *'), true);
    assert.equal(
      scheduler.automationTick(new Date('2026-01-01T12:34:00.000Z')),
      '2026-01-01T12:34',
      'delayed cron callbacks must retain the scheduled minute instead of using callback wall time',
    );
    assert.equal(scheduler.isSupportedAutomationCron('*/10 * * * * *'), false, 'seconds-field cron must be rejected');
    assert.match(scheduler.automationCronError('*/10 * * * * *') || '', /exactly five fields/i);
    assert.equal(
      routines.routineTriggerTestHooks.latestMissedScheduleTick(
        { id: 'last-day', type: 'schedule', enabled: true, cron: '0 0 L * *', timezone: 'UTC' },
        new Date('2026-01-30T00:00:00.000Z'),
        new Date('2026-02-01T00:01:00.000Z'),
      )?.toISOString(),
      '2026-01-31T00:00:00.000Z',
      'offline catch-up must use the same L/# cron matcher as live scheduling',
    );
    const durableTickOne = scheduler.schedulerRuntimeTestHooks.enqueueScheduleExecutionIntent({
      scheduleKey: 'durable-agent:durable-schedule',
      tick: '2026-01-01T00:00',
      agentId: 'durable-agent',
      agentName: 'Durable agent',
      scheduleId: 'durable-schedule',
      cron: '* * * * *',
      instructions: 'Original durable instructions',
    });
    const duplicateDurableTick = scheduler.schedulerRuntimeTestHooks.enqueueScheduleExecutionIntent({
      scheduleKey: 'durable-agent:durable-schedule',
      tick: '2026-01-01T00:00',
      agentId: 'durable-agent',
      agentName: 'Durable agent',
      scheduleId: 'durable-schedule',
      cron: '* * * * *',
      instructions: 'Original durable instructions',
    });
    assert.equal(durableTickOne.inserted, true);
    assert.equal(duplicateDurableTick.inserted, false, 'one schedule minute must have one durable intent');
    assert.equal(duplicateDurableTick.intent.id, durableTickOne.intent.id);
    const durableTickTwo = scheduler.schedulerRuntimeTestHooks.enqueueScheduleExecutionIntent({
      scheduleKey: 'durable-agent:durable-schedule',
      tick: '2026-01-01T00:01',
      agentId: 'durable-agent',
      agentName: 'Durable agent',
      scheduleId: 'durable-schedule',
      cron: '* * * * *',
      instructions: 'Newest durable instructions',
    });
    assert.equal(durableTickTwo.inserted, true);
    assert.equal(
      scheduler.schedulerRuntimeTestHooks.list().find((intent) => intent.id === durableTickOne.intent.id)?.status,
      'skipped',
      'new ticks coalesce an offline pending backlog',
    );
    let durableIntentClaim = scheduler.schedulerRuntimeTestHooks.claimScheduleExecutionIntents(1)[0];
    assert.equal(durableIntentClaim.id, durableTickTwo.intent.id);
    const deferredAt = Date.now();
    assert.equal(scheduler.schedulerRuntimeTestHooks.deferScheduleIntent(durableIntentClaim, 'simulated capacity refusal', 1_000), true);
    const deferredIntent = scheduler.schedulerRuntimeTestHooks.list().find((intent) => intent.id === durableIntentClaim.id)!;
    assert.equal(deferredIntent.status, 'pending');
    assert(Date.parse(deferredIntent.availableAt) >= deferredAt + 900, 'retry backoff must prevent a hot loop');
    assert.equal(scheduler.schedulerRuntimeTestHooks.claimScheduleExecutionIntents(1).length, 0);
    db.prepare('UPDATE schedule_execution_intents SET availableAt = ? WHERE id = ?')
      .run(new Date().toISOString(), deferredIntent.id);
    durableIntentClaim = scheduler.schedulerRuntimeTestHooks.claimScheduleExecutionIntents(1)[0];
    db.prepare('UPDATE schedule_execution_intents SET leaseExpiresAt = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), durableIntentClaim.id);
    assert.equal(scheduler.schedulerRuntimeTestHooks.recoverExpiredScheduleIntents(), 1);
    assert.equal(
      scheduler.schedulerRuntimeTestHooks.list().find((intent) => intent.id === durableIntentClaim.id)?.status,
      'pending',
      'a crash before run persistence must recover the exact scheduled intent',
    );
    db.prepare('UPDATE schedule_execution_intents SET availableAt = ?, createdAt = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString(), durableIntentClaim.id);
    durableIntentClaim = scheduler.schedulerRuntimeTestHooks.claimScheduleExecutionIntents(1)[0];
    assert.equal(scheduler.schedulerRuntimeTestHooks.deferScheduleIntent(durableIntentClaim, 'still offline', 1_000), true);
    assert.equal(
      scheduler.schedulerRuntimeTestHooks.list().find((intent) => intent.id === durableIntentClaim.id)?.status,
      'failed',
      'stale intents eventually stop retrying',
    );
    db.prepare('UPDATE schedule_execution_intents SET completedAt = ? WHERE id = ?')
      .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString(), durableTickOne.intent.id);
    scheduler.schedulerRuntimeTestHooks.enqueueScheduleExecutionIntent({
      scheduleKey: 'durable-agent:durable-schedule',
      tick: '2026-01-01T00:02',
      agentId: 'durable-agent',
      agentName: 'Durable agent',
      scheduleId: 'durable-schedule',
      cron: '* * * * *',
      instructions: 'Retention probe',
    });
    assert.equal(
      scheduler.schedulerRuntimeTestHooks.list().some((intent) => intent.id === durableTickOne.intent.id),
      false,
      'old terminal schedule intents must be pruned',
    );
    db.prepare(`
      UPDATE schedule_execution_intents SET status = 'skipped', completedAt = ?, updatedAt = ?
      WHERE status IN ('pending', 'processing')
    `).run(new Date().toISOString(), new Date().toISOString());
    db.prepare(`
      INSERT INTO runs (id, agentId, agentName, model, status, prompt, startedAt, scheduleId, sideEffects, trace)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, '[]', '[]')
    `).run('persisted-overlap-run', 'overlap-agent', 'Overlap verifier', 'local:test', 'running schedule', new Date().toISOString(), 'schedule-a');
    assert.equal(scheduler.isPersistedScheduleStillRunning('overlap-agent', 'schedule-a'), true);
    assert.equal(scheduler.isPersistedScheduleStillRunning('overlap-agent', 'schedule-b'), false);
    db.prepare('UPDATE runs SET status = ?, completedAt = ? WHERE id = ?')
      .run('completed', new Date().toISOString(), 'persisted-overlap-run');
    assert.equal(scheduler.isPersistedScheduleStillRunning('overlap-agent', 'schedule-a'), false);

    const secret = 'routine-webhook-secret-123';
    const routine = routines.createRoutine({
      id: 'routine-verifier',
      name: 'Verifier routine',
      description: 'Exercises dedupe, retries, dependencies, and circuit state.',
      agentId: 'agent-verifier',
      prompt: 'Handle {{kind}} for {{name}}.',
      triggers: [
        { id: 'manual-trigger', type: 'manual', enabled: true },
        { id: 'hook', type: 'webhook', enabled: true, secret },
        { id: 'events', type: 'integration_event', enabled: true, integration: 'github', event: 'push' },
        { id: 'health', type: 'health', enabled: false, processPid: process.pid, intervalSeconds: 30 },
        { id: 'filesystem', type: 'filesystem', enabled: false, path: root, intervalSeconds: 30 },
        { id: 'cron', type: 'schedule', enabled: false, cron: '0 9 * * 1-5' },
      ],
      conditions: [{ path: 'kind', operator: 'equals', value: 'go' }],
      parameters: { name: 'Shiba' },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, multiplier: 2, maxDelayMs: 1_000 },
      timeoutMs: 5_000,
      concurrencyKey: 'routine-verifier',
      catchUpPolicy: 'run_once',
      circuitBreaker: { failureThreshold: 2, cooldownSeconds: 60 },
      steps: [
        { id: 'first', name: 'First', prompt: 'First step' },
        { id: 'second', name: 'Second', prompt: 'Second step', dependsOn: ['first'] },
      ],
    });
    assert.equal(routine.triggers.find((trigger) => trigger.type === 'webhook')?.secret, '••••••••');
    const storedTriggers = JSON.parse((db.prepare('SELECT triggers FROM routines WHERE id = ?').get(routine.id) as { triggers: string }).triggers) as Array<{ type: string; secret?: string }>;
    assert.match(storedTriggers.find((trigger) => trigger.type === 'webhook')?.secret || '', /^enc:v1:/, 'webhook secret must be encrypted at rest');
    assert.deepEqual(routine.steps.map((step) => step.id), ['first', 'second']);

    const atomicTriggerRoutine = routines.createRoutine({
      id: 'atomic-trigger-routine',
      name: 'Atomic trigger routine',
      agentId: 'agent-verifier',
      prompt: 'Handle a durable filesystem change',
      triggers: [
        { id: 'filesystem', type: 'filesystem', enabled: true, path: root, intervalSeconds: 5 },
        { id: 'schedule', type: 'schedule', enabled: false, cron: '0 * * * *', timezone: 'UTC' },
      ],
    });
    assert(db.prepare(`
      SELECT 1 AS found FROM routine_trigger_state WHERE routineId = ? AND triggerId = 'schedule'
    `).get(atomicTriggerRoutine.id), 'schedule observation state must commit with routine creation');
    const triggerCheckAt = new Date('2026-01-02T00:00:00.000Z');
    const abandonedTriggerClaim = routines.routineTriggerTestHooks.claimTriggerCheck(
      atomicTriggerRoutine.id,
      'filesystem',
      5,
      triggerCheckAt,
    )!;
    assert.equal(
      routines.routineTriggerTestHooks.claimTriggerCheck(atomicTriggerRoutine.id, 'filesystem', 5, triggerCheckAt),
      null,
      'a live trigger-check claim must suppress duplicate probes',
    );
    const triggerStateRow = db.prepare(`
      SELECT state FROM routine_trigger_state WHERE routineId = ? AND triggerId = 'filesystem'
    `).get(atomicTriggerRoutine.id) as { state: string };
    const abandonedState = JSON.parse(triggerStateRow.state) as { __shibaTriggerCheck: { leaseUntil: string } };
    abandonedState.__shibaTriggerCheck.leaseUntil = new Date(triggerCheckAt.getTime() - 1_000).toISOString();
    db.prepare(`
      UPDATE routine_trigger_state SET state = ? WHERE routineId = ? AND triggerId = 'filesystem'
    `).run(JSON.stringify(abandonedState), atomicTriggerRoutine.id);
    const recoveredTriggerClaim = routines.routineTriggerTestHooks.claimTriggerCheck(
      atomicTriggerRoutine.id,
      'filesystem',
      5,
      triggerCheckAt,
    )!;
    assert.equal(recoveredTriggerClaim.dueKey, abandonedTriggerClaim.dueKey, 'a crashed probe must reclaim the same due event');
    const atomicallyQueued = routines.routineTriggerTestHooks.finalizeTriggerCheck(
      recoveredTriggerClaim,
      { signature: 'after-crash', checkedAt: triggerCheckAt.toISOString() },
      {
        routineId: atomicTriggerRoutine.id,
        triggerId: 'filesystem',
        triggerType: 'filesystem',
        dedupeKey: `filesystem:filesystem:${recoveredTriggerClaim.dueKey}:after-crash`,
        payload: { previousSignature: 'before-crash', signature: 'after-crash' },
      },
    );
    assert.equal(atomicallyQueued?.inserted, true);
    const committedTriggerState = db.prepare(`
      SELECT state, nextDueAt FROM routine_trigger_state WHERE routineId = ? AND triggerId = 'filesystem'
    `).get(atomicTriggerRoutine.id) as { state: string; nextDueAt: string };
    assert.equal('__shibaTriggerCheck' in JSON.parse(committedTriggerState.state), false);
    assert.equal(committedTriggerState.nextDueAt, new Date(triggerCheckAt.getTime() + 5_000).toISOString());
    assert.equal(routines.listRoutineInvocations(atomicTriggerRoutine.id).length, 1);
    db.prepare(`
      UPDATE routine_trigger_state SET state = '{"sentinel":true}'
      WHERE routineId = ? AND triggerId = 'schedule'
    `).run(atomicTriggerRoutine.id);
    const atomicTriggerEdited = routines.updateRoutine(atomicTriggerRoutine.id, {
      triggers: [
        { id: 'filesystem', type: 'filesystem', enabled: true, path: root, intervalSeconds: 5 },
        { id: 'schedule', type: 'schedule', enabled: false, cron: '5 * * * *', timezone: 'UTC' },
      ],
    }, atomicTriggerRoutine.version);
    const resetScheduleState = JSON.parse((db.prepare(`
      SELECT state FROM routine_trigger_state WHERE routineId = ? AND triggerId = 'schedule'
    `).get(atomicTriggerRoutine.id) as { state: string }).state) as Record<string, unknown>;
    assert.equal(resetScheduleState.sentinel, undefined, 'definition edit and trigger-state reset must commit together');
    assert.equal(typeof resetScheduleState.lastObservedAt, 'string');
    routines.deleteRoutine(atomicTriggerRoutine.id, atomicTriggerEdited.version);

    assert.throws(() => routines.createRoutine({
      id: 'routine-cycle', name: 'Cycle', agentId: 'agent-verifier', prompt: 'cycle',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
      steps: [
        { id: 'a', name: 'A', prompt: 'a', dependsOn: ['b'] },
        { id: 'b', name: 'B', prompt: 'b', dependsOn: ['a'] },
      ],
    }), /cycle/i);
    assert.throws(() => routines.createRoutine({
      id: 'routine-seconds-cron', name: 'Seconds cron', agentId: 'agent-verifier', prompt: 'Never create',
      triggers: [{ id: 'seconds', type: 'schedule', enabled: true, cron: '*/10 * * * * *' }],
    }), /exactly five fields/i);

    const skipped = routines.triggerRoutineManually(routine.id, { kind: 'stop' }, 'condition-miss');
    assert.equal(skipped.invocation.status, 'skipped');

    const first = routines.triggerRoutineManually(routine.id, { kind: 'go' }, 'manual-delivery-1');
    const duplicate = routines.triggerRoutineManually(routine.id, { kind: 'go' }, 'manual-delivery-1');
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(first.invocation.id, duplicate.invocation.id, 'manual delivery must be idempotent');

    const secondQueued = routines.triggerRoutineManually(routine.id, { kind: 'go' }, 'manual-delivery-2');
    let claimed = routines.claimRoutineInvocations(10);
    assert.equal(claimed.length, 1, 'a shared concurrency key must serialize invocations');
    assert.equal(routines.claimRoutineInvocations(10).length, 0, 'an active durable lease must prevent a second process claim');
    let failed = routines.finishRoutineInvocation(claimed[0].id, { ok: false, error: 'attempt one failed' }, claimed[0].attempt);
    assert.equal(failed.status, 'pending');
    assert.equal(failed.attempt, 1);
    db.prepare('UPDATE routine_invocations SET availableAt = ? WHERE id = ?').run(new Date(Date.now() + 60_000).toISOString(), secondQueued.invocation.id);
    db.prepare('UPDATE routine_invocations SET availableAt = ? WHERE id = ?').run(new Date().toISOString(), failed.id);
    claimed = routines.claimRoutineInvocations(1);
    assert.equal(claimed[0].attempt, 2);
    ledger.createTask({ id: 'routine-fail-task-1', kind: 'routine', title: 'First final failure', status: 'failed' });
    db.prepare('UPDATE routine_invocations SET taskId = ? WHERE id = ?').run('routine-fail-task-1', claimed[0].id);
    failed = routines.finishRoutineInvocation(claimed[0].id, { ok: false, error: 'attempt two failed' }, claimed[0].attempt);
    assert.equal(failed.status, 'failed');
    assert.equal(routines.getRoutine(routine.id)?.failureStreak, 1);

    // The second queued invocation can now claim, exhaust its retry, and trip the breaker.
    db.prepare('UPDATE routine_invocations SET availableAt = ? WHERE id = ?').run(new Date().toISOString(), secondQueued.invocation.id);
    claimed = routines.claimRoutineInvocations(1);
    routines.finishRoutineInvocation(claimed[0].id, { ok: false, error: 'second invocation attempt one' }, claimed[0].attempt);
    db.prepare('UPDATE routine_invocations SET availableAt = ? WHERE id = ?').run(new Date().toISOString(), claimed[0].id);
    claimed = routines.claimRoutineInvocations(1);
    ledger.createTask({ id: 'routine-fail-task-2', kind: 'routine', title: 'Second final failure', status: 'failed' });
    db.prepare('UPDATE routine_invocations SET taskId = ? WHERE id = ?').run('routine-fail-task-2', claimed[0].id);
    routines.finishRoutineInvocation(claimed[0].id, { ok: false, error: 'second invocation attempt two' }, claimed[0].attempt);
    const opened = routines.getRoutine(routine.id)!;
    assert.equal(opened.circuitState, 'open');
    assert(opened.circuitOpenUntil);
    assert.equal(ledger.listAttention({ status: 'open', taskId: 'routine-fail-task-2' }).total, 1, 'breaker must open one durable attention item');
    assert.equal(routines.triggerRoutineManually(routine.id, { kind: 'go' }, 'while-open').invocation.status, 'skipped');
    const reset = routines.resetRoutineCircuit(routine.id, opened.version);
    assert.equal(reset.circuitState, 'closed');
    assert.equal(reset.failureStreak, 0);

    const fencedRoutine = routines.createRoutine({
      id: 'lease-fenced-routine',
      name: 'Lease-fenced routine',
      agentId: 'agent-verifier',
      prompt: 'Verify stale workers cannot finish reclaimed work.',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, multiplier: 2, maxDelayMs: 1_000 },
      concurrencyKey: 'lease-fenced-routine',
    });
    routines.triggerRoutineManually(fencedRoutine.id, {}, 'lease-fence-1');
    const staleClaim = routines.claimRoutineInvocations(1)[0];
    const staleAttempt = staleClaim.attempt;
    assert.equal(routines.routineStepRuntimeTestHooks.startRoutineStepRunFenced({
      invocationId: staleClaim.id,
      stepId: 'run',
      taskId: 'stale-step-task',
      attempt: staleAttempt,
    }), true);
    ledger.createTask({
      id: 'recovered-parent-task', kind: 'routine', title: 'Recovered parent', status: 'running',
      metadata: { suppressFailureSignals: true },
    });
    ledger.createTask({
      id: 'recovered-child-task', kind: 'work', title: 'Recovered child', status: 'running',
      parentId: 'recovered-parent-task', runId: 'recovered-child-run',
      metadata: { suppressTerminalSignals: true },
    });
    db.prepare('UPDATE routine_invocations SET taskId = ? WHERE id = ?').run('recovered-parent-task', staleClaim.id);
    db.prepare('UPDATE routine_invocations SET leaseExpiresAt = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), staleClaim.id);
    const reclaimedClaim = routines.claimRoutineInvocations(1)[0];
    assert.equal(reclaimedClaim.id, staleClaim.id);
    assert.equal(reclaimedClaim.attempt, staleAttempt + 1, 'a reclaimed invocation receives a new fencing attempt');
    assert.equal(routines.routineStepRuntimeTestHooks.startRoutineStepRunFenced({
      invocationId: reclaimedClaim.id,
      stepId: 'run',
      taskId: 'current-step-task',
      attempt: reclaimedClaim.attempt,
    }), true);
    assert.equal(routines.routineStepRuntimeTestHooks.updateRoutineStepRunFenced({
      invocationId: staleClaim.id,
      stepId: 'run',
      taskId: 'stale-step-task',
      attempt: staleAttempt,
      status: 'succeeded',
      output: 'stale step output',
    }), false, 'a reclaimed attempt must fence stale step terminal writes');
    const currentStepRow = db.prepare(`
      SELECT status, taskId, output FROM routine_step_runs WHERE invocationId = ? AND stepId = 'run'
    `).get(reclaimedClaim.id) as { status: string; taskId: string; output: string | null };
    assert.deepEqual({ ...currentStepRow }, { status: 'processing', taskId: 'current-step-task', output: null });
    assert.equal(routines.routineStepRuntimeTestHooks.updateRoutineStepRunFenced({
      invocationId: reclaimedClaim.id,
      stepId: 'run',
      taskId: 'current-step-task',
      attempt: reclaimedClaim.attempt,
      status: 'succeeded',
      output: 'current step output',
    }), true);
    assert.equal(ledger.getTask('recovered-parent-task')?.status, 'lost', 'the prior parent must not remain running');
    assert.equal(ledger.getTask('recovered-child-task')?.status, 'lost', 'the prior child must be settled and cancelled');
    assert.equal(ledger.listAttention({ taskId: 'recovered-parent-task', status: 'open' }).total, 0, 'retry recovery must not notify as a final failure');
    assert.throws(
      () => routines.finishRoutineInvocation(staleClaim.id, { ok: true, result: 'stale result' }, staleAttempt),
      /lease is no longer owned/,
    );
    const afterStaleFinish = routines.listRoutineInvocations(fencedRoutine.id)[0];
    assert.equal(afterStaleFinish.status, 'processing', 'a stale worker cannot overwrite reclaimed work');
    assert.equal(afterStaleFinish.attempt, reclaimedClaim.attempt);
    const fencedFinished = routines.finishRoutineInvocation(
      reclaimedClaim.id,
      { ok: true, result: 'current result' },
      reclaimedClaim.attempt,
    );
    assert.equal(fencedFinished.status, 'succeeded');
    assert.equal(fencedFinished.result, 'current result');

    // An invocation owns an immutable execution DAG. Definition edits after
    // partial output must only affect invocations queued after the edit.
    const snapshotRoutine = routines.createRoutine({
      id: 'execution-snapshot-routine',
      name: 'Original snapshot routine',
      agentId: 'agent-verifier',
      prompt: 'Original pinned prompt',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
      retryPolicy: { maxAttempts: 2, baseDelayMs: 100, multiplier: 2, maxDelayMs: 1_000 },
      concurrencyKey: 'execution-snapshot-routine',
      steps: [
        { id: 'original-first', name: 'Original first', prompt: 'Original first prompt' },
        { id: 'original-second', name: 'Original second', prompt: 'Original second prompt', dependsOn: ['original-first'] },
      ],
    });
    const snapshotQueued = routines.triggerRoutineManually(snapshotRoutine.id, {}, 'snapshot-before-edit').invocation;
    const pinnedBefore = routines.getRoutineInvocationExecutionSnapshot(snapshotQueued.id);
    const snapshotAttemptOne = routines.claimRoutineInvocations(1)[0];
    assert.equal(snapshotAttemptOne.id, snapshotQueued.id);
    db.prepare(`
      INSERT INTO routine_step_runs (invocationId, stepId, status, attempt, taskId, output, error, updatedAt)
      VALUES (?, 'original-first', 'succeeded', 1, NULL, 'partial original output', NULL, ?)
    `).run(snapshotQueued.id, new Date().toISOString());
    const editedSnapshotRoutine = routines.updateRoutine(snapshotRoutine.id, {
      name: 'Replacement snapshot routine',
      agentId: 'agent-replacement',
      prompt: 'Replacement prompt',
      retryPolicy: { maxAttempts: 5, baseDelayMs: 60_000, multiplier: 3, maxDelayMs: 120_000 },
      steps: [{ id: 'replacement', name: 'Replacement', prompt: 'Replacement step prompt' }],
    }, snapshotRoutine.version);
    const retryScheduledAt = Date.now();
    const snapshotFailed = routines.finishRoutineInvocation(
      snapshotQueued.id,
      { ok: false, error: 'retry after partial output' },
      snapshotAttemptOne.attempt,
    );
    assert(
      Date.parse(snapshotFailed.availableAt) < retryScheduledAt + 5_000,
      'an edited retry policy must not delay an already-queued invocation',
    );
    db.prepare('UPDATE routine_invocations SET availableAt = ? WHERE id = ?')
      .run(new Date().toISOString(), snapshotQueued.id);
    const snapshotRetry = routines.claimRoutineInvocations(1)[0];
    assert.equal(snapshotRetry.id, snapshotQueued.id);
    const pinnedRetry = routines.getRoutineInvocationExecutionSnapshot(snapshotRetry.id);
    assert.deepEqual(pinnedRetry, pinnedBefore);
    assert.equal(pinnedRetry.prompt, 'Original pinned prompt');
    assert.equal(pinnedRetry.agentId, 'agent-verifier');
    assert.deepEqual(pinnedRetry.steps.map((step) => step.id), ['original-first', 'original-second']);
    assert.equal((db.prepare(`
      SELECT output FROM routine_step_runs WHERE invocationId = ? AND stepId = 'original-first'
    `).get(snapshotRetry.id) as { output: string }).output, 'partial original output');
    routines.finishRoutineInvocation(snapshotRetry.id, { ok: true, result: 'completed pinned DAG' }, snapshotRetry.attempt);
    const queuedAfterEdit = routines.triggerRoutineManually(snapshotRoutine.id, {}, 'snapshot-after-edit').invocation;
    const replacementSnapshot = routines.getRoutineInvocationExecutionSnapshot(queuedAfterEdit.id);
    assert.equal(replacementSnapshot.definitionVersion, editedSnapshotRoutine.version);
    assert.equal(replacementSnapshot.prompt, 'Replacement prompt');
    assert.deepEqual(replacementSnapshot.steps.map((step) => step.id), ['replacement']);
    const afterEditClaim = routines.claimRoutineInvocations(1)[0];
    assert.equal(afterEditClaim.id, queuedAfterEdit.id);
    routines.finishRoutineInvocation(afterEditClaim.id, { ok: true, result: 'completed replacement DAG' }, afterEditClaim.attempt);

    // An expired final lease must exhaust exactly once instead of looping
    // forever, and operational circuit state must not invalidate an editor's
    // optimistic definition version.
    const exhaustedRoutine = routines.createRoutine({
      id: 'retry-exhaustion-routine',
      name: 'Retry exhaustion routine',
      agentId: 'agent-verifier',
      prompt: 'Verify final lease expiry',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
      retryPolicy: { maxAttempts: 1, baseDelayMs: 100, multiplier: 2, maxDelayMs: 1_000 },
      circuitBreaker: { failureThreshold: 1, cooldownSeconds: 60 },
    });
    routines.triggerRoutineManually(exhaustedRoutine.id, {}, 'expire-final-attempt');
    const expiring = routines.claimRoutineInvocations(1)[0];
    assert.equal(expiring.attempt, 1);
    ledger.createTask({ id: 'exhausted-parent-task', kind: 'routine', title: 'Exhausted parent', status: 'running' });
    ledger.createTask({
      id: 'exhausted-child-task', kind: 'work', title: 'Exhausted child', status: 'running',
      parentId: 'exhausted-parent-task', runId: 'exhausted-child-run',
      metadata: { suppressTerminalSignals: true },
    });
    db.prepare('UPDATE routine_invocations SET taskId = ? WHERE id = ?').run('exhausted-parent-task', expiring.id);
    db.prepare('UPDATE routine_invocations SET leaseExpiresAt = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), expiring.id);
    assert.equal(routines.claimRoutineInvocations(1).length, 0, 'an exhausted lease must not be reclaimed');
    const exhaustedInvocation = routines.listRoutineInvocations(exhaustedRoutine.id)[0];
    assert.equal(exhaustedInvocation.status, 'failed');
    assert.equal(exhaustedInvocation.attempt, 1);
    assert.equal(ledger.getTask('exhausted-parent-task')?.status, 'failed');
    assert.equal(ledger.getTask('exhausted-child-task')?.status, 'lost');
    const exhaustedAfter = routines.getRoutine(exhaustedRoutine.id)!;
    assert.equal(exhaustedAfter.circuitState, 'open');
    assert.equal(exhaustedAfter.version, exhaustedRoutine.version, 'runtime state must not bump definition version');
    const definitionEdit = routines.updateRoutine(
      exhaustedRoutine.id,
      { description: 'Edited using the pre-run definition version' },
      exhaustedRoutine.version,
    );
    assert.equal(definitionEdit.version, exhaustedRoutine.version + 1);

    // A busy key with many old rows cannot hide an unrelated eligible key
    // behind a fixed candidate scan. Deleting then cancels both leased and
    // queued work, and fences the stale worker's completion.
    const blockedRoutine = routines.createRoutine({
      id: 'fairness-blocked-routine', name: 'Fairness blocked', agentId: 'agent-verifier', prompt: 'Blocked',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
      concurrencyKey: 'shared-busy-key',
    });
    routines.triggerRoutineManually(blockedRoutine.id, {}, 'active');
    const activeBlocked = routines.claimRoutineInvocations(1)[0];
    ledger.createTask({
      id: 'deleted-routine-root-task', kind: 'routine', title: 'Deleted routine root', status: 'running',
      metadata: { suppressTerminalSignals: true },
    });
    let deepestDeletedTaskId = 'deleted-routine-root-task';
    for (let depth = 1; depth <= 102; depth += 1) {
      const taskId = `deleted-routine-depth-${depth}`;
      ledger.createTask({
        id: taskId,
        kind: 'work',
        title: `Deleted routine child ${depth}`,
        status: 'running',
        parentId: deepestDeletedTaskId,
        metadata: { suppressTerminalSignals: true },
      });
      deepestDeletedTaskId = taskId;
    }
    db.prepare('UPDATE routine_invocations SET taskId = ? WHERE id = ?')
      .run('deleted-routine-root-task', activeBlocked.id);
    for (let index = 0; index < 8; index++) {
      routines.triggerRoutineManually(blockedRoutine.id, {}, `blocked-${index}`);
    }
    const freeRoutine = routines.createRoutine({
      id: 'fairness-free-routine', name: 'Fairness free', agentId: 'agent-verifier', prompt: 'Free',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
      concurrencyKey: 'independent-free-key',
    });
    const freeQueued = routines.triggerRoutineManually(freeRoutine.id, {}, 'free');
    const fairClaim = routines.claimRoutineInvocations(1);
    assert.equal(fairClaim.length, 1);
    assert.equal(fairClaim[0].id, freeQueued.invocation.id, 'an independent key must not starve behind busy rows');
    routines.finishRoutineInvocation(fairClaim[0].id, { ok: true, result: 'free completed' }, fairClaim[0].attempt);
    db.exec(`
      CREATE TEMP TRIGGER fail_deleted_routine_task_settlement
      BEFORE UPDATE OF status ON tasks
      WHEN OLD.id = 'deleted-routine-root-task' AND NEW.status = 'cancelled'
      BEGIN
        SELECT RAISE(ABORT, 'simulated routine settlement failure');
      END
    `);
    try {
      assert.throws(
        () => routines.deleteRoutine(blockedRoutine.id, blockedRoutine.version),
        /simulated routine settlement failure/,
      );
    } finally {
      db.exec('DROP TRIGGER fail_deleted_routine_task_settlement');
    }
    assert(routines.getRoutine(blockedRoutine.id), 'routine tombstone must roll back with task settlement');
    assert.equal(routines.listRoutineInvocations(blockedRoutine.id).find((item) => item.id === activeBlocked.id)?.status, 'processing');
    assert.equal(ledger.getTask('deleted-routine-root-task')?.status, 'running');
    assert.equal(ledger.getTask(deepestDeletedTaskId)?.status, 'running');
    routines.deleteRoutine(blockedRoutine.id, blockedRoutine.version);
    assert(routines.listRoutineInvocations(blockedRoutine.id).every((invocation) => invocation.status === 'skipped'));
    assert.equal(ledger.getTask('deleted-routine-root-task')?.status, 'cancelled');
    assert.equal(ledger.getTask(deepestDeletedTaskId)?.status, 'cancelled', 'task trees deeper than 100 must fully settle');
    assert.throws(
      () => routines.finishRoutineInvocation(activeBlocked.id, { ok: true, result: 'stale after delete' }, activeBlocked.attempt),
      /lease is no longer owned/,
    );

    // Simulate an older process crash after the routine tombstone committed
    // but before its invocation/task projections were settled.
    const interruptedRoutine = routines.createRoutine({
      id: 'interrupted-delete-routine', name: 'Interrupted delete', agentId: 'agent-verifier', prompt: 'Recover me',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
    });
    routines.triggerRoutineManually(interruptedRoutine.id, {}, 'interrupted-delete');
    const interruptedInvocation = routines.claimRoutineInvocations(1)[0];
    ledger.createTask({ id: 'interrupted-delete-root', kind: 'routine', title: 'Interrupted root', status: 'running' });
    ledger.createTask({
      id: 'interrupted-delete-child', kind: 'work', title: 'Interrupted child', status: 'running',
      parentId: 'interrupted-delete-root', metadata: { suppressTerminalSignals: true },
    });
    ledger.createTask({
      id: 'interrupted-delete-grandchild', kind: 'work', title: 'Interrupted grandchild', status: 'running',
      parentId: 'interrupted-delete-child', metadata: { suppressTerminalSignals: true },
    });
    db.prepare('UPDATE routine_invocations SET taskId = ? WHERE id = ?')
      .run('interrupted-delete-root', interruptedInvocation.id);
    const interruptedAt = new Date().toISOString();
    db.prepare('UPDATE routines SET enabled = 0, deletedAt = ?, updatedAt = ? WHERE id = ?')
      .run(interruptedAt, interruptedAt, interruptedRoutine.id);
    const deletedRepair = routines.repairDeletedRoutineTaskProjections();
    assert(deletedRepair.invocationsSkipped >= 1);
    assert(deletedRepair.tasksSettled >= 3);
    assert.equal(
      (db.prepare('SELECT status FROM routine_invocations WHERE id = ?').get(interruptedInvocation.id) as { status: string }).status,
      'skipped',
    );
    assert.equal(ledger.getTask('interrupted-delete-root')?.status, 'cancelled');
    assert.equal(ledger.getTask('interrupted-delete-child')?.status, 'cancelled');
    assert.equal(ledger.getTask('interrupted-delete-grandchild')?.status, 'cancelled');
    assert.deepEqual(routines.repairDeletedRoutineTaskProjections(), { invocationsSkipped: 0, tasksSettled: 0 });

    // One-time delivery is durably consumed and the definition retires after
    // its only invocation reaches a terminal state, without a version bump.
    const oneTimeRoutine = routines.createRoutine({
      id: 'consumed-one-time', name: 'Consumed one time', agentId: 'agent-verifier', prompt: 'Once',
      triggers: [{ id: 'once', type: 'one_time', enabled: true, at: new Date(Date.now() - 2_000).toISOString() }],
      catchUpPolicy: 'run_once',
    });
    assert.equal(await routines.pollRoutineTriggers(), 1);
    assert.equal(await routines.pollRoutineTriggers(), 0, 'one-time trigger must be consumed after its first delivery');
    const oneTimeClaim = routines.claimRoutineInvocations(1)[0];
    assert.equal(oneTimeClaim.routineId, oneTimeRoutine.id);
    routines.finishRoutineInvocation(oneTimeClaim.id, { ok: true, result: 'done once' }, oneTimeClaim.attempt);
    const retired = routines.getRoutine(oneTimeRoutine.id)!;
    assert.equal(retired.enabled, false);
    assert.equal(retired.version, oneTimeRoutine.version, 'automatic one-time retirement is operational state');
    const consumedState = JSON.parse((db.prepare(`
      SELECT state FROM routine_trigger_state WHERE routineId = ? AND triggerId = ?
    `).get(oneTimeRoutine.id, 'once') as { state: string }).state) as { invocationId?: string; consumedAt?: string };
    assert.equal(consumedState.invocationId, oneTimeClaim.id);
    assert(consumedState.consumedAt);
    db.prepare('UPDATE routines SET enabled = 1 WHERE id = ?').run(oneTimeRoutine.id);
    await routines.pollRoutineTriggers();
    assert.equal(
      routines.getRoutine(oneTimeRoutine.id)?.enabled,
      false,
      'a restart after terminal commit but before retirement must retire an already-consumed one-time routine',
    );

    // Backpressure must leave queue attempts untouched while the global run
    // pool is full; an attempt begins only after durable claim.
    const capacityRoutine = routines.createRoutine({
      id: 'capacity-routine', name: 'Capacity routine', agentId: 'agent-verifier', prompt: 'Wait for capacity',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
    });
    const capacityInvocation = routines.triggerRoutineManually(capacityRoutine.id, {}, 'capacity').invocation;
    const guards = await import('../lib/run-guards');
    const { loadConfig } = await import('../lib/persistence');
    const configuredLimit = guards.maxConcurrentRuns(await loadConfig());
    const syntheticRunIds = Array.from({ length: configuredLimit }, (_, index) => `routine-capacity-${index}`);
    for (const runId of syntheticRunIds) guards.registerActiveRun(runId, 'capacity-agent', 'Capacity verifier');
    try {
      assert.equal(await routines.processRoutineInvocations(4), 0);
      const stillPending = routines.listRoutineInvocations(capacityRoutine.id).find((item) => item.id === capacityInvocation.id)!;
      assert.equal(stillPending.status, 'pending');
      assert.equal(stillPending.attempt, 0, 'backpressure must not burn a retry attempt');
    } finally {
      for (const runId of syntheticRunIds) guards.releaseActiveRun(runId);
    }
    routines.deleteRoutine(capacityRoutine.id, capacityRoutine.version);

    // Independent slow health probes run concurrently, so one endpoint cannot
    // hold every other trigger behind its timeout.
    const healthServer = createServer((_request, response) => {
      setTimeout(() => {
        response.statusCode = 503;
        response.end('unhealthy');
      }, 400);
    });
    await new Promise<void>((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = healthServer.address();
      assert(address && typeof address === 'object');
      const healthRoutine = routines.createRoutine({
        id: 'parallel-health-routine', name: 'Parallel health', agentId: 'agent-verifier', prompt: 'Report health',
        triggers: [
          { id: 'health-a', type: 'health', enabled: true, url: `http://127.0.0.1:${address.port}/a`, intervalSeconds: 5, timeoutMs: 2_000 },
          { id: 'health-b', type: 'health', enabled: true, url: `http://127.0.0.1:${address.port}/b`, intervalSeconds: 5, timeoutMs: 2_000 },
        ],
      });
      const pollStarted = Date.now();
      assert.equal(await routines.pollRoutineTriggers(), 2);
      const pollElapsed = Date.now() - pollStarted;
      assert(pollElapsed < 650, `health checks should overlap (elapsed ${pollElapsed}ms)`);
      routines.deleteRoutine(healthRoutine.id, healthRoutine.version);
    } finally {
      await new Promise<void>((resolve, reject) => healthServer.close((error) => error ? reject(error) : resolve()));
    }

    const timestamp = String(Math.floor(Date.now() / 1_000));
    const rawBody = JSON.stringify({ kind: 'go', name: 'Webhook' });
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const webhook = routines.verifyAndEnqueueRoutineWebhook({
      routineId: routine.id,
      triggerId: 'hook',
      timestamp,
      signature: `sha256=${signature}`,
      deliveryId: 'delivery-42',
      rawBody,
    });
    assert.equal(webhook.inserted, true);
    const webhookDuplicate = routines.verifyAndEnqueueRoutineWebhook({
      routineId: routine.id,
      triggerId: 'hook',
      timestamp,
      signature,
      deliveryId: 'delivery-42',
      rawBody,
    });
    assert.equal(webhookDuplicate.inserted, false, 'duplicate webhook delivery cannot duplicate an invocation');
    assert.throws(() => routines.verifyAndEnqueueRoutineWebhook({
      routineId: routine.id, triggerId: 'hook', timestamp, signature: '00'.repeat(32), deliveryId: 'bad', rawBody,
    }), /signature/i);
    const webhookRoute = await import('../app/api/routines/[id]/webhook/route');
    const endpointBody = JSON.stringify({ kind: 'go', name: 'Endpoint' });
    const endpointSignature = createHmac('sha256', secret).update(`${timestamp}.${endpointBody}`).digest('hex');
    const endpointResponse = await webhookRoute.POST(new Request(`http://localhost/api/routines/${routine.id}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shiba-trigger': 'hook',
        'x-shiba-timestamp': timestamp,
        'x-shiba-signature': `sha256=${endpointSignature}`,
        'x-shiba-delivery': 'endpoint-delivery-1',
      },
      body: endpointBody,
    }), { params: Promise.resolve({ id: routine.id }) });
    assert.equal(endpointResponse.status, 202, 'signed webhook route must accept a valid delivery');

    const integration = routines.emitRoutineIntegrationEvent({
      integration: 'github', event: 'push', payload: { kind: 'go' }, dedupeKey: 'github-delivery-1',
    });
    assert.equal(integration.length, 1);
    const integrationDuplicate = routines.emitRoutineIntegrationEvent({
      integration: 'github', event: 'push', payload: { kind: 'go' }, dedupeKey: 'github-delivery-1',
    });
    assert.equal(integrationDuplicate[0].id, integration[0].id);

    const dueRoutine = routines.createRoutine({
      id: 'due-one-time', name: 'Due one time', agentId: 'agent-verifier', prompt: 'Due',
      triggers: [{ id: 'due', type: 'one_time', enabled: true, at: new Date(Date.now() - 2_000).toISOString() }],
      catchUpPolicy: 'run_once',
    });
    assert.equal(await routines.pollRoutineTriggers(), 1);
    assert.equal(await routines.pollRoutineTriggers(), 0, 'one-time trigger polling must dedupe durably');
    assert.equal(routines.listRoutineInvocations(dueRoutine.id).length, 1);

    const catchUpRoutine = routines.createRoutine({
      id: 'catch-up-schedule', name: 'Catch-up schedule', agentId: 'agent-verifier', prompt: 'Catch up',
      triggers: [{ id: 'each-minute', type: 'schedule', enabled: true, cron: '* * * * *' }],
      catchUpPolicy: 'run_once',
    });
    const baseline = new Date(Date.now() + 1_000);
    await routines.pollRoutineTriggers(baseline);
    await routines.pollRoutineTriggers(new Date(baseline.getTime() + 61_000));
    assert.equal(routines.listRoutineInvocations(catchUpRoutine.id).length, 1, 'missed schedule polling must catch up once');

    const parsed = routines.parseNaturalOneTime('in 2 hours', new Date('2026-01-01T00:00:00.000Z'));
    assert.equal(parsed?.toISOString(), '2026-01-01T02:00:00.000Z');
    const durable = routines.createDurableOneTimeRoutine({ agentId: 'agent-verifier', when: 'in 1 minute', prompt: 'Follow up' });
    assert.equal(durable.routine.triggers[0].type, 'one_time');

    const agentsRoute = await import('../app/api/agents/route');
    const invalidAgentResponse = await agentsRoute.POST(new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Invalid cron agent',
        schedules: [{ id: 'seconds', enabled: true, cron: '*/10 * * * * *', instructions: 'Never save' }],
      }),
    }) as Parameters<typeof agentsRoute.POST>[0]);
    assert.equal(invalidAgentResponse.status, 400, 'agent API must reject unsupported cron before persistence');
    assert.match(String((await invalidAgentResponse.json() as { error?: string }).error), /exactly five fields/i);

    const json = routines.exportRoutine(routine.id, 'json');
    const yaml = routines.exportRoutine(routine.id, 'yaml');
    assert(json.includes('shiba.routine/v1'));
    assert(yaml.includes('schema:'));
    assert(!json.includes(secret));
    assert(!yaml.includes(secret));

    const maintenance = await import('../lib/automation-maintenance');
    const releaseMaintenance = maintenance.beginAutomationMaintenance('routine verification');
    try {
      assert.throws(
        () => routines.triggerRoutineManually(freeRoutine.id, {}, 'maintenance-blocked'),
        (error: unknown) => error instanceof routines.RoutineMaintenanceError && error.retryable,
      );
      assert.equal(await routines.pollRoutineTriggers(), 0);
      assert.equal(await routines.processRoutineInvocations(), 0);
      const runRoute = await import('../app/api/routines/[id]/run/route');
      const maintenanceResponse = await runRoute.POST(new Request(`http://localhost/api/routines/${freeRoutine.id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: {}, dedupeKey: 'maintenance-route' }),
      }), { params: Promise.resolve({ id: freeRoutine.id }) });
      assert.equal(maintenanceResponse.status, 503);
      assert.equal(maintenanceResponse.headers.get('retry-after'), '5');
      await scheduler.initScheduler();
      assert.equal(scheduler.listScheduled().length, 0);
    } finally {
      releaseMaintenance();
    }

    await scheduler.initScheduler();
    await scheduler.stopAllScheduledTasks();
    assert.equal(scheduler.listScheduled().length, 0, 'awaited scheduler stop must leave no re-armed tasks');

    console.log('Routine verification passed');
  } finally {
    await routines.stopRoutineEngine();
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Routine verification failed', error);
  process.exit(1);
});
