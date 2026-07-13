import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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

    assert.throws(() => routines.createRoutine({
      id: 'routine-cycle', name: 'Cycle', agentId: 'agent-verifier', prompt: 'cycle',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
      steps: [
        { id: 'a', name: 'A', prompt: 'a', dependsOn: ['b'] },
        { id: 'b', name: 'B', prompt: 'b', dependsOn: ['a'] },
      ],
    }), /cycle/i);

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
    db.prepare('UPDATE routine_invocations SET leaseExpiresAt = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), staleClaim.id);
    const reclaimedClaim = routines.claimRoutineInvocations(1)[0];
    assert.equal(reclaimedClaim.id, staleClaim.id);
    assert.equal(reclaimedClaim.attempt, staleAttempt + 1, 'a reclaimed invocation receives a new fencing attempt');
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

    const json = routines.exportRoutine(routine.id, 'json');
    const yaml = routines.exportRoutine(routine.id, 'yaml');
    assert(json.includes('shiba.routine/v1'));
    assert(yaml.includes('schema:'));
    assert(!json.includes(secret));
    assert(!yaml.includes(secret));

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
