import { authenticateNativeNode, completeNativeNodeJob, NativeNodeError } from '@/lib/native-nodes';

export async function POST(request: Request) {
  try {
    const auth = authenticateNativeNode(request);
    if (Number(request.headers.get('content-length') || 0) > 12 * 1024 * 1024) throw new NativeNodeError('Native-node result is too large', 413);
    const body = await request.json();
    return Response.json({ ok: true, job: await completeNativeNodeJob(auth, body.payloadBase64, body.signature) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Native-node completion failed' }, {
      status: error instanceof NativeNodeError ? error.status : 400,
    });
  }
}
