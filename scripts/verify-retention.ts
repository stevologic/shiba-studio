import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-retention-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = 'ef'.repeat(32);

  const dbModule = await import('../lib/db');
  const persistence = await import('../lib/persistence');
  const ledger = await import('../lib/task-ledger');
  const context = await import('../lib/context-engine');
  const retention = await import('../lib/retention');
  try {
    await persistence.saveConfig({ runRetentionDays: 1, auditRetentionDays: 0 });
    const db = dbModule.getDb();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000).toISOString();
    const insertRun = db.prepare(`
      INSERT INTO runs (
        id, taskId, attemptNo, agentId, agentName, model, status, prompt,
        startedAt, completedAt, finalOutput, sideEffects, trace
      ) VALUES (?, ?, 1, 'retention-agent', 'Retention Agent', 'test-model', ?, ?, ?, ?, ?, '[]', '[]')
    `);
    insertRun.run('retention-terminal', 'retention-terminal-task', 'completed', 'terminal', old, old, 'done');
    insertRun.run('retention-running', null, 'running', 'running', old, null, null);
    insertRun.run('retention-active-task', 'retention-active-task-id', 'completed', 'guarded', old, old, 'done');

    ledger.createTask({
      id: 'retention-terminal-task', kind: 'agent', title: 'Terminal retention task',
      status: 'succeeded', originType: 'manual', runId: 'retention-terminal',
    });
    ledger.createTask({
      id: 'retention-active-task-id', kind: 'agent', title: 'Active retention task',
      status: 'queued', originType: 'manual', runId: 'retention-active-task',
    });
    context.indexRunContext({
      id: 'retention-terminal', taskId: 'retention-terminal-task', attemptNo: 1,
      agentId: 'retention-agent', agentName: 'Retention Agent', model: 'test-model',
      status: 'completed', prompt: 'terminal', startedAt: old, completedAt: old,
      finalOutput: 'done', sideEffects: [], trace: [],
    });
    ledger.claimTaskRunControlSignals('schema-only', 'retention-verifier');
    db.prepare(`
      INSERT INTO task_run_controls (
        id, commandId, taskId, runId, kind, instruction, status, attempts,
        availableAt, consumerId, leaseUntil, lastError, createdAt, acknowledgedAt
      ) VALUES ('retention-control', 'retention-command', 'retention-terminal-task',
        'retention-terminal', 'cancel', NULL, 'pending', 0, ?, NULL, NULL, NULL, ?, NULL)
    `).run(old, old);

    const result = await retention.pruneStores();
    assert.equal(result.runsRemoved, 1);
    assert.equal(db.prepare('SELECT 1 FROM runs WHERE id = ?').get('retention-terminal'), undefined);
    assert(db.prepare('SELECT 1 FROM runs WHERE id = ?').get('retention-running'), 'running runs are never retained away');
    assert(db.prepare('SELECT 1 FROM runs WHERE id = ?').get('retention-active-task'), 'runs bound to active tasks are preserved');
    assert.equal((db.prepare('SELECT runId FROM tasks WHERE id = ?').get('retention-terminal-task') as { runId: string | null }).runId, null);
    assert.equal(db.prepare('SELECT 1 FROM task_run_controls WHERE id = ?').get('retention-control'), undefined);
    assert.equal(db.prepare("SELECT 1 FROM context_sources WHERE scopeType = 'run' AND scopeId = ?").get('retention-terminal'), undefined);
    console.log('retention: 8 passed, 0 failed');
  } finally {
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('retention: failed', error);
  process.exit(1);
});
