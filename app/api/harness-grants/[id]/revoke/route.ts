import { revokeHarnessGrant } from '@/lib/harness-grants';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const grant = revokeHarnessGrant(id);
    const { audit } = await import('@/lib/audit-log');
    audit('run', 'external harness grant revoked', `${grant.provider}:${grant.id}`, {
      taskId: grant.taskId,
      childTaskId: grant.childTaskId,
    });
    return Response.json({ ok: true, grant });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Harness revocation failed' }, { status: 400 });
  }
}
