import { PhoneAssistantError } from '@/lib/phone-assistant';
import {
  buildPhoneAssistantSetup,
  getPhoneAssistantStatus,
  requireLocalPhoneAdmin,
  revokePhoneToken,
  rotatePhoneToken,
  setPhoneAssistantEnabled,
  updatePhoneAssistantSettings,
} from '@/lib/phone-assistant';

export const dynamic = 'force-dynamic';

function errorResponse(error: unknown): Response {
  const status = error instanceof PhoneAssistantError ? error.status : 400;
  const message = error instanceof Error ? error.message : 'Phone assistant request failed';
  return Response.json({ ok: false, error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  try {
    requireLocalPhoneAdmin(request);
    const status = await getPhoneAssistantStatus(request);
    return Response.json({
      ok: true,
      status,
      setup: buildPhoneAssistantSetup(status),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireLocalPhoneAdmin(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || '');
    if (action === 'set_enabled') {
      const status = await setPhoneAssistantEnabled(body.enabled === true);
      return Response.json({ ok: true, status, setup: buildPhoneAssistantSetup(status) });
    }
    if (action === 'rotate_token') {
      const { status, issued } = await rotatePhoneToken();
      return Response.json({
        ok: true,
        status,
        token: issued.token,
        setup: buildPhoneAssistantSetup(status, issued.token),
      }, { status: 201 });
    }
    if (action === 'revoke_token') {
      const status = await revokePhoneToken();
      return Response.json({ ok: true, status, setup: buildPhoneAssistantSetup(status) });
    }
    if (action === 'update') {
      const status = await updatePhoneAssistantSettings({
        phoneNumber: body.phoneNumber === undefined ? undefined : String(body.phoneNumber || ''),
        webhookSecret: body.webhookSecret === undefined ? undefined : String(body.webhookSecret || ''),
        allowedCallers: Array.isArray(body.allowedCallers) ? body.allowedCallers.map(String) : undefined,
      });
      return Response.json({ ok: true, status, setup: buildPhoneAssistantSetup(status) });
    }
    return Response.json({ ok: false, error: `Unknown phone admin action "${action}"` }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
