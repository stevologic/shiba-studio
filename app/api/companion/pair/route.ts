import { CompanionAuthError, exchangeCompanionPairing } from '@/lib/companion-auth';

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 4 * 1024) throw new CompanionAuthError('Pairing request is too large', 413);
    const body = await request.json();
    const result = await exchangeCompanionPairing({
      id: body.pairingId,
      code: body.code,
      deviceName: body.deviceName,
    });
    return Response.json({ ok: true, ...result }, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const status = error instanceof CompanionAuthError ? error.status : 400;
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Pairing failed',
    }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
