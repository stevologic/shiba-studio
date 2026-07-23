import { convertLiveMeetingTodos } from '@/lib/live-meetings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const meeting = await convertLiveMeetingTodos({
      meetingId: id,
      todoIds: Array.isArray(body.todoIds) ? body.todoIds.map(String) : [],
      confirmed: body.confirmed === true,
    });
    return Response.json({ ok: true, meeting }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not create Board cards' }, { status: 400 });
  }
}
