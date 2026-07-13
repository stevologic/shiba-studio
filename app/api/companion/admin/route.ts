import {
  CompanionAuthError,
  createCompanionPairing,
  listCompanionDevices,
  remoteAccessStatus,
  requireLocalCompanionAdmin,
  revokeCompanionDevice,
  setRemoteAccessEnabled,
} from '@/lib/companion-auth';

export const dynamic = 'force-dynamic';

function errorResponse(error: unknown) {
  const status = error instanceof CompanionAuthError ? error.status : 400;
  return Response.json({
    ok: false,
    error: error instanceof Error ? error.message : 'Companion administration failed',
  }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  try {
    requireLocalCompanionAdmin(request);
    return Response.json({
      ok: true,
      remoteAccess: await remoteAccessStatus(),
      devices: listCompanionDevices(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireLocalCompanionAdmin(request);
    const body = await request.json();
    if (body.action === 'set_enabled') {
      await setRemoteAccessEnabled(body.enabled === true);
      return Response.json({ ok: true, remoteAccess: await remoteAccessStatus() });
    }
    if (body.action === 'create_pairing') {
      const pairing = await createCompanionPairing({
        companionOrigin: String(body.companionOrigin || ''),
        scopes: body.scopes,
      });
      return Response.json({ ok: true, pairing }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    }
    if (body.action === 'revoke_device') {
      return Response.json({ ok: true, device: revokeCompanionDevice(String(body.deviceId || '')) });
    }
    return Response.json({ ok: false, error: 'Unknown companion admin action' }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
