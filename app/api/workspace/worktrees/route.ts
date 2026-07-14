import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { loadAgents } from '@/lib/persistence';
import { ensureWorktree, listWorktrees, resolveWorkspace } from '@/lib/workspace';
import { dataDir } from '@/lib/data-paths';
import { ownershipStoreFencePath, withStoreFileLock } from '@/lib/store-file-lock';
import { listChatSessions } from '@/lib/chat-sessions';
import { listProjects } from '@/lib/projects';
import { getDb } from '@/lib/db';
import {
  listWorktreeResourceRecords,
  reconcileWorktreeResources,
} from '@/lib/worktree-integrity';
import { scheduleWorktreeIntegrityReconciliation } from '@/lib/integrity-coordinator';

function sameWorkspace(left: string, right: string): boolean {
  return normalizedWorkspaceKey(left) === normalizedWorkspaceKey(right);
}

function normalizedWorkspaceKey(value: string): string {
  const resolved = resolveWorkspace(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathIsAtOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function worktreeInventory(workspace: string, focusAgentIds: string[] = []) {
  const snapshot = await withStoreFileLock(ownershipStoreFencePath(dataDir()), async () => {
    const [agents, sessions, projects] = await Promise.all([
      loadAgents(),
      listChatSessions({ includeArchived: true }),
      listProjects(),
    ]);
    const mappedAgents = agents.filter((agent) => agent.workspace.useWorktree
      && sameWorkspace(agent.workspace.path, workspace));
    const projectWorkspaces = new Map(projects.flatMap((project) => (
      typeof project.workspacePath === 'string' && project.workspacePath.trim()
        ? [[project.id, project.workspacePath.trim()] as const]
        : []
    )));
    return { mappedAgents, sessions, projectWorkspaces };
  });
  const activeTasks = (getDb().prepare(`
    SELECT id, title, status, workspaceRoots FROM tasks
    WHERE status IN ('queued','running','paused','waiting_for_input','waiting_for_approval','blocked')
  `).all() as Array<{ id: string; title: string; status: string; workspaceRoots: string }>)
    .map((task) => {
      try {
        const roots = JSON.parse(task.workspaceRoots) as Array<{ path?: unknown }>;
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          workspacePaths: Array.isArray(roots)
            ? roots.flatMap((root) => (
              typeof root?.path === 'string' && root.path.trim() ? [root.path.trim()] : []
            ))
            : [],
        };
      } catch {
        return { id: task.id, title: task.title, status: task.status, workspacePaths: [] };
      }
    });
  // Git branch inspection can be slow on large repositories. Keep the
  // ownership snapshot atomic, then release the fence before read-only Git IO.
  const [result, resourceRecords] = await Promise.all([
    listWorktrees(workspace, [
      ...new Set([...focusAgentIds, ...snapshot.mappedAgents.map((agent) => agent.id)]),
    ]),
    listWorktreeResourceRecords(workspace),
  ]);
  const resourcesByPath = new Map(resourceRecords.map((record) => [
    normalizedWorkspaceKey(record.worktreePath),
    record,
  ]));
  return {
    ...result,
    worktrees: result.worktrees.map((worktree) => {
      const resource = resourcesByPath.get(normalizedWorkspaceKey(worktree.path));
      return {
        ...worktree,
        mappedAgent: snapshot.mappedAgents.some((agent) => agent.id === worktree.agentId),
        managed: Boolean(resource),
        ...(resource ? {
          cleanupState: resource.state,
          ...(resource.attention ? { cleanupAttention: resource.attention } : {}),
          ...(resource.deleteRequestedAt ? { deleteRequestedAt: resource.deleteRequestedAt } : {}),
        } : {}),
        chatConsumers: snapshot.sessions.flatMap((session) => {
          const effectiveWorkspace = typeof session.workspaceDir === 'string' && session.workspaceDir.trim()
            ? session.workspaceDir.trim()
            : typeof session.projectId === 'string'
              ? snapshot.projectWorkspaces.get(session.projectId) || ''
              : '';
          if (!effectiveWorkspace || !pathIsAtOrInside(effectiveWorkspace, worktree.path)) return [];
          return [{ id: session.id, title: session.title || 'Chat', archived: !!session.archived }];
        }),
        activeTaskConsumers: activeTasks.flatMap((task) => {
          const ownsResource = resource?.taskId === task.id
            || task.workspacePaths.some((workspacePath) => pathIsAtOrInside(workspacePath, worktree.path));
          return ownsResource
            ? [{ id: task.id, title: task.title || 'Background task', status: task.status }]
            : [];
        }),
      };
    }),
  };
}

export async function GET(req: NextRequest) {
  const workspace = req.nextUrl.searchParams.get('workspace') || '';
  if (!workspace.trim()) {
    return NextResponse.json({ error: 'workspace query param required' }, { status: 400 });
  }
  try {
    const resolvedWorkspace = resolveWorkspace(workspace);
    const cleanup = await reconcileWorktreeResources({ baseWorkspaces: [resolvedWorkspace] });
    if (cleanup.pending > 0 || cleanup.errors.length > 0) {
      scheduleWorktreeIntegrityReconciliation();
    }
    const result = await worktreeInventory(resolvedWorkspace);
    return NextResponse.json({ ok: true, cleanup, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to list worktrees';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const workspace = String(body.workspace || '').trim();
  const agentId = String(body.agentId || '').trim();
  if (!workspace || !agentId) {
    return NextResponse.json({ error: 'workspace and agentId required' }, { status: 400 });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId) || agentId === '.' || agentId === '..') {
    return NextResponse.json({ error: 'Invalid agentId' }, { status: 400 });
  }

  try {
    if (body.action === 'create') {
      const created = await withStoreFileLock(ownershipStoreFencePath(dataDir()), async () => {
        const agent = (await loadAgents()).find((candidate) => candidate.id === agentId
          && candidate.workspace.useWorktree
          && sameWorkspace(candidate.workspace.path, workspace));
        if (!agent) return null;
        const worktree = await ensureWorktree(workspace, agentId, String(body.branch || 'main'));
        const listed = await worktreeInventory(workspace, [agentId]);
        return { worktree, listed };
      });
      if (!created) {
        return NextResponse.json({ error: 'Agent is not mapped to this worktree workspace' }, { status: 409 });
      }
      return NextResponse.json({ ok: true, worktree: created.worktree, ...created.listed });
    }
    if (body.action === 'remove') {
      const outcome = await withStoreFileLock(ownershipStoreFencePath(dataDir()), async () => {
        const {
          requestWorktreeResourceDeletion,
          worktreeResourcePathExists,
        } = await import('@/lib/worktree-integrity');
        await requestWorktreeResourceDeletion(workspace, agentId, 'Manual cleanup requested.');
        const cleanup = await reconcileWorktreeResources({ baseWorkspaces: [workspace] });
        if (cleanup.pending > 0 || cleanup.errors.length > 0) {
          scheduleWorktreeIntegrityReconciliation();
        }
        const listed = await worktreeInventory(workspace);
        return { listed, removed: !await worktreeResourcePathExists(workspace, agentId) };
      });
      if (!outcome.removed) {
        return NextResponse.json({
          error: 'Worktree is still mapped to a chat, agent, or active task, or contains uncommitted/unpushed work.',
        }, { status: 409 });
      }
      return NextResponse.json({ ok: true, ...outcome.listed });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Worktree action failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
