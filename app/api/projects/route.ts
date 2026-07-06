import { NextRequest, NextResponse } from 'next/server';
import {
  createProject,
  deleteProject,
  deleteProjectFile,
  getProject,
  listProjects,
  saveProjectMessages,
  updateProject,
} from '@/lib/projects';

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const project = await getProject(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true, project });
  }
  const projects = await listProjects();
  return NextResponse.json({ ok: true, projects });
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (body.action === 'create') {
    const project = await createProject(body.name || 'New Project', body.description || '');
    return NextResponse.json({ ok: true, project });
  }

  if (body.action === 'update') {
    const patch: Parameters<typeof updateProject>[1] = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.instructions !== undefined) patch.instructions = String(body.instructions);
    if (body.workspacePath !== undefined) patch.workspacePath = String(body.workspacePath);
    if (body.defaultAgentId !== undefined) patch.defaultAgentId = String(body.defaultAgentId);
    const project = await updateProject(body.id, patch);
    return NextResponse.json({ ok: true, project });
  }

  if (body.action === 'delete') {
    await deleteProject(body.id);
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'saveMessages') {
    const project = await saveProjectMessages(body.id, body.messages || []);
    return NextResponse.json({ ok: true, project });
  }

  if (body.action === 'deleteFile') {
    const project = await deleteProjectFile(body.id, body.fileId);
    return NextResponse.json({ ok: true, project });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}