import { NextRequest, NextResponse } from 'next/server';
import { buildProjectChatContext, getProject } from '@/lib/projects';
import { loadConfig } from '@/lib/persistence';

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const cfg = await loadConfig();
  const context = await buildProjectChatContext(project, cfg.defaultWorkspace);
  return NextResponse.json({ ok: true, context, fileCount: project.files.length });
}