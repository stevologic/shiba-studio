import { NextRequest, NextResponse } from 'next/server';
import { uploadXaiFile } from '@/lib/xai-files';
import { loadConfig } from '@/lib/persistence';
import { resolveCloudBearer } from '@/lib/xai-oauth';
import { parseModelRef } from '@/lib/model-providers';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;

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
    if (contentLength > MAX_FILE_BYTES + 1024 * 1024) {
      return NextResponse.json({ error: 'Upload exceeds the 48MB limit' }, { status: 413 });
    }
    const form = await req.formData();
    const file = form.get('file');
    const modelRef = String(form.get('model') || 'cloud:grok-4');
    const ref = parseModelRef(modelRef);

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: 'File exceeds the 48MB limit' }, { status: 413 });
    }

    const mimeType = file.type || 'application/octet-stream';
    const isImage = IMAGE_TYPES.has(mimeType) || /\.(jpe?g|png|gif|webp)$/i.test(file.name);

    if (isImage) {
      if (file.size > MAX_INLINE_IMAGE_BYTES) {
        return NextResponse.json({ error: 'Inline images are limited to 12MB' }, { status: 413 });
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const b64 = buf.toString('base64');
      const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${b64}`;
      return NextResponse.json({
        ok: true,
        attachment: {
          kind: 'image',
          name: file.name,
          mimeType,
          dataUrl,
          size: buf.length,
        },
      });
    }

    const buf = Buffer.from(await file.arrayBuffer());

    if (ref.provider === 'local') {
      const text = buf.toString('utf8');
      return NextResponse.json({
        ok: true,
        attachment: {
          kind: 'file',
          name: file.name,
          mimeType,
          size: buf.length,
          textContent: text.slice(0, 8000),
        },
      });
    }

    const cfg = await loadConfig();
    const auth = await resolveCloudBearer(cfg, ref.authSource);
    if (!auth.token) {
      return NextResponse.json({ error: 'Cloud credentials required to upload files (API key or OAuth with X)' }, { status: 400 });
    }
    const uploaded = await uploadXaiFile(file.name, buf, auth.token);
    return NextResponse.json({
      ok: true,
      attachment: {
        kind: 'file',
        name: file.name,
        mimeType,
        fileId: uploaded.id,
        size: buf.length,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Upload failed';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
