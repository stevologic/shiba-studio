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
    const active = await harness.startHarnessGrant(issued.grant.id, issued.token, 'Implement the requested change.');
    assert.equal(active.status, 'active');
    assert.equal(ledger.getTask(active.childTaskId)?.status, 'waiting_for_input');
    harness.postHarnessCallback({
      id: active.id,
      token: issued.token,
      status: 'running',
      summary: 'Harness attached.',
    });
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

    const revoke = harness.createHarnessGrant({
      taskId: parent.id,
      provider: 'codex',
      workspaceRootId: 'repo',
      allowedTools: ['fs.read'],
    });
    assert.equal(harness.revokeHarnessGrant(revoke.grant.id).status, 'revoked');
    assert.equal(ledger.getTask(revoke.grant.childTaskId)?.status, 'cancelled');

    const expiry = harness.createHarnessGrant({
      taskId: parent.id,
      provider: 'claude',
      workspaceRootId: 'repo',
      allowedTools: ['fs.read'],
    });
    getDb().prepare("UPDATE harness_grants SET expiresAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), expiry.grant.id);
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
