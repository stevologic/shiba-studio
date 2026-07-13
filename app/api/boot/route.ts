import { NextResponse } from 'next/server';
import { initScheduler } from '@/lib/scheduler';
import { startRoutineEngine } from '@/lib/routines';
import { startRunLeaseReconciler } from '@/lib/agent-runs-store';
import { startTaskDeliveryPump } from '@/lib/task-delivery';
import { startQueuedRetryDispatcher } from '@/lib/background-tasks';
import { startTeamWorkerClaimReconciler } from '@/lib/task-teams';
import { reconcileProcessingTaskCommandsAtStartup } from '@/lib/task-ledger';
import { loadConfig } from '@/lib/persistence';
import { getRuntimeVersion } from '@/lib/runtime-version';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  // Ensure Grok key is loaded
  await loadConfig();
  // These initializers are process-global and idempotent. Instrumentation
  // starts them before requests; /api/boot is a safe readiness fallback and
  // must not trigger a second stop/re-arm cycle on every page load.
  startRunLeaseReconciler();
  startTaskDeliveryPump();
  startTeamWorkerClaimReconciler();
  await reconcileProcessingTaskCommandsAtStartup();
  startQueuedRetryDispatcher();
  startRoutineEngine();
  await initScheduler();
  // Live commit of the tree this Node process is serving (not a stale build-time bake).
  const runtime = getRuntimeVersion();
  return NextResponse.json({
    ok: true,
    scheduler: 'running',
    routines: 'running',
    delivery: 'running',
    recovery: 'running',
    version: runtime.version,
    commit: runtime.commit,
    commitFull: runtime.commitFull,
    dirty: runtime.dirty,
    root: runtime.root,
    commitSource: runtime.source,
    checkedAt: runtime.checkedAt,
  });
}
