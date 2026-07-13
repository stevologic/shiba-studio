import { queueMeetingTranscription } from '@/lib/meetings';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    const meeting = queueMeetingTranscription(id, {
      language: typeof body.language === 'string' ? body.language : undefined,
      keyterms: Array.isArray(body.keyterms) ? body.keyterms.map(String) : undefined,
      fillerWords: body.fillerWords === true,
    });
    return Response.json({ ok: true, meeting }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not start transcription';
    return Response.json({ ok: false, error: message }, { status: /not found/i.test(message) ? 404 : /already running/i.test(message) ? 409 : 400 });
  }
}
