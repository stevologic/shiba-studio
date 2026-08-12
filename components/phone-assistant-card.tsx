'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, Phone } from 'lucide-react';
import type { PhoneAssistantPublicStatus, PhoneAssistantSetup } from '@/lib/phone-assistant-types';

interface AdminPayload {
  ok?: boolean;
  status?: PhoneAssistantPublicStatus;
  setup?: PhoneAssistantSetup;
  token?: string;
  error?: string;
}

export function PhoneAssistantCard() {
  const [status, setStatus] = useState<PhoneAssistantPublicStatus | null>(null);
  const [setup, setSetup] = useState<PhoneAssistantSetup | null>(null);
  const [token, setToken] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const apply = useCallback((payload: AdminPayload) => {
    if (payload.status) {
      setStatus(payload.status);
      setPhoneNumber(payload.status.phoneNumber || '');
    }
    if (payload.setup) setSetup(payload.setup);
    if (payload.token) setToken(payload.token);
  }, []);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const response = await fetch('/api/phone/admin', { cache: 'no-store' });
      const data = await response.json() as AdminPayload;
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load phone assistant');
      apply(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load phone assistant');
    } finally {
      setBusy(null);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch('/api/phone/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await response.json() as AdminPayload;
      if (!response.ok || !data.ok) throw new Error(data.error || 'Phone assistant update failed');
      apply(data);
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : 'Phone assistant update failed');
    } finally {
      setBusy(null);
    }
  }

  async function copy(label: string, value: string) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => current === label ? null : current), 1_500);
  }

  const ready = status?.enabled && status.hasToken;

  return (
    <div className="grok-card p-5 settings-card">
      <div className="settings-card-head">
        <Phone size={16} className="opacity-70 shrink-0" />
        <div>
          <div className="font-medium text-sm">Phone assistant</div>
          <div className="text-[11px] text-dim">Call the Grok number and dictate Studio commands. Grok reaches this machine through MCP.</div>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm mt-3">
        <input
          type="checkbox"
          checked={!!status?.enabled}
          disabled={!status || busy !== null}
          onChange={(event) => void post('set_enabled', { enabled: event.target.checked })}
        />
        Enable phone commands
      </label>

      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          className="grok-btn grok-btn-primary text-sm"
          disabled={busy !== null}
          onClick={() => void post('rotate_token')}
        >
          {busy === 'rotate_token' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
          {status?.hasToken ? 'Rotate token' : 'Generate token'}
        </button>
        {status?.hasToken ? (
          <button
            type="button"
            className="grok-btn grok-btn-ghost text-sm text-error"
            disabled={busy !== null}
            onClick={() => void post('revoke_token')}
          >
            Revoke token
          </button>
        ) : null}
      </div>

      {token ? (
        <div className="mt-3">
          <div className="text-[11px] text-dim mb-1">Bearer token — copy it now. It is not shown again.</div>
          <div className="flex gap-2">
            <input className="grok-input flex-1 min-w-0 font-mono text-xs" readOnly value={token} aria-label="Phone assistant bearer token" />
            <button type="button" className="grok-btn grok-btn-secondary text-xs shrink-0" onClick={() => void copy('token', token)}>
              {copied === 'token' ? <Check size={14} /> : <Copy size={14} />} Copy
            </button>
          </div>
        </div>
      ) : status?.tokenPrefix ? (
        <div className="text-[11px] text-dim mt-2">Active token starts with <span className="font-mono">{status.tokenPrefix}…</span></div>
      ) : null}

      <label className="text-xs text-dim block mt-3">
        Grok phone number (optional)
        <div className="flex gap-2 mt-1">
          <input
            className="grok-input flex-1 min-w-0 font-mono text-xs"
            value={phoneNumber}
            onChange={(event) => setPhoneNumber(event.target.value)}
            placeholder="+1 555 0100"
            aria-label="Grok phone number"
          />
          <button
            type="button"
            className="grok-btn grok-btn-secondary text-xs shrink-0"
            disabled={busy !== null}
            onClick={() => void post('update', { phoneNumber })}
          >
            Save
          </button>
        </div>
      </label>

      <label className="text-xs text-dim block mt-3">
        Incoming SIP webhook secret (optional)
        <input
          className="grok-input w-full mt-1 font-mono text-xs"
          type="password"
          value={webhookSecret}
          onChange={(event) => setWebhookSecret(event.target.value)}
          placeholder={status?.hasWebhookSecret ? '••••••••' : 'whsec_… from CreatePhoneNumberV2'}
          aria-label="Incoming call webhook secret"
        />
      </label>
      {webhookSecret ? (
        <button
          type="button"
          className="grok-btn grok-btn-secondary text-xs mt-2"
          disabled={busy !== null}
          onClick={() => void post('update', { webhookSecret }).then(() => setWebhookSecret(''))}
        >
          Save webhook secret
        </button>
      ) : null}

      <div className="mt-4 space-y-2 text-[11px] text-dim">
        <div>
          MCP URL
          <div className="flex gap-2 mt-1">
            <input className="grok-input flex-1 min-w-0 font-mono text-xs" readOnly value={status?.mcpUrl || 'Set SHIBA_PUBLIC_ORIGIN to get a public URL'} aria-label="Phone MCP URL" />
            <button type="button" className="grok-btn grok-btn-secondary text-xs shrink-0" disabled={!status?.mcpUrl} onClick={() => void copy('mcp', status?.mcpUrl || '')}>
              {copied === 'mcp' ? <Check size={14} /> : <Copy size={14} />} Copy
            </button>
          </div>
        </div>
        {!status?.reachableFromXai ? (
          <p>
            xAI cannot reach localhost. Put Studio behind HTTPS with <code>SHIBA_PUBLIC_ORIGIN</code> (Tailscale Funnel, Cloudflare Tunnel, or a reverse proxy) so the Voice Agent can call these URLs.
          </p>
        ) : (
          <p>Public origin is {status.publicOrigin}. Paste the MCP URL and bearer into <a className="link-accent" href="https://console.x.ai" target="_blank" rel="noreferrer">Voice Agent Builder</a> and call the assigned number.</p>
        )}
        {setup ? (
          <p>
            System prompt: {setup.instructions}
          </p>
        ) : null}
        {ready ? <p className="text-success">Ready — call the number and say things like “create a task to fix login” or “git status”.</p> : null}
      </div>

      {error ? <p className="text-error text-xs mt-3">{error}</p> : null}
    </div>
  );
}

export default PhoneAssistantCard;
