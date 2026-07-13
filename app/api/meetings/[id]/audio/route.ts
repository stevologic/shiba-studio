import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { getMeetingAudioDescriptor } from '@/lib/meetings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 200) || 'recording';
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const audio = getMeetingAudioDescriptor(id);
    if (!audio) return Response.json({ ok: false, error: 'Meeting audio is unavailable' }, { status: 410 });
    const stat = await fs.stat(audio.path);
    const size = stat.size;
    const range = request.headers.get('range');
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      if (!match[1] && match[2]) {
        const suffixLength = Number(match[2]);
        if (!Number.isInteger(suffixLength) || suffixLength <= 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        start = Math.max(0, size - suffixLength);
        end = size - 1;
      } else {
        start = match[1] ? Number(match[1]) : 0;
        end = match[2] ? Number(match[2]) : size - 1;
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      status = 206;
    }
    const stream = Readable.toWeb(createReadStream(audio.path, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status,
      headers: {
        'Content-Type': audio.mime,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
        'Content-Disposition': `inline; filename="${safeFilename(audio.filename)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read meeting audio';
    return Response.json({ ok: false, error: message }, { status: /Invalid meeting id/i.test(message) ? 400 : 404 });
  }
}
