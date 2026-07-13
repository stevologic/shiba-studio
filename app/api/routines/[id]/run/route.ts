import { randomUUID } from 'node:crypto';
import { triggerRoutineManually } from '@/lib/routines';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    const result = triggerRoutineManually(
      id,
      body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {},
      String(body.dedupeKey || `manual:${randomUUID()}`),
    );
    return Response.json({ ok: true, ...result }, { status: result.inserted ? 202 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Routine trigger failed';
    return Response.json({ ok: false, error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
