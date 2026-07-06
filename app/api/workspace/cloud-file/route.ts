import { NextRequest, NextResponse } from 'next/server';
import { setApiKey } from '@/lib/grok-client';
import { downloadXaiFileContent, getXaiFileMeta } from '@/lib/xai-files';
import { loadConfig } from '@/lib/persistence';
import { resolveCloudBearer } from '@/lib/xai-oauth';

function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    md: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    json: 'application/json; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
  };
  return map[ext || ''] || 'application/octet-stream';
}

export async function GET(req: NextRequest) {
  const fileId = req.nextUrl.searchParams.get('fileId');
  if (!fileId) {
    return NextResponse.json({ error: 'fileId required' }, { status: 400 });
  }

  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) {
    return NextResponse.json({ error: 'Cloud credentials required (API key or OAuth with X)' }, { status: 400 });
  }
  setApiKey(auth.token);

  try {
    const meta = await getXaiFileMeta(fileId);
    const buf = await downloadXaiFileContent(fileId);
    const filename = meta.filename || fileId;
    const mime = guessMime(filename);
    const inline = mime.startsWith('image/') || mime.startsWith('text/') || mime === 'application/pdf';

    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(buf.length),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to load cloud file';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}