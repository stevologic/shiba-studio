import { NextRequest, NextResponse } from 'next/server';
import { removeCloudSyncByLocalName } from '@/lib/cloud-sync';
import { deleteGlobalUploadFile, sanitizeUploadName, saveUploadFromBuffer } from '@/lib/workspace';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const items = form.getAll('files');
    if (!items.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const saved: Awaited<ReturnType<typeof saveUploadFromBuffer>>[] = [];
    const errors: string[] = [];

    for (const item of items) {
      if (!(item instanceof File)) continue;
      try {
        const buf = Buffer.from(await item.arrayBuffer());
        const file = await saveUploadFromBuffer(item.name, buf);
        saved.push(file);
      } catch (e: any) {
        errors.push(`${item.name}: ${e.message}`);
      }
    }

    return NextResponse.json({ ok: true, saved, errors });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
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