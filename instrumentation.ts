// Next.js instrumentation — runs once when the SERVER starts, before any
// request. Arms every agent cron schedule immediately, so automations run
// even if no browser ever opens the app (previously scheduling was triggered
// by the client hitting /api/boot on page load). Also starts the real host
// PTY WebSocket bridge (node-pty) on localhost for the in-app terminal.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  let safeMode = false;
  try {
    const { loadConfig } = await import('./lib/persistence');
    safeMode = !!(await loadConfig()).safeMode;
    if (safeMode) console.warn('[shiba-studio] safe mode active: optional network listeners are disabled');
  } catch {
    /* core startup continues with normal defaults */
  }
  try {
    // A run left 'running' means the process died mid-execution — clear it so
    // the Automations page doesn't show a permanent spinner.
    const { reconcileOrphanedRuns } = await import('./lib/agent-runs-store');
    const n = reconcileOrphanedRuns();
    if (n > 0) console.log(`[shiba-studio] reconciled ${n} interrupted run(s) at server start`);
    const { reconcileOrphanedTasks } = await import('./lib/task-ledger');
    const tasks = reconcileOrphanedTasks();
    if (tasks > 0) console.log(`[shiba-studio] marked ${tasks} interrupted task(s) as lost`);
    const { reconcileTeamWorkerClaims } = await import('./lib/task-teams');
    const claims = reconcileTeamWorkerClaims();
    if (claims > 0) console.log(`[shiba-studio] released ${claims} expired worker claim(s)`);
    const { reconcileInterruptedMeetings } = await import('./lib/meetings');
    const meetings = reconcileInterruptedMeetings();
    if (meetings > 0) console.log(`[shiba-studio] marked ${meetings} interrupted meeting transcription(s) as failed`);
    const { reconcileInterruptedCompanionVoiceActions } = await import('./lib/companion-auth');
    const voices = await reconcileInterruptedCompanionVoiceActions();
    if (voices.completed || voices.failed) {
      console.log(`[shiba-studio] reconciled ${voices.completed + voices.failed} companion voice request(s) (${voices.resumed} resumed, ${voices.failed} failed safely)`);
    }
  } catch (e) {
    console.error('[shiba-studio] failed to reconcile orphaned runs', e);
  }
  try {
    const { startTaskDeliveryPump } = await import('./lib/task-delivery');
    startTaskDeliveryPump();
  } catch (e) {
    console.error('[shiba-studio] failed to start task delivery pump', e);
  }
  try {
    const { backfillContextIndexes } = await import('./lib/context-engine');
    const indexed = await backfillContextIndexes();
    if (indexed.sessions || indexed.projects || indexed.runs) {
      console.log(`[shiba-studio] context index backfilled: ${indexed.sessions} session(s), ${indexed.projects} project(s), ${indexed.runs} run(s)`);
    }
  } catch (e) {
    console.error('[shiba-studio] failed to backfill durable context index', e);
  }
  try {
    const { loadAndScheduleAll } = await import('./lib/scheduler');
    await loadAndScheduleAll();
    const { audit } = await import('./lib/audit-log');
    audit('system', 'schedules armed at server start', 'instrumentation.register');
    console.log('[shiba-studio] agent schedules armed at server start');
  } catch (e) {
    console.error('[shiba-studio] failed to arm schedules at server start', e);
  }
  try {
    const { startRoutineEngine } = await import('./lib/routines');
    startRoutineEngine();
    console.log('[shiba-studio] durable routine engine started');
  } catch (e) {
    console.error('[shiba-studio] failed to start durable routine engine', e);
  }
  try {
    const { startTerminalServer } = await import('./lib/terminal-server');
    startTerminalServer();
  } catch (e) {
    console.error('[shiba-studio] failed to start terminal PTY bridge', e);
  }
  try {
    const { startRetentionSchedule } = await import('./lib/retention');
    startRetentionSchedule();
    const { startMeetingRetention } = await import('./lib/meetings');
    startMeetingRetention();
  } catch (e) {
    console.error('[shiba-studio] failed to start retention pruning', e);
  }
  // Advertise the app on the LAN by name (mDNS) — e.g. http://shiba.local:3000.
  if (!safeMode) try {
    const { startMdns } = await import('./lib/mdns');
    startMdns();
  } catch (e) {
    console.error('[shiba-studio] failed to start mDNS responder', e);
  }
  // Let bare http://shiba.local (port 80) redirect to the app's real port, so
  // users don't have to remember to type the port after the name.
  if (!safeMode) try {
    const { startPort80Redirect } = await import('./lib/port80-redirect');
    startPort80Redirect();
  } catch (e) {
    console.error('[shiba-studio] failed to start port-80 redirect', e);
  }
  // Slack Socket Mode + Discord Gateway: @mention → agent reply
  if (!safeMode) try {
    const { syncChannelListeners } = await import('./lib/channel-listeners');
    const statuses = await syncChannelListeners();
    const active = Object.values(statuses).filter((s) => s.enabled);
    if (active.length) {
      console.log(
        '[shiba-studio] channel listeners:',
        active.map((s) => `${s.platform}=${s.detail || (s.running ? 'on' : 'starting')}`).join(', '),
      );
    }
  } catch (e) {
    console.error('[shiba-studio] failed to start channel listeners', e);
  }
}
