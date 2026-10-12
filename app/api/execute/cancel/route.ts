import { NextRequest } from 'next/server';
import { isRunStartReserved, requestRunCancel } from '@/lib/agent-runtime';
import { getRun } from '@/lib/agent-runs-store';
import { listActiveRuns } from '@/lib/run-guards';
import { getTaskByRunId } from '@/lib/task-ledger';
import { TERMINAL_TASK_STATUSES } from '@/lib/task-types';
import { projectRunCancellation } from '@/lib/run-cancellation';

// POST { runId } — ask an in-flight agent run to stop. Best-effort: the run
// ends cleanly (persisted, slot released) at its next step boundary. A no-op if
// the run already finished.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const runId = String(body?.runId || '').trim();
  if (!runId) return Response.json({ ok: false, error: 'runId is required' }, { status: 400 });
  if (runId.length > 200) return Response.json({ ok: false, error: 'runId is invalid' }, { status: 400 });

  const task = getTaskByRunId(runId);
  if (task && TERMINAL_TASK_STATUSES.has(task.status)) {
    if (task.status === 'cancelled') return Response.json({ ok: true, status: 'cancelled', taskId: task.id });
    return Response.json({ ok: false, error: `Run already finished with status ${task.status}` }, { status: 409 });
  }
  const active = listActiveRuns().some((run) => run.runId === runId);
  const reserved = isRunStartReserved(runId);
  const persisted = task || active || reserved ? null : await getRun(runId);
  if (!task && !active && !reserved && persisted?.status !== 'running') {
    return Response.json({ ok: false, error: 'Run is not active' }, { status: 404 });
  }
  // Exact run ids are announced before the generator starts. Keep the request
  // even if its active controller/task has not been registered in this tick.
  requestRunCancel(runId);
  if (task) {
    const projection = projectRunCancellation(runId, task);
    if (projection.status === 'finished') {
      return Response.json({
        ok: false,
        error: `Run already finished with status ${projection.task.status}`,
        taskId: projection.task.id,
      }, { status: 409 });
    }
    if (projection.status === 'contended') {
      return Response.json({
        ok: false,
        error: 'Cancellation was signalled, but task state kept changing; retry to confirm.',
        taskId: projection.task.id,
      }, { status: 503 });
    }
    if (projection.status === 'cancelled') {
      return Response.json({ ok: true, status: 'cancelled', taskId: projection.task.id });
    }
  }
  return Response.json({ ok: true, status: 'cancellation_requested', taskId: task?.id });
}
