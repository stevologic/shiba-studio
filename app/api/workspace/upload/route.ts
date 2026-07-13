import { NextRequest, NextResponse } from 'next/server';
import { removeCloudSyncByLocalName } from '@/lib/cloud-sync';
import { deleteGlobalUploadFile, sanitizeUploadName, saveUploadFromBuffer } from '@/lib/workspace';

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
    const items = form.getAll('files');
    if (!items.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }
    const files = items.filter((item): item is File => item instanceof File);
    if (files.length > MAX_FILE_COUNT) {
      return NextResponse.json({ error: `Upload at most ${MAX_FILE_COUNT} files at once` }, { status: 413 });
    }
    if (files.some((file) => file.size > MAX_FILE_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: 'A file exceeds 48MB or the batch exceeds 96MB' }, { status: 413 });
    }

    const saved: Awaited<ReturnType<typeof saveUploadFromBuffer>>[] = [];
    const errors: string[] = [];

    for (const item of files) {
      try {
        const buf = Buffer.from(await item.arrayBuffer());
        const file = await saveUploadFromBuffer(item.name, buf);
        saved.push(file);
      } catch (e) {
        errors.push(`${item.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return NextResponse.json({ ok: true, saved, errors });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name');
  if (!name?.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  try {
    const safe = sanitizeUploadName(name);
    await deleteGlobalUploadFile(safe);
    await removeCloudSyncByLocalName(safe);
    return NextResponse.json({ ok: true, name: safe });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Delete failed';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
