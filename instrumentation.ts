// Next.js instrumentation — runs once when the SERVER starts, before any
// request. Starts the durable Automation engine so work runs even if no
// browser ever opens the app. Also starts the real host
// PTY WebSocket bridge (node-pty) on localhost for the in-app terminal.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Restore recovery must precede every read of config, JSON stores, or the
  // SQLite handle. It rolls an interrupted atomic swap to one complete
  // generation before any worker can observe mixed backup/live state.
  try {
    const { recoverInterruptedBackupRestore } = await import('./lib/backup');
    await recoverInterruptedBackupRestore();
  } catch (error) {
    console.error('[shiba-studio] interrupted backup restore recovery failed; startup is blocked', error);
    throw error;
  }
  let safeMode = false;
  let serveLocalName = true;
  try {
    const { loadConfig } = await import('./lib/persistence');
    const bootConfig = await loadConfig();
    safeMode = !!bootConfig.safeMode;
    serveLocalName = bootConfig.serveLocalName !== false;
    if (safeMode) console.warn('[shiba-studio] safe mode active: optional network listeners are disabled');
  } catch {
    /* core startup continues with normal defaults */
  }
  // Establish ownership invariants before any scheduler, retry pump, or
  // listener can act on durable state. A failed repair is a fail-closed startup
  // condition: executing potentially orphaned work would be worse than making
  // the operator restart after fixing the underlying disk/store error.
  {
    const { beginAutomationMaintenance } = await import('./lib/automation-maintenance');
    const releaseIntegrityGate = beginAutomationMaintenance('startup data-integrity repair');
    try {
      const { migrateLegacyAgentSchedules } = await import('./lib/routines');
      await migrateLegacyAgentSchedules();
      const { reconcileInterruptedCheckpointRestores } = await import('./lib/task-checkpoints');
      const checkpointRestores = await reconcileInterruptedCheckpointRestores();
      if (checkpointRestores.errors.length) {
        throw new Error(`checkpoint restore compensation was incomplete: ${checkpointRestores.errors.join('; ')}`);
      }
      const { reconcileAllDataIntegrity, startDataIntegritySchedule } = await import('./lib/integrity-coordinator');
      let integrity = await reconcileAllDataIntegrity({ reason: 'startup', includeStorage: true });
      for (let attempt = 0; integrity.skippedBecauseLeaseHeld && attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        integrity = await reconcileAllDataIntegrity({ reason: 'startup', includeStorage: true });
      }
      if (integrity.skippedBecauseLeaseHeld) {
        throw new Error('another process held the data-integrity lease for more than 60 seconds');
      }
      if (integrity.storage?.errors.length) {
        throw new Error(`managed-storage repair was incomplete: ${integrity.storage.errors.join('; ')}`);
      }
      if (integrity.binaryStorage?.errors.length) {
        throw new Error(`binary-storage repair was incomplete: ${integrity.binaryStorage.errors.join('; ')}`);
      }
      if (integrity.capabilityPackRegistry?.errors.length) {
        throw new Error(`capability-pack registry repair was incomplete: ${integrity.capabilityPackRegistry.errors.join('; ')}`);
      }
      startDataIntegritySchedule();
      releaseIntegrityGate();
      console.log('[shiba-studio] durable ownership integrity verified');
    } catch (error) {
      console.error('[shiba-studio] startup data-integrity repair failed; background work remains fenced', error);
      throw error;
    }
  }
  // Lease recovery is deliberately periodic instead of declaring every
  // running row dead at startup. Another server process may still own and
  // heartbeat the work while this process is coming online.
  try {
    const { startRunLeaseReconciler } = await import('./lib/agent-runs-store');
    startRunLeaseReconciler();
  } catch (e) {
    console.error('[shiba-studio] failed to start run lease reconciliation', e);
  }
  // Keep recovery domains isolated: a corrupt optional subsystem must not
  // prevent worker claims, schedules, or delivery from recovering.
  try {
    const { startTeamWorkerClaimReconciler } = await import('./lib/task-teams');
    startTeamWorkerClaimReconciler();
  } catch (e) {
    console.error('[shiba-studio] failed to start team worker claim reconciliation', e);
  }
  try {
    const { reconcileProcessingTaskCommandsAtStartup } = await import('./lib/task-ledger');
    const commands = await reconcileProcessingTaskCommandsAtStartup();
    if (commands.inspected > 0) {
      console.log(
        `[shiba-studio] reconciled ${commands.inspected} interrupted task command(s) `
        + `(${commands.applied} applied, ${commands.requeued} requeued, ${commands.rejected} rejected)`,
      );
    }
  } catch (e) {
    console.error('[shiba-studio] failed to reconcile interrupted task commands', e);
  }
  try {
    const { startQueuedRetryDispatcher } = await import('./lib/background-tasks');
    startQueuedRetryDispatcher();
  } catch (e) {
    console.error('[shiba-studio] failed to start queued retry recovery', e);
  }
  try {
    const { startBoardAssignmentProcessor } = await import('./lib/board-runner');
    startBoardAssignmentProcessor();
  } catch (e) {
    console.error('[shiba-studio] failed to start Board assignment recovery', e);
  }
  try {
    const { reconcileInterruptedMeetings } = await import('./lib/meetings');
    const meetings = reconcileInterruptedMeetings();
    if (meetings > 0) console.log(`[shiba-studio] marked ${meetings} interrupted meeting transcription(s) as failed`);
  } catch (e) {
    console.error('[shiba-studio] failed to reconcile meeting transcription work', e);
  }
  try {
    const { reconcileInterruptedCompanionVoiceActions } = await import('./lib/companion-auth');
    const voices = await reconcileInterruptedCompanionVoiceActions();
    if (voices.completed || voices.failed) {
      console.log(`[shiba-studio] reconciled ${voices.completed + voices.failed} companion voice request(s) (${voices.resumed} resumed, ${voices.failed} failed safely)`);
    }
  } catch (e) {
    console.error('[shiba-studio] failed to reconcile companion voice work', e);
  }
  try {
    const { startTaskDeliveryPump } = await import('./lib/task-delivery');
    startTaskDeliveryPump();
  } catch (e) {
    console.error('[shiba-studio] failed to start task delivery pump', e);
  }
  try {
    const { startRoutineEngine } = await import('./lib/routines');
    await startRoutineEngine();
    console.log('[shiba-studio] durable Automation engine started');
  } catch (e) {
    console.error('[shiba-studio] failed to start durable Automation engine', e);
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
  // The Settings "serve on local network" toggle gates both listeners and can
  // also start/stop them later without a restart (see /api/config).
  if (!safeMode && serveLocalName) try {
    const { startMdns } = await import('./lib/mdns');
    startMdns();
  } catch (e) {
    console.error('[shiba-studio] failed to start mDNS responder', e);
  }
  // Let bare http://shiba.local (port 80) redirect to the app's real port, so
  // users don't have to remember to type the port after the name.
  if (!safeMode && serveLocalName) try {
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

  // Index repair can be expensive on a large history and is not required for
  // automation correctness. Run it only after all control-plane services are
  // armed, without holding server readiness hostage.
  void import('./lib/context-engine')
    .then(({ backfillContextIndexes }) => backfillContextIndexes())
    .then((indexed) => {
      if (indexed.sessions || indexed.projects || indexed.runs) {
        console.log(`[shiba-studio] context index backfilled: ${indexed.sessions} session(s), ${indexed.projects} project(s), ${indexed.runs} run(s)`);
      }
    })
    .catch((e) => {
      console.error('[shiba-studio] failed to backfill durable context index', e);
    });
}
