import { NextRequest, NextResponse } from 'next/server';
import { getRun, listRunSummaries } from '@/lib/agent-runs-store';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Full run (with trace) by id — fetched on demand when a row is opened.
  const id = searchParams.get('id');
  if (id) {
    const run = await getRun(id);
    if (!run) return NextResponse.json({ ok: false, error: 'Run not found' }, { status: 404 });
    return NextResponse.json({ ok: true, run });
  }

  // Default: lightweight summaries (no trace payloads) — fast dashboard path.
  const agentId = searchParams.get('agentId') || undefined;
  const limit = Number(searchParams.get('limit')) || 50;
  const runs = await listRunSummaries({ agentId, limit });
  return NextResponse.json({ ok: true, runs });
}
