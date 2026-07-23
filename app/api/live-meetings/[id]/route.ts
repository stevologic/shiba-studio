import { deleteLiveMeeting, getLiveMeeting } from '@/lib/live-meetings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const meeting = getLiveMeeting(id);
    if (!meeting) return Response.json({ ok: false, error: 'Meeting not found' }, { status: 404 });
    return Response.json({ ok: true, meeting }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not load the meeting' }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    deleteLiveMeeting(id);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not delete the meeting';
    // Not found → 404; summarizing / concurrent version races → 409; other validation → 400.
    const status = /not found/i.test(message)
      ? 404
      : /concurrently|minutes to finish/i.test(message)
        ? 409
        : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
