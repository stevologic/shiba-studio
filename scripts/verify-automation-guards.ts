import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-automation-guards-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '91'.repeat(32);

  const db = await import('../lib/db');
  const guards = await import('../lib/run-guards');
  try {
    assert.equal((db.getDb().prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5_000);
    assert.equal(db.claimScheduleTick('agent:schedule', '2026-07-13T12:00'), true);
    assert.equal(db.claimScheduleTick('agent:schedule', '2026-07-13T12:00'), false,
      'only the schedule tick primary-key race is reported as a duplicate');

    const config = { maxConcurrentRuns: 3 } as Parameters<typeof guards.tryAcquireRunSlot>[0];
    assert.equal(guards.tryAcquireRunSlot(config, 'unique-run', 'agent-1', 'Verifier'), null);
    assert.match(
      guards.tryAcquireRunSlot(config, 'unique-run', 'agent-2', 'Duplicate') || '',
      /already active/i,
      'duplicate run ids cannot overwrite an existing capacity claim',
    );
    assert.equal(guards.activeRunCount(), 1);
    guards.releaseActiveRun('unique-run');
    assert.equal(guards.activeRunCount(), 0);

    const release = db.beginDbMaintenance();
    try {
      assert.throws(
        () => db.claimScheduleTick('agent:schedule', '2026-07-13T12:01'),
        /maintenance in progress/i,
        'database failures must surface instead of masquerading as duplicate ticks',
      );
    } finally {
      release();
    }

    const routines = await import('../lib/routines');
    routines.startRoutineEngine();
    const routineRuntime = globalThis as unknown as {
      __shibaRoutineCronSync?: Promise<void>;
      __shibaRoutinePoll?: ReturnType<typeof setInterval>;
      __shibaRoutinePump?: ReturnType<typeof setInterval>;
    };
    const firstSync = routineRuntime.__shibaRoutineCronSync;
    const firstPoll = routineRuntime.__shibaRoutinePoll;
    const firstPump = routineRuntime.__shibaRoutinePump;
    routines.startRoutineEngine();
    assert.equal(routineRuntime.__shibaRoutineCronSync, firstSync,
      'a second routine-engine start does not rescan and re-arm schedules');
    assert.equal(routineRuntime.__shibaRoutinePoll, firstPoll,
      'a second routine-engine start reuses the poll timer');
    assert.equal(routineRuntime.__shibaRoutinePump, firstPump,
      'a second routine-engine start reuses the invocation pump');
    await routines.stopRoutineEngine();

    const taskLedger = await import('../lib/task-ledger');
    const startupReconcile = taskLedger.reconcileProcessingTaskCommandsAtStartup();
    assert.equal(taskLedger.reconcileProcessingTaskCommandsAtStartup(), startupReconcile,
      'instrumentation and boot share one startup task-command reconciliation');
    await startupReconcile;

    console.log('Automation guard verification passed');
  } finally {
    guards.releaseActiveRun('unique-run');
    db.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Automation guard verification failed', error);
  process.exitCode = 1;
});
