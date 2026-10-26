import { getTaskByRunId, transitionTask } from './task-ledger';
import { TERMINAL_TASK_STATUSES, type TaskRecord } from './task-types';

export type CancellationProjection =
  | { status: 'cancelled'; task: TaskRecord }
  | { status: 'finished'; task: TaskRecord }
  | { status: 'missing' }
  | { status: 'contended'; task: TaskRecord };

/** Retry an optimistic task projection when a heartbeat wins the first race. */
export function projectRunCancellation(
  runId: string,
  initialTask: TaskRecord | null = getTaskByRunId(runId),
): CancellationProjection {
  let task = initialTask;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!task) return { status: 'missing' };
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return { status: task.status === 'cancelled' ? 'cancelled' : 'finished', task };
    }
    try {
      const cancelled = transitionTask({
        taskId: task.id,
        status: 'cancelled',
        expectedVersion: task.version,
        error: 'Run cancelled by the user.',
        currentStep: 'Cancelled',
        nextAction: null,
      });
      return { status: 'cancelled', task: cancelled };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/changed concurrently|Invalid task transition|Task not found/i.test(message)) throw error;
      task = getTaskByRunId(runId);
    }
  }
  const latest = getTaskByRunId(runId);
  if (!latest) return { status: 'missing' };
  if (TERMINAL_TASK_STATUSES.has(latest.status)) {
    return { status: latest.status === 'cancelled' ? 'cancelled' : 'finished', task: latest };
  }
  return { status: 'contended', task: latest };
}
