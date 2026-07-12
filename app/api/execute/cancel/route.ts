import { NextRequest } from 'next/server';
import { requestRunCancel } from '@/lib/agent-runtime';

// POST { runId } — ask an in-flight agent run to stop. Best-effort: the run
// ends cleanly (persisted, slot released) at its next step boundary. A no-op if
// the run already finished.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const runId = String(body?.runId || '').trim();
  if (!runId) return Response.json({ ok: false, error: 'runId is required' }, { status: 400 });
  requestRunCancel(runId);
  return Response.json({ ok: true });
}
