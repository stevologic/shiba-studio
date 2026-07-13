import type { NextRequest } from 'next/server';
import { createTask, listTasks } from '@/lib/task-ledger';
import type { TaskKind, TaskOriginType, TaskStatus } from '@/lib/task-types';

export const dynamic = 'force-dynamic';

function csv<T extends string>(value: string | null): T[] | undefined {
  const items = value?.split(',').map((item) => item.trim()).filter(Boolean) as T[] | undefined;
  return items?.length ? items : undefined;
}

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    const result = listTasks({
      statuses: csv<TaskStatus>(query.get('status')),
      kinds: csv<TaskKind>(query.get('kind')),
      parentId: query.get('parentId') || undefined,
      originType: (query.get('originType') || undefined) as TaskOriginType | undefined,
      originId: query.get('originId') || undefined,
      agentId: query.get('agentId') || undefined,
      projectId: query.get('projectId') || undefined,
      sessionId: query.get('sessionId') || undefined,
      q: query.get('q') || undefined,
      limit: Number(query.get('limit')) || undefined,
      offset: Number(query.get('offset')) || undefined,
    });
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Invalid task query' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const task = createTask({
      id: body.id,
      kind: body.kind,
      title: body.title,
      description: body.description,
      status: body.status,
      parentId: body.parentId,
      originType: body.originType || 'api',
      originId: body.originId,
      agentId: body.agentId,
      projectId: body.projectId,
      runId: body.runId,
      sessionId: body.sessionId,
      workspaceRoots: body.workspaceRoots,
      plan: body.plan,
      maxRetries: body.maxRetries,
      contract: body.contract,
      metadata: body.metadata,
    });
    return Response.json({ ok: true, task }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid task';
    const conflict = /UNIQUE|already exists/i.test(message);
    return Response.json({ ok: false, error: message }, { status: conflict ? 409 : 400 });
  }
}
