import { CheckpointConflictError, restoreTaskCheckpoint } from '@/lib/task-checkpoints';

export const dynamic = 'force-dynamic';

/** Explicitly destructive rewind; confirmation is bound to this checkpoint. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; checkpointId: string }> },
) {
  const { id, checkpointId } = await context.params;
  try {
    const body = await request.json();
    if (body.confirmCheckpointId !== checkpointId) {
      return Response.json({
        ok: false,
        error: 'confirmCheckpointId must exactly match the checkpoint being restored',
      }, { status: 428 });
    }
    const restore = await restoreTaskCheckpoint(id, checkpointId);
    return Response.json({ ok: true, restore });
  } catch (error) {
    if (error instanceof CheckpointConflictError) {
      return Response.json({ ok: false, error: error.message, restore: error.restore }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Could not restore checkpoint';
    return Response.json({ ok: false, error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
