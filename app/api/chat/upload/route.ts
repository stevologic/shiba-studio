import { NextRequest, NextResponse } from 'next/server';
import { setApiKey } from '@/lib/grok-client';
import { uploadXaiFile } from '@/lib/xai-files';
import { loadConfig } from '@/lib/persistence';
import { resolveCloudBearer } from '@/lib/xai-oauth';
import { parseModelRef } from '@/lib/model-providers';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    const modelRef = String(form.get('model') || 'cloud:grok-4');
    const ref = parseModelRef(modelRef);

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || 'application/octet-stream';
    const isImage = IMAGE_TYPES.has(mimeType) || /\.(jpe?g|png|gif|webp)$/i.test(file.name);

    if (isImage) {
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
    const auth = await resolveCloudBearer(cfg);
    if (!auth.token) {
      return NextResponse.json({ error: 'Cloud credentials required to upload files (API key or OAuth with X)' }, { status: 400 });
    }
    setApiKey(auth.token);

    const uploaded = await uploadXaiFile(file.name, buf);
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