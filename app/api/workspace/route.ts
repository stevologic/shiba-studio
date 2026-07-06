import { NextRequest, NextResponse } from 'next/server';
import {
  listFiles,
  readFileSmart,
  writeFile,
  resolveWorkspace,
  getGlobalUploadsDir,
  GLOBAL_UPLOADS_SUBDIR,
} from '@/lib/workspace';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get('section') === 'uploads-meta') {
    const uploadsPath = await getGlobalUploadsDir();
    return NextResponse.json({ uploadsPath, subdir: GLOBAL_UPLOADS_SUBDIR });
  }
  const dir = searchParams.get('dir') || process.cwd();
  const files = await listFiles(dir);
  return NextResponse.json({ files, resolved: resolveWorkspace(dir) });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (body.action === 'read' && body.path) {
    try {
      const result = await readFileSmart(body.path);
      return NextResponse.json(result);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  }
  const { path, content } = body;
  if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 });
  await writeFile(path, content || '');
  return NextResponse.json({ ok: true });
}
