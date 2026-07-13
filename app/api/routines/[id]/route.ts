import {
  deleteRoutine,
  getRoutine,
  listRoutineInvocations,
  resetRoutineCircuit,
  updateRoutine,
} from '@/lib/routines';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const routine = getRoutine(id);
  if (!routine) return Response.json({ ok: false, error: 'Routine not found' }, { status: 404 });
  return Response.json({ ok: true, routine, invocations: listRoutineInvocations(id) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const expectedVersion = Number(body.expectedVersion ?? request.headers.get('if-match'));
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return Response.json({ ok: false, error: 'expectedVersion or If-Match is required' }, { status: 428 });
    }
    const routine = body.action === 'reset_circuit'
      ? resetRoutineCircuit(id, expectedVersion)
      : updateRoutine(id, body, expectedVersion);
    return Response.json({ ok: true, routine });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Routine update failed';
    return Response.json({ ok: false, error: message }, { status: /concurrently/i.test(message) ? 409 : 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    const expectedVersion = Number(body.expectedVersion ?? request.headers.get('if-match'));
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return Response.json({ ok: false, error: 'expectedVersion or If-Match is required' }, { status: 428 });
    }
    deleteRoutine(id, expectedVersion);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Routine deletion failed';
    return Response.json({ ok: false, error: message }, { status: /concurrently/i.test(message) ? 409 : 400 });
  }
}
