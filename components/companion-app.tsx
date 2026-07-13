'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearCompanionDevice,
  loadCompanionSession,
  loadCompanionSummary,
  saveCompanionSession,
  saveCompanionSummary,
} from '@/lib/companion-client-cache';
import { confirmDialog } from '@/components/confirm-dialog';
import { CompanionVoiceRequest, type CompanionVoiceRequestSummary } from './companion-voice-request';
import styles from './companion-app.module.css';

interface CompanionSession {
  deviceKey: string;
  device: { id: string; name: string; scopes: string[] };
}

interface ApprovalSummary {
  attentionId: string;
  taskId: string;
  taskVersion: number;
  approvalId: string;
  toolName: string;
  arguments: unknown;
  actionDigest: string;
  expiresAt: string;
}

interface CompanionData {
  syncedAt: string;
  tasks: Array<{
    id: string;
    kind: string;
    status: string;
    title: string;
    progress: number;
    currentStep?: string;
    nextAction?: string;
    version: number;
    updatedAt: string;
    evidence: Array<{ id: string; kind: string; status: string; label: string; recordedAt: string }>;
  }>;
  attention: Array<{
    id: string;
    taskId: string;
    kind: string;
    severity: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    approval?: ApprovalSummary;
  }>;
  routines: Array<{
    routineId: string;
    name: string;
    enabled: boolean;
    circuitState: string;
    version: number;
  }>;
  voiceRequests: CompanionVoiceRequestSummary[];
}

const ACTIVE_STATUSES = new Set(['queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked']);

