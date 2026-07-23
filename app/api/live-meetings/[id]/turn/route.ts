import { runLiveMeetingTurn } from '@/lib/live-meetings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Turns call the model and may capture a screenshot — allow slow replies. */
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    const text = typeof body.text === 'string' ? body.text : null;
    const stageTurnId = typeof body.stageTurnId === 'string' ? body.stageTurnId : undefined;
    const meeting = await runLiveMeetingTurn(id, text, { stageTurnId });
    return Response.json({ ok: true, meeting });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Meeting turn failed';
    return Response.json({ ok: false, error: message }, { status: /already responding/i.test(message) ? 409 : 400 });
  }
}
