import { GrokBotError } from '@/lib/grok-bot';
import {
  buildGrokBotSetup,
  getGrokBotStatus,
  requireLocalGrokBotAdmin,
  revokeGrokBotToken,
  rotateGrokBotToken,
  setGrokBotEnabled,
} from '@/lib/grok-bot';

export const dynamic = 'force-dynamic';

function errorResponse(error: unknown): Response {
  const status = error instanceof GrokBotError ? error.status : 400;
  const message = error instanceof Error ? error.message : 'Grok Bot connector request failed';
  return Response.json({ ok: false, error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  try {
    requireLocalGrokBotAdmin(request);
    const status = await getGrokBotStatus(request);
    return Response.json({
      ok: true,
      status,
      setup: buildGrokBotSetup(status),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireLocalGrokBotAdmin(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || '');
    if (action === 'set_enabled') {
      const status = await setGrokBotEnabled(body.enabled === true);
      return Response.json({ ok: true, status, setup: buildGrokBotSetup(status) });
    }
    if (action === 'rotate_token') {
      const { status, issued } = await rotateGrokBotToken();
      return Response.json({
        ok: true,
        status,
        token: issued.token,
        setup: buildGrokBotSetup(status, issued.token),
      }, { status: 201 });
    }
    if (action === 'revoke_token') {
      const status = await revokeGrokBotToken();
      return Response.json({ ok: true, status, setup: buildGrokBotSetup(status) });
    }
    return Response.json({ ok: false, error: `Unknown Grok Bot admin action "${action}"` }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
