import { postHarnessCallback } from '@/lib/harness-grants';

function bearer(request: Request): string {
  return request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() || '';
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const grant = postHarnessCallback({
      id,
      token: bearer(request),
      status: body.status,
      summary: String(body.summary || ''),
      evidence: body.evidence,
    });
    const { audit } = await import('@/lib/audit-log');
    audit('run', 'external harness callback', `${grant.provider}:${body.status}`, {
      taskId: grant.taskId,
      childTaskId: grant.childTaskId,
      grantId: grant.id,
    });
    return Response.json({ ok: true, grant });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Harness callback failed' }, { status: 400 });
  }
}
