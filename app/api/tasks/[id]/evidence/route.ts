import { getTaskDetails, recordTaskEvidence } from '@/lib/task-ledger';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const task = getTaskDetails(id);
    if (!task) return Response.json({ ok: false, error: 'Task not found' }, { status: 404 });
    return Response.json({ ok: true, evidence: task.evidence });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid task id' }, { status: 400 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await request.json();
    const evidence = recordTaskEvidence({
      id: body.id,
      taskId: id,
      requirementId: body.requirementId,
      kind: body.kind,
      status: body.status,
      label: body.label,
      summary: body.summary,
      uri: body.uri,
      command: body.command,
      exitCode: body.exitCode,
      scope: body.scope,
      recordedAt: body.recordedAt,
      metadata: body.metadata,
    });
    return Response.json({ ok: true, evidence }, { status: 201 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid task evidence' }, { status: 400 });
  }
}
