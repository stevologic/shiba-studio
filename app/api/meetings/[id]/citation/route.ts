import { getMeeting } from '@/lib/meetings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function secondsLabel(value: number): string {
  const minutes = Math.floor(Math.max(0, value) / 60);
  const seconds = Math.max(0, value) - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const meeting = getMeeting(id);
    if (!meeting) return new Response('Transcript citation not found.', { status: 404 });

    const url = new URL(request.url);
    const requestedStart = Math.max(0, Number(url.searchParams.get('t')) || 0);
    const segment = meeting.segments.find((candidate) => Math.abs(candidate.start - requestedStart) < 0.01)
      || meeting.segments.find((candidate) => candidate.start <= requestedStart && candidate.end >= requestedStart)
      || [...meeting.segments].sort((a, b) => Math.abs(a.start - requestedStart) - Math.abs(b.start - requestedStart))[0];
    const speaker = segment ? meeting.speakerLabels[segment.speakerId] || segment.speakerId : '';
    const transcript = segment?.text || meeting.transcriptText || 'Transcript is not available yet.';
    const timing = segment ? `${secondsLabel(segment.start)}–${secondsLabel(segment.end)}` : secondsLabel(requestedStart);
    const body = [meeting.title || 'Voice request', `${timing}${speaker ? ` · ${speaker}` : ''}`, '', transcript].join('\n');

    return new Response(body, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read transcript citation';
    return new Response(message, { status: /Invalid meeting id/i.test(message) ? 400 : 404 });
  }
}
