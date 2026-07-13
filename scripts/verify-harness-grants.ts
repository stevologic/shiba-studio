import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-harness-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '77'.repeat(32);
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const ledger = await import('../lib/task-ledger');
  const harness = await import('../lib/harness-grants');
  const { getDb, closeDb } = await import('../lib/db');
  try {
    const parent = ledger.createTask({
      id: 'parent-harness-task',
      kind: 'code',
      title: 'Scoped external implementation',
      description: 'Make a bounded change and prove it.',
      originType: 'manual',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'write' }],
    });
    assert.deepEqual(harness.listHarnessGrants(parent.id), []);
    const taskCountBeforeRejectedGrant = Number((getDb().prepare('SELECT COUNT(*) AS count FROM tasks')
      .get() as { count: number }).count);
    getDb().exec(`
      CREATE TEMP TRIGGER fail_harness_grant_insert
      BEFORE INSERT ON harness_grants
      BEGIN
        SELECT RAISE(ABORT, 'simulated harness grant insert failure');
      END
    `);
    try {
      assert.throws(() => harness.createHarnessGrant({
        taskId: parent.id,
        provider: 'grok',
        workspaceRootId: 'repo',
        allowedTools: ['fs.read'],
      }), /simulated harness grant insert failure/);
    } finally {
      getDb().exec('DROP TRIGGER fail_harness_grant_insert');
    }
    assert.equal(
      Number((getDb().prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count),
      taskCountBeforeRejectedGrant,
      'a rejected grant insert must not leave an orphan child task',
    );
    const issued = harness.createHarnessGrant({
      taskId: parent.id,
      provider: 'hermes',
      workspaceRootId: 'repo',
      allowedTools: ['fs.read', 'fs.write', 'shell:test'],
      ttlSeconds: 120,
    });
    assert.match(issued.token, /^shg_/);
    assert(!JSON.stringify(harness.listHarnessGrants(parent.id)).includes(issued.token), 'list output must never expose grant tokens');
    assert.throws(() => harness.authenticateHarnessGrant(issued.grant.id, 'wrong'), /Invalid harness/);
    getDb().exec(`
      CREATE TEMP TRIGGER fail_harness_start_task
      BEFORE UPDATE OF status ON tasks
      WHEN OLD.id = '${issued.grant.childTaskId}' AND NEW.status = 'running'
      BEGIN
        SELECT RAISE(ABORT, 'simulated harness start failure');
      END
    `);
    try {
      await assert.rejects(
        () => harness.startHarnessGrant(issued.grant.id, issued.token, 'Implement the requested change.'),
        /simulated harness start failure/,
      );
    } finally {
      getDb().exec('DROP TRIGGER fail_harness_start_task');
    }
    assert.equal(harness.authenticateHarnessGrant(issued.grant.id, issued.token).status, 'issued');
    assert.equal(ledger.getTask(issued.grant.childTaskId)?.status, 'queued');
    const active = await harness.startHarnessGrant(issued.grant.id, issued.token, 'Implement the requested change.');
    assert.equal(active.status, 'active');
    assert.equal(ledger.getTask(active.childTaskId)?.status, 'waiting_for_input');
    harness.postHarnessCallback({
      id: active.id,
      token: issued.token,
      status: 'running',
      summary: 'Harness attached.',
    });
    getDb().exec(`
      CREATE TEMP TRIGGER fail_harness_terminal_grant
      BEFORE UPDATE OF status ON harness_grants
      WHEN OLD.id = '${active.id}' AND NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'simulated harness terminal failure');
      END
    `);
    try {
      assert.throws(() => harness.postHarnessCallback({
        id: active.id,
        token: issued.token,
        status: 'succeeded',
        summary: 'Should roll back.',
      }), /simulated harness terminal failure/);
    } finally {
      getDb().exec('DROP TRIGGER fail_harness_terminal_grant');
    }
    assert.equal(harness.authenticateHarnessGrant(active.id, issued.token).status, 'active');
    assert.equal(ledger.getTask(active.childTaskId)?.status, 'running');
    const completed = harness.postHarnessCallback({
      id: active.id,
      token: issued.token,
      status: 'succeeded',
      summary: 'Change complete.',
      evidence: [{
        kind: 'test',
        status: 'passed',
        label: 'Focused tests',
        summary: 'All focused tests passed.',
        command: 'npm test',
        exitCode: 0,
      }],
    });
    assert.equal(completed.status, 'completed');
    const child = ledger.getTaskDetails(completed.childTaskId)!;
    assert.equal(child.parentId, parent.id);
    assert.equal(child.status, 'succeeded');
    assert.equal(child.evidence[0]?.scope, 'repo');
    assert.throws(() => harness.revokeHarnessGrant(completed.id), /cannot be revoked from status completed/);

    const revoke = harness.createHarnessGrant({
      taskId: parent.id,
      provider: 'codex',
      workspaceRootId: 'repo',
      allowedTools: ['fs.read'],
    });
    getDb().exec(`
      CREATE TEMP TRIGGER fail_harness_child_cancel
      BEFORE UPDATE OF status ON tasks
      WHEN OLD.id = '${revoke.grant.childTaskId}' AND NEW.status = 'cancelled'
      BEGIN
        SELECT RAISE(ABORT, 'simulated harness settlement failure');
      END
    `);
    try {
      assert.throws(() => harness.revokeHarnessGrant(revoke.grant.id), /simulated harness settlement failure/);
    } finally {
      getDb().exec('DROP TRIGGER fail_harness_child_cancel');
    }
    assert.equal(
      (getDb().prepare('SELECT status FROM harness_grants WHERE id = ?').get(revoke.grant.id) as { status: string }).status,
      'issued',
      'grant revocation must roll back when child settlement fails',
    );
    assert.equal(ledger.getTask(revoke.grant.childTaskId)?.status, 'queued');
    assert.equal(harness.revokeHarnessGrant(revoke.grant.id).status, 'revoked');
    assert.equal(ledger.getTask(revoke.grant.childTaskId)?.status, 'cancelled');

    const interrupted = harness.createHarnessGrant({
      taskId: parent.id,
      provider: 'grok',
      workspaceRootId: 'repo',
      allowedTools: ['fs.read'],
    });
    getDb().prepare("UPDATE harness_grants SET status = 'revoked', revokedAt = ? WHERE id = ?")
      .run(new Date().toISOString(), interrupted.grant.id);
    const interruptedRepair = harness.repairHarnessGrantLifecycleProjections();
    assert.equal(interruptedRepair.tasksCancelled, 1);
    assert.equal(ledger.getTask(interrupted.grant.childTaskId)?.status, 'cancelled');

    const externallyCancelled = harness.createHarnessGrant({
      taskId: parent.id,
      provider: 'hermes',
      workspaceRootId: 'repo',
      allowedTools: ['fs.read'],
    });
    const externalChild = ledger.getTask(externallyCancelled.grant.childTaskId)!;
    ledger.transitionTask({
      taskId: externalChild.id,
      status: 'cancelled',
      expectedVersion: externalChild.version,
      error: 'Parent lifecycle ended.',
    });
    const cancelledRepair = harness.repairHarnessGrantLifecycleProjections();
    assert.equal(cancelledRepair.grantsTerminalized, 1);
    assert.throws(
      () => harness.authenticateHarnessGrant(externallyCancelled.grant.id, externallyCancelled.token),
      /Harness grant is revoked/,
    );

    const expiry = harness.createHarnessGrant({
      taskId: parent.id,
      provider: 'claude',
      workspaceRootId: 'repo',
      allowedTools: ['fs.read'],
    });
    getDb().prepare("UPDATE harness_grants SET expiresAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), expiry.grant.id);
    const expiryRepair = harness.repairHarnessGrantLifecycleProjections();
    assert.equal(expiryRepair.grantsExpired, 1);
    assert.equal(expiryRepair.tasksCancelled, 1);
    assert.equal(harness.listHarnessGrants(parent.id).find((item) => item.id === expiry.grant.id)?.status, 'expired');
    assert.equal(ledger.getTask(expiry.grant.childTaskId)?.status, 'cancelled');
    console.log('Harness grant verification passed');
  } finally {
    closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Harness grant verification failed', error);
  process.exitCode = 1;
});
