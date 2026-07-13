'use client';

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, KeyRound, Loader2, Play, ShieldX } from 'lucide-react';
import type { HarnessGrant, HarnessProvider } from '@/lib/harness-grants';
import type { TaskRecord } from '@/lib/task-types';

const TOOL_OPTIONS = [
  { id: 'fs.read', label: 'Read workspace files' },
  { id: 'fs.write', label: 'Edit workspace files' },
  { id: 'shell:test', label: 'Run tests and builds' },
  { id: 'git.diff', label: 'Inspect Git diffs' },
];

export function HarnessGrantPanel({ task }: { task: TaskRecord }) {
  const writableRoots = task.workspaceRoots.filter((root) => root.permission === 'write');
  const [grants, setGrants] = useState<HarnessGrant[]>([]);
  const [provider, setProvider] = useState<HarnessProvider>('grok');
  const [workspaceRootId, setWorkspaceRootId] = useState(writableRoots[0]?.id || '');
  const [allowedTools, setAllowedTools] = useState<string[]>(['fs.read', 'fs.write', 'shell:test', 'git.diff']);
  const [ttlMinutes, setTtlMinutes] = useState(15);
  const [token, setToken] = useState<{ grantId: string; value: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/harness-grants?taskId=${encodeURIComponent(task.id)}`, { cache: 'no-store', signal });
    const data = await response.json() as { ok?: boolean; grants?: HarnessGrant[]; error?: string };
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load harness grants');
    setGrants(data.grants || []);
    setError(null);
  }, [task.id]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(controller.signal).catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load harness grants');
      });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function issue() {
    if (!workspaceRootId || !allowedTools.length) return;
    setPending('issue');
    setError(null);
    try {
      const response = await fetch('/api/harness-grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, provider, workspaceRootId, allowedTools, ttlSeconds: ttlMinutes * 60 }),
      });
      const data = await response.json() as { ok?: boolean; grant?: HarnessGrant; token?: string; error?: string };
      if (!response.ok || !data.ok || !data.grant || !data.token) throw new Error(data.error || 'Could not issue harness grant');
      setToken({ grantId: data.grant.id, value: data.token });
      await load();
    } catch (issueError) {
      setError(issueError instanceof Error ? issueError.message : 'Could not issue harness grant');
    } finally {
      setPending(null);
    }
  }

  async function start(grant: HarnessGrant) {
    if (token?.grantId !== grant.id) return;
    setPending(grant.id);
    setError(null);
    try {
      const response = await fetch(`/api/harness-grants/${encodeURIComponent(grant.id)}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: 'Work the attached Shiba task within the issued capability grant.' }),
      });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not start harness');
      await load();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not start harness');
    } finally {
      setPending(null);
    }
  }

  async function revoke(grant: HarnessGrant) {
    setPending(grant.id);
    setError(null);
    try {
      const response = await fetch(`/api/harness-grants/${encodeURIComponent(grant.id)}/revoke`, { method: 'POST' });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not revoke harness');
      if (token?.grantId === grant.id) setToken(null);
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'Could not revoke harness');
    } finally {
      setPending(null);
    }
  }

  if (!writableRoots.length) return null;
  return (
    <section className="grok-card p-5 space-y-4" aria-labelledby="harness-heading">
      <div>
        <h2 id="harness-heading" className="text-base font-semibold flex items-center gap-2"><KeyRound size={16} aria-hidden="true" /> External coding harness</h2>
        <p className="text-xs text-dim mt-1">Issue a one-session, expiring capability for one workspace. Ambient secrets and MCP servers are excluded.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-xs">Provider
          <select className="grok-select w-full mt-1" value={provider} onChange={(event) => setProvider(event.target.value as HarnessProvider)}>
            <option value="grok">Grok CLI</option><option value="codex">Codex CLI</option><option value="claude">Claude Code</option><option value="hermes">Hermes Agent</option>
          </select>
        </label>
        <label className="text-xs">Workspace
          <select className="grok-select w-full mt-1" value={workspaceRootId} onChange={(event) => setWorkspaceRootId(event.target.value)}>
            {writableRoots.map((root) => <option key={root.id} value={root.id}>{root.label || root.path}</option>)}
          </select>
        </label>
        <label className="text-xs">Expires after
          <select className="grok-select w-full mt-1" value={ttlMinutes} onChange={(event) => setTtlMinutes(Number(event.target.value))}>
            <option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option>
          </select>
        </label>
      </div>
      <fieldset>
        <legend className="text-xs font-medium">Allowed action classes</legend>
        <div className="flex flex-wrap gap-3 mt-2">
          {TOOL_OPTIONS.map((tool) => (
            <label key={tool.id} className="inline-flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={allowedTools.includes(tool.id)} onChange={(event) => setAllowedTools((current) => event.target.checked ? [...current, tool.id] : current.filter((id) => id !== tool.id))} />
              {tool.label}
            </label>
          ))}
        </div>
      </fieldset>
      <button type="button" className="grok-btn grok-btn-secondary" disabled={!!pending || !allowedTools.length} onClick={() => void issue()}>
        {pending === 'issue' ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} Issue scoped grant
      </button>
      {token && (
        <div className="border border-warning rounded-md p-3" role="status">
          <div className="text-xs font-medium">One-time capability token</div>
          <input className="grok-input w-full font-mono text-xs mt-2" readOnly value={token.value} aria-label="One-time harness capability token" />
          <p className="text-[11px] text-dim mt-1">Shown only in this page state. Treat it like a password until it expires or is revoked.</p>
        </div>
      )}
      {error && <div className="text-xs text-error" role="alert">{error}</div>}
      {grants.length > 0 && (
        <ul className="space-y-2" aria-label="External harness grants">
          {grants.map((grant) => (
            <li key={grant.id} className="border border-default rounded-md p-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium capitalize">{grant.provider}</span><span className="status-pill text-dim">{grant.status}</span>
              <span className="text-dim">expires {new Date(grant.expiresAt).toLocaleTimeString()}</span>
              <a className="link-accent inline-flex items-center gap-1" href={`/tasks/${encodeURIComponent(grant.childTaskId)}`}>Child task <ExternalLink size={11} /></a>
              <span className="ml-auto flex gap-1">
                {grant.status === 'issued' && token?.grantId === grant.id && <button type="button" className="grok-btn grok-btn-primary" disabled={!!pending} onClick={() => void start(grant)}><Play size={12} /> {grant.provider === 'grok' ? 'Start' : 'Attach'}</button>}
                {(grant.status === 'issued' || grant.status === 'active') && <button type="button" className="grok-btn grok-btn-ghost text-error" disabled={!!pending} onClick={() => void revoke(grant)}><ShieldX size={12} /> Revoke</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default HarnessGrantPanel;
