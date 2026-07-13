import { getTask, setTaskContract } from '@/lib/task-ledger';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const task = getTask(id);
    if (!task) return Response.json({ ok: false, error: 'Task not found' }, { status: 404 });
    return Response.json({ ok: true, contract: task.contract || null, completion: task.completion || null });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid task id' }, { status: 400 });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const task = setTaskContract(id, body.contract || body);
    return Response.json({ ok: true, contract: task.contract });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid completion contract' }, { status: 400 });
  }
}
