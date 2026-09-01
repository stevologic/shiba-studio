'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, Sparkles } from 'lucide-react';
import type { GrokBotPublicStatus, GrokBotSetup } from '@/lib/grok-bot-types';

interface AdminPayload {
  ok?: boolean;
  status?: GrokBotPublicStatus;
  setup?: GrokBotSetup;
  token?: string;
  error?: string;
}

export function GrokBotCard() {
  const [status, setStatus] = useState<GrokBotPublicStatus | null>(null);
  const [setup, setSetup] = useState<GrokBotSetup | null>(null);
  const [token, setToken] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const apply = useCallback((payload: AdminPayload) => {
    if (payload.status) setStatus(payload.status);
    if (payload.setup) setSetup(payload.setup);
    if (payload.token) setToken(payload.token);
  }, []);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const response = await fetch('/api/grok-bot/admin', { cache: 'no-store' });
      const data = await response.json() as AdminPayload;
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load Grok Bot connector');
      apply(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load Grok Bot connector');
    } finally {
      setBusy(null);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch('/api/grok-bot/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await response.json() as AdminPayload;
      if (!response.ok || !data.ok) throw new Error(data.error || 'Grok Bot connector update failed');
      apply(data);
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : 'Grok Bot connector update failed');
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
  const pluginJson = setup ? JSON.stringify(setup.plugin, null, 2) : '';

  return (
    <div className="grok-card p-5 settings-card">
      <div className="settings-card-head">
        <Sparkles size={16} className="opacity-70 shrink-0" />
        <div>
          <div className="font-medium text-sm">Grok Bot</div>
          <div className="text-[11px] text-dim">Let Grok Bot (and grok.com connectors) operate this Studio over MCP: board, agents, tasks, attention.</div>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm mt-3">
        <input
          type="checkbox"
          checked={!!status?.enabled}
          disabled={!status || busy !== null}
          onChange={(event) => void post('set_enabled', { enabled: event.target.checked })}
        />
        Enable Grok Bot connector
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
            <input className="grok-input flex-1 min-w-0 font-mono text-xs" readOnly value={token} aria-label="Grok Bot bearer token" />
            <button type="button" className="grok-btn grok-btn-secondary text-xs shrink-0" onClick={() => void copy('token', token)}>
              {copied === 'token' ? <Check size={14} /> : <Copy size={14} />} Copy
            </button>
          </div>
        </div>
      ) : status?.tokenPrefix ? (
        <div className="text-[11px] text-dim mt-2">Active token starts with <span className="font-mono">{status.tokenPrefix}…</span></div>
      ) : null}

      <div className="mt-4 space-y-2 text-[11px] text-dim">
        <div>
          Loopback MCP URL (Grok Bot on this machine)
          <div className="flex gap-2 mt-1">
            <input className="grok-input flex-1 min-w-0 font-mono text-xs" readOnly value={status?.loopbackMcpUrl || ''} aria-label="Grok Bot loopback MCP URL" />
            <button type="button" className="grok-btn grok-btn-secondary text-xs shrink-0" disabled={!status?.loopbackMcpUrl} onClick={() => void copy('loopback', status?.loopbackMcpUrl || '')}>
              {copied === 'loopback' ? <Check size={14} /> : <Copy size={14} />} Copy
            </button>
          </div>
        </div>
        <div>
          Public MCP URL (grok.com / xAI Remote MCP)
          <div className="flex gap-2 mt-1">
            <input className="grok-input flex-1 min-w-0 font-mono text-xs" readOnly value={status?.mcpUrl || 'Set SHIBA_PUBLIC_ORIGIN for a public URL'} aria-label="Grok Bot public MCP URL" />
            <button type="button" className="grok-btn grok-btn-secondary text-xs shrink-0" disabled={!status?.mcpUrl} onClick={() => void copy('mcp', status?.mcpUrl || '')}>
              {copied === 'mcp' ? <Check size={14} /> : <Copy size={14} />} Copy
            </button>
          </div>
        </div>
        {setup?.grokCliCommand ? (
          <div>
            Grok Build CLI
            <div className="flex gap-2 mt-1">
              <input className="grok-input flex-1 min-w-0 font-mono text-xs" readOnly value={setup.grokCliCommand} aria-label="Grok CLI MCP add command" />
              <button type="button" className="grok-btn grok-btn-secondary text-xs shrink-0" onClick={() => void copy('cli', setup.grokCliCommand)}>
                {copied === 'cli' ? <Check size={14} /> : <Copy size={14} />} Copy
              </button>
            </div>
          </div>
        ) : null}
        {pluginJson ? (
          <div>
            Grok Bot plugin JSON
            <div className="flex gap-2 mt-1">
              <textarea className="grok-input flex-1 min-w-0 font-mono text-xs" rows={5} readOnly value={pluginJson} aria-label="Grok Bot plugin JSON" />
              <button type="button" className="grok-btn grok-btn-secondary text-xs shrink-0 self-start" onClick={() => void copy('plugin', pluginJson)}>
                {copied === 'plugin' ? <Check size={14} /> : <Copy size={14} />} Copy
              </button>
            </div>
          </div>
        ) : null}
        {!status?.reachableFromXai ? (
          <p>
            Desktop Grok Bot can use the loopback URL. Cloud Grok (grok.com connectors, xAI Remote MCP) cannot reach localhost — set <code>SHIBA_PUBLIC_ORIGIN</code> to an https origin if you need that path.
          </p>
        ) : (
          <p>Public origin is {status.publicOrigin}. Use that URL for grok.com connectors and xAI Remote MCP tools.</p>
        )}
        {ready ? <p className="text-success">Ready — add the MCP URL and bearer in Grok Bot Settings → Plugins, then ask it to list the board or start work.</p> : null}
        {error ? <p className="text-error">{error}</p> : null}
      </div>
    </div>
  );
}
