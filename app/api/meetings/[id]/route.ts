import { deleteMeeting, deleteMeetingAudio, getMeeting, updateMeetingReview } from '@/lib/meetings';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const meeting = getMeeting(id);
    return meeting
      ? Response.json({ ok: true, meeting }, { headers: { 'Cache-Control': 'no-store' } })
      : Response.json({ ok: false, error: 'Meeting not found' }, { status: 404 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid meeting id' }, { status: 400 });
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
    const meeting = updateMeetingReview(id, {
      expectedVersion,
      title: body.title,
      summary: body.summary,
      decisions: body.decisions,
      actionItems: body.actionItems,
      speakerLabels: body.speakerLabels,
      retentionDays: body.retentionDays,
    });
    return Response.json({ ok: true, meeting });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Meeting update failed';
    return Response.json({ ok: false, error: message }, { status: /concurrently/i.test(message) ? 409 : 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const audioOnly = new URL(request.url).searchParams.get('audioOnly') === 'true';
    if (audioOnly) {
      const meeting = await deleteMeetingAudio(id);
      return Response.json({ ok: true, meeting });
    }
    await deleteMeeting(id);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Meeting deletion failed';
    return Response.json({ ok: false, error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
