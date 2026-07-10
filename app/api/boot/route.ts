import { NextResponse } from 'next/server';
import { initScheduler, loadAndScheduleAll } from '@/lib/scheduler';
import { loadConfig } from '@/lib/persistence';
import { getRuntimeVersion } from '@/lib/runtime-version';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  // Ensure Grok key is loaded
  await loadConfig();
  // Start the scheduler
  initScheduler();
  await loadAndScheduleAll();
  // Live commit of the tree this Node process is serving (not a stale build-time bake).
  const runtime = getRuntimeVersion(true);
  return NextResponse.json({
    ok: true,
    scheduler: 'running',
    version: runtime.version,
    commit: runtime.commit,
    commitFull: runtime.commitFull,
    dirty: runtime.dirty,
    root: runtime.root,
    commitSource: runtime.source,
    checkedAt: runtime.checkedAt,
  });
}
