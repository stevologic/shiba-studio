import { authenticateNativeNode, claimNativeNodeJob, NativeNodeError } from '@/lib/native-nodes';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  try {
    const auth = authenticateNativeNode(request);
    return Response.json({ ok: true, job: claimNativeNodeJob(auth) }, {
      headers: { 'Cache-Control': 'no-store', Vary: 'Authorization' },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Native-node poll failed' }, {
      status: error instanceof NativeNodeError ? error.status : 400,
    });
  }
}
