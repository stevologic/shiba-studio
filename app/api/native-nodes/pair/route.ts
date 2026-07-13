import { NativeNodeError, pairNativeNode, requireNativeNodeTransport } from '@/lib/native-nodes';

export async function POST(request: Request) {
  try {
    requireNativeNodeTransport(request);
    if (Number(request.headers.get('content-length') || 0) > 64 * 1024) throw new NativeNodeError('Pairing request is too large', 413);
    const body = await request.json();
    const paired = pairNativeNode({
      pairingId: body.pairingId,
      code: body.code,
      name: body.name,
      platform: body.platform,
      manifestPayloadBase64: body.manifestPayloadBase64,
      manifestSignature: body.manifestSignature,
    });
    return Response.json({ ok: true, ...paired }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Native-node pairing failed' }, {
      status: error instanceof NativeNodeError ? error.status : 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
