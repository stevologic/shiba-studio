// Shared helpers for serving a resolved on-disk file to the UI: a JSON
// inspection (text content or a binary verdict, so the viewer never renders
// garbage) and a raw response with a safe content type. Code files are served
// as text/plain on purpose — agent-authored html/js must never run as scripts
// against the studio's own origin.
import { promises as fs } from 'fs';
import path from 'path';

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

const VIEW_CAP = 512 * 1024;

export interface FileInspect {
  ok: true;
  name: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

/** Read a file for the in-app viewer: UTF-8 text when it really is text, or a
 *  binary verdict (a NUL byte or invalid UTF-8 in the head). Null if unreadable. */
export async function inspectFile(absPath: string, name: string): Promise<FileInspect | null> {
  const data = await fs.readFile(absPath).catch(() => null);
  if (!data) return null;
  const head = data.subarray(0, 8192);
  let binary = head.includes(0);
  if (!binary) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head);
    } catch {
      binary = true;
    }
  }
  const truncated = !binary && data.length > VIEW_CAP;
  return {
    ok: true,
    name,
    size: data.length,
    binary,
    truncated,
    content: binary ? '' : data.subarray(0, VIEW_CAP).toString('utf8'),
  };
}

/** Serve a file's raw bytes with a safe content type (images/pdf inline, code
 *  as text/plain, everything else as a download). */
export async function rawFileResponse(absPath: string, name: string): Promise<Response> {
  const data = await fs.readFile(absPath).catch(() => null);
  if (!data) return Response.json({ ok: false, error: 'File no longer exists on disk' }, { status: 410 });
  const inlineType = INLINE_TYPES[path.extname(absPath).toLowerCase()];
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': inlineType || 'application/octet-stream',
      'Content-Disposition': `${inlineType ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
