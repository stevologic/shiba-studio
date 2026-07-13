import { NextRequest, NextResponse } from 'next/server';
import { addProjectFile, getProject } from '@/lib/projects';

const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_FILE_COUNT = 20;

export async function POST(req: NextRequest) {
  try {
    const lengthHeader = req.headers.get('content-length');
    if (!lengthHeader) {
      return NextResponse.json({ error: 'Content-Length is required for bounded uploads' }, { status: 411 });
    }
    const contentLength = Number(lengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return NextResponse.json({ error: 'Invalid Content-Length' }, { status: 400 });
    }
    if (contentLength > MAX_TOTAL_BYTES + 1024 * 1024) {
      return NextResponse.json({ error: 'Upload batch exceeds the 96MB limit' }, { status: 413 });
    }
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
    const files = items.filter((item): item is File => item instanceof File);
    if (files.length > MAX_FILE_COUNT) {
      return NextResponse.json({ error: `Upload at most ${MAX_FILE_COUNT} files at once` }, { status: 413 });
    }
    if (files.some((file) => file.size > MAX_FILE_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: 'A file exceeds 48MB or the batch exceeds 96MB' }, { status: 413 });
    }
    const saved = [];
    const errors: string[] = [];

    for (const item of files) {
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
