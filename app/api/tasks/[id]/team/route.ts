import { createTaskTeam, dispatchReadyTeamWorkers, getTaskTeam } from '@/lib/task-teams';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return Response.json({ ok: true, workers: getTaskTeam(id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not load team' }, { status: /not found/i.test(String(error)) ? 404 : 400 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const workers = await createTaskTeam(id, body.workers);
    const started = body.start === false ? [] : await dispatchReadyTeamWorkers(id);
    return Response.json({ ok: true, workers, started }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not create team' }, { status: 400 });
  }
}
