import { dispatchReadyTeamWorkers } from '@/lib/task-teams';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return Response.json({ ok: true, started: await dispatchReadyTeamWorkers(id) }, { status: 202 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not dispatch team' }, { status: 400 });
  }
}
