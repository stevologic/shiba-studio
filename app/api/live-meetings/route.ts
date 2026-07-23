import type { NextRequest } from 'next/server';
import { createLiveMeeting, listLiveMeetings } from '@/lib/live-meetings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const meetings = listLiveMeetings(Number(request.nextUrl.searchParams.get('limit')) || 100);
    return Response.json({ ok: true, meetings }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not load meetings' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const meeting = await createLiveMeeting({
      title: typeof body.title === 'string' ? body.title : '',
      agentId: String(body.agentId || ''),
      projectId: typeof body.projectId === 'string' ? body.projectId : null,
      focus: typeof body.focus === 'string' ? body.focus : '',
    });
    return Response.json({ ok: true, meeting }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not start the meeting' }, { status: 400 });
  }
}
