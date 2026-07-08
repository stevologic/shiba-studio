import { NextResponse } from 'next/server';
import { getRuntimeVersion } from '@/lib/runtime-version';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Lightweight poll endpoint so the UI always shows the running tree's commit. */
export async function GET() {
  const runtime = getRuntimeVersion();
  return NextResponse.json({
    ok: true,
    version: runtime.version,
    commit: runtime.commit,
    commitFull: runtime.commitFull,
    dirty: runtime.dirty,
    root: runtime.root,
    source: runtime.source,
    checkedAt: runtime.checkedAt,
  });
}
