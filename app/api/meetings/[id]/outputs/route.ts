import { createMeetingOutputs } from '@/lib/meetings';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const outputs = await createMeetingOutputs({
      meetingId: id,
      confirmed: body.confirmed === true,
      actionItemIds: Array.isArray(body.actionItemIds) ? body.actionItemIds.map(String) : [],
      createBoardCards: body.createBoardCards === true,
      createRoutines: body.createRoutines === true,
      routineAgentId: typeof body.routineAgentId === 'string' ? body.routineAgentId : undefined,
    });
    return Response.json({ ok: true, outputs }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not create meeting outputs' }, { status: 400 });
  }
}
