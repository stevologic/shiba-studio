import './verify-isolate';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type MockResponse = {
  choices: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: unknown;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  process.env.SHIBA_SECRET_KEY ||= '55'.repeat(32);

  const dbModule = await import('../lib/db');
  const ledger = await import('../lib/task-ledger');
  const runs = await import('../lib/agent-runs-store');
  const background = await import('../lib/background-tasks');
  const delivery = await import('../lib/task-delivery');
  const persistence = await import('../lib/persistence');
  const runtime = await import('../lib/agent-runtime');
  const maintenance = await import('../lib/automation-maintenance');
  const { normalizeAgent } = await import('../lib/types');
  const originalLocalGrokEnabled = (await persistence.loadConfig()).localGrokEnabled;

  try {
    const db = dbModule.getDb();
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, 12, 'background-work migrations should be current');
    const runColumns = new Set(
      (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((row) => row.name),
    );
    assert(runColumns.has('ownerId'));
    assert(runColumns.has('heartbeatAt'));
    const taskFtsTrigger = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tasks_fts_au'
    `).get() as { sql: string };
    assert.match(
      taskFtsTrigger.sql,
      /AFTER UPDATE OF title, description, result, error ON tasks/i,
      'task heartbeat/progress writes must not rebuild the FTS row',
    );
    const maintenanceIndexes = new Set(
      (db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_task_outbox_delivered',
          'idx_task_commands_recovery',
          'idx_tasks_queued_retry'
        )
      `).all() as Array<{ name: string }>).map((row) => row.name),
    );
    assert.deepEqual(maintenanceIndexes, new Set([
      'idx_task_outbox_delivered',
      'idx_task_commands_recovery',
      'idx_tasks_queued_retry',
    ]));

    // Recovery scans must tolerate a legacy/corrupt metadata payload. Keeping
    // JSON expressions out of the partial-index predicate also prevents one
    // malformed row from making the schema migration or later writes fail.
    const malformedQueued = ledger.createTask({
      id: 'malformed-queued-metadata',
      kind: 'work',
      title: 'Malformed queued metadata',
      originType: 'system',
      status: 'queued',
    });
    db.prepare("UPDATE tasks SET metadata = 'not-json' WHERE id = ?").run(malformedQueued.id);
    assert.equal(
      ledger.listQueuedRetryTasks().some((task) => task.id === malformedQueued.id),
      false,
      'invalid metadata without a retry intent should be ignored safely',
    );
    db.prepare('UPDATE tasks SET retryCount = 1 WHERE id = ?').run(malformedQueued.id);
    assert.equal(
      ledger.listQueuedRetryTasks().some((task) => task.id === malformedQueued.id),
      true,
      'the durable retry counter should still recover a task with invalid metadata',
    );
    db.prepare('DELETE FROM tasks WHERE id = ?').run(malformedQueued.id);

    // Removing a saved agent must not make its durable queued work execute
    // later under a synthetic agent with different credentials.
    ledger.createTask({
      id: 'deleted-agent-queued-task',
      kind: 'agent',
      title: 'Do not impersonate a deleted agent',
      description: 'This task must be made explicitly recoverable.',
      originType: 'system',
      status: 'queued',
      agentId: 'deleted-persisted-agent',
      metadata: { model: 'local:test' },
    });
    await assert.rejects(
      background.dispatchExistingTask('deleted-agent-queued-task'),
      /Assigned agent no longer exists/,
    );
    assert.equal(ledger.getTask('deleted-agent-queued-task')?.status, 'lost');
    assert.match(
      ledger.getTask('deleted-agent-queued-task')?.error || '',
      /assigned agent .* no longer exists/i,
    );

    const insertedOnlyTask = ledger.createTask({
      id: 'inserted-only-command-task',
      kind: 'work',
      title: 'Recover command insert gap',
      originType: 'system',
      status: 'running',
    });
    const insertedOnlyCommand = ledger.enqueueTaskCommand({
      taskId: insertedOnlyTask.id,
      kind: 'pause',
      expectedVersion: insertedOnlyTask.version,
      idempotencyKey: 'recover-inserted-only-command',
    });
    const insertedOnlyRecovery = await ledger.reconcileProcessingTaskCommands(0);
    assert(insertedOnlyRecovery.applied >= 1);
    assert.equal(ledger.getTask(insertedOnlyTask.id)?.status, 'paused');
    assert.equal(
      (db.prepare('SELECT status FROM task_commands WHERE id = ?').get(insertedOnlyCommand.id) as { status: string }).status,
      'applied',
      'a crash after command INSERT but before claim must self-heal',
    );

    // Canonical background state and links must stay scoped to the verified chat.
    const paused = ledger.createTask({
      id: 'background-paused',
      kind: 'work',
      title: 'Paused background task',
      description: 'Wait for user direction.',
      originType: 'chat',
      originId: 'session-a',
      sessionId: 'session-a',
      runId: 'background-paused-run',
      status: 'running',
      metadata: { agentName: 'Scoped Worker' },
    });
    ledger.transitionTask({ taskId: paused.id, status: 'paused', expectedVersion: paused.version });
    const pausedInfo = background.getBackgroundTask(paused.id, 'session-a');
    assert.equal(pausedInfo?.taskStatus, 'paused');
    assert.equal(pausedInfo?.status, 'paused', 'primary background status must be canonical');
    assert.equal(pausedInfo?.taskUrl, '/tasks/background-paused');
    assert.equal(pausedInfo?.runUrl, '/automations?run=background-paused-run');
    assert.equal(background.getBackgroundTask(paused.id, 'session-b'), null, 'one chat cannot inspect another chat task');
    const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    db.prepare('UPDATE tasks SET heartbeatAt = heartbeatAt WHERE id = ?').run(paused.id);
    const changesAfter = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    assert.equal(changesAfter - changesBefore, 1, 'a heartbeat-only task update must not write to FTS');

    // A deleted chat destination is terminal: durable task/Attention remains,
    // but its delivery row must not retry forever.
    const missingChat = ledger.createTask({
      id: 'missing-chat-delivery',
      kind: 'work',
      title: 'Finish after chat deletion',
      description: 'Delivery should be discarded safely.',
      originType: 'chat',
      originId: 'deleted-session',
      sessionId: 'deleted-session',
      status: 'running',
    });
    ledger.transitionTask({
      taskId: missingChat.id,
      status: 'succeeded',
      expectedVersion: missingChat.version,
      result: 'The background work still completed.',
    });
    await delivery.processTaskOutbox();
    const discarded = db.prepare(`
      SELECT status, attempts, lastError FROM task_outbox WHERE taskId = ?
    `).get(missingChat.id) as { status: string; attempts: number; lastError: string | null };
    assert.equal(discarded.status, 'delivered');
    assert.equal(discarded.attempts, 1);
    assert.equal(discarded.lastError, null);

    // A crash after task assignment but before the first run insert must not
    // leave work running forever. The lease grace period protects fresh starts.
    ledger.createTask({
      id: 'stale-start-task',
      kind: 'agent',
      title: 'Abandoned before run insert',
      runId: 'stale-start-missing-run',
      status: 'running',
    });
    ledger.createTask({
      id: 'fresh-start-task',
      kind: 'agent',
      title: 'Fresh worker startup',
      runId: 'fresh-start-missing-run',
      status: 'running',
    });
    const pausedStaleStart = ledger.createTask({
      id: 'paused-stale-start-task',
      kind: 'agent',
      title: 'Paused before run insert',
      runId: 'paused-stale-start-missing-run',
      status: 'running',
    });
    ledger.transitionTask({
      taskId: pausedStaleStart.id,
      status: 'paused',
      expectedVersion: pausedStaleStart.version,
    });
    const staleStartTime = new Date(Date.now() - runs.RUN_LEASE_TIMEOUT_MS - 5_000).toISOString();
    db.prepare('UPDATE tasks SET heartbeatAt = ?, updatedAt = ? WHERE id = ?')
      .run(staleStartTime, staleStartTime, 'stale-start-task');
    db.prepare('UPDATE tasks SET heartbeatAt = ?, updatedAt = ? WHERE id = ?')
      .run(staleStartTime, staleStartTime, pausedStaleStart.id);
    assert.deepEqual(
      new Set(await runs.reconcileStaleRunStarts()),
      new Set(['stale-start-task', pausedStaleStart.id]),
    );
    assert.equal(ledger.getTask('stale-start-task')?.status, 'lost');
    assert.equal(ledger.getTask(pausedStaleStart.id)?.status, 'lost');
    assert.equal(ledger.getTask('fresh-start-task')?.status, 'running');

    // Recent leases belong to a live process; only an expired lease is
    // reconciled, and only its exact paused/running task projection is lost.
    await runs.persistAgentRun({
      id: 'leased-run',
      taskId: 'leased-task',
      agentId: 'lease-agent',
      agentName: 'Lease Agent',
      model: 'local:test',
      status: 'running',
      prompt: 'Hold the lease.',
      startedAt: new Date().toISOString(),
      trace: [],
      sideEffects: [],
    });
    assert.deepEqual(runs.reconcileExpiredRunLeases(), { count: 0, runIds: [] });
    const leasedTask = ledger.getTask('leased-task')!;
    ledger.transitionTask({ taskId: leasedTask.id, status: 'paused', expectedVersion: leasedTask.version });
    db.prepare('UPDATE runs SET heartbeatAt = ? WHERE id = ?')
      .run(new Date(Date.now() - runs.RUN_LEASE_TIMEOUT_MS - 5_000).toISOString(), 'leased-run');
    const expired = runs.reconcileExpiredRunLeases();
    assert.deepEqual(expired, { count: 1, runIds: ['leased-run'] });
    await assert.rejects(runs.persistAgentRun({
      id: 'leased-run',
      taskId: 'leased-task',
      agentId: 'lease-agent',
      agentName: 'Lease Agent',
      model: 'local:test',
      status: 'completed',
      prompt: 'Hold the lease.',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date().toISOString(),
      finalOutput: 'A stale owner must not publish this completion.',
      trace: [],
      sideEffects: [],
    }), /lease ownership was lost/);
    assert.equal((await runs.getRun('leased-run'))?.status, 'error');
    const recoveredProjection = runs.reconcileExpiredRunLeases();
    assert.deepEqual(recoveredProjection, { count: 0, runIds: ['leased-run'] }, 'task projection survives a crash gap');
    assert.equal(ledger.reconcileOrphanedTasks(recoveredProjection.runIds), 1);
    assert.equal(ledger.getTask('leased-task')?.status, 'lost');
    assert.equal(ledger.getTask('background-paused')?.status, 'paused', 'unrelated paused work must survive');

    // A process can commit a terminal run and die before syncing its task.
    // Periodic reconciliation repairs both ordinary success and error rows.
    await runs.persistAgentRun({
      id: 'projection-completed-run',
      taskId: 'projection-completed-task',
      agentId: 'lease-agent',
      agentName: 'Lease Agent',
      model: 'local:test',
      status: 'running',
      prompt: 'Finish before task projection.',
      startedAt: new Date().toISOString(),
      trace: [],
      sideEffects: [],
    });
    await runs.persistAgentRun({
      id: 'projection-error-run',
      taskId: 'projection-error-task',
      agentId: 'lease-agent',
      agentName: 'Lease Agent',
      model: 'local:test',
      status: 'running',
      prompt: 'Fail before task projection.',
      startedAt: new Date().toISOString(),
      trace: [],
      sideEffects: [],
    });
    const projectionTime = new Date().toISOString();
    db.prepare(`
      UPDATE runs SET status = 'completed', completedAt = ?, finalOutput = ?, ownerId = NULL, heartbeatAt = NULL
      WHERE id = ?
    `).run(projectionTime, 'Durable completion survived the crash.', 'projection-completed-run');
    db.prepare(`
      UPDATE runs SET status = 'error', completedAt = ?, finalOutput = ?, ownerId = NULL, heartbeatAt = NULL
      WHERE id = ?
    `).run(projectionTime, 'Durable failure survived the crash.', 'projection-error-run');
    await runs.reconcileExpiredRunsAndTasks();
    assert.equal(ledger.getTask('projection-completed-task')?.status, 'succeeded');
    assert.equal(ledger.getTask('projection-completed-task')?.result, 'Durable completion survived the crash.');
    assert.equal(ledger.getTask('projection-error-task')?.status, 'failed');
    assert.equal(ledger.getTask('projection-error-task')?.error, 'Durable failure survived the crash.');

    // The run commit is authoritative even if task projection throws after it.
    // Missing active and terminal projections are both reconstructible.
    db.exec(`
      CREATE TRIGGER fail_forced_task_projection
      BEFORE INSERT ON tasks
      WHEN NEW.id IN ('forced-running-projection-task', 'forced-terminal-projection-task')
      BEGIN
        SELECT RAISE(ABORT, 'synthetic task projection failure');
      END;
    `);
    const projectionErrors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (String(args[0] || '').includes('task projection failed for forced-')) {
        projectionErrors.push(String(args[0]));
        return;
      }
      originalConsoleError(...args);
    };
    const forcedRunningStartedAt = new Date().toISOString();
    try {
      await runs.persistAgentRun({
        id: 'forced-running-projection-run',
        taskId: 'forced-running-projection-task',
        agentId: 'lease-agent',
        agentName: 'Lease Agent',
        model: 'local:test',
        status: 'running',
        prompt: 'Repair a missing active task projection.',
        startedAt: forcedRunningStartedAt,
        trace: [],
        sideEffects: [],
      });
      await runs.persistAgentRun({
        id: 'forced-terminal-projection-run',
        taskId: 'forced-terminal-projection-task',
        agentId: 'lease-agent',
        agentName: 'Lease Agent',
        model: 'local:test',
        status: 'completed',
        prompt: 'Repair a missing terminal task projection.',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        finalOutput: 'Terminal run commit remained authoritative.',
        trace: [],
        sideEffects: [],
      });
    } finally {
      console.error = originalConsoleError;
      db.exec('DROP TRIGGER IF EXISTS fail_forced_task_projection');
    }
    assert.equal(projectionErrors.length, 2);
    assert.equal(ledger.getTask('forced-running-projection-task'), null);
    assert.equal(ledger.getTask('forced-terminal-projection-task'), null);
    assert.equal(await runs.repairMissingActiveRunTaskProjections(), 1);
    assert.equal(await runs.repairTerminalRunTaskProjections(), 1);
    assert.equal(ledger.getTask('forced-running-projection-task')?.status, 'running');
    assert.equal(ledger.getTask('forced-terminal-projection-task')?.status, 'succeeded');
    await runs.persistAgentRun({
      id: 'forced-running-projection-run',
      taskId: 'forced-running-projection-task',
      agentId: 'lease-agent',
      agentName: 'Lease Agent',
      model: 'local:test',
      status: 'completed',
      prompt: 'Repair a missing active task projection.',
      startedAt: forcedRunningStartedAt,
      completedAt: new Date().toISOString(),
      finalOutput: 'Active projection repaired and completed.',
      trace: [],
      sideEffects: [],
    });

    await runs.persistAgentRun({
      id: 'stolen-run',
      taskId: 'stolen-task',
      agentId: 'lease-agent',
      agentName: 'Lease Agent',
      model: 'local:test',
      status: 'running',
      prompt: 'Another process will take this lease.',
      startedAt: new Date().toISOString(),
      trace: [],
      sideEffects: [],
    });
    db.prepare('UPDATE runs SET ownerId = ? WHERE id = ?').run('another-process', 'stolen-run');
    await assert.rejects(runs.persistAgentRun({
      id: 'stolen-run',
      taskId: 'stolen-task',
      agentId: 'lease-agent',
      agentName: 'Lease Agent',
      model: 'local:test',
      status: 'completed',
      prompt: 'Another process will take this lease.',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      finalOutput: 'Stale completion.',
      trace: [],
      sideEffects: [],
    }), /lease ownership was lost/);
    assert.equal((await runs.getRun('stolen-run'))?.status, 'running');
    db.prepare('UPDATE runs SET heartbeatAt = ? WHERE id = ?')
      .run(new Date(Date.now() - runs.RUN_LEASE_TIMEOUT_MS - 5_000).toISOString(), 'stolen-run');
    const stolenExpired = runs.reconcileExpiredRunLeases();
    ledger.reconcileOrphanedTasks(stolenExpired.runIds);

    const workspace = path.join(process.env.SHIBA_DATA_DIR!, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const agent = normalizeAgent({
      id: 'background-runtime-agent',
      name: 'Background Runtime Agent',
      model: 'local:test',
      workspace: { path: workspace, useWorktree: false },
      integrations: {},
      peers: [],
      skills: [],
      schedules: [],
      learning: { mode: 'off', autoRecall: false, maxMemories: 20 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const lateWorker = await runtime.runAgentOnce(agent, 'This stale worker must not execute.', {
      runId: 'stale-start-missing-run',
      taskId: 'stale-start-task',
      grokChatFn: async (): Promise<MockResponse> => {
        throw new Error('a worker whose task is already lost must not call the model');
      },
    });
    assert.equal(lateWorker.status, 'error');
    assert.match(lateWorker.finalOutput || '', /already lost; refusing to start a late worker/);
    assert.equal(ledger.getTask('stale-start-task')?.status, 'lost');

    const releaseMaintenance = maintenance.beginAutomationMaintenance('verification restore');
    try {
      await assert.rejects(runtime.runAgentOnce(agent, 'Must not start during restore.', {
        runId: 'maintenance-run',
        taskId: 'maintenance-task',
      }), /temporarily paused for maintenance/);
      assert.throws(() => background.startBackgroundTask({
        prompt: 'Must not dispatch during restore.',
        sessionId: 'session-a',
        agent,
        model: agent.model,
      }), /temporarily paused for maintenance/);
      assert.equal(await runs.getRun('maintenance-run'), null);
      assert.equal(ledger.getTask('maintenance-task'), null);
      assert.equal(await delivery.processTaskOutbox(), 0);
      assert.deepEqual(runs.reconcileExpiredRunLeases(), { count: 0, runIds: [] });
    } finally {
      releaseMaintenance();
    }

    // Guard refusals are terminal records with the real reason, not generic
    // "Agent run failed" projections.
    await persistence.saveConfig({ localGrokEnabled: false });
    const refused = await runtime.runAgentOnce(agent, 'This should be refused before model spend.', {
      runId: 'guard-refusal-run',
      taskId: 'guard-refusal-task',
    });
    assert.equal(refused.status, 'error');
    assert(refused.completedAt);
    assert.match(refused.finalOutput || '', /Local Grok is disabled/);
    assert.match(ledger.getTask('guard-refusal-task')?.error || '', /Local Grok is disabled/);

    await persistence.saveConfig({ localGrokEnabled: true });

    // Config/auth/integration preflight used to happen before the durable run
    // existed. Even an early failure must finalize the announced identity.
    const preflightAgent = normalizeAgent({ ...agent, id: 'preflight-failure-agent' });
    Object.defineProperty(preflightAgent, 'integrationOverrides', {
      configurable: true,
      get() { throw new Error('Synthetic integration preflight failure.'); },
    });
    const preflightFailure = await runtime.runAgentOnce(preflightAgent, 'Fail during early preflight.', {
      runId: 'preflight-failure-run',
      taskId: 'preflight-failure-task',
      grokChatFn: async (): Promise<MockResponse> => {
        throw new Error('model must not run after preflight failure');
      },
    });
    assert.equal(preflightFailure.status, 'error');
    assert.equal(preflightFailure.finalOutput, 'Synthetic integration preflight failure.');
    assert.equal((await runs.getRun('preflight-failure-run'))?.status, 'error');
    assert.equal(ledger.getTask('preflight-failure-task')?.status, 'failed');

    // Setup failures after the running row is created must be finalized
    // immediately, rather than waiting for the lease reconciler.
    const mcpFile = path.join(process.env.SHIBA_DATA_DIR!, 'mcp-servers.json');
    const previousMcp = await fs.readFile(mcpFile, 'utf8').catch(() => null);
    await fs.writeFile(mcpFile, '{not-json');
    let setupFailure: Awaited<ReturnType<typeof runtime.runAgentOnce>> | null = null;
    try {
      setupFailure = await runtime.runAgentOnce(agent, 'Fail during MCP setup.', {
        runId: 'setup-failure-run',
        taskId: 'setup-failure-task',
        grokChatFn: async (): Promise<MockResponse> => {
          throw new Error('model must not run after setup failure');
        },
      });
    } finally {
      if (previousMcp == null) await fs.rm(mcpFile, { force: true });
      else await fs.writeFile(mcpFile, previousMcp);
    }
    assert(setupFailure);
    assert.equal(setupFailure.status, 'error');
    assert.match(setupFailure.finalOutput || '', /JSON|Unexpected|position/i);
    assert.equal((await runs.getRun('setup-failure-run'))?.status, 'error');
    assert.equal(ledger.getTask('setup-failure-task')?.status, 'failed');

    // A pre-announced exact id can be cancelled before the generator has
    // registered its controller/task, and the durable task remains cancelled
    // after the final error-shaped AgentRun projection lands.
    const [cancelModule, { NextRequest }] = await Promise.all([
      import('../app/api/execute/cancel/route'),
      import('next/server'),
    ]);
    const cancelRun = cancelModule.POST;
    const racedCancellationTask = ledger.createTask({
      id: 'cancel-version-race-task',
      kind: 'agent',
      title: 'Cancel through a stale version',
      runId: 'cancel-version-race-run',
      status: 'running',
    });
    ledger.heartbeatTask(racedCancellationTask.id, { currentStep: 'Concurrent heartbeat won first' });
    const racedProjection = cancelModule.projectRunCancellation(
      'cancel-version-race-run',
      racedCancellationTask,
    );
    assert.equal(racedProjection.status, 'cancelled');
    assert.equal(ledger.getTask(racedCancellationTask.id)?.status, 'cancelled');
    const racedCompletionTask = ledger.createTask({
      id: 'cancel-completion-race-task',
      kind: 'agent',
      title: 'Complete during cancellation',
      runId: 'cancel-completion-race-run',
      status: 'running',
    });
    ledger.transitionTask({
      taskId: racedCompletionTask.id,
      status: 'succeeded',
      expectedVersion: racedCompletionTask.version,
      result: 'Completed before cancellation committed.',
    });
    const completedProjection = cancelModule.projectRunCancellation(
      'cancel-completion-race-run',
      racedCompletionTask,
    );
    assert.equal(completedProjection.status, 'finished');
    if (completedProjection.status === 'finished') assert.equal(completedProjection.task.status, 'succeeded');
    const unknownCancel = await cancelRun(new NextRequest('http://localhost/api/execute/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'unknown-run-id' }),
    }));
    assert.equal(unknownCancel.status, 404);
    assert.equal(runtime.isRunCancelRequested('unknown-run-id'), false, 'unknown ids must not be retained');
    const finishedCancel = await cancelRun(new NextRequest('http://localhost/api/execute/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'cancel-completion-race-run' }),
    }));
    assert.equal(finishedCancel.status, 409);

    runtime.reserveRunStart('pre-cancelled-run');
    const cancelResponse = await cancelRun(new NextRequest('http://localhost/api/execute/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'pre-cancelled-run' }),
    }));
    assert.equal(cancelResponse.status, 200);
    assert.equal((await cancelResponse.json()).status, 'cancellation_requested');
    const preCancelled = await runtime.runAgentOnce(agent, 'Do not begin this work.', {
      runId: 'pre-cancelled-run',
      taskId: 'pre-cancelled-task',
      grokChatFn: async (): Promise<MockResponse> => {
        throw new Error('cancelled run must not call the model');
      },
    });
    assert.equal(preCancelled.status, 'error');
    assert.equal(preCancelled.finalOutput, 'Run cancelled by the user.');
    assert.equal(ledger.getTask('pre-cancelled-task')?.status, 'cancelled');
    assert.equal(runtime.isRunStartReserved('pre-cancelled-run'), false);

    // Caller time budgets and disconnect signals are interruptions, not an
    // explicit user cancel. Preserve the AbortSignal reason and fail the task.
    const timeoutController = new AbortController();
    let timeoutModelStarted!: () => void;
    const timeoutStarted = new Promise<void>((resolve) => { timeoutModelStarted = resolve; });
    const timedOutPromise = runtime.runAgentOnce(agent, 'Wait until the routine time budget expires.', {
      runId: 'external-timeout-run',
      taskId: 'external-timeout-task',
      signal: timeoutController.signal,
      grokChatFn: async ({ signal }): Promise<MockResponse> => {
        timeoutModelStarted();
        return new Promise<MockResponse>((_resolve, reject) => {
          const fail = () => reject(signal?.reason || new Error('Model request interrupted.'));
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail, { once: true });
        });
      },
    });
    await timeoutStarted;
    timeoutController.abort(new Error('Routine execution time budget expired.'));
    const timedOut = await timedOutPromise;
    assert.equal(timedOut.status, 'error');
    assert.equal(timedOut.finalOutput, 'Routine execution time budget expired.');
    assert.equal(ledger.getTask('external-timeout-task')?.status, 'failed');
    assert.equal(ledger.getTask('external-timeout-task')?.error, 'Routine execution time budget expired.');

    const capped = await runtime.runAgentOnce(agent, 'Stop at the exact token cap.', {
      runId: 'token-cap-run',
      taskId: 'token-cap-task',
      tokenCap: 1,
      grokChatFn: async (): Promise<MockResponse> => ({
        choices: [{
          message: { role: 'assistant', content: 'This response exceeds the cap.' },
          finish_reason: 'stop',
        }],
        usage: { total_tokens: 5 },
      }),
    });
    assert.equal(capped.status, 'error');
    assert.match(capped.finalOutput || '', /Per-run token cap reached \(5 of 1 tokens\)/);
    assert.match(ledger.getTask('token-cap-task')?.error || '', /Per-run token cap reached \(5 of 1 tokens\)/);

    // Persist trace progress while the second model turn is deliberately held.
    let modelCalls = 0;
    let secondTurnStarted!: () => void;
    const secondTurn = new Promise<void>((resolve) => { secondTurnStarted = resolve; });
    let releaseSecondTurn!: () => void;
    const release = new Promise<void>((resolve) => { releaseSecondTurn = resolve; });
    const runningPromise = runtime.runAgentOnce(agent, 'Inspect the workspace, then summarize.', {
      runId: 'trace-progress-run',
      taskId: 'trace-progress-task',
      grokChatFn: async (): Promise<MockResponse> => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: 'Inspecting the workspace.',
                tool_calls: [{
                  id: 'list-workspace',
                  type: 'function',
                  function: { name: 'fs_list', arguments: JSON.stringify({ dir: '.' }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          };
        }
        secondTurnStarted();
        await release;
        return {
          choices: [{
            message: { role: 'assistant', content: 'Workspace inspection completed.' },
            finish_reason: 'stop',
          }],
        };
      },
    });
    await secondTurn;
    await wait(900);
    const midRun = await runs.getRun('trace-progress-run');
    assert.equal(midRun?.status, 'running');
    assert((midRun?.trace.length || 0) >= 3, 'in-flight tool trace should be durable before completion');
    releaseSecondTurn();
    assert.equal((await runningPromise).status, 'completed');

    // Pause/resume/steer commands are durable and may be applied by a route in
    // another process. Runtime boundaries must claim and acknowledge them.
    const locallyAppliedControlIds = new Set<string>();
    let reclaimedSteerApplications = 0;
    assert.equal(runtime.durableRunControlTestHooks.applyRunControlOnce(
      locallyAppliedControlIds,
      'reclaimed-steer-control',
      () => { reclaimedSteerApplications += 1; },
    ), true);
    // Model an acknowledgement failure followed by reclaim in the same live
    // worker: the durable ack is retried, but the user instruction is not.
    assert.equal(runtime.durableRunControlTestHooks.applyRunControlOnce(
      locallyAppliedControlIds,
      'reclaimed-steer-control',
      () => { reclaimedSteerApplications += 1; },
    ), false);
    assert.equal(reclaimedSteerApplications, 1);
    let controlModelCalls = 0;
    let firstControlTurnStarted!: () => void;
    const firstControlTurn = new Promise<void>((resolve) => { firstControlTurnStarted = resolve; });
    let releaseFirstControlTurn!: () => void;
    const releaseControlTurn = new Promise<void>((resolve) => { releaseFirstControlTurn = resolve; });
    let steeringObserved = false;
    const controlledPromise = runtime.runAgentOnce(agent, 'Inspect, then follow revised direction.', {
      runId: 'durable-control-run',
      taskId: 'durable-control-task',
      grokChatFn: async ({ messages }): Promise<MockResponse> => {
        controlModelCalls += 1;
        if (controlModelCalls === 1) {
          firstControlTurnStarted();
          await releaseControlTurn;
          return {
            choices: [{
              message: {
                role: 'assistant',
                content: 'I will inspect the workspace first.',
                tool_calls: [{
                  id: 'durable-control-list',
                  type: 'function',
                  function: { name: 'fs_list', arguments: JSON.stringify({ dir: '.' }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          };
        }
        steeringObserved = messages.some((message) =>
          typeof message.content === 'string'
          && message.content.includes('Use the revised acceptance criterion.'),
        );
        return {
          choices: [{
            message: { role: 'assistant', content: 'Applied the revised acceptance criterion.' },
            finish_reason: 'stop',
          }],
        };
      },
    });
    await firstControlTurn;
    let controlledTask = ledger.getTask('durable-control-task')!;
    const pauseCommand = ledger.enqueueTaskCommand({
      taskId: controlledTask.id,
      kind: 'pause',
      idempotencyKey: 'durable-control-pause',
      expectedVersion: controlledTask.version,
    });
    ledger.applyTaskCommand(pauseCommand.id);
    releaseFirstControlTurn();
    await wait(200);
    assert.equal(controlModelCalls, 1, 'the runtime must remain paused at the post-model boundary');
    controlledTask = ledger.getTask('durable-control-task')!;
    const steerCommand = ledger.enqueueTaskCommand({
      taskId: controlledTask.id,
      kind: 'steer',
      payload: { instruction: 'Use the revised acceptance criterion.' },
      idempotencyKey: 'durable-control-steer',
      expectedVersion: controlledTask.version,
    });
    ledger.applyTaskCommand(steerCommand.id);
    controlledTask = ledger.getTask('durable-control-task')!;
    const resumeCommand = ledger.enqueueTaskCommand({
      taskId: controlledTask.id,
      kind: 'resume',
      idempotencyKey: 'durable-control-resume',
      expectedVersion: controlledTask.version,
    });
    ledger.applyTaskCommand(resumeCommand.id);
    const controlled = await controlledPromise;
    assert.equal(controlled.status, 'completed');
    assert.equal(steeringObserved, true);
    const acknowledgedControls = db.prepare(`
      SELECT kind, status FROM task_run_controls WHERE runId = ? ORDER BY createdAt ASC
    `).all('durable-control-run') as Array<{ kind: string; status: string }>;
    assert.deepEqual(
      acknowledgedControls.map((row) => [row.kind, row.status]),
      [['pause', 'acknowledged'], ['steer', 'acknowledged'], ['resume', 'acknowledged']],
    );

    // Durable cancel signals use the same consumer, but explicit cancellation
    // remains distinct from an external timeout.
    let cancelModelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { cancelModelStarted = resolve; });
    let releaseCancelModel!: () => void;
    const releaseCancel = new Promise<void>((resolve) => { releaseCancelModel = resolve; });
    const durableCancelPromise = runtime.runAgentOnce(agent, 'Wait for an explicit durable cancel.', {
      runId: 'durable-cancel-run',
      taskId: 'durable-cancel-task',
      grokChatFn: async (): Promise<MockResponse> => {
        cancelModelStarted();
        await releaseCancel;
        return {
          choices: [{
            message: { role: 'assistant', content: 'This result must be cancelled.' },
            finish_reason: 'stop',
          }],
        };
      },
    });
    await cancelStarted;
    const durableCancelTask = ledger.getTask('durable-cancel-task')!;
    const durableCancelCommand = ledger.enqueueTaskCommand({
      taskId: durableCancelTask.id,
      kind: 'cancel',
      idempotencyKey: 'durable-control-cancel',
      expectedVersion: durableCancelTask.version,
    });
    ledger.applyTaskCommand(durableCancelCommand.id);
    releaseCancelModel();
    const durableCancelled = await durableCancelPromise;
    assert.equal(durableCancelled.status, 'error');
    assert.equal(durableCancelled.finalOutput, 'Run cancelled by the user.');
    assert.equal(ledger.getTask('durable-cancel-task')?.status, 'cancelled');
    assert.equal(
      (db.prepare('SELECT status FROM task_run_controls WHERE runId = ? AND kind = ?')
        .get('durable-cancel-run', 'cancel') as { status: string }).status,
      'acknowledged',
    );

    // Delivery receipts are operational bookkeeping, unlike commands/events.
    // Prune only old acknowledged/delivered rows in bounded batches.
    const oldReceiptTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString();
    db.prepare(`
      UPDATE task_run_controls SET acknowledgedAt = ?
      WHERE runId = ? AND kind = 'pause' AND status = 'acknowledged'
    `).run(oldReceiptTime, 'durable-control-run');
    db.prepare(`
      UPDATE task_run_controls
      SET status = 'pending', acknowledgedAt = ?, consumerId = NULL, leaseUntil = NULL
      WHERE runId = ? AND kind = 'steer'
    `).run(oldReceiptTime, 'durable-control-run');
    db.prepare('UPDATE task_outbox SET deliveredAt = ? WHERE taskId = ? AND status = ?')
      .run(oldReceiptTime, 'missing-chat-delivery', 'delivered');
    const pendingOutbox = db.prepare(`
      SELECT id FROM task_outbox WHERE status IN ('pending', 'failed', 'processing') LIMIT 1
    `).get() as { id: string } | undefined;
    if (pendingOutbox) {
      db.prepare('UPDATE task_outbox SET deliveredAt = ? WHERE id = ?').run(oldReceiptTime, pendingOutbox.id);
    }
    const commandCountBeforeRetention = (db.prepare(`
      SELECT COUNT(*) AS n FROM task_commands WHERE taskId = ?
    `).get('durable-control-task') as { n: number }).n;
    const eventCountBeforeRetention = (db.prepare(`
      SELECT COUNT(*) AS n FROM task_events WHERE taskId = ?
    `).get('durable-control-task') as { n: number }).n;
    const receiptCleanup = ledger.pruneTaskDeliveryReceipts({
      nowMs: Date.now(),
      olderThanMs: 30 * 24 * 60 * 60 * 1_000,
      limit: 100,
    });
    assert.equal(receiptCleanup.acknowledgedRunControls, 1);
    assert.equal(receiptCleanup.deliveredOutbox, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM task_run_controls WHERE runId = ? AND kind = 'pause'")
        .get('durable-control-run') as { n: number }).n,
      0,
    );
    assert.equal(
      (db.prepare("SELECT status FROM task_run_controls WHERE runId = ? AND kind = 'steer'")
        .get('durable-control-run') as { status: string }).status,
      'pending',
    );
    assert.equal(
      (db.prepare("SELECT status FROM task_run_controls WHERE runId = ? AND kind = 'resume'")
        .get('durable-control-run') as { status: string }).status,
      'acknowledged',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM task_outbox WHERE taskId = ?')
        .get('missing-chat-delivery') as { n: number }).n,
      0,
    );
    if (pendingOutbox) {
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS n FROM task_outbox WHERE id = ?').get(pendingOutbox.id) as { n: number }).n,
        1,
      );
    }
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM task_commands WHERE taskId = ?')
        .get('durable-control-task') as { n: number }).n,
      commandCountBeforeRetention,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE taskId = ?')
        .get('durable-control-task') as { n: number }).n,
      eventCountBeforeRetention,
    );
    const controlRetentionIndex = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_run_controls_acknowledged'
    `).get() as { name: string } | undefined;
    assert.equal(controlRetentionIndex?.name, 'idx_task_run_controls_acknowledged');

    // Worktree fallback is a recoverable warning and cannot poison success.
    const fallbackAgent = normalizeAgent({
      ...agent,
      id: '../invalid-worktree-agent',
      workspace: { path: workspace, useWorktree: true },
    });
    const fallback = await runtime.runAgentOnce(fallbackAgent, 'Return a short final answer.', {
      runId: 'worktree-fallback-run',
      taskId: 'worktree-fallback-task',
      grokChatFn: async (): Promise<MockResponse> => ({
        choices: [{
          message: { role: 'assistant', content: 'Completed using the base workspace.' },
          finish_reason: 'stop',
        }],
      }),
    });
    assert.equal(fallback.status, 'completed');
    assert(fallback.trace.some((step) => step.type === 'think' && step.content.includes('Using base workspace')));
    assert(!fallback.trace.some((step) => step.type === 'error'));

    // The streaming/UI protocol exposes and consumes the exact id, with no
    // fallback to whichever unrelated global run happens to be first.
    const [streamSource, uiSource, grokSource, dbSource] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'app/api/execute/stream/route.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'components/shiba-studio.tsx'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'app/api/grok/stream/route.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'lib/db.ts'), 'utf8'),
    ]);
    assert.match(streamSource, /type: 'run_started', runId/);
    assert.match(streamSource, /runId,/);
    assert.match(uiSource, /event\.type === 'run_started'/);
    assert.doesNotMatch(uiSource, /runId = runs\.find\(\(r\) => r\.status === 'running'\)/);
    assert.doesNotMatch(uiSource, /\|\| runs\.find\(\(r\) => r\.status === 'running' && !r\.scheduleId\)/);
    assert.match(grokSource, /const backgroundSessionId = requestChatSession && !ephemeralSession/);
    assert.match(grokSource, /getBackgroundTask\(id, backgroundSessionId\)/);
    assert.match(dbSource, /globalThis[\s\S]*__shibaDbState/);
    assert.match(dbSource, /dbState\.handle = candidate/);

    // The process-wide restore fence is token-owned and remains closed until
    // its exact owner releases it; stale/idempotent releases cannot reopen it.
    const releaseFirstDbMaintenance = dbModule.beginDbMaintenance();
    assert.throws(() => dbModule.getDb(), /maintenance in progress/);
    releaseFirstDbMaintenance();
    const releaseSecondDbMaintenance = dbModule.beginDbMaintenance();
    releaseFirstDbMaintenance();
    assert.throws(() => dbModule.getDb(), /maintenance in progress/);
    releaseSecondDbMaintenance();
    dbModule.getDb();

    console.log('background work verification passed');
  } finally {
    await persistence.saveConfig({ localGrokEnabled: originalLocalGrokEnabled }).catch(() => {});
    await ledger.stopTaskCommandReconciler();
    await runs.stopRunLeaseReconciler();
    await delivery.stopTaskDeliveryPump();
    dbModule.closeDb();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
