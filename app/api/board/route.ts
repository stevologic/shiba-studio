import { NextRequest } from 'next/server';
import {
  createBoardTask,
  deleteBoardTask,
  getBoardTask,
  listBoardTasks,
  moveBoardTask,
  updateBoardTask,
} from '@/lib/board';
import { isBoardStatus } from '@/lib/board-types';
import { startWorkOnTask } from '@/lib/board-runner';
import { audit } from '@/lib/audit-log';

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const task = await getBoardTask(id);
    return Response.json(task ? { ok: true, task } : { ok: false, error: 'Not found' }, { status: task ? 200 : 404 });
  }
  const tasks = await listBoardTasks();
  return Response.json({ ok: true, tasks });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  try {
    switch (action) {
      case 'create': {
        const task = await createBoardTask({
          title: String(body.title || ''),
          description: body.description ? String(body.description) : '',
          status: isBoardStatus(body.status) ? body.status : undefined,
          priority: body.priority,
          assigneeAgentId: body.assigneeAgentId ? String(body.assigneeAgentId) : null,
          labels: Array.isArray(body.labels) ? body.labels : [],
        });
        audit('config', 'board card created', `${task.key}: ${task.title.slice(0, 100)}`);
        return Response.json({ ok: true, task });
      }
      case 'update': {
        const task = await updateBoardTask(String(body.id || ''), {
          title: body.title !== undefined ? String(body.title) : undefined,
          description: body.description !== undefined ? String(body.description) : undefined,
          status: isBoardStatus(body.status) ? body.status : undefined,
          priority: body.priority,
          assigneeAgentId: body.assigneeAgentId !== undefined
            ? (body.assigneeAgentId ? String(body.assigneeAgentId) : null)
            : undefined,
          labels: Array.isArray(body.labels) ? body.labels : undefined,
          note: body.note?.text
            ? { kind: 'user', text: String(body.note.text) }
            : undefined,
        });
        return Response.json({ ok: true, task });
      }
      case 'move': {
        const task = await moveBoardTask(
          String(body.id || ''),
          body.status,
          body.beforeId ? String(body.beforeId) : null,
          body.afterId ? String(body.afterId) : null,
        );
        return Response.json({ ok: true, task });
      }
      case 'delete': {
        await deleteBoardTask(String(body.id || ''));
        audit('config', 'board card deleted', String(body.id || ''));
        return Response.json({ ok: true });
      }
      case 'startWork': {
        const started = await startWorkOnTask(String(body.id || ''));
        return Response.json({ ok: true, started });
      }
      default:
        return Response.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Board action failed';
    return Response.json({ ok: false, error: msg }, { status: 400 });
  }
}
