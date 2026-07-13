import { applyTaskCommand, enqueueTaskCommand, getTask } from '@/lib/task-ledger';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const command = enqueueTaskCommand({
      taskId: id,
      kind: body.type,
      payload: body.payload,
      idempotencyKey: String(body.idempotencyKey || ''),
      expectedVersion: Number(body.expectedVersion),
    });
    const shouldApplyImmediately = ['pause', 'resume', 'cancel', 'retry', 'steer', 'approve', 'deny'].includes(command.kind);
    const result = shouldApplyImmediately ? applyTaskCommand(command.id) : command;
    let retryDispatch: { state: 'started' | 'queued_for_recovery'; detail?: string } | undefined;
    if ('appliedNow' in result && result.appliedNow && result.status === 'applied' && result.kind === 'retry') {
      try {
        const { dispatchExistingTask } = await import('@/lib/background-tasks');
        const dispatched = await dispatchExistingTask(id);
        retryDispatch = {
          state: dispatched.status === 'queued' ? 'queued_for_recovery' : 'started',
        };
      } catch (error) {
        // The retry mutation is already committed and the durable queued-retry
        // pump owns eventual execution. Never report the accepted command as
        // failed merely because this best-effort fast path was unavailable.
        retryDispatch = {
          state: 'queued_for_recovery',
          detail: error instanceof Error ? error.message : 'Immediate dispatch was unavailable',
        };
      }
    } else if ('appliedNow' in result && result.status === 'applied' && result.kind === 'retry') {
      retryDispatch = { state: getTask(id)?.status === 'queued' ? 'queued_for_recovery' : 'started' };
    }
    return Response.json({ ok: true, command: result, ...(retryDispatch ? { retryDispatch } : {}) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task command failed';
    const conflict = /concurrently|transition|retry limit/i.test(message);
    return Response.json({ ok: false, error: message }, { status: conflict ? 409 : 400 });
  }
}
