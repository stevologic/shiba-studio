import { authenticateNativeNode, NativeNodeError, recordNativeNodeEvent } from '@/lib/native-nodes';

export async function POST(request: Request) {
  try {
    const auth = authenticateNativeNode(request);
    if (!auth.node.capabilities.includes('quick_entry')) throw new NativeNodeError('Node lacks quick-entry capability', 403);
    if (Number(request.headers.get('content-length') || 0) > 64 * 1024) throw new NativeNodeError('Native-node event is too large', 413);
    const body = await request.json();
    return Response.json({ ok: true, ...recordNativeNodeEvent(auth, body.payloadBase64, body.signature) }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Native-node event failed' }, {
      status: error instanceof NativeNodeError ? error.status : 400,
    });
  }
}
