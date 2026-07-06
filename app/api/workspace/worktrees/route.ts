import { NextRequest, NextResponse } from 'next/server';
import { loadAgents } from '@/lib/persistence';
import { ensureWorktree, listWorktrees, removeWorktree } from '@/lib/workspace';

export async function GET(req: NextRequest) {
  const workspace = req.nextUrl.searchParams.get('workspace') || '';
  if (!workspace.trim()) {
    return NextResponse.json({ error: 'workspace query param required' }, { status: 400 });
  }
  try {
    const agents = await loadAgents();
    const agentIds = agents
      .filter((a) => a.workspace.path === workspace || a.workspace.useWorktree)
      .map((a) => a.id);
    const result = await listWorktrees(workspace, agentIds);
    return NextResponse.json({ ok: true, ...result });
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

  try {
    if (body.action === 'create') {
      const wt = await ensureWorktree(workspace, agentId, body.branch || 'main');
      const listed = await listWorktrees(workspace, [agentId]);
      return NextResponse.json({ ok: true, worktree: wt, ...listed });
    }
    if (body.action === 'remove') {
      const removed = await removeWorktree(workspace, agentId);
      if (!removed.ok) return NextResponse.json({ error: removed.error }, { status: 400 });
      const listed = await listWorktrees(workspace, []);
      return NextResponse.json({ ok: true, ...listed });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Worktree action failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}