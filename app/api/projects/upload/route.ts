import { NextRequest, NextResponse } from 'next/server';
import { addProjectFile, getProject } from '@/lib/projects';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const projectId = String(form.get('projectId') || '');
    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400 });
    }

    const project = await getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const items = form.getAll('files');
    const saved = [];
    const errors: string[] = [];

    for (const item of items) {
      if (!(item instanceof File)) continue;
      try {
        const buf = Buffer.from(await item.arrayBuffer());
        const meta = await addProjectFile(projectId, item.name, buf, item.type || undefined);
        saved.push(meta);
      } catch (e: unknown) {
        errors.push(`${item.name}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }

    const updated = await getProject(projectId);
    return NextResponse.json({ ok: true, saved, errors, project: updated });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Upload failed' }, { status: 400 });
  }
}