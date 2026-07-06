import { NextRequest, NextResponse } from 'next/server';
import {
  enrichCloudSyncEntry,
  getCloudSyncEntries,
  listCloudFilesPreview,
  syncDownloadFromCloud,
  syncUploadToCloud,
} from '@/lib/cloud-sync';
import { promises as fs } from 'fs';
import path from 'path';

const SYNC_FILE = path.join(process.cwd(), 'data', 'cloud-sync.json');

async function getLastSyncAt(): Promise<string | null> {
  try {
    const raw = await fs.readFile(SYNC_FILE, 'utf8');
    return JSON.parse(raw).lastSyncAt || null;
  } catch {
    return null;
  }
}
import { getGlobalUploadsDir, listGlobalUploadFiles } from '@/lib/workspace';

export async function GET() {
  try {
    const [uploads, sync, cloud, uploadsPath, lastSyncAt] = await Promise.all([
      listGlobalUploadFiles(),
      getCloudSyncEntries(),
      listCloudFilesPreview().catch(() => []),
      getGlobalUploadsDir(),
      getLastSyncAt(),
    ]);
    const syncByName = new Map(sync.map((s) => [s.localName, s]));
    const enriched = uploads.map((u) => {
      const cloud = syncByName.get(u.name);
      return {
        ...u,
        cloud: cloud ? enrichCloudSyncEntry(cloud) : null,
      };
    });
    return NextResponse.json({
      ok: true,
      uploadsPath,
      uploads: enriched,
      cloudFiles: cloud,
      lastSyncAt,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  try {
    if (body.action === 'upload') {
      const result = await syncUploadToCloud();
      return NextResponse.json({ ok: true, ...result });
    }
    if (body.action === 'download') {
      const result = await syncDownloadFromCloud();
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
}