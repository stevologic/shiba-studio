import { getTaskDetails, heartbeatTask, transitionTask } from '@/lib/task-ledger';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const task = getTaskDetails(id);
    if (!task) return Response.json({ ok: false, error: 'Task not found' }, { status: 404 });
    return Response.json({ ok: true, task }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid task id' }, { status: 400 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const expectedVersion = Number(body.expectedVersion ?? request.headers.get('if-match'));
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return Response.json({ ok: false, error: 'expectedVersion or If-Match is required' }, { status: 428 });
    }
    const task = body.action === 'heartbeat'
      ? heartbeatTask(id, {
          progress: body.progress,
          currentStep: body.currentStep,
          nextAction: body.nextAction,
          expectedVersion,
        })
      : transitionTask({
          taskId: id,
          status: body.status,
          expectedVersion,
          progress: body.progress,
          currentStep: body.currentStep,
          nextAction: body.nextAction,
          result: body.result,
          error: body.error,
          checkpointId: body.checkpointId,
          metadata: body.metadata,
        });
    return Response.json({ ok: true, task });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task update failed';
    const conflict = /concurrently|Invalid task transition/i.test(message);
    const current = conflict ? getTaskDetails(id) : null;
    return Response.json({ ok: false, error: message, ...(current ? { task: current } : {}) }, { status: conflict ? 409 : 400 });
  }
}
