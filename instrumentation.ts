// Next.js instrumentation — runs once when the SERVER starts, before any
// request. Arms every agent cron schedule immediately, so automations run
// even if no browser ever opens the app (previously scheduling was triggered
// by the client hitting /api/boot on page load). Also starts the real host
// PTY WebSocket bridge (node-pty) on localhost for the in-app terminal.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    // A run left 'running' means the process died mid-execution — clear it so
    // the Automations page doesn't show a permanent spinner.
    const { reconcileOrphanedRuns } = await import('./lib/agent-runs-store');
    const n = reconcileOrphanedRuns();
    if (n > 0) console.log(`[shiba-studio] reconciled ${n} interrupted run(s) at server start`);
  } catch (e) {
    console.error('[shiba-studio] failed to reconcile orphaned runs', e);
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
    const { startTerminalServer } = await import('./lib/terminal-server');
    startTerminalServer();
  } catch (e) {
    console.error('[shiba-studio] failed to start terminal PTY bridge', e);
  }
  try {
    const { startRetentionSchedule } = await import('./lib/retention');
    startRetentionSchedule();
  } catch (e) {
    console.error('[shiba-studio] failed to start retention pruning', e);
  }
  // Advertise the app on the LAN by name (mDNS) — e.g. http://shiba.local:3000.
  try {
    const { startMdns } = await import('./lib/mdns');
    startMdns();
  } catch (e) {
    console.error('[shiba-studio] failed to start mDNS responder', e);
  }
  // Slack Socket Mode + Discord Gateway: @mention → agent reply
  try {
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
