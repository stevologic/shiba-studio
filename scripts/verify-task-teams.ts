import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-teams-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '88'.repeat(32);
  const workspace = path.join(root, 'repo');
  await fs.mkdir(workspace, { recursive: true });
  const persistence = await import('../lib/persistence');
  const { EMPTY_INTEGRATION_SCOPE } = await import('../lib/types');
  const ledger = await import('../lib/task-ledger');
  const teams = await import('../lib/task-teams');
  const background = await import('../lib/background-tasks');
  const runGuards = await import('../lib/run-guards');
  const policy = await import('../lib/task-workspace-policy');
  const { executeAgentTool } = await import('../lib/agent-tool-exec');
  const { closeDb, getDb } = await import('../lib/db');
  try {
    await persistence.saveAgents([{
      id: 'worker-agent',
      name: 'Worker',
      model: 'cloud:grok-4',
      description: '',
      workspace: { path: workspace, useWorktree: true },
      integrations: { ...EMPTY_INTEGRATION_SCOPE }, peers: [], skills: [], schedules: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]);
    const parent = ledger.createTask({
      id: 'team-parent', kind: 'code', title: 'Parallel initiative', status: 'queued',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'write' }],
    });
    const graph = await teams.createTaskTeam(parent.id, [
      { key: 'research', title: 'Research', instructions: 'Inspect the design.', agentId: 'worker-agent', workspaceRootIds: ['repo'], readOnly: true },
      { key: 'implement', title: 'Implement', instructions: 'Apply the change.', agentId: 'worker-agent', workspaceRootIds: ['repo'], dependsOn: ['research'] },
    ]);
    assert.equal(graph.length, 2);
    const research = graph.find((node) => node.key === 'research')!;
    const implement = graph.find((node) => node.key === 'implement')!;
    assert.equal(research.task.workspaceRoots[0].permission, 'read');
    assert.deepEqual(implement.dependencies, [research.task.id]);
    assert.equal(ledger.getTask(parent.id)?.status, 'running');
    assert.equal(ledger.evaluateTaskCompletion(parent.id, false).complete, false, 'required unfinished children block parent completion');
    for (const node of [research, implement]) {
      let child = ledger.transitionTask({ taskId: node.task.id, status: 'running' });
      ledger.recordTaskEvidence({ taskId: child.id, kind: 'assertion', status: 'passed', label: 'Worker result', summary: 'Verified worker output.' });
      child = ledger.getTask(child.id)!;
      ledger.transitionTask({ taskId: child.id, status: 'succeeded', expectedVersion: child.version, result: 'Done' });
    }
    assert.equal(ledger.evaluateTaskCompletion(parent.id, false).complete, true);

    const scopedParent = ledger.createTask({
      id: 'scoped-team-parent', kind: 'code', title: 'Scoped workers', status: 'queued',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'write' }],
    });
    const scopedGraph = await teams.createTaskTeam(scopedParent.id, [{
      key: 'scoped-research', title: 'Scoped research', instructions: 'Read only.', agentId: 'worker-agent',
      workspaceRootIds: ['repo'], readOnly: true, required: false,
      integrationScopes: ['github'], allowedTools: ['fs_read', 'github_list_repos', 'slack_post'],
    }, {
      key: 'required-work', title: 'Required work', instructions: 'Finish.', agentId: 'worker-agent',
      workspaceRootIds: ['repo'], required: true,
    }]);
    const scopedResearch = scopedGraph.find((node) => node.key === 'scoped-research')!;
    const requiredWork = scopedGraph.find((node) => node.key === 'required-work')!;
    assert.equal(policy.taskToolDecision(scopedResearch.task.id, 'github_list_repos').allowed, true);
    assert.match(policy.taskToolDecision(scopedResearch.task.id, 'slack_post').reason || '', /integration scope/);
    assert.match(policy.taskToolDecision(scopedResearch.task.id, 'fs_search').reason || '', /allowedTools/);
    assert.match(policy.taskToolDecision(scopedResearch.task.id, 'shell_exec').reason || '', /Read-only tasks/);
    const scopedSlack = await executeAgentTool('slack_post', { channel: 'test', text: 'no' }, (await persistence.loadAgents())[0], { taskId: scopedResearch.task.id }, workspace);
    assert.equal((scopedSlack.result as { denied?: boolean }).denied, true, 'executor rechecks worker integration scopes at dispatch');

    ledger.transitionTask({ taskId: scopedResearch.task.id, status: 'running' });
    ledger.transitionTask({ taskId: scopedResearch.task.id, status: 'failed', error: 'Optional source unavailable.' });
    ledger.transitionTask({ taskId: requiredWork.task.id, status: 'running' });
    ledger.recordTaskEvidence({ taskId: requiredWork.task.id, kind: 'assertion', status: 'passed', label: 'Required result', summary: 'Required worker passed.' });
    ledger.transitionTask({ taskId: requiredWork.task.id, status: 'succeeded', result: 'Done' });
    await teams.dispatchReadyTeamWorkers(scopedParent.id);
    assert.equal(ledger.getTask(scopedParent.id)?.status, 'succeeded', 'an optional worker failure does not fail the parent');

    const fixtureAgent = (await persistence.loadAgents())[0];
    const insideFile = path.join(workspace, 'inside.txt');
    const outsideFile = path.join(root, 'outside-secret.txt');
    await fs.writeFile(insideFile, 'inside');
    await fs.writeFile(outsideFile, 'outside');
    const readTask = ledger.createTask({
      id: 'read-boundary-task', kind: 'work', title: 'Read boundary', status: 'running',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'read' }], metadata: { readOnly: true },
    });
    const validRead = await executeAgentTool('fs_read', { path: 'inside.txt' }, fixtureAgent, { taskId: readTask.id }, workspace);
    assert.equal(validRead.result, 'inside', 'in-root reads remain available');
    for (const [tool, args] of [
      ['fs_read', { path: outsideFile }],
      ['fs_list', { dir: root }],
      ['fs_search', { dir: root, pattern: 'outside' }],
      ['fs_write', { path: 'blocked.txt', content: 'no' }],
    ] as const) {
      const denied = await executeAgentTool(tool, args, fixtureAgent, { taskId: readTask.id }, workspace);
      assert.equal((denied.result as { denied?: boolean; error?: string }).denied === true || /denied|outside/i.test(String((denied.result as { error?: string }).error)), true,
        `${tool} rejects access beyond the task grant`);
    }
    const readShell = await executeAgentTool('shell_exec', { command: 'npm --version' }, fixtureAgent, { taskId: readTask.id }, workspace, undefined, undefined, undefined, { liveTaskShellApproval: true });
    assert.equal((readShell.result as { denied?: boolean }).denied, true, 'read-only workers cannot use host shell even with a forged approval flag');

    const writerTask = ledger.createTask({
      id: 'writer-boundary-task', kind: 'code', title: 'Writer boundary', status: 'running',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'write' }],
    });
    const unapprovedShell = await executeAgentTool('shell_exec', { command: 'npm --version' }, fixtureAgent, { taskId: writerTask.id }, workspace);
    assert.equal((unapprovedShell.result as { denied?: boolean }).denied, true, 'writer shell cannot bypass exact live approval');
    const escapedShell = await executeAgentTool('shell_exec', { command: `git status "${outsideFile}"` }, fixtureAgent, { taskId: writerTask.id }, workspace, undefined, undefined, undefined, { liveTaskShellApproval: true });
    assert.match(String((escapedShell.result as { error?: string }).error), /absolute|parent|home/i);
    const sharedTerminal = await executeAgentTool('terminal_exec', { command: 'npm --version' }, fixtureAgent, { taskId: writerTask.id }, workspace);
    assert.equal((sharedTerminal.result as { denied?: boolean }).denied, true, 'shared terminal cannot bypass task cwd containment');
    const approvedShell = await executeAgentTool('shell_exec', { command: 'npm --version' }, fixtureAgent, { id: 'writer-run', taskId: writerTask.id }, workspace, undefined, undefined, undefined, { liveTaskShellApproval: true });
    assert.equal((approvedShell.result as { code?: number }).code, 0, 'approved contained verification commands remain available');
    assert.equal(ledger.getTaskDetails(writerTask.id)?.evidence.some((item) => item.metadata.checkpointId), false,
      'a read-only shell command does not invent diff evidence');
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
      scripts: { 'touch-source': 'node write-test.js' },
    }));
    await fs.writeFile(path.join(workspace, 'write-test.js'), "require('node:fs').writeFileSync('shell-created.txt', 'checkpointed')\n");
    const mutatingShell = await executeAgentTool('shell_exec', { command: 'npm run touch-source' }, fixtureAgent, { id: 'writer-run', taskId: writerTask.id }, workspace, undefined, undefined, undefined, { liveTaskShellApproval: true });
    assert.equal((mutatingShell.result as { code?: number }).code, 0);
    const shellDiff = ledger.getTaskDetails(writerTask.id)?.evidence.find((item) => item.metadata.checkpointId);
    assert(shellDiff, 'approved shell mutations emit checkpoint-linked diff evidence');
    const { listTaskCheckpoints } = await import('../lib/task-checkpoints');
    const shellCheckpoint = listTaskCheckpoints(writerTask.id).find((item) => item.id === shellDiff.metadata.checkpointId);
    const createdFile = shellCheckpoint?.files.find((file) => file.relativePath === 'shell-created.txt');
    assert.equal(createdFile?.beforeExists, false, 'new shell-created files are rewindable to absent');
    assert.equal(createdFile?.afterExists, true, 'new shell-created files are sealed after execution');

    const hardlinkPath = path.join(workspace, 'outside-hardlink.txt');
    await fs.link(outsideFile, hardlinkPath);
    const hardlinkWrite = await executeAgentTool('fs_write', { path: 'outside-hardlink.txt', content: 'blocked' }, fixtureAgent, { taskId: writerTask.id }, workspace);
    assert.match(String((hardlinkWrite.result as { error?: string }).error), /multiply-linked/i, 'hardlink writes cannot mutate an out-of-root inode');
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside');

    const outsideDir = path.join(root, 'outside-dir');
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret');
    const linkPath = path.join(workspace, 'outside-link');
    try {
      await fs.symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      const symlinkRead = await executeAgentTool('fs_list', { dir: 'outside-link' }, fixtureAgent, { taskId: readTask.id }, workspace);
      assert.match(String((symlinkRead.result as { error?: string }).error), /outside|symbolic/i, 'symlink traversal is denied');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await assert.rejects(teams.createTaskTeam(parent.id, [
      { key: 'a', title: 'A', instructions: 'A', agentId: 'worker-agent', workspaceRootIds: ['repo'], dependsOn: ['b'] },
      { key: 'b', title: 'B', instructions: 'B', agentId: 'worker-agent', workspaceRootIds: ['repo'], dependsOn: ['a'] },
    ]), /cycle/);

    const atomicTeamParent = ledger.createTask({
      id: 'atomic-team-parent', kind: 'code', title: 'Atomic team creation', status: 'queued',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'write' }],
    });
    await assert.rejects(teams.createTaskTeam(atomicTeamParent.id, [
      { key: 'valid-first', title: 'Valid first', instructions: 'Would otherwise persist.', agentId: 'worker-agent', workspaceRootIds: ['repo'] },
      { key: 'invalid-later', title: 'Invalid later', instructions: 'Invalid grant.', agentId: 'missing-agent', workspaceRootIds: ['repo'] },
    ]), /agent not found/);
    assert.equal(ledger.getTaskDetails(atomicTeamParent.id)?.children.length, 0,
      'a later invalid worker grant must not leave earlier child tasks behind');
    await assert.rejects(teams.createTaskTeam(atomicTeamParent.id, [
      { key: 'valid-root-first', title: 'Valid root first', instructions: 'Would otherwise persist.', agentId: 'worker-agent', workspaceRootIds: ['repo'] },
      { key: 'invalid-root-later', title: 'Invalid root later', instructions: 'Invalid root grant.', agentId: 'worker-agent', workspaceRootIds: ['missing-root'] },
    ]), /unknown workspace root/);
    assert.equal(ledger.getTaskDetails(atomicTeamParent.id)?.children.length, 0,
      'a later invalid workspace grant must not leave earlier child tasks behind');
    getDb().exec(`
      CREATE TRIGGER fail_second_team_child BEFORE INSERT ON tasks
      WHEN NEW.parentId = 'atomic-team-parent' AND NEW.title = 'Fail second insert'
      BEGIN SELECT RAISE(ABORT, 'forced team insert failure'); END
    `);
    try {
      await assert.rejects(teams.createTaskTeam(atomicTeamParent.id, [
        { key: 'first-insert', title: 'First insert', instructions: 'Must roll back.', agentId: 'worker-agent', workspaceRootIds: ['repo'] },
        { key: 'second-insert', title: 'Fail second insert', instructions: 'Force rollback.', agentId: 'worker-agent', workspaceRootIds: ['repo'] },
      ]), /forced team insert failure/);
    } finally {
      getDb().exec('DROP TRIGGER fail_second_team_child');
    }
    assert.equal(ledger.getTaskDetails(atomicTeamParent.id)?.children.length, 0,
      'unexpected database failures must roll back the complete team');
    assert.equal(ledger.getTask(atomicTeamParent.id)?.status, 'queued',
      'the parent transition must share the atomic team transaction');

    const pauseBudgetTask = ledger.createTask({
      id: 'pause-budget-worker', kind: 'work', title: 'Pause-aware budget', status: 'running',
    });
    const budgetController = new AbortController();
    const stopBudget = teams.startPauseAwareWorkerBudget(pauseBudgetTask.id, budgetController, 120, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const pausedBudgetTask = ledger.transitionTask({
      taskId: pauseBudgetTask.id,
      status: 'paused',
      expectedVersion: ledger.getTask(pauseBudgetTask.id)!.version,
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(budgetController.signal.aborted, false, 'cooperative pause time must not consume the worker budget');
    ledger.transitionTask({ taskId: pausedBudgetTask.id, status: 'running', expectedVersion: pausedBudgetTask.version });
    const budgetDeadline = Date.now() + 300;
    while (!budgetController.signal.aborted && Date.now() < budgetDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stopBudget();
    assert.equal(budgetController.signal.aborted, true, 'the remaining active-time budget still expires after resume');
    ledger.transitionTask({ taskId: pauseBudgetTask.id, status: 'cancelled' });

    const leaseHeartbeatController = new AbortController();
    assert.doesNotThrow(() => teams.teamWorkerRuntimeTestHooks.runTeamLeaseHeartbeatTick(
      leaseHeartbeatController,
      () => { throw new Error('simulated sqlite heartbeat failure'); },
    ), 'a heartbeat callback exception must stay inside the interval boundary');
    assert.equal(leaseHeartbeatController.signal.aborted, true,
      'a worker must fail closed when lease ownership cannot be proven');
    assert.match(String((leaseHeartbeatController.signal.reason as Error).message), /heartbeat.*simulated sqlite/i);
    const lostLeaseController = new AbortController();
    teams.teamWorkerRuntimeTestHooks.runTeamLeaseHeartbeatTick(lostLeaseController, () => false);
    assert.match(String((lostLeaseController.signal.reason as Error).message), /ownership was lost/i);

    const retryTeamParent = ledger.createTask({
      id: 'retry-team-parent', kind: 'code', title: 'Retry team dependency', status: 'queued',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'write' }],
    });
    const retryGraph = await teams.createTaskTeam(retryTeamParent.id, [
      {
        key: 'retry-source', title: 'Retry source', instructions: 'Produce the source result.',
        agentId: 'worker-agent', workspaceRootIds: ['repo'], readOnly: true,
        integrationScopes: ['github'], allowedTools: ['fs_read'],
      },
      {
        key: 'retry-dependent', title: 'Retry dependent', instructions: 'Use the source result.',
        agentId: 'worker-agent', workspaceRootIds: ['repo'], dependsOn: ['retry-source'],
      },
    ]);
    const retrySource = retryGraph.find((node) => node.key === 'retry-source')!.task;
    const retryDependent = retryGraph.find((node) => node.key === 'retry-dependent')!.task;
    const retrySourceRunning = ledger.transitionTask({ taskId: retrySource.id, status: 'running' });
    const retrySourceFailed = ledger.transitionTask({
      taskId: retrySource.id,
      status: 'failed',
      expectedVersion: retrySourceRunning.version,
      error: 'Transient source failure.',
    });
    await teams.dispatchReadyTeamWorkers(retryTeamParent.id);
    assert.equal(ledger.getTask(retryDependent.id)?.status, 'blocked');
    assert.equal(ledger.getTask(retryTeamParent.id)?.status, 'blocked');
    const retryCommand = ledger.enqueueTaskCommand({
      taskId: retrySource.id,
      kind: 'retry',
      idempotencyKey: 'retry-team-source',
      expectedVersion: retrySourceFailed.version,
    });
    ledger.applyTaskCommand(retryCommand.id);
    const retryCapacityIds = Array.from(
      { length: runGuards.maxConcurrentRuns(await persistence.loadConfig()) },
      (_, index) => `team-retry-capacity-${index}`,
    );
    for (const runId of retryCapacityIds) runGuards.registerActiveRun(runId, 'capacity-test', 'Capacity test');
    try {
      assert.equal(await background.processQueuedTaskRetries(), 1,
        'periodic retry recovery must discover a command whose post-commit dispatch was interrupted');
      const recoveredSource = ledger.getTask(retrySource.id)!;
      assert.equal(recoveredSource.status, 'queued');
      assert.equal(recoveredSource.runId, undefined, 'team retry must not use the generic unscoped launcher');
      assert.deepEqual(recoveredSource.metadata.allowedTools, ['fs_read']);
      assert.equal(ledger.getTask(retryTeamParent.id)?.status, 'running',
        'retrying a worker must return its blocked parent to coordination');
      assert.equal(ledger.listAttention({ taskId: retryTeamParent.id, status: 'open' }).total, 0,
        'retry recovery must resolve the stale blocked-team alert');

      const recoveredRunning = ledger.transitionTask({ taskId: retrySource.id, status: 'running' });
      ledger.recordTaskEvidence({
        taskId: retrySource.id,
        kind: 'assertion',
        status: 'passed',
        label: 'Recovered source result',
        summary: 'The retried dependency completed.',
      });
      ledger.transitionTask({
        taskId: retrySource.id,
        status: 'succeeded',
        expectedVersion: recoveredRunning.version + 1,
        result: 'Recovered.',
      });
      await teams.dispatchReadyTeamWorkers(retryTeamParent.id);
      assert.equal(ledger.getTask(retryDependent.id)?.status, 'queued',
        'a dependent blocked by the old failure must become dispatchable after retry succeeds');
    } finally {
      for (const runId of retryCapacityIds) runGuards.releaseActiveRun(runId);
    }
    ledger.transitionTask({ taskId: retryDependent.id, status: 'cancelled' });
    ledger.transitionTask({ taskId: retryTeamParent.id, status: 'cancelled' });

    const orphan = ledger.createTask({ id: 'orphan-worker', kind: 'work', title: 'Orphan', status: 'running' });
    getDb().prepare(`
      INSERT INTO task_worker_claims (taskId, ownerId, status, leaseUntil, heartbeatAt, attempt, createdAt)
      VALUES (?, 'dead-instance', 'active', ?, ?, 1, ?)
    `).run(orphan.id, new Date(Date.now() - 2_000).toISOString(), new Date(Date.now() - 3_000).toISOString(), new Date(Date.now() - 3_000).toISOString());
    assert.equal(teams.reconcileTeamWorkerClaims(), 1);
    assert.equal(ledger.getTask(orphan.id)?.status, 'lost');
    const interrupted = ledger.createTask({ id: 'interrupted-worker', kind: 'work', title: 'Interrupted', status: 'running' });
    ledger.transitionTask({ taskId: interrupted.id, status: 'lost', error: 'Worker process stopped.' });
    getDb().prepare(`
      INSERT INTO task_worker_claims (taskId, ownerId, status, leaseUntil, heartbeatAt, attempt, createdAt)
      VALUES (?, 'previous-instance', 'active', ?, ?, 1, ?)
    `).run(
      interrupted.id,
      new Date(Date.now() + 120_000).toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    assert.equal(teams.reconcileTeamWorkerClaims(), 1, 'terminal tasks release old-process claims without waiting for their future lease');
    assert.equal(
      (getDb().prepare('SELECT status FROM task_worker_claims WHERE taskId = ?').get(interrupted.id) as { status: string }).status,
      'released',
    );

    const isolatedBad = ledger.createTask({ id: 'isolated-bad-claim', kind: 'work', title: 'Bad claim', status: 'running' });
    const isolatedGood = ledger.createTask({ id: 'isolated-good-claim', kind: 'work', title: 'Good claim', status: 'running' });
    const expiredAt = new Date(Date.now() - 2_000).toISOString();
    const insertExpiredClaim = getDb().prepare(`
      INSERT INTO task_worker_claims (taskId, ownerId, status, leaseUntil, heartbeatAt, attempt, createdAt)
      VALUES (?, ?, 'active', ?, ?, 1, ?)
    `);
    insertExpiredClaim.run(isolatedBad.id, 'bad-claim-owner', expiredAt, expiredAt, expiredAt);
    insertExpiredClaim.run(isolatedGood.id, 'good-claim-owner', expiredAt, expiredAt, expiredAt);
    getDb().exec(`
      CREATE TRIGGER fail_one_claim_release BEFORE UPDATE ON task_worker_claims
      WHEN OLD.taskId = 'isolated-bad-claim' AND NEW.status = 'released'
      BEGIN SELECT RAISE(ABORT, 'forced claim release failure'); END
    `);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      assert.equal(teams.reconcileTeamWorkerClaims(), 1, 'one corrupt claim must not prevent later claims from reconciling');
    } finally {
      console.error = originalConsoleError;
      getDb().exec('DROP TRIGGER fail_one_claim_release');
    }
    assert.equal(ledger.getTask(isolatedBad.id)?.status, 'running');
    assert.equal(ledger.getTask(isolatedGood.id)?.status, 'lost');
    assert.equal(
      (getDb().prepare('SELECT status FROM task_worker_claims WHERE taskId = ?').get(isolatedGood.id) as { status: string }).status,
      'released',
    );
    assert.equal(teams.reconcileTeamWorkerClaims(), 1, 'the isolated failed claim remains recoverable on the next pass');

    const periodicParent = ledger.createTask({
      id: 'periodic-reconcile-parent',
      kind: 'code',
      title: 'Periodic claim recovery',
      status: 'running',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'write' }],
    });
    const periodicChild = ledger.createTask({
      id: 'periodic-reconcile-child',
      kind: 'work',
      title: 'Queued after a quick restart',
      parentId: periodicParent.id,
      status: 'queued',
      agentId: 'worker-agent',
      workspaceRoots: [{ id: 'repo', path: workspace, permission: 'read' }],
      metadata: { teamWorkerKey: 'periodic-recovery', readOnly: true },
    });
    const leaseUntil = new Date(Date.now() + 350).toISOString();
    getDb().prepare(`
      INSERT INTO task_worker_claims (taskId, ownerId, status, leaseUntil, heartbeatAt, attempt, createdAt)
      VALUES (?, 'quick-restart-owner', 'active', ?, ?, 1, ?)
    `).run(periodicChild.id, leaseUntil, new Date().toISOString(), new Date().toISOString());
    const maxRuns = runGuards.maxConcurrentRuns(await persistence.loadConfig());
    const capacityRunIds = Array.from({ length: maxRuns }, (_, index) => `reconcile-capacity-${index}`);
    for (const runId of capacityRunIds) runGuards.registerActiveRun(runId, 'capacity-test', 'Capacity test');
    teams.startTeamWorkerClaimReconciler(250);
    try {
      const deadline = Date.now() + 2_500;
      while (Date.now() < deadline) {
        const claim = getDb().prepare('SELECT status FROM task_worker_claims WHERE taskId = ?')
          .get(periodicChild.id) as { status: string };
        if (claim.status === 'released') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        (getDb().prepare('SELECT status FROM task_worker_claims WHERE taskId = ?').get(periodicChild.id) as { status: string }).status,
        'released',
        'periodic reconciliation must revisit a claim that was still live during startup',
      );
      assert.equal(ledger.getTask(periodicChild.id)?.status, 'queued', 'a claim-before-run crash must leave the child redispatchable');
    } finally {
      await teams.stopTeamWorkerClaimReconciler();
      for (const runId of capacityRunIds) runGuards.releaseActiveRun(runId);
    }
    const teamPanel = await fs.readFile(path.join(process.cwd(), 'components', 'task-team-panel.tsx'), 'utf8');
    for (const control of ["commandWorker(node, 'pause')", "commandWorker(node, 'resume')", "commandWorker(node, 'cancel')", "commandWorker(node, 'steer')", 'Inspect worker']) {
      assert(teamPanel.includes(control), `visible worker graph includes ${control}`);
    }
    console.log('Task team verification passed');
  } finally {
    await teams.stopTeamWorkerClaimReconciler();
    await background.stopQueuedRetryDispatcher();
    closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Task team verification failed', error);
  process.exitCode = 1;
});
