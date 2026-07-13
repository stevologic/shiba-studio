import { startHarnessGrant } from '@/lib/harness-grants';

function bearer(request: Request): string {
  return request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() || '';
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json().catch(() => ({}));
    const grant = await startHarnessGrant(id, bearer(request), String(body.instruction || ''));
    return Response.json({ ok: true, grant }, { status: 202 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Harness start failed' }, { status: 400 });
  }
}
