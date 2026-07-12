import { NextRequest } from 'next/server';
import { collectAllCreatedFiles, resolveCreatedFile } from '@/lib/board-work';
import { inspectFile, rawFileResponse } from '@/lib/serve-file';

// GET /api/files                      → every file agents have created (Files page)
// GET /api/files?file=<abs>&inspect=1 → JSON content for the in-app viewer
// GET /api/files?file=<abs>           → raw bytes (open/download)
// A file is only served if it is actually a tracked created file — the list
// itself is the capability, so arbitrary paths are rejected.
export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get('file');
  if (!filePath) {
    const files = await collectAllCreatedFiles();
    return Response.json({ ok: true, files });
  }

  const file = await resolveCreatedFile(filePath);
  if (!file) return Response.json({ ok: false, error: 'Not a tracked file' }, { status: 404 });

  if (req.nextUrl.searchParams.get('inspect') === '1') {
    const inspected = await inspectFile(file.absPath, file.name);
    if (!inspected) return Response.json({ ok: false, error: 'File no longer exists on disk' }, { status: 410 });
    return Response.json(inspected);
  }

  return rawFileResponse(file.absPath, file.name);
}
