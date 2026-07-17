'use client';

/**
 * Interactive API explorer, served from the app origin so "Send" makes real
 * same-origin calls that pass the proxy.ts guard. Standalone route (not the
 * shell) — open it at http://127.0.0.1:3000/api-docs.
 */
import React, { useMemo, useState } from 'react';
import Link from 'next/link';

type Method = 'GET' | 'POST';

interface Param {
  name: string;
  desc: string;
  example?: string;
}

interface Endpoint {
  group: string;
  method: Method;
  path: string;
  summary: string;
  /** true = changes data on the server; the explorer warns before sending. */
  mutating?: boolean;
  /** true = response may expose secrets; confirmation text is distinct from writes. */
  sensitive?: boolean;
  query?: Param[];
  /** Prefilled JSON body for POST endpoints. */
  body?: string;
}

const ENDPOINTS: Endpoint[] = [
  // --- Read / status ---
  { group: 'Status', method: 'GET', path: '/api/version', summary: 'Running commit, version, and (with checkUpdate=1) the latest GitHub release.', query: [{ name: 'checkUpdate', desc: 'Set to 1 to also probe GitHub releases', example: '1' }] },
  { group: 'Status', method: 'GET', path: '/api/nav-stats', summary: 'Sidebar counts: chats, projects, memories, workspace files, active Automations, integrations, usage cost, cloud reachability.' },
  { group: 'Status', method: 'GET', path: '/api/boot', summary: 'Boot ping — hydrates server config and ensures the single durable Automation engine is running (idempotent).' },
  { group: 'Status', method: 'GET', path: '/api/health', summary: 'Lightweight liveness probe with no startup side effects.' },
  { group: 'Status', method: 'GET', path: '/api/models', summary: 'All selectable models (cloud + local) and cloud-auth flags.' },
  { group: 'Status', method: 'GET', path: '/api/tools', summary: 'The full built-in tool catalog with groups and scope requirements.' },

  // --- Config ---
  { group: 'Config', method: 'GET', path: '/api/config', summary: 'Settings (secrets masked), auth flags, secret-key location.' },
  { group: 'Config', method: 'POST', path: '/api/config', summary: 'Update settings. This example sets the daily spend budget.', mutating: true, body: JSON.stringify({ dailyBudgetUsd: 0 }, null, 2) },
  { group: 'Config', method: 'GET', path: '/api/integrations', summary: 'Configured integration credentials (secret fields masked) + channel-listener status.' },

  // --- Agents & runs ---
  { group: 'Agents', method: 'GET', path: '/api/agents', summary: 'All execution owners with models, workspaces, scopes, skills, and peers.' },
  { group: 'Agents', method: 'GET', path: '/api/runs', summary: 'Recent run summaries (no trace payloads).', query: [{ name: 'agentId', desc: 'Filter to one execution owner' }, { name: 'limit', desc: 'Max rows (default 50)', example: '20' }, { name: 'scheduledOnly', desc: '1 = only Automation-owned runs' }] },
  { group: 'Agents', method: 'GET', path: '/api/runs', summary: 'A single run WITH its full execution trace.', query: [{ name: 'id', desc: 'Run id', example: '' }] },

  // --- Durable Automations ---
  { group: 'Automations', method: 'GET', path: '/api/routines', summary: 'All durable recurring, one-time, manual, webhook, event, filesystem, and health-check Automations.', query: [{ name: 'enabled', desc: 'true or false' }, { name: 'limit', desc: 'Page size', example: '50' }, { name: 'offset', desc: 'Row offset', example: '0' }] },

  // --- Search / logs / usage ---
  { group: 'Observability', method: 'GET', path: '/api/search', summary: 'Global search across chats, memories, runs, and the audit log.', query: [{ name: 'q', desc: 'Query (min 2 chars)', example: 'shiba' }] },
  { group: 'Observability', method: 'GET', path: '/api/logs', summary: 'Audit log, paginated.', query: [{ name: 'q', desc: 'Substring filter', example: '' }, { name: 'category', desc: 'run|chat|agent|config|integration|skill|sync|workspace|auth|system' }, { name: 'limit', desc: 'Page size (max 500)', example: '25' }, { name: 'offset', desc: 'Row offset', example: '0' }] },
  { group: 'Observability', method: 'GET', path: '/api/usage', summary: 'Usage & cost summary (studio metering + optional xAI billing backport).' },

  // --- Content stores ---
  { group: 'Content', method: 'GET', path: '/api/chat-sessions', summary: 'All chat sessions (metadata + messages).' },
  { group: 'Content', method: 'GET', path: '/api/projects', summary: 'All projects.' },
  { group: 'Content', method: 'GET', path: '/api/memories', summary: 'Search and filter shared-chat and per-agent memories.', query: [{ name: 'q', desc: 'Search keys and content' }, { name: 'agentId', desc: 'Scope id (__chat__ or agent id)' }, { name: 'status', desc: 'active|pending|archived' }, { name: 'source', desc: 'manual|tool|learned' }] },
  { group: 'Content', method: 'POST', path: '/api/memories', summary: 'Create, update, approve, archive, pin, delete, or clear memories.', mutating: true, body: JSON.stringify({ action: 'create', agentId: '__chat__', key: 'preferred-package-manager', content: 'Use npm for this workspace.', kind: 'preference', pinned: false }, null, 2) },
  { group: 'Content', method: 'GET', path: '/api/skills', summary: 'Built-in + custom skills.' },
  { group: 'Content', method: 'GET', path: '/api/mcp', summary: 'Configured MCP servers.' },
  { group: 'Content', method: 'GET', path: '/api/workspace', summary: 'List files in a directory.', query: [{ name: 'dir', desc: 'Directory path (default cwd)', example: '' }] },
  { group: 'Content', method: 'GET', path: '/api/fs/browse', summary: 'Folder browser — subdirectories of a path (git repos badged).', query: [{ name: 'dir', desc: 'Directory to list (default home)', example: '' }] },

  // --- Code IDE ---
  { group: 'Code IDE', method: 'GET', path: '/api/ide/files', summary: 'Load the contained workspace root and its first directory level.', query: [{ name: 'action', desc: 'bootstrap|list|read|search', example: 'bootstrap' }, { name: 'workspace', desc: 'Workspace root (default configured workspace)', example: '' }] },
  { group: 'Code IDE', method: 'GET', path: '/api/ide/git', summary: 'Structured Git status, branches, upstream state, remotes, and recent commits.', query: [{ name: 'view', desc: 'snapshot|diff', example: 'snapshot' }, { name: 'workspace', desc: 'Workspace root (default configured workspace)', example: '' }] },
  { group: 'Code IDE', method: 'GET', path: '/api/ide/github', summary: 'Open pull requests, issues, and workflow runs for the workspace origin.', query: [{ name: 'workspace', desc: 'Workspace root (default configured workspace)', example: '' }] },

  // --- CLI & backup ---
  { group: 'CLI & Backup', method: 'GET', path: '/api/grok-cli/status', summary: 'Grok CLI detection: installed, version, path, models.', query: [{ name: 'checkUpdate', desc: '1 = also check for a newer CLI release' }] },
  { group: 'CLI & Backup', method: 'GET', path: '/api/backup', summary: 'Download a full studio backup. Sensitive: the encryption key is included unless omitted.', sensitive: true, query: [{ name: 'key', desc: 'Use "omit" unless you explicitly need a portable secret-bearing backup', example: 'omit' }] },
];

