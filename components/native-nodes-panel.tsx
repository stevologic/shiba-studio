'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clipboard, Copy, Loader2, MonitorUp, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { confirmDialog } from '@/components/confirm-dialog';

interface NodeView {
  id: string;
  name: string;
  platform: string;
  releaseId: string;
  capabilities: string[];
  captureState: 'idle' | 'active';
  lastSeenAt?: string;
  expiresAt: string;
  revokedAt?: string;
}

interface GrantView {
  id: string;
  nodeId: string;
  appId: string;
  appLabel: string;
  appRevision: string;
  capabilities: string[];
  revision: number;
  expiresAt: string;
  revokedAt?: string;
}

interface JobView {
  id: string;
  nodeId: string;
  action: string;
  status: string;
  result?: { windows?: AppWindow[] };
  error?: string;
  createdAt: string;
}

interface AppWindow {
  handle: number;
  title: string;
  appId: string;
  appLabel: string;
  appRevision: string;
}

interface AdminState { nodes: NodeView[]; grants: GrantView[]; jobs: JobView[] }

const PAIR_CAPABILITIES = [
  'inventory', 'capture', 'notify', 'clipboard_read', 'clipboard_write', 'file_open', 'click', 'type', 'quick_entry',
];

export function NativeNodesPanel() {
  const [state, setState] = useState<AdminState>({ nodes: [], grants: [], jobs: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; setupCommand: string } | null>(null);
  const [origin, setOrigin] = useState('https://shiba.local:3000');
  const [nodeId, setNodeId] = useState('');
  const [boundary, setBoundary] = useState<'app' | 'clipboard' | 'file'>('app');
  const [appId, setAppId] = useState('');
  const [appLabel, setAppLabel] = useState('');
  const [appRevision, setAppRevision] = useState('');
  const [allowedPathPrefix, setAllowedPathPrefix] = useState('');
  const [ttlMinutes, setTtlMinutes] = useState(60);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch('/api/native-nodes/admin', { cache: 'no-store' });
      const data = await response.json() as AdminState & { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load native nodes');
      setState({ nodes: data.nodes || [], grants: data.grants || [], jobs: data.jobs || [] });
      setNodeId((current) => current || data.nodes?.find((node) => !node.revokedAt)?.id || '');
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load native nodes');
    } finally { if (!quiet) setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    const hasLiveWork = state.nodes.some((node) => node.captureState === 'active')
      || state.jobs.some((job) => job.status === 'queued' || job.status === 'processing');
    if (!hasLiveWork) return;
    const timer = window.setInterval(() => void refresh(true), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, state.jobs, state.nodes]);

  const activeNodes = state.nodes.filter((node) => !node.revokedAt);
  const inventory = useMemo(() => {
    const job = state.jobs.find((item) => item.nodeId === nodeId && item.action === 'list_apps' && item.status === 'succeeded');
    return job?.result?.windows || [];
  }, [nodeId, state.jobs]);

  async function admin(action: string, body: Record<string, unknown>) {
    const response = await fetch('/api/native-nodes/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await response.json() as { ok?: boolean; error?: string; pairing?: { code: string; expiresAt: string; setupCommand: string } };
    if (!response.ok || !data.ok) throw new Error(data.error || 'Native-node operation failed');
    return data;
  }

  async function createPairing() {
    setBusy('pair'); setError(null);
    try {
      const data = await admin('create_pairing', { capabilities: PAIR_CAPABILITIES, nodeOrigin: origin });
      setPairing(data.pairing || null);
      await refresh(true);
    } catch (operationError) { setError(operationError instanceof Error ? operationError.message : 'Pairing failed'); }
    finally { setBusy(null); }
  }

  async function runInventory() {
    if (!nodeId) return;
    setBusy('inventory'); setError(null);
    try {
      await admin('enqueue_job', { nodeId, action: 'list_apps', args: {} });
      await refresh(true);
    } catch (operationError) { setError(operationError instanceof Error ? operationError.message : 'Inventory failed'); }
    finally { setBusy(null); }
  }

  async function createGrant() {
    if (!nodeId) return;
    setBusy('grant'); setError(null);
    try {
      const system = boundary === 'clipboard'
        ? { appId: '__clipboard__', appLabel: 'Clipboard', appRevision: 'windows-clipboard-v1', capabilities: ['clipboard_read', 'clipboard_write'] }
        : { appId: '__file_open__', appLabel: 'File open', appRevision: 'windows-shell-v1', capabilities: ['file_open'] };
      const selected = boundary === 'app'
        ? { appId, appLabel, appRevision, capabilities: ['capture', 'click', 'type'] }
        : system;
      await admin('create_grant', {
        nodeId,
        ...selected,
        ttlMinutes,
        constraints: boundary === 'file' ? { allowedPathPrefix } : {},
      });
      await refresh(true);
    } catch (operationError) { setError(operationError instanceof Error ? operationError.message : 'Grant failed'); }
    finally { setBusy(null); }
  }

  async function revoke(kind: 'node' | 'grant', id: string) {
    const node = kind === 'node' ? state.nodes.find((item) => item.id === id) : undefined;
    const grant = kind === 'grant' ? state.grants.find((item) => item.id === id) : undefined;
    const confirmed = await confirmDialog({
      title: kind === 'node' ? `Revoke ${node?.name || 'native node'}?` : `Revoke ${grant?.appLabel || 'native grant'}?`,
      message: kind === 'node'
        ? 'This immediately blocks the helper and every grant issued to it. Pairing it again will require a new one-time code.'
        : `This immediately removes ${grant?.capabilities.join(', ') || 'the approved capabilities'} from this exact boundary.`,
      confirmLabel: kind === 'node' ? 'Revoke node' : 'Revoke grant',
      danger: true,
    });
    if (!confirmed) return;
    setBusy(id); setError(null);
    try { await admin(kind === 'node' ? 'revoke_node' : 'revoke_grant', kind === 'node' ? { nodeId: id } : { grantId: id }); await refresh(true); }
    catch (operationError) { setError(operationError instanceof Error ? operationError.message : 'Revoke failed'); }
    finally { setBusy(null); }
  }

  function selectWindow(windowInfo: AppWindow) {
    setBoundary('app'); setAppId(windowInfo.appId); setAppLabel(windowInfo.appLabel); setAppRevision(windowInfo.appRevision);
  }

  return (
    <section className="grok-card p-5 space-y-5" aria-labelledby="native-nodes-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><MonitorUp size={19} aria-hidden="true" /><h2 id="native-nodes-heading" className="font-semibold">Native companion nodes</h2></div>
          <p className="text-xs text-muted mt-1 max-w-3xl">Optional, one-shot Windows access when connectors and controlled browsers cannot finish a task. Every app grant expires; click, type, capture, clipboard, and file-open actions require an exact approved grant.</p>
        </div>
        <button type="button" className="grok-btn grok-btn-ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      {error && <div className="rounded-lg border border-error/40 bg-error/10 p-3 text-xs text-error" role="alert">{error}</div>}

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-subtle p-4 space-y-3">
          <div className="flex items-center gap-2"><ShieldCheck size={16} /><h3 className="text-sm font-semibold">Pair a signed helper</h3></div>
          <label className="block text-xs text-muted">HTTPS Studio origin
            <input className="grok-input mt-1 w-full" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://shiba.example.test" />
          </label>
          <button type="button" className="grok-btn grok-btn-primary" disabled={busy !== null} onClick={() => void createPairing()}>
            {busy === 'pair' && <Loader2 size={13} className="animate-spin" />} Create five-minute pairing
          </button>
          {pairing && (
            <div className="rounded-lg bg-raised p-3 space-y-2" role="status">
              <div className="text-xs">Pairing code <strong className="font-mono tracking-wider">{pairing.code}</strong> · expires {new Date(pairing.expiresAt).toLocaleTimeString()}</div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted">{pairing.setupCommand}</pre>
              <button type="button" className="grok-btn grok-btn-ghost" onClick={() => void navigator.clipboard.writeText(pairing.setupCommand)}><Copy size={12} /> Copy setup command</button>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-subtle p-4 space-y-3">
          <h3 className="text-sm font-semibold">Paired nodes</h3>
          {activeNodes.length ? activeNodes.map((node) => (
            <div key={node.id} className="flex items-start justify-between gap-3 rounded-lg bg-raised p-3">
              <div className="min-w-0 text-xs">
                <div className="font-medium truncate">{node.name}</div>
                <div className="text-dim truncate">{node.platform} · {node.releaseId}</div>
                <div className={node.captureState === 'active' ? 'text-error font-medium mt-1' : 'text-dim mt-1'}>
                  {node.captureState === 'active' ? '● Visible native access active' : `Last seen ${node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : 'never'}`}
                </div>
              </div>
              <button type="button" className="grok-btn grok-btn-ghost" aria-label={`Revoke ${node.name}`} disabled={busy !== null} onClick={() => void revoke('node', node.id)}>
                {busy === node.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Revoke
              </button>
            </div>
          )) : <p className="text-xs text-dim">No active native nodes.</p>}
        </div>
      </div>

      {activeNodes.length > 0 && (
        <div className="rounded-xl border border-subtle p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Expiring app grants</h3>
            <select className="grok-input min-w-56" value={nodeId} onChange={(event) => setNodeId(event.target.value)} aria-label="Native node">
              {activeNodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Grant boundary">
            {(['app', 'clipboard', 'file'] as const).map((value) => (
              <button key={value} type="button" className={`grok-btn ${boundary === value ? 'grok-btn-primary' : 'grok-btn-ghost'}`} onClick={() => setBoundary(value)}>
                {value === 'clipboard' && <Clipboard size={12} />}{value === 'app' ? 'Specific app' : value === 'clipboard' ? 'Clipboard' : 'File-open prefix'}
              </button>
            ))}
          </div>
          {boundary === 'app' && (
            <>
              <button type="button" className="grok-btn grok-btn-secondary" disabled={busy !== null} onClick={() => void runInventory()}>
                {busy === 'inventory' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Request window inventory
              </button>
              {inventory.length > 0 && <div className="max-h-48 overflow-auto rounded-lg border border-subtle divide-y divide-subtle">
                {inventory.map((item) => <button type="button" key={`${item.handle}:${item.appRevision}`} className="block w-full p-2 text-left text-xs hover:bg-raised" onClick={() => selectWindow(item)}><span className="font-medium">{item.appLabel}</span> · {item.title}<span className="block text-[10px] text-dim truncate">{item.appId}</span></button>)}
              </div>}
              <div className="grid gap-2 md:grid-cols-3">
                <input className="grok-input" value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="Absolute executable path" aria-label="App executable path" />
                <input className="grok-input" value={appLabel} onChange={(event) => setAppLabel(event.target.value)} placeholder="App label" aria-label="App label" />
                <input className="grok-input" value={appRevision} onChange={(event) => setAppRevision(event.target.value)} placeholder="Exact app revision" aria-label="App revision" />
              </div>
            </>
          )}
          {boundary === 'file' && <input className="grok-input w-full" value={allowedPathPrefix} onChange={(event) => setAllowedPathPrefix(event.target.value)} placeholder="Absolute allowed folder prefix" aria-label="Allowed file-open folder prefix" />}
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted">TTL (minutes)<input className="grok-input mt-1 w-28" type="number" min={1} max={1440} value={ttlMinutes} onChange={(event) => setTtlMinutes(Number(event.target.value))} /></label>
            <button type="button" className="grok-btn grok-btn-primary" disabled={busy !== null} onClick={() => void createGrant()}>{busy === 'grant' && <Loader2 size={13} className="animate-spin" />} Grant exact boundary</button>
          </div>
          <div className="space-y-2">
            {state.grants.filter((grant) => grant.nodeId === nodeId && !grant.revokedAt).map((grant) => (
              <div key={grant.id} className="flex items-start justify-between gap-3 rounded-lg bg-raised p-3 text-xs">
                <div className="min-w-0"><div className="font-medium">{grant.appLabel} · revision {grant.revision}</div><div className="text-dim truncate">{grant.appId}</div><div className="text-dim">{grant.capabilities.join(', ')} · expires {new Date(grant.expiresAt).toLocaleString()}</div></div>
                <button type="button" className="grok-btn grok-btn-ghost" disabled={busy !== null} onClick={() => void revoke('grant', grant.id)}>{busy === grant.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Revoke</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-dim">The helper never continuously records the screen. Captures are one-shot, visibly indicated, stored locally, scanned as untrusted content, and blocked for sensitive app classes.</p>
    </section>
  );
}
