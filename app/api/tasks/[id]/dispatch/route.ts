import { dispatchExistingTask } from '@/lib/background-tasks';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const task = await dispatchExistingTask(id);
    return Response.json({ ok: true, task }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task dispatch failed';
    const status = /not found/i.test(message) ? 404 : /Only queued|Routine drafts/i.test(message) ? 409 : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
