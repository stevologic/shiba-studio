import type { NextRequest } from 'next/server';
import { listMeetings, MAX_MEETING_AUDIO_BYTES, saveMeetingAudio } from '@/lib/meetings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function decodedHeader(request: Request, name: string): string {
  const value = request.headers.get(name) || '';
  try { return decodeURIComponent(value); } catch { return value; }
}

export async function GET(request: NextRequest) {
  try {
    const meetings = await listMeetings(Number(request.nextUrl.searchParams.get('limit')) || 100);
    return Response.json({ ok: true, meetings }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not load meetings' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_MEETING_AUDIO_BYTES) {
    return Response.json({ ok: false, error: 'Audio exceeds the 50 MB upload limit' }, { status: 413 });
  }
  if (!request.body) return Response.json({ ok: false, error: 'Audio body is required' }, { status: 400 });
  try {
    const meeting = await saveMeetingAudio({
      title: decodedHeader(request, 'x-meeting-title') || 'Untitled meeting',
      source: request.headers.get('x-meeting-source') === 'microphone' ? 'microphone' : 'upload',
      originalFilename: decodedHeader(request, 'x-audio-filename') || 'recording.webm',
      mime: request.headers.get('content-type') || '',
      retentionDays: Number(request.headers.get('x-retention-days')),
      consentConfirmed: request.headers.get('x-consent-confirmed') === 'true',
      stream: request.body,
    });
    return Response.json({ ok: true, meeting }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Meeting upload failed';
    return Response.json({ ok: false, error: message }, { status: /50 MB/i.test(message) ? 413 : 400 });
  }
}
