import { remoteAccessStatus } from '@/lib/companion-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await remoteAccessStatus();
  return Response.json({ ok: true, enabled: status.enabled }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
