import { createHarnessGrant, listHarnessGrants } from '@/lib/harness-grants';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const taskId = new URL(request.url).searchParams.get('taskId') || undefined;
    return Response.json({ ok: true, grants: listHarnessGrants(taskId) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not list harness grants' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = createHarnessGrant({
      taskId: body.taskId,
      provider: body.provider,
      workspaceRootId: body.workspaceRootId,
      allowedTools: body.allowedTools,
      ttlSeconds: body.ttlSeconds,
    });
    const { audit } = await import('@/lib/audit-log');
    audit('run', 'external harness grant issued', `${result.grant.provider}:${result.grant.id}`, {
      taskId: result.grant.taskId,
      childTaskId: result.grant.childTaskId,
      workspaceRootId: result.grant.workspaceRootId,
      expiresAt: result.grant.expiresAt,
    });
    return Response.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not issue harness grant' }, { status: 400 });
  }
}
