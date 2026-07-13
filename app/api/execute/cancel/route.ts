import { NextRequest } from 'next/server';
import { requestRunCancel } from '@/lib/agent-runtime';
import { listActiveRuns } from '@/lib/run-guards';

// POST { runId } — ask an in-flight agent run to stop. Best-effort: the run
// ends cleanly (persisted, slot released) at its next step boundary. A no-op if
// the run already finished.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const runId = String(body?.runId || '').trim();
  if (!runId) return Response.json({ ok: false, error: 'runId is required' }, { status: 400 });
  if (!listActiveRuns().some((run) => run.runId === runId)) {
    return Response.json({ ok: false, error: 'Run is not active' }, { status: 404 });
  }
  requestRunCancel(runId);
  return Response.json({ ok: true });
}
