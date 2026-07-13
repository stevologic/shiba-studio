import { listLearningJourney } from '@/lib/capability-packs';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json({ ok: true, entries: listLearningJourney() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not load learning journey' }, { status: 500 });
  }
}
