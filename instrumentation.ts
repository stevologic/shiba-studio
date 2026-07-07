// Next.js instrumentation — runs once when the SERVER starts, before any
// request. Arms every agent cron schedule immediately, so automations run
// even if no browser ever opens the app (previously scheduling was triggered
// by the client hitting /api/boot on page load).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { loadAndScheduleAll } = await import('./lib/scheduler');
    await loadAndScheduleAll();
    const { audit } = await import('./lib/audit-log');
    audit('system', 'schedules armed at server start', 'instrumentation.register');
    console.log('[shiba-studio] agent schedules armed at server start');
  } catch (e) {
    console.error('[shiba-studio] failed to arm schedules at server start', e);
  }
}
