import {
  getTaskCheckpoint,
  listTaskCheckpointRestores,
  sealTaskCheckpoint,
} from '@/lib/task-checkpoints';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; checkpointId: string }> },
) {
  const { id, checkpointId } = await context.params;
  try {
    const checkpoint = getTaskCheckpoint(checkpointId, id);
    if (!checkpoint) return Response.json({ ok: false, error: 'Checkpoint not found' }, { status: 404 });
    const restores = listTaskCheckpointRestores(id, checkpointId);
    return Response.json({ ok: true, checkpoint, restores }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Could not read checkpoint',
    }, { status: 400 });
  }
}

/** Seal the post-mutation bytes. Open checkpoints cannot be restored. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; checkpointId: string }> },
) {
  const { id, checkpointId } = await context.params;
  try {
    const body = await request.json();
    if (body.action !== 'seal') {
      return Response.json({ ok: false, error: 'Only the seal action is supported' }, { status: 400 });
    }
    const checkpoint = await sealTaskCheckpoint(id, checkpointId);
    return Response.json({ ok: true, checkpoint });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not seal checkpoint';
    return Response.json({ ok: false, error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
