import { runDoctor } from '@/lib/doctor';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json({ ok: true, report: await runDoctor() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Doctor failed' }, { status: 500 });
  }
}
