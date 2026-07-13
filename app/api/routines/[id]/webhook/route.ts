import { RoutineMaintenanceError, verifyAndEnqueueRoutineWebhook } from '@/lib/routines';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 1_000_000) return Response.json({ ok: false, error: 'Webhook payload exceeds the 1 MB limit' }, { status: 413 });
  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) return Response.json({ ok: false, error: 'Webhook payload exceeds the 1 MB limit' }, { status: 413 });
  try {
    const result = verifyAndEnqueueRoutineWebhook({
      routineId: id,
      triggerId: request.headers.get('x-shiba-trigger') || undefined,
      timestamp: request.headers.get('x-shiba-timestamp') || '',
      signature: request.headers.get('x-shiba-signature') || '',
      deliveryId: request.headers.get('x-shiba-delivery') || undefined,
      rawBody,
    });
    return Response.json({ ok: true, accepted: result.inserted, invocationId: result.invocation.id }, { status: result.inserted ? 202 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook rejected';
    if (error instanceof RoutineMaintenanceError) {
      return Response.json({ ok: false, error: message, retryable: true }, {
        status: 503,
        headers: { 'Retry-After': '5' },
      });
    }
    const status = /not found/i.test(message) ? 404 : /signature|timestamp|replay/i.test(message) ? 401 : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
