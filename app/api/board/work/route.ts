import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { collectCardWork, resolveCardDeliverable } from '@/lib/board-work';

/** Inline-safe types: render in the browser tab. Everything else downloads. */
const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  // Code files render as plain text — html/js deliberately NOT served as
  // executable types: same-origin scripts from agent output must never run
  // against the studio.
  '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.htm': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
};

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id') || '';
  if (!id) return Response.json({ ok: false, error: 'id is required' }, { status: 400 });

  const filePath = req.nextUrl.searchParams.get('file');
  if (!filePath) {
    const work = await collectCardWork(id);
    return Response.json(
      work ? { ok: true, work } : { ok: false, error: 'Card not found' },
      { status: work ? 200 : 404 },
    );
  }

  // Serve one deliverable — only if it really is a deliverable of this card
  // (the card id acts as the capability; arbitrary paths are rejected).
  const deliverable = await resolveCardDeliverable(id, filePath);
  if (!deliverable) {
    return Response.json({ ok: false, error: 'Not a deliverable of this card' }, { status: 404 });
  }
  const data = await fs.readFile(deliverable.absPath).catch(() => null);
  if (!data) {
    return Response.json({ ok: false, error: 'File no longer exists on disk' }, { status: 410 });
  }

  // inspect=1 → JSON for the in-app file reader: text content when the file
  // really is text, or a binary verdict so the UI can say so instead of
  // rendering garbage. A NUL byte or invalid UTF-8 in the head = binary.
  if (req.nextUrl.searchParams.get('inspect') === '1') {
    const head = data.subarray(0, 8192);
    let binary = head.includes(0);
    if (!binary) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(head);
      } catch {
        binary = true;
      }
    }
    const VIEW_CAP = 512 * 1024;
    const truncated = !binary && data.length > VIEW_CAP;
    return Response.json({
      ok: true,
      name: deliverable.name,
      size: data.length,
      binary,
      truncated,
      content: binary ? '' : data.subarray(0, VIEW_CAP).toString('utf8'),
    });
  }

  const ext = path.extname(deliverable.absPath).toLowerCase();
  const inlineType = INLINE_TYPES[ext];
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': inlineType || 'application/octet-stream',
      'Content-Disposition': `${inlineType ? 'inline' : 'attachment'}; filename="${deliverable.name.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
