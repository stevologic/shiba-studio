'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import QRCode from 'qrcode';
import styles from './companion-app.module.css';

interface AdminState {
  remoteAccess: { enabled: boolean; pairingTtlMinutes: number; deviceTtlDays: number };
  devices: Array<{
    id: string;
    name: string;
    scopes: string[];
    createdAt: string;
    expiresAt: string;
    lastSeenAt?: string;
    revokedAt?: string;
  }>;
}

interface Pairing {
  id: string;
  code: string;
  pairingUrl: string;
  expiresAt: string;
  scopes: string[];
}

const DEFAULT_SCOPES = [
  'read:tasks',
  'read:attention',
  'read:routines',
  'action:attention',
  'action:steer',
  'action:cancel',
  'action:routines',
  'action:voice',
];

interface CompanionAdminProps {
  defaultOrigin: string;
}

export function CompanionAdmin({ defaultOrigin }: CompanionAdminProps) {
  const [state, setState] = useState<AdminState | null>(null);
  const [origin, setOrigin] = useState(defaultOrigin);
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairingQr, setPairingQr] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const response = await fetch('/api/companion/admin', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load companion settings');
    setState(payload as AdminState);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void load().catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Could not load settings'));
    }, 0);
    return () => window.clearTimeout(initial);
  }, [load]);

  useEffect(() => {
    let active = true;
    if (!pairing?.pairingUrl) {
      return () => { active = false; };
    }
    void QRCode.toDataURL(pairing.pairingUrl, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#11110f', light: '#ffffff' },
    }).then((value) => {
      if (active) setPairingQr(value);
    }).catch(() => {
      if (active) setPairingQr('');
    });
    return () => { active = false; };
  }, [pairing?.pairingUrl]);

  const adminAction = async (body: Record<string, unknown>) => {
    setBusy(String(body.action || 'action'));
    setError('');
    try {
      const response = await fetch('/api/companion/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Companion administration failed');
      if (payload.pairing) setPairing(payload.pairing as Pairing);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Companion administration failed');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={styles.shell}>
      <main className={styles.main}>
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>Localhost administration</div>
            <h1 className={styles.title}>Companion access</h1>
            <p className={styles.muted}>Pair scoped LAN or Tailscale devices. The full Studio API remains local-only.</p>
          </div>
          <Link className={styles.quiet} href="/companion">Open companion</Link>
        </header>
        {error ? <div className={styles.error} role="alert">{error}</div> : null}

        <section className={styles.card} aria-labelledby="remote-toggle-title">
          <div className={styles.between}>
            <div>
              <h2 className={styles.sectionTitle} id="remote-toggle-title">Remote access</h2>
              <p className={styles.muted}>Disabled by default. Turning it off immediately blocks every device key.</p>
            </div>
            <button
              className={state?.remoteAccess.enabled ? styles.danger : styles.button}
              type="button"
              disabled={!state || !!busy}
              onClick={() => void adminAction({ action: 'set_enabled', enabled: !state?.remoteAccess.enabled })}
            >
              {state?.remoteAccess.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
        </section>

        <div className={styles.grid}>
          <section className={styles.section} aria-labelledby="new-pair-title">
            <div className={styles.sectionHeader}><h2 className={styles.sectionTitle} id="new-pair-title">New pairing</h2></div>
            <div className={styles.card}>
              <label className={styles.field}>Companion origin
                <input className={styles.input} value={origin} onChange={(event) => setOrigin(event.target.value)} />
              </label>
              <fieldset className={styles.field}>
                <legend>Device permissions</legend>
                {DEFAULT_SCOPES.map((scope) => (
                  <label className={styles.row} key={scope}>
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={(event) => setScopes((current) => event.target.checked
                        ? [...current, scope]
                        : current.filter((item) => item !== scope))}
                    />
                    <span>{scope}</span>
                  </label>
                ))}
              </fieldset>
              <div className={styles.actions}>
                <button className={styles.button} type="button" disabled={!state?.remoteAccess.enabled || !!busy || scopes.length === 0} onClick={() => void adminAction({ action: 'create_pairing', companionOrigin: origin, scopes })}>Create one-time pairing</button>
              </div>
              {pairing ? (
                <div className={styles.banner}>
                  <strong>One-time code: {pairing.code}</strong>
                  {pairingQr ? (
                    <figure className={styles.qrFigure} aria-labelledby="pairing-qr-caption">
                      <Image
                        className={styles.qrImage}
                        src={pairingQr}
                        width={240}
                        height={240}
                        unoptimized
                        alt="QR code containing the one-time Shiba Companion pairing URL"
                      />
                      <figcaption id="pairing-qr-caption" className={styles.muted}>Scan on the companion device to open this exact one-time pairing.</figcaption>
                    </figure>
                  ) : null}
                  <span className={styles.code}>{pairing.pairingUrl}</span>
                  <p className={styles.muted}>Accessible URL fallback · expires {new Date(pairing.expiresAt).toLocaleTimeString()}</p>
                </div>
              ) : null}
            </div>
          </section>

          <section className={styles.section} aria-labelledby="devices-title">
            <div className={`${styles.sectionHeader} ${styles.between}`}>
              <h2 className={styles.sectionTitle} id="devices-title">Paired devices</h2>
              <span className={styles.badge}>{state?.devices.filter((device) => !device.revokedAt).length || 0} active</span>
            </div>
            <div className={styles.list}>
              {!state?.devices.length ? <p className={styles.empty}>No devices paired.</p> : state.devices.map((device) => (
                <article className={styles.card} key={device.id}>
                  <div className={styles.between}>
                    <h3 className={styles.cardTitle}>{device.name}</h3>
                    <span className={device.revokedAt ? styles.offline : styles.online}>{device.revokedAt ? 'Revoked' : 'Active'}</span>
                  </div>
                  <p className={styles.meta}>Expires {new Date(device.expiresAt).toLocaleDateString()}</p>
                  <p className={styles.muted}>{device.scopes.join(' · ')}</p>
                  {!device.revokedAt ? <div className={styles.actions}><button className={styles.danger} type="button" disabled={!!busy} onClick={() => void adminAction({ action: 'revoke_device', deviceId: device.id })}>Revoke</button></div> : null}
                </article>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
