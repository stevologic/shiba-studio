import {
  createNativeNodeGrant,
  createNativeNodePairing,
  enqueueNativeNodeJob,
  listNativeNodeGrants,
  listNativeNodeJobs,
  listNativeNodes,
  NativeNodeError,
  requireLocalNativeNodeAdmin,
  revokeNativeNode,
  revokeNativeNodeGrant,
} from '@/lib/native-nodes';

export const dynamic = 'force-dynamic';

function failure(error: unknown) {
  return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Native-node administration failed' }, {
    status: error instanceof NativeNodeError ? error.status : 400,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function checkedNodeOrigin(value: unknown): string {
  const url = new URL(String(value || 'https://shiba.local:3000'));
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new NativeNodeError('Node origin must be a plain HTTPS or loopback URL');
  }
  return url.origin;
}

function psLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function GET(request: Request) {
  try {
    requireLocalNativeNodeAdmin(request);
    return Response.json({
      ok: true,
      nodes: listNativeNodes(),
      grants: listNativeNodeGrants(),
      jobs: listNativeNodeJobs(undefined, 50),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    requireLocalNativeNodeAdmin(request);
    const body = await request.json();
    if (body.action === 'create_pairing') {
      const pairing = createNativeNodePairing(body.capabilities);
      const origin = checkedNodeOrigin(body.nodeOrigin);
      const setupCommand = `$d="$env:LOCALAPPDATA\\ShibaNode"; New-Item -ItemType Directory -Force $d | Out-Null; `
        + `@('shiba-node-helper.ps1','shiba-node-helper-core.ps1','release-manifest.json','release-manifest.sig','release-public.json') | % { Invoke-WebRequest (${psLiteral(`${origin}/api/native-nodes/release/`)} + $_) -OutFile "$d\\$_" }; `
        + `powershell -NoProfile -ExecutionPolicy Bypass -STA -File "$d\\shiba-node-helper.ps1" -HostUrl ${psLiteral(origin)} -PairingId ${psLiteral(pairing.id)} -PairingCode ${psLiteral(pairing.code)}`;
      return Response.json({ ok: true, pairing: { ...pairing, setupCommand } }, { status: 201 });
    }
    if (body.action === 'revoke_node') return Response.json({ ok: true, node: revokeNativeNode(String(body.nodeId || '')) });
    if (body.action === 'create_grant') return Response.json({ ok: true, grant: createNativeNodeGrant(body) }, { status: 201 });
    if (body.action === 'revoke_grant') return Response.json({ ok: true, grant: revokeNativeNodeGrant(String(body.grantId || '')) });
    if (body.action === 'enqueue_job') return Response.json({ ok: true, job: enqueueNativeNodeJob(body) }, { status: 202 });
    return Response.json({ ok: false, error: 'Unknown native-node admin action' }, { status: 400 });
  } catch (error) { return failure(error); }
}
