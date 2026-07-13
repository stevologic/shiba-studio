import { resolveAttention } from '@/lib/task-ledger';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const item = resolveAttention(id, body.status === 'dismissed' ? 'dismissed' : 'resolved');
    return Response.json({ ok: true, item });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Attention update failed' }, { status: 400 });
  }
}
