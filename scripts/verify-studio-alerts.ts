import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-studio-alerts-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '77'.repeat(32);

  const ledger = await import('../lib/task-ledger');
  const alerts = await import('../lib/studio-alerts');
  const inbox = await import('../lib/agent-inbox');
  const db = await import('../lib/db');

  try {
    const running = ledger.createTask({
      kind: 'work',
      title: 'Publish changelog',
      status: 'running',
    });
    ledger.transitionTask({
      taskId: running.id,
      expectedVersion: running.version,
      status: 'failed',
      error: 'npm test exited 1',
    });

    const listed = alerts.listStudioAlerts();
    const failure = listed.items.find((item) => item.sourceId === running.id);
    assert(failure, 'failing a task through transitionTask must record a studio alert');
    assert.equal(failure.kind, 'task_failed');
    assert.match(failure.body, /npm test exited 1/);
    assert.equal(failure.href, `/tasks/${running.id}`);
    assert(listed.unread >= 1);

    const suppressed = ledger.createTask({
      kind: 'routine',
      title: 'Child step',
      status: 'running',
      metadata: { suppressTerminalSignals: true },
    });
    ledger.transitionTask({
      taskId: suppressed.id,
      expectedVersion: suppressed.version,
      status: 'failed',
      error: 'inner step failed',
    });
    assert.equal(
      alerts.listStudioAlerts().items.some((item) => item.sourceId === suppressed.id),
      false,
      'suppressed child failures must not become badge noise',
    );

    alerts.recordStudioAlert({
      kind: 'automation_skipped',
      title: 'Nightly review skipped',
      body: 'Routine circuit breaker is open',
      href: '/automations',
      sourceId: 'routine-a',
      dedupeKey: 'routine-skip:routine-a:open',
    });
    const unreadBefore = alerts.unreadStudioAlertCount();
    assert(unreadBefore >= 2);
    const marked = alerts.markStudioAlertRead(failure.id);
    assert(marked?.readAt);
    assert.equal(alerts.unreadStudioAlertCount(), unreadBefore - 1);

    inbox.postToAgentInbox('agent-b', 'agent-a', 'handoff the screenshot');
    db.closeDb();
    const drained = inbox.drainInbox('agent-b');
    assert.equal(drained.length, 1);
    assert.match(drained[0], /handoff the screenshot/);
    assert.deepEqual(inbox.drainInbox('agent-b'), [], 'drain must consume durable rows');

    console.log('verify-studio-alerts: OK');
  } finally {
    const { closeDb } = await import('../lib/db');
    closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('verify-studio-alerts failed', error);
  process.exitCode = 1;
});
