import { createTaskCheckpoint, listTaskCheckpoints } from '@/lib/task-checkpoints';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const url = new URL(request.url);
    const checkpoints = listTaskCheckpoints(id, Number(url.searchParams.get('limit') || 100));
    return Response.json({ ok: true, checkpoints }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not list checkpoints';
    return Response.json({ ok: false, error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}

/** Capture declared task-owned paths before the caller mutates them. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const checkpoint = await createTaskCheckpoint({
      taskId: id,
      reason: body.reason,
      files: body.files,
      context: body.context,
    });
    return Response.json({ ok: true, checkpoint }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create checkpoint';
    return Response.json({ ok: false, error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