export function CompanionApp() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [session, setSession] = useState<CompanionSession | null>(null);
  const [data, setData] = useState<CompanionData | null>(null);
  const [pairingId, setPairingId] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [deviceName, setDeviceName] = useState('My companion');
  const [steering, setSteering] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [offline, setOffline] = useState(false);
  const [secureContext, setSecureContext] = useState<boolean | null>(null);
  const [notificationsSupported, setNotificationsSupported] = useState(false);
  const seenAttention = useRef<Set<string>>(new Set());
  const refreshAbortRef = useRef<AbortController | null>(null);
  const refreshSequenceRef = useRef(0);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const params = new URLSearchParams(window.location.search);
      if (active) {
        setPairingId(params.get('pair') || '');
        setPairingCode((params.get('code') || '').toUpperCase());
        setDeviceName(`${navigator.platform || 'Device'} companion`.slice(0, 80));
        setSecureContext(window.isSecureContext);
        setNotificationsSupported('Notification' in window);
      }
      const [statusResponse, savedSession, cached] = await Promise.all([
        fetch('/api/companion/status', { cache: 'no-store' }).then((response) => response.json()).catch(() => null),
        loadCompanionSession<CompanionSession>().catch(() => null),
        loadCompanionSummary<CompanionData>().catch(() => null),
      ]);
      if (!active) return;
      setEnabled(statusResponse ? statusResponse.enabled === true : null);
      setSession(savedSession);
      if (cached && Date.now() - Date.parse(cached.syncedAt) <= 7 * 86_400_000) {
        setData(cached);
        setOffline(true);
      }
    };
    void boot();
    if ('serviceWorker' in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register('/companion-sw.js', { scope: '/companion' });
    }
    return () => {
      active = false;
      refreshAbortRef.current?.abort();
    };
  }, []);

  const refresh = useCallback(async (activeSession: CompanionSession) => {
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    const sequence = ++refreshSequenceRef.current;
    refreshAbortRef.current = controller;
    try {
      const response = await fetch('/api/companion/data', {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${activeSession.deviceKey}` },
        signal: controller.signal,
      });
      const payload = await response.json();
      if (sequence !== refreshSequenceRef.current) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          await clearCompanionDevice();
          setSession(null);
        }
        throw new Error(payload.error || 'Companion sync failed');
      }
      const next = payload as CompanionData;
      const previous = seenAttention.current;
      if (previous.size > 0 && 'Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready;
        for (const item of next.attention) {
          if (!previous.has(item.id)) void registration.showNotification(item.title, { tag: item.id, data: { url: '/companion' } });
        }
      }
      if (controller.signal.aborted || sequence !== refreshSequenceRef.current) return;
      seenAttention.current = new Set(next.attention.map((item) => item.id));
      setData(next);
      setOffline(false);
      setError('');
      await saveCompanionSummary(next);
    } catch (refreshError) {
      if (controller.signal.aborted || sequence !== refreshSequenceRef.current) return;
      const cached = await loadCompanionSummary<CompanionData>().catch(() => null);
      if (sequence !== refreshSequenceRef.current) return;
      if (cached && Date.now() - Date.parse(cached.syncedAt) <= 7 * 86_400_000) setData(cached);
      setOffline(true);
      setError(refreshError instanceof Error ? refreshError.message : 'Companion is offline');
    } finally {
      if (sequence === refreshSequenceRef.current) refreshAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    const initial = window.setTimeout(() => void refresh(session), 0);
    const timer = window.setInterval(() => void refresh(session), 15_000);
    const onOnline = () => void refresh(session);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh, session]);

  const pair = async () => {
    setBusy('pair');
    setError('');
    try {
      const response = await fetch('/api/companion/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingId, code: pairingCode, deviceName }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Pairing failed');
      const next: CompanionSession = { deviceKey: payload.deviceKey, device: payload.device };
      await saveCompanionSession(next);
      setSession(next);
      window.history.replaceState({}, '', '/companion');
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : 'Pairing failed');
    } finally {
      setBusy('');
    }
  };

  const perform = async (body: Record<string, unknown>) => {
    if (!session) return;
    const action = String(body.action || 'action');
    setBusy(`${action}:${String(body.taskId || body.attentionId || body.routineId || '')}`);
    setError('');
    try {
      const response = await fetch('/api/companion/actions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.deviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Action failed');
      await refresh(session);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Action failed');
    } finally {
      setBusy('');
    }
  };

  const disconnect = async () => {
    refreshAbortRef.current?.abort();
    await clearCompanionDevice();
    setSession(null);
    setData(null);
  };

  const can = (scope: string) => session?.device.scopes.includes(scope) === true;

  const cancelTask = async (task: CompanionData['tasks'][number]) => {
    const confirmed = await confirmDialog({
      title: `Cancel ${task.title}?`,
      message: 'This is a terminal remote action for this task. The exact task revision shown on this device will be checked before cancellation.',
      confirmLabel: 'Cancel task',
      danger: true,
    });
    if (confirmed) await perform({ action: 'cancel', taskId: task.id, expectedVersion: task.version });
  };

  return (
    <div className={styles.shell}>
      <main className={styles.main}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <Image className={styles.logo} src="/shiba-logo.svg" width={42} height={42} alt="Shiba Studio" priority />
            <div>
              <div className={styles.eyebrow}>Remote view</div>
              <h1 className={styles.title}>Shiba Companion</h1>
            </div>
          </div>
          <div className={styles.statusText}>
            <span className={offline ? styles.offline : styles.online}>{offline ? 'Offline cache' : 'Host connected'}</span>
            {data?.syncedAt ? <div>Synced {new Date(data.syncedAt).toLocaleTimeString()}</div> : null}
          </div>
        </header>

        {error ? <div className={styles.error} role="alert">{error}</div> : null}
        {secureContext === false ? (
          <div className={styles.banner}>Use HTTPS (for example Tailscale Serve) to install the PWA and keep encrypted offline summaries. Live LAN controls still work over HTTP.</div>
        ) : null}

        {!session ? (
          <section className={styles.pairing} aria-labelledby="pair-title">
            <div className={styles.eyebrow}>One-time setup</div>
            <h2 className={styles.sectionTitle} id="pair-title">Pair this device</h2>
            {enabled === false ? <p className={styles.muted}>Remote access is disabled. Open <Link href="/companion/admin">Companion admin</Link> in the Shiba host browser to enable it.</p> : null}
            <label className={styles.field}>Device name
              <input className={styles.input} value={deviceName} maxLength={80} onChange={(event) => setDeviceName(event.target.value)} />
            </label>
            <label className={styles.field}>Pairing id
              <input className={styles.input} value={pairingId} autoComplete="off" onChange={(event) => setPairingId(event.target.value)} />
            </label>
            <label className={styles.field}>One-time code
              <input className={styles.input} value={pairingCode} autoComplete="one-time-code" onChange={(event) => setPairingCode(event.target.value.toUpperCase())} />
            </label>
            <div className={styles.actions}>
              <button className={styles.button} type="button" disabled={busy === 'pair' || enabled === false} onClick={() => void pair()}>
                {busy === 'pair' ? 'Pairing…' : 'Pair device'}
              </button>
            </div>
          </section>
        ) : (
          <>
            <div className={styles.between}>
              <p className={styles.muted}>Paired as {session.device.name}</p>
              <div className={styles.actions}>
                {notificationsSupported ? <button className={styles.quiet} type="button" onClick={() => void Notification.requestPermission()}>Notifications</button> : null}
                <button className={styles.quiet} type="button" onClick={() => void disconnect()}>Forget on this device</button>
              </div>
            </div>

            <div className={styles.grid}>
              {can('action:voice') ? (
                <CompanionVoiceRequest
                  deviceKey={session.deviceKey}
                  secureContext={secureContext}
                  requests={data?.voiceRequests || []}
                  onAccepted={() => refresh(session)}
                />
              ) : null}

              <section className={`${styles.section} ${styles.sectionWide}`} aria-labelledby="attention-title">
                <div className={`${styles.sectionHeader} ${styles.between}`}>
                  <h2 className={styles.sectionTitle} id="attention-title">Attention</h2>
                  <span className={styles.badge}>{data?.attention.length || 0} open</span>
                </div>
                <div className={styles.list}>
                  {!data?.attention.length ? <p className={styles.empty}>Nothing needs you right now.</p> : data.attention.map((item) => (
                    <article className={styles.card} key={item.id}>
                      <div className={styles.between}>
                        <h3 className={styles.cardTitle}>{item.title}</h3>
                        <span className={item.severity === 'critical' ? styles.severity : styles.badge}>{item.kind}</span>
                      </div>
                      <p className={styles.meta}>{new Date(item.createdAt).toLocaleString()}</p>
                      {item.approval ? (
                        <>
                          <p className={styles.muted}>Exact action: {item.approval.toolName}</p>
                          <pre className={styles.arguments}>{JSON.stringify(item.approval.arguments, null, 2)}</pre>
                          <p className={styles.meta}>Expires {new Date(item.approval.expiresAt).toLocaleTimeString()}</p>
                          <div className={styles.actions}>
                            <button className={styles.button} type="button" disabled={!can('action:attention') || !!busy} onClick={() => void perform({ action: 'approve', attentionId: item.id, taskId: item.approval?.taskId, expectedVersion: item.approval?.taskVersion, actionDigest: item.approval?.actionDigest, expiresAt: item.approval?.expiresAt })}>Approve exact action</button>
                            <button className={styles.danger} type="button" disabled={!can('action:attention') || !!busy} onClick={() => void perform({ action: 'deny', attentionId: item.id, taskId: item.approval?.taskId, expectedVersion: item.approval?.taskVersion, actionDigest: item.approval?.actionDigest, expiresAt: item.approval?.expiresAt })}>Deny</button>
                          </div>
                        </>
                      ) : can('action:attention') ? (
                        <div className={styles.actions}>
                          <button className={styles.secondary} type="button" disabled={!!busy} onClick={() => void perform({ action: 'resolve_attention', attentionId: item.id, updatedAt: item.updatedAt })}>Mark handled</button>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>

              <section className={styles.section} aria-labelledby="tasks-title">
                <div className={`${styles.sectionHeader} ${styles.between}`}>
                  <h2 className={styles.sectionTitle} id="tasks-title">Tasks</h2>
                  <span className={styles.badge}>{data?.tasks.length || 0} recent</span>
                </div>
                <div className={styles.list}>
                  {!data?.tasks.length ? <p className={styles.empty}>No recent task summaries.</p> : data.tasks.map((task) => (
                    <article className={styles.card} key={task.id}>
                      <div className={styles.between}>
                        <h3 className={styles.cardTitle}>{task.title}</h3>
                        <span className={styles.badge}>{task.status}</span>
                      </div>
                      {task.currentStep ? <p className={styles.muted}>{task.currentStep}</p> : null}
                      <progress className={styles.progress} max={1} value={task.progress} aria-label={`${Math.round(task.progress * 100)} percent complete`} />
                      {task.evidence.length ? <ul className={styles.evidence}>{task.evidence.map((evidence) => <li key={evidence.id}>{evidence.status === 'passed' ? '✓' : '•'} {evidence.label}</li>)}</ul> : null}
                      {ACTIVE_STATUSES.has(task.status) ? (
                        <div className={styles.actions}>
                          {can('action:steer') ? <input className={styles.input} value={steering[task.id] || ''} aria-label={`Steer ${task.title}`} placeholder="Add instruction" onChange={(event) => setSteering((current) => ({ ...current, [task.id]: event.target.value }))} /> : null}
                          {can('action:steer') ? <button className={styles.secondary} type="button" disabled={!steering[task.id]?.trim() || !!busy} onClick={() => void perform({ action: 'steer', taskId: task.id, expectedVersion: task.version, instruction: steering[task.id] })}>Steer</button> : null}
                           {can('action:cancel') ? <button className={styles.danger} type="button" disabled={!!busy} onClick={() => void cancelTask(task)}>Cancel</button> : null}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>

              <section className={styles.section} aria-labelledby="routines-title">
                <div className={`${styles.sectionHeader} ${styles.between}`}>
                  <h2 className={styles.sectionTitle} id="routines-title">Saved automations</h2>
                  <span className={styles.badge}>{data?.routines.length || 0}</span>
                </div>
                <div className={styles.list}>
                  {!data?.routines.length ? <p className={styles.empty}>No automations available to this device.</p> : data.routines.map((routine) => (
                    <article className={styles.card} key={routine.routineId}>
                      <h3 className={styles.cardTitle}>{routine.name}</h3>
                      <p className={styles.muted}>{routine.enabled ? 'Enabled' : 'Disabled'} · circuit {routine.circuitState}</p>
                      {can('action:routines') ? <div className={styles.actions}><button className={styles.secondary} type="button" disabled={!!busy || !routine.enabled || routine.circuitState === 'open'} onClick={() => void perform({ action: 'start_routine', routineId: routine.routineId, expectedVersion: routine.version })}>Run now</button></div> : null}
                    </article>
                  ))}
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
