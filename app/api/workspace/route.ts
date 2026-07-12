import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import {
  listFiles,
  readFileSmart,
  writeFile,
  resolveWorkspace,
  getGlobalUploadsDir,
  GLOBAL_UPLOADS_SUBDIR,
} from '@/lib/workspace';
import { rawFileResponse } from '@/lib/serve-file';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get('section') === 'uploads-meta') {
    const uploadsPath = await getGlobalUploadsDir();
    return NextResponse.json({ uploadsPath, subdir: GLOBAL_UPLOADS_SUBDIR });
  }
  // Serve one file for "open in new browser tab". A GET can be embedded/loaded
  // cross-site in ways the JSON POST read cannot, so serve same-origin only.
  const filePath = searchParams.get('file');
  if (filePath) {
    if (req.headers.get('sec-fetch-site') === 'cross-site') {
      return NextResponse.json({ ok: false, error: 'cross-site request blocked' }, { status: 403 });
    }
    const abs = resolveWorkspace(filePath);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) {
      return NextResponse.json({ ok: false, error: 'Not a file' }, { status: 404 });
    }
    return rawFileResponse(abs, path.basename(abs));
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
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }
  const { path, content } = body;
  if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 });
  await writeFile(path, content || '');
  return NextResponse.json({ ok: true });
}