const GROUP_ORDER = ['Status', 'Config', 'Agents', 'Automations', 'Observability', 'Content', 'Code IDE', 'CLI & Backup'];

export default function ApiDocsPage() {
  const [selected, setSelected] = useState<Endpoint>(ENDPOINTS[0]);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [resp, setResp] = useState<{ status: number; ms: number; text: string } | null>(null);
  const [confirmMutation, setConfirmMutation] = useState(false);

  const grouped = useMemo(() => {
    const m = new Map<string, Endpoint[]>();
    for (const e of ENDPOINTS) {
      if (!m.has(e.group)) m.set(e.group, []);
      m.get(e.group)!.push(e);
    }
    return GROUP_ORDER.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
  }, []);

  function pick(e: Endpoint) {
    setSelected(e);
    setQuery(Object.fromEntries((e.query || []).map((p) => [p.name, p.example ?? ''])));
    setBody(e.body ?? '');
    setResp(null);
    setConfirmMutation(false);
  }

  function buildUrl(): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v.trim()) qs.set(k, v.trim());
    const s = qs.toString();
    return selected.path + (s ? `?${s}` : '');
  }

  async function readCapped(response: Response, maxBytes: number): Promise<{ raw: string; truncated: boolean }> {
    if (!response.body) return { raw: '', truncated: false };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let bytes = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - bytes;
        if (value.byteLength > remaining) {
          raw += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
          truncated = true;
          await reader.cancel();
          break;
        }
        bytes += value.byteLength;
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      return { raw, truncated };
    } finally {
      reader.releaseLock();
    }
  }

  async function send() {
    if ((selected.mutating || selected.sensitive) && !confirmMutation) { setConfirmMutation(true); return; }
    setSending(true);
    setResp(null);
    const started = performance.now();
    try {
      const init: RequestInit = { method: selected.method, headers: {} };
      if (selected.method === 'POST') {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        init.body = body || '{}';
      }
      const r = await fetch(buildUrl(), init);
      const ct = r.headers.get('content-type') || '';
      const isJson = ct.includes('application/json');
      const capped = await readCapped(r, isJson ? 100_000 : 4_000);
      let text = capped.raw;
      if (isJson && !capped.truncated) {
        try { text = JSON.stringify(JSON.parse(capped.raw), null, 2); } catch { /* show raw invalid JSON */ }
      }
      if (capped.truncated) text += `\n… (truncated at ${isJson ? '100 KB' : '4 KB'})`;
      setResp({ status: r.status, ms: Math.round(performance.now() - started), text });
    } catch (e) {
      setResp({ status: 0, ms: Math.round(performance.now() - started), text: `Request failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSending(false);
      setConfirmMutation(false);
    }
  }

  return (
    <div className="apidocs-root">
      <aside className="apidocs-sidebar">
        <div className="apidocs-brand">
          <Link href="/" className="apidocs-back">← Shiba Studio</Link>
          <h1>API Explorer</h1>
          <p className="apidocs-note">
            Live, same-origin calls against your running instance. Review every endpoint before sending;
            <strong> POST requests can modify data and some GET responses contain sensitive exports</strong>. Full reference:{' '}
            <a href="https://github.com/stevologic/shiba-studio/blob/main/docs/api.md" target="_blank" rel="noreferrer">docs/api.md</a>.
          </p>
        </div>
        {grouped.map(([group, items]) => (
          <div key={group} className="apidocs-group">
            <div className="apidocs-group-title">{group}</div>
            {items.map((e, i) => {
              const active = e === selected;
              return (
                <button
                  key={`${e.method}-${e.path}-${i}`}
                  type="button"
                  className={`apidocs-endpoint ${active ? 'active' : ''}`}
                  onClick={() => pick(e)}
                >
                  <span className={`apidocs-method apidocs-method-${e.method.toLowerCase()}`}>{e.method}</span>
                  <span className="apidocs-path">{e.path}</span>
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      <main className="apidocs-main">
        <div className="apidocs-req-head">
          <span className={`apidocs-method apidocs-method-${selected.method.toLowerCase()}`}>{selected.method}</span>
          <code className="apidocs-req-path">{buildUrl()}</code>
        </div>
        <p className="apidocs-summary">{selected.summary}</p>

        {(selected.query?.length ?? 0) > 0 && (
          <div className="apidocs-section">
            <div className="apidocs-section-title">Query parameters</div>
            {selected.query!.map((p) => (
              <label key={p.name} className="apidocs-param">
                <span className="apidocs-param-name">{p.name}</span>
                <input
                  className="grok-input apidocs-input"
                  value={query[p.name] ?? ''}
                  placeholder={p.desc}
                  onChange={(ev) => setQuery((q) => ({ ...q, [p.name]: ev.target.value }))}
                />
                <span className="apidocs-param-desc">{p.desc}</span>
              </label>
            ))}
          </div>
        )}

        {selected.method === 'POST' && (
          <div className="apidocs-section">
            <div className="apidocs-section-title">Request body (JSON)</div>
            <textarea
              className="grok-input apidocs-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}

        {selected.mutating && (
          <div className="apidocs-warn">⚠ This is a write endpoint — sending it changes data in your live studio.</div>
        )}
        {selected.sensitive && (
          <div className="apidocs-warn">Sensitive export: the response can contain private workspace data or encryption material.</div>
        )}

        <div className="apidocs-actions">
          <button type="button" className="grok-btn grok-btn-primary" onClick={() => void send()} disabled={sending}>
            {sending ? 'Sending…' : confirmMutation ? 'Click again to confirm' : 'Send request'}
          </button>
          {confirmMutation && (
            <span className="apidocs-confirm-hint">
              {selected.mutating ? 'This will modify data.' : 'This may expose sensitive data.'} Click again to proceed.
            </span>
          )}
        </div>

        {resp && (
          <div className="apidocs-section apidocs-response">
            <div className="apidocs-section-title">
              Response
              <span className={`apidocs-status ${resp.status >= 200 && resp.status < 300 ? 'ok' : 'bad'}`}>
                {resp.status || 'ERR'} · {resp.ms}ms
              </span>
            </div>
            <pre className="apidocs-resp-body">{resp.text}</pre>
          </div>
        )}
      </main>
    </div>
  );
}
