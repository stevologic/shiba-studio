import { NextRequest, NextResponse } from 'next/server';
import {
  enrichCloudSyncEntry,
  getCloudSyncOverview,
  listCloudFilesPreview,
  syncDownloadFromCloud,
  syncUploadToCloud,
} from '@/lib/cloud-sync';
import { getGlobalUploadsDir, listGlobalUploadFiles } from '@/lib/workspace';

export async function GET() {
  try {
    const [uploads, syncState, cloud, uploadsPath] = await Promise.all([
      listGlobalUploadFiles(),
      getCloudSyncOverview(),
      listCloudFilesPreview().catch(() => []),
      getGlobalUploadsDir(),
    ]);
    const sync = syncState.files;
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
      lastSyncAt: syncState.lastSyncAt,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
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
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
