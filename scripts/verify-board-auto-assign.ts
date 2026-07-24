import './verify-isolate'; // MUST be first: never touch the live Board/agent stores
import * as fs from 'fs/promises';
import * as path from 'path';
import { GOAL_SCRATCH } from '../lib/verify-scratch';

process.env.SHIBA_DISABLE_BOARD_DISPATCH = '1';

let passed = 0;

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${label}`);
  passed += 1;
  console.log(`  OK ${label}`);
}

async function main() {
  const dataDir = path.join(GOAL_SCRATCH, `board-auto-assign-${process.pid}-${Date.now()}`);
  process.env.SHIBA_DATA_DIR = dataDir;
  process.env.SHIBA_SECRET_KEY = '6d'.repeat(32);
  await fs.mkdir(dataDir, { recursive: true });

  const [{ normalizeAgent }, persistence, board, runner, ledger, db, runs] = await Promise.all([
    import('../lib/types'),
    import('../lib/persistence'),
    import('../lib/board'),
    import('../lib/board-runner'),
    import('../lib/task-ledger'),
    import('../lib/db'),
    import('../lib/agent-runs-store'),
  ]);

  const timestamp = new Date().toISOString();
  const makeAgent = (id: string, name: string, enabled: boolean) => normalizeAgent({
    id,
    name,
    model: 'local:board-verifier',
    description: `${name} Board verifier`,
    autoAcceptBoardAssignments: enabled,
    workspace: { path: dataDir, useWorktree: false },
    integrations: {},
    peers: [],
    skills: [],
    schedules: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await persistence.saveAgents([
    makeAgent('agent-manual', 'Manual Agent', false),
    makeAgent('agent-auto', 'Auto Agent', true),
  ]);

  console.log('=== BOARD AUTO-ASSIGNMENT VERIFICATION ===');

  const promptFixture = {
    key: 'SHIB-CLI',
    title: 'Implement the requested Board change',
    description: 'Update the repository and prove the requested behavior works.',
    labels: ['engineering'],
    feedback: 'Keep the existing behavior for cloud agents.',
    previousOutcome: 'The first pass only described what it planned to do.',
  };
  const cliPrompt = runner.buildBoardCardPrompt(promptFixture, 'cli:grok-build');
  assert(cliPrompt.includes(promptFixture.description), 'CLI Board prompt includes the full authoritative brief');
  assert(
    cliPrompt.includes('Do not try to pull or re-read the story from Shiba Studio'),
    'CLI Board prompt forbids trying to fetch the already embedded card',
  );
  assert(
    cliPrompt.includes('Do not call, search for, or try to discover board_get_task'),
    'CLI Board prompt does not advertise unavailable Shiba board tools',
  );
  assert(
    cliPrompt.includes('Execute the work now')
      && cliPrompt.includes('Do not stop after stating a plan')
      && cliPrompt.includes('changed file paths')
      && cliPrompt.includes('validation commands and results'),
    'CLI Board prompt requires execution and concrete validated evidence',
  );
  assert(
    !cliPrompt.includes('Work the card to completion. You have board tools:'),
    'CLI Board prompt omits the non-CLI board-tool contract',
  );
  assert(
    runner.buildBoardCardPrompt(promptFixture, 'grok-cli:grok-build').includes('Execute the work now'),
    'legacy Grok CLI model references receive the CLI Board contract',
  );
  const cloudPrompt = runner.buildBoardCardPrompt(promptFixture, 'cloud:grok-4');
  assert(
    cloudPrompt.includes('Work the card to completion. You have board tools:')
      && cloudPrompt.includes('board_update_task')
      && cloudPrompt.includes('board_get_task / board_list_tasks'),
    'non-CLI Board agents retain Shiba board-tool instructions',
  );

  const manualCard = await board.createBoardTask({ title: 'Manual-only assignment', status: 'todo' });
  const manualAssigned = await board.updateBoardTask(manualCard.id, { assigneeAgentId: 'agent-manual' });
  assert(manualAssigned.autoAssignment?.status === 'disabled', 'opted-out assignment is durably dismissed');
  assert(!manualAssigned.activeWork && !manualAssigned.working, 'opted-out assignment never starts work');
  assert(ledger.listTasks({ originType: 'board', originId: manualCard.id }).total === 0, 'opted-out assignment creates no task');

  const first = await board.createBoardTask({ title: 'Automatic first card', status: 'backlog' });
  const firstAccepted = await board.updateBoardTask(first.id, { assigneeAgentId: 'agent-auto' });
  assert(firstAccepted.autoAssignment?.status === 'accepted', 'opted-in assignment is accepted automatically');
  assert(firstAccepted.status === 'in_progress' && firstAccepted.working, 'accepted assignment moves to In Progress');
  assert(firstAccepted.activeWork?.mode === 'automatic', 'accepted assignment records automatic work mode');
  const firstTasks = ledger.listTasks({ originType: 'board', originId: first.id });
  assert(firstTasks.total === 1 && firstTasks.tasks[0].status === 'queued', 'automatic assignment creates one queued durable task');
  assert(firstTasks.tasks[0].metadata.dispatchRequested === true, 'fresh Board intent is restart-discoverable');
  assert(ledger.listQueuedRetryTasks().some((task) => task.id === firstTasks.tasks[0].id), 'queued dispatcher discovers a fresh Board intent');

  await board.updateBoardTask(first.id, { assigneeAgentId: 'agent-auto' });
  assert(ledger.listTasks({ originType: 'board', originId: first.id }).total === 1, 'replayed assignee update is idempotent');
  let reassignmentBlocked = false;
  try {
    await board.updateBoardTask(first.id, { assigneeAgentId: 'agent-manual' });
  } catch (error) {
    reassignmentBlocked = /accepted|active/i.test(error instanceof Error ? error.message : String(error));
  }
  assert(reassignmentBlocked, 'active work fences reassignment');

  const second = await board.createBoardTask({ title: 'Queued behind same agent', status: 'todo' });
  const secondPending = await board.updateBoardTask(second.id, { assigneeAgentId: 'agent-auto' });
  assert(secondPending.autoAssignment?.status === 'pending' && !secondPending.activeWork, 'busy agent leaves later assignment pending');
  assert(ledger.listTasks({ originType: 'board', originId: second.id }).total === 0, 'busy agent does not create a competing task');

  const firstTask = firstTasks.tasks[0];
  const firstAssignedTask = ledger.assignTaskExecution({
    taskId: firstTask.id,
    runId: 'run-board-success',
    agentId: 'agent-auto',
    expectedVersion: firstTask.version,
  });
  ledger.transitionTask({
    taskId: firstAssignedTask.id,
    status: 'succeeded',
    expectedVersion: firstAssignedTask.version,
    result: 'Implemented and verified the requested card.',
  });
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const firstDone = await board.getBoardTask(first.id);
  const secondAccepted = await board.getBoardTask(second.id);
  assert(firstDone?.status === 'in_review' && !firstDone.working && !firstDone.activeWork, 'successful work lands in Review and releases its claim');
  assert(firstDone?.runIds.includes('run-board-success'), 'successful run is linked to the card');
  assert(secondAccepted?.autoAssignment?.status === 'accepted' && secondAccepted.working, 'pending assignment starts after the agent is free');
  assert(ledger.listTasks({ originType: 'board', originId: second.id }).total === 1, 'released agent creates exactly one next task');
  const successNotes = firstDone?.activity.filter((activity) => activity.runId === 'run-board-success').length || 0;
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const firstReplayed = await board.getBoardTask(first.id);
  assert(
    firstReplayed?.activity.filter((activity) => activity.runId === 'run-board-success').length === successNotes,
    'terminal projection is idempotent',
  );

  const secondTask = ledger.listTasks({ originType: 'board', originId: second.id }).tasks[0];
  ledger.transitionTask({ taskId: secondTask.id, status: 'failed', error: 'Verifier failure' });
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const secondFailed = await board.getBoardTask(second.id);
  assert(secondFailed?.status === 'in_progress' && !secondFailed.working && !secondFailed.activeWork, 'failed work releases the claim without entering Review');
  assert(secondFailed?.activity.some((activity) => activity.text.includes('Verifier failure')), 'failure diagnostic is preserved on the card');

  const { beginAutomationMaintenance } = await import('../lib/automation-maintenance');
  const releaseMaintenance = beginAutomationMaintenance('Board concurrent-accept verifier');
  let concurrentCard: Awaited<ReturnType<typeof board.createBoardTask>>;
  try {
    concurrentCard = await board.createBoardTask({ title: 'Concurrent assignment reaction', status: 'todo' });
    const pending = await board.updateBoardTask(concurrentCard.id, { assigneeAgentId: 'agent-auto' });
    assert(pending.autoAssignment?.status === 'pending' && !pending.activeWork, 'maintenance leaves an assignment durably pending');
  } finally {
    releaseMaintenance();
  }
  await Promise.all([
    runner.reactToBoardAssignment(concurrentCard!.id),
    runner.reactToBoardAssignment(concurrentCard!.id),
  ]);
  const concurrentlyAccepted = await board.getBoardTask(concurrentCard!.id);
  const concurrentTasks = ledger.listTasks({ originType: 'board', originId: concurrentCard!.id });
  assert(concurrentlyAccepted?.autoAssignment?.status === 'accepted' && !!concurrentlyAccepted.activeWork, 'concurrent reactors converge on one accepted claim');
  assert(concurrentTasks.total === 1, 'concurrent reactors create exactly one durable task');
  ledger.transitionTask({ taskId: concurrentTasks.tasks[0].id, status: 'failed', error: 'Concurrency fixture settled' });
  await runner.processBoardAssignmentsOnce({ dispatch: false });

  const cancellable = await board.createBoardTask({ title: 'Cancellation fence', status: 'todo' });
  const cancelAccepted = await board.updateBoardTask(cancellable.id, { assigneeAgentId: 'agent-auto' });
  const cancelledTaskId = cancelAccepted.activeWork?.taskId;
  assert(!!cancelledTaskId, 'cancellation fixture accepted work');
  const cancellationPending = await board.updateBoardTask(cancellable.id, { status: 'cancelled' });
  assert(ledger.getTask(cancelledTaskId!)?.status === 'cancelled', 'cancelling a card cancels its durable queued work');
  assert(
    cancellationPending.status === 'cancelled'
      && cancellationPending.working
      && !!cancellationPending.activeWork?.cancelRequestedAt,
    'Board retains its busy claim until queued cancellation is projected',
  );
  const behindCancellation = await board.createBoardTask({ title: 'Wait behind cancellation', status: 'todo' });
  const behindPending = await board.updateBoardTask(behindCancellation.id, { assigneeAgentId: 'agent-auto' });
  assert(
    behindPending.autoAssignment?.status === 'pending' && !behindPending.activeWork,
    'cancellation-pending claim prevents the next card from starting',
  );
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const cancellationSettled = await board.getBoardTask(cancellable.id);
  const behindAccepted = await board.getBoardTask(behindCancellation.id);
  assert(
    cancellationSettled?.status === 'cancelled' && !cancellationSettled.working && !cancellationSettled.activeWork,
    'terminal queued cancellation releases the exact Board claim',
  );
  assert(behindAccepted?.activeWork && behindAccepted.working, 'next assignment starts only after cancellation settles');
  const behindTask = ledger.listTasks({ originType: 'board', originId: behindCancellation.id }).tasks[0];
  ledger.transitionTask({ taskId: behindTask.id, status: 'failed', error: 'Cancellation queue fixture settled' });
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  await board.projectBoardWork({
    taskId: cancelledTaskId!,
    state: 'succeeded',
    result: 'Late stale result',
    agentName: 'Auto Agent',
  });
  const cancelled = await board.getBoardTask(cancellable.id);
  assert(cancelled?.status === 'cancelled' && !cancelled.working && !cancelled.activeWork, 'late completion cannot overwrite a cancelled card');

  const runningCancellable = await board.createBoardTask({ title: 'Running cancellation control', status: 'todo' });
  const runningAccepted = await board.updateBoardTask(runningCancellable.id, { assigneeAgentId: 'agent-auto' });
  const runningTask = ledger.getTask(runningAccepted.activeWork!.taskId)!;
  const runningAssigned = ledger.assignTaskExecution({
    taskId: runningTask.id,
    runId: 'run-board-cancel-control',
    agentId: 'agent-auto',
    expectedVersion: runningTask.version,
  });
  ledger.transitionTask({
    taskId: runningAssigned.id,
    status: 'running',
    expectedVersion: runningAssigned.version,
  });
  const runningStartedAt = new Date().toISOString();
  await runs.persistAgentRun({
    id: 'run-board-cancel-control',
    taskId: runningTask.id,
    attemptNo: 1,
    agentId: 'agent-auto',
    agentName: 'Auto Agent',
    model: 'local:test',
    status: 'running',
    prompt: 'Keep running until the cancellation signal is acknowledged.',
    startedAt: runningStartedAt,
    trace: [],
    sideEffects: [],
  });
  const runningCancellation = await board.updateBoardTask(runningCancellable.id, { status: 'cancelled' });
  assert(
    ledger.getTask(runningTask.id)?.status === 'cancelled'
      && !!runningCancellation.activeWork?.cancelRequestedAt,
    'running card cancellation is durable before its Board claim is released',
  );
  const runningControls = ledger.claimTaskRunControlSignals(
    'run-board-cancel-control',
    'board-cancel-verifier',
  );
  assert(
    runningControls.some((signal) => signal.kind === 'cancel' && signal.taskId === runningTask.id),
    'running cancellation emits a durable run-control signal',
  );
  const runningCancelControl = runningControls.find((signal) => (
    signal.kind === 'cancel' && signal.taskId === runningTask.id
  ))!;
  assert(
    ledger.finishTaskRunControlSignal({
      id: runningCancelControl.id,
      runId: runningCancelControl.runId,
      consumerId: 'board-cancel-verifier',
      expectedAttempts: runningCancelControl.attempts,
      delivered: true,
    }),
    'running cancellation control is durably acknowledged',
  );
  const behindRunningCancellation = await board.createBoardTask({
    title: 'Wait for cancelled run to terminate',
    status: 'todo',
  });
  const behindRunningPending = await board.updateBoardTask(
    behindRunningCancellation.id,
    { assigneeAgentId: 'agent-auto' },
  );
  assert(
    behindRunningPending.autoAssignment?.status === 'pending' && !behindRunningPending.activeWork,
    'live cancelled run keeps later same-agent work pending',
  );
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const runningCancellationHeld = await board.getBoardTask(runningCancellable.id);
  const behindRunningHeld = await board.getBoardTask(behindRunningCancellation.id);
  assert(
    !!runningCancellationHeld?.activeWork
      && runningCancellationHeld.working
      && behindRunningHeld?.autoAssignment?.status === 'pending'
      && !behindRunningHeld.activeWork,
    'acknowledged cancellation retains the Board claim while its run is still live',
  );
  await runs.persistAgentRun({
    id: 'run-board-cancel-control',
    taskId: runningTask.id,
    attemptNo: 1,
    agentId: 'agent-auto',
    agentName: 'Auto Agent',
    model: 'local:test',
    status: 'error',
    prompt: 'Keep running until the cancellation signal is acknowledged.',
    startedAt: runningStartedAt,
    completedAt: new Date().toISOString(),
    finalOutput: 'Cancelled after acknowledging the Board control signal.',
    trace: [],
    sideEffects: [],
  });
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const runningCancellationSettled = await board.getBoardTask(runningCancellable.id);
  const behindRunningAccepted = await board.getBoardTask(behindRunningCancellation.id);
  assert(
    runningCancellationSettled?.status === 'cancelled'
      && !runningCancellationSettled.activeWork
      && !runningCancellationSettled.working,
    'running cancellation releases its claim only after the run is terminal',
  );
  assert(
    !!behindRunningAccepted?.activeWork && behindRunningAccepted.working,
    'next same-agent assignment starts after the cancelled run terminates',
  );
  const behindRunningTask = ledger.listTasks({
    originType: 'board',
    originId: behindRunningCancellation.id,
  }).tasks[0];
  ledger.transitionTask({
    taskId: behindRunningTask.id,
    status: 'failed',
    error: 'Running cancellation queue fixture settled',
  });
  await runner.processBoardAssignmentsOnce({ dispatch: false });

  const stale = await board.createBoardTask({ title: 'Stale queued dispatch fence', status: 'todo' });
  const staleAccepted = await board.updateBoardTask(stale.id, { assigneeAgentId: 'agent-auto' });
  const staleTaskId = staleAccepted.activeWork?.taskId;
  assert(!!staleTaskId, 'stale-dispatch fixture accepted work');
  await board.projectBoardWork({
    taskId: staleTaskId!,
    state: 'succeeded',
    result: 'Projection won before dispatch',
    agentName: 'Auto Agent',
  });
  let staleDispatchRejected = false;
  try {
    const { dispatchExistingTask } = await import('../lib/background-tasks');
    await dispatchExistingTask(staleTaskId!);
  } catch (error) {
    staleDispatchRejected = /claim is no longer active/i.test(error instanceof Error ? error.message : String(error));
  }
  assert(staleDispatchRejected && ledger.getTask(staleTaskId!)?.status === 'cancelled', 'dispatcher revalidates the Board claim before launching');

  // Simulate the Board-first crash gap: persist a claim, omit its ledger row,
  // then let the recovery pass reconstruct the exact deterministic task.
  await persistence.saveAgents([
    makeAgent('agent-manual', 'Manual Agent', false),
    makeAgent('agent-auto', 'Auto Agent', false),
  ]);
  const recoverable = await board.createBoardTask({ title: 'Recover missing durable task', status: 'todo' });
  await board.updateBoardTask(recoverable.id, { assigneeAgentId: 'agent-auto' });
  await persistence.saveAgents([
    makeAgent('agent-manual', 'Manual Agent', false),
    makeAgent('agent-auto', 'Auto Agent', true),
  ]);
  const recoveredClaim = await board.claimBoardWork({
    idOrKey: recoverable.id,
    workId: 'recover-work-generation',
    taskId: 'board-recover-task',
    agentId: 'agent-auto',
    agentName: 'Auto Agent',
    mode: 'manual',
  });
  assert(recoveredClaim.claimed && !ledger.getTask('board-recover-task'), 'crash-gap fixture has a Board claim without a task');
  const recoveryPass = await runner.processBoardAssignmentsOnce({ dispatch: false });
  assert(recoveryPass.ensured >= 1 && ledger.getTask('board-recover-task')?.status === 'queued', 'reconciler repairs the assignment-to-task crash gap');

  const recoverTask = ledger.getTask('board-recover-task')!;
  const recoverAssigned = ledger.assignTaskExecution({
    taskId: recoverTask.id,
    runId: 'run-interrupted-board',
    agentId: 'agent-auto',
    expectedVersion: recoverTask.version,
  });
  const recoverRunning = ledger.transitionTask({
    taskId: recoverAssigned.id,
    status: 'running',
    expectedVersion: recoverAssigned.version,
  });
  ledger.transitionTask({
    taskId: recoverRunning.id,
    status: 'lost',
    expectedVersion: recoverRunning.version,
    error: 'Simulated restart interruption',
  });
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const retried = ledger.getTask('board-recover-task');
  const recoverCard = await board.getBoardTask(recoverable.id);
  assert(retried?.status === 'queued' && retried.retryCount === 1, 'interrupted Board task is retried durably');
  assert(recoverCard?.working && recoverCard.activeWork?.taskId === retried?.id, 'retry keeps the exact Board claim active');
  ledger.transitionTask({ taskId: retried!.id, status: 'failed', error: 'Recovery fixture settled' });
  await runner.processBoardAssignmentsOnce({ dispatch: false });

  const deletedAfterSuccess = await board.createBoardTask({ title: 'Completed before agent deletion', status: 'todo' });
  const deletedAfterSuccessAccepted = await board.updateBoardTask(deletedAfterSuccess.id, {
    assigneeAgentId: 'agent-auto',
  });
  const deletedAfterSuccessTask = ledger.getTask(deletedAfterSuccessAccepted.activeWork!.taskId)!;
  const deletedAfterSuccessRun = ledger.assignTaskExecution({
    taskId: deletedAfterSuccessTask.id,
    runId: 'run-completed-before-agent-delete',
    agentId: 'agent-auto',
    expectedVersion: deletedAfterSuccessTask.version,
  });
  ledger.transitionTask({
    taskId: deletedAfterSuccessRun.id,
    status: 'succeeded',
    expectedVersion: deletedAfterSuccessRun.version,
    result: 'Completed before the agent record was removed.',
  });
  await persistence.saveAgents([makeAgent('agent-manual', 'Manual Agent', false)]);
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const completedWithoutAgent = await board.getBoardTask(deletedAfterSuccess.id);
  assert(
    completedWithoutAgent?.status === 'in_review'
      && completedWithoutAgent.activity.some((activity) => activity.text.includes('Completed before the agent')),
    'terminal ledger result wins when its agent was deleted before projection',
  );

  await persistence.saveAgents([
    makeAgent('agent-manual', 'Manual Agent', false),
    makeAgent('agent-auto', 'Auto Agent', true),
  ]);
  const deletedWhileRunning = await board.createBoardTask({ title: 'Cancel work for deleted agent', status: 'todo' });
  const deletedWhileRunningAccepted = await board.updateBoardTask(deletedWhileRunning.id, {
    assigneeAgentId: 'agent-auto',
  });
  const deletedWhileRunningTask = ledger.getTask(deletedWhileRunningAccepted.activeWork!.taskId)!;
  const deletedWhileRunningRun = ledger.assignTaskExecution({
    taskId: deletedWhileRunningTask.id,
    runId: 'run-deleted-agent-cancel',
    agentId: 'agent-auto',
    expectedVersion: deletedWhileRunningTask.version,
  });
  ledger.transitionTask({
    taskId: deletedWhileRunningRun.id,
    status: 'running',
    expectedVersion: deletedWhileRunningRun.version,
  });
  const deletedAgentRunStartedAt = new Date().toISOString();
  await runs.persistAgentRun({
    id: 'run-deleted-agent-cancel',
    taskId: deletedWhileRunningTask.id,
    attemptNo: 1,
    agentId: 'agent-auto',
    agentName: 'Auto Agent',
    model: 'local:test',
    status: 'running',
    prompt: 'Stop safely if this agent is deleted.',
    startedAt: deletedAgentRunStartedAt,
    trace: [],
    sideEffects: [],
  });
  await persistence.saveAgents([makeAgent('agent-manual', 'Manual Agent', false)]);
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const deletedAgentTask = ledger.getTask(deletedWhileRunningTask.id);
  const deletedAgentCardHeld = await board.getBoardTask(deletedWhileRunning.id);
  assert(
    deletedAgentTask?.status === 'cancelled'
      && !!deletedAgentCardHeld?.activeWork
      && deletedAgentCardHeld.working,
    'missing-agent reconciliation cancels active work while retaining the live-run claim',
  );
  const deletedAgentControls = ledger.claimTaskRunControlSignals(
    'run-deleted-agent-cancel',
    'deleted-agent-verifier',
  );
  assert(
    deletedAgentControls.some((signal) => signal.kind === 'cancel' && signal.taskId === deletedWhileRunningTask.id),
    'missing-agent reconciliation emits a durable run-control cancellation',
  );
  const deletedAgentCancelControl = deletedAgentControls.find((signal) => (
    signal.kind === 'cancel' && signal.taskId === deletedWhileRunningTask.id
  ))!;
  ledger.finishTaskRunControlSignal({
    id: deletedAgentCancelControl.id,
    runId: deletedAgentCancelControl.runId,
    consumerId: 'deleted-agent-verifier',
    expectedAttempts: deletedAgentCancelControl.attempts,
    delivered: true,
  });
  await runs.persistAgentRun({
    id: 'run-deleted-agent-cancel',
    taskId: deletedWhileRunningTask.id,
    attemptNo: 1,
    agentId: 'agent-auto',
    agentName: 'Auto Agent',
    model: 'local:test',
    status: 'error',
    prompt: 'Stop safely if this agent is deleted.',
    startedAt: deletedAgentRunStartedAt,
    completedAt: new Date().toISOString(),
    finalOutput: 'Cancelled after the agent was deleted.',
    trace: [],
    sideEffects: [],
  });
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const deletedAgentCardSettled = await board.getBoardTask(deletedWhileRunning.id);
  assert(
    !deletedAgentCardSettled?.activeWork && !deletedAgentCardSettled?.working,
    'missing-agent claim releases after its cancelled run becomes terminal',
  );

  await persistence.saveAgents([
    makeAgent('agent-manual', 'Manual Agent', false),
    makeAgent('agent-auto', 'Auto Agent', true),
  ]);
  const collisionCard = await board.createBoardTask({ title: 'Identity collision must be isolated', status: 'todo' });
  await board.updateBoardTask(collisionCard.id, { assigneeAgentId: 'agent-manual' });
  const collisionClaim = await board.claimBoardWork({
    idOrKey: collisionCard.id,
    workId: 'collision-work-generation',
    taskId: 'board-identity-collision',
    agentId: 'agent-manual',
    agentName: 'Manual Agent',
    mode: 'manual',
  });
  assert(collisionClaim.claimed, 'identity-collision fixture owns a Board claim');
  ledger.createTask({
    id: 'board-identity-collision',
    kind: 'board',
    title: 'Unrelated durable row',
    originType: 'board',
    originId: manualCard.id,
    agentId: 'agent-manual',
    metadata: { boardWorkId: 'different-generation', agentName: 'Manual Agent' },
  });
  const healthyAfterCollision = await board.createBoardTask({ title: 'Healthy card after collision', status: 'todo' });
  const healthyAccepted = await board.updateBoardTask(healthyAfterCollision.id, { assigneeAgentId: 'agent-auto' });
  const healthyTask = ledger.getTask(healthyAccepted.activeWork!.taskId)!;
  ledger.transitionTask({ taskId: healthyTask.id, status: 'succeeded', result: 'Healthy projection continued.' });
  const collisionPass = await runner.processBoardAssignmentsOnce({ dispatch: false });
  const healthyProjected = await board.getBoardTask(healthyAfterCollision.id);
  assert(collisionPass.errors >= 1, 'identity collision is reported by the recovery pass');
  assert(
    healthyProjected?.status === 'in_review' && !healthyProjected.activeWork,
    'one corrupt claim cannot block reconciliation of later cards',
  );

  // ── Explicit queueing ───────────────────────────────────────────────────
  // A dedicated agent: earlier fixtures rewrite the roster and leave the other
  // agents busy or deleted. It stays opted OUT of automatic assignments, which
  // is the whole point — the queue click alone must be enough.
  await persistence.saveAgents([
    ...(await persistence.loadAgents()).filter((agent) => agent.id !== 'agent-queue'),
    makeAgent('agent-queue', 'Queue Agent', false),
  ]);
  // Queue consent is the operator's own click, so it must work for an agent
  // that never opted into automatic Board assignments.
  const queuedCard = await board.createBoardTask({
    title: 'Queued for the queue agent',
    description: 'Should start once the queue agent is free.',
    status: 'todo',
    assigneeAgentId: 'agent-queue',
    createdBy: 'verifier',
  });
  // Occupy the queue agent so the queued card cannot start immediately.
  const busyCard = await board.createBoardTask({
    title: 'Occupies the queue agent',
    description: 'Holds the single active claim.',
    status: 'todo',
    assigneeAgentId: 'agent-queue',
    createdBy: 'verifier',
  });
  await runner.startWorkOnTask(busyCard.id);
  const busyNow = await board.getBoardTask(busyCard.id);
  assert(busyNow?.working === true, 'queue agent holds an active claim');

  let startWorkRejected = '';
  try {
    await runner.startWorkOnTask(queuedCard.id);
  } catch (error) {
    startWorkRejected = error instanceof Error ? error.message : String(error);
  }
  assert(/already has accepted Board work/i.test(startWorkRejected), 'Start work still refuses while the agent is busy');

  const queued = await board.queueBoardWork(queuedCard.id, 'verifier');
  assert(
    queued.autoAssignment?.status === 'pending' && queued.autoAssignment.queued === true && !queued.working,
    'queueing a card for a busy agent records a durable pending queue entry',
  );
  assert(queued.activity.some((activity) => /Queued by verifier/.test(activity.text)), 'queueing is recorded on the card activity feed');

  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const stillQueued = await board.getBoardTask(queuedCard.id);
  assert(
    stillQueued?.autoAssignment?.status === 'pending' && !stillQueued.working,
    'a queued card stays queued (never disabled) while its agent is busy',
  );

  // Release the busy claim — the queued card must then be picked up, even
  // though this agent has autoAcceptBoardAssignments disabled.
  const busyTask = ledger.listTasks({ originType: 'board', originId: busyCard.id }).tasks[0];
  ledger.transitionTask({ taskId: busyTask.id, status: 'succeeded', result: 'Freed the agent.' });
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const startedFromQueue = await board.getBoardTask(queuedCard.id);
  assert(
    startedFromQueue?.working === true && startedFromQueue.autoAssignment?.status === 'accepted',
    'a queued card starts automatically once its agent frees, without auto-accept opt-in',
  );
  assert(startedFromQueue?.activeWork?.mode === 'queued', 'work claimed from the queue records the queued mode');
  assert(
    ledger.listTasks({ originType: 'board', originId: queuedCard.id }).total === 1,
    'starting from the queue creates exactly one durable task',
  );

  // Leaving the queue is possible while still waiting.
  const secondQueued = await board.createBoardTask({
    title: 'Queued then withdrawn',
    description: 'Removed from the queue before it starts.',
    status: 'todo',
    assigneeAgentId: 'agent-queue',
    createdBy: 'verifier',
  });
  await board.queueBoardWork(secondQueued.id, 'verifier');
  const withdrawn = await board.unqueueBoardWork(secondQueued.id, 'verifier');
  assert(withdrawn.autoAssignment?.status === 'disabled', 'leaving the queue disables the pending entry');
  await runner.processBoardAssignmentsOnce({ dispatch: false });
  const stayedOut = await board.getBoardTask(secondQueued.id);
  assert(!stayedOut?.working && !stayedOut?.activeWork, 'a withdrawn card is never picked up');

  let queueWithoutAgentRejected = false;
  const unassigned = await board.createBoardTask({
    title: 'No assignee', description: 'Cannot be queued.', status: 'todo', createdBy: 'verifier',
  });
  try {
    await board.queueBoardWork(unassigned.id, 'verifier');
  } catch (error) {
    queueWithoutAgentRejected = /no assigned agent/i.test(error instanceof Error ? error.message : String(error));
  }
  assert(queueWithoutAgentRejected, 'a card cannot be queued without an assigned agent');

  let unknownAgentRejected = false;
  try {
    await board.updateBoardTask(manualCard.id, { assigneeAgentId: 'deleted-agent' });
  } catch (error) {
    unknownAgentRejected = /does not exist/i.test(error instanceof Error ? error.message : String(error));
  }
  assert(unknownAgentRejected, 'unknown assignee ids cannot create orphaned Board references');

  await runner.stopBoardAssignmentProcessor();
  db.closeDb();
  await fs.rm(dataDir, { recursive: true, force: true });
  console.log(`PASS: ${passed} Board auto-assignment checks`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
