import { loadConfig } from '@/lib/persistence';
import { PhoneAssistantError } from '@/lib/phone-assistant';
import { acceptIncomingPhoneCall, verifyIncomingPhoneWebhook } from '@/lib/phone-call-session';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY = 64_000;

export async function POST(request: Request) {
  try {
    const cfg = await loadConfig();
    if (cfg.phoneAssistant?.enabled !== true) {
      return Response.json({ ok: false, error: 'Phone assistant is disabled' }, { status: 403 });
    }
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY) {
      return Response.json({ ok: false, error: 'Incoming-call payload is too large' }, { status: 413 });
    }
    await verifyIncomingPhoneWebhook({
      id: request.headers.get('webhook-id') || '',
      timestamp: request.headers.get('webhook-timestamp') || '',
      signature: request.headers.get('webhook-signature') || '',
      rawBody,
    });
    const payload = rawBody ? JSON.parse(rawBody) as unknown : {};
    const accepted = await acceptIncomingPhoneCall(payload);
    return Response.json({ ok: true, ...accepted }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ ok: false, error: 'Incoming-call body must be JSON' }, { status: 400 });
    }
    const status = error instanceof PhoneAssistantError ? error.status : 400;
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Incoming call rejected',
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
