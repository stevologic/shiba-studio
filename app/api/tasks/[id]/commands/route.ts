import { applyTaskCommand, enqueueTaskCommand } from '@/lib/task-ledger';

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
    if ('appliedNow' in result && result.appliedNow && result.status === 'applied' && result.kind === 'retry') {
      const { dispatchExistingTask } = await import('@/lib/background-tasks');
      await dispatchExistingTask(id);
    }
    return Response.json({ ok: true, command: result }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task command failed';
    const conflict = /concurrently|transition|retry limit/i.test(message);
    return Response.json({ ok: false, error: message }, { status: conflict ? 409 : 400 });
  }
}
