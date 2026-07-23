import { endLiveMeeting } from '@/lib/live-meetings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const meeting = await endLiveMeeting(id);
    return Response.json({ ok: true, meeting });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not end the meeting' }, { status: 400 });
  }
}
