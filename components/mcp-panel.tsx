'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, Plus, Plug,
  RefreshCw, Server, Trash2, Wrench, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/confirm-dialog';
import type { McpPreset } from '@/lib/mcp-catalog';
import { MCP_PROTOCOL_DOCS_URL, MCP_SERVERS_REGISTRY_URL, getMcpPreset } from '@/lib/mcp-catalog';

type McpServer = {
  id: string;
  name: string;
  presetId?: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  notes?: string;
};

type McpTestState = Record<string, { ok?: boolean; toolCount?: number; tools?: string[]; error?: string }>;

interface McpPanelProps {
  githubToken?: string;
  defaultWorkspace?: string;
  onBrowsePath?: () => void;
  /** Path chosen via parent folder browser (e.g. filesystem preset). */
  externalAllowedPath?: string | null;
}

function ExternalDocsLink({
  href,
  children,
  className = '',
  stopPropagation,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  stopPropagation?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`mcp-docs-link ${className}`}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
      }}
    >
      {children}
      <ExternalLink size={11} className="shrink-0 opacity-70" />
    </a>
  );
}

export default function McpPanel({ githubToken, defaultWorkspace, onBrowsePath, externalAllowedPath }: McpPanelProps) {
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [tests, setTests] = useState<McpTestState>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [addingPreset, setAddingPreset] = useState<string | null>(null);
  const [presetFields, setPresetFields] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState(false);
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState({
    name: '',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-fetch',
    envJson: '{}',
    notes: '',
  });

  const loadMcp = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mcp');
      const data = await res.json();
      if (data.ok) {
        setPresets(data.presets || []);
        setServers(data.servers || []);
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadMcp();
  }, [loadMcp]);

  useEffect(() => {
    if (externalAllowedPath && addingPreset === 'filesystem') {
      setPresetFields((f) => ({ ...f, allowedPath: externalAllowedPath }));
    }
  }, [externalAllowedPath, addingPreset]);

  function openPreset(preset: McpPreset) {
    const values: Record<string, string> = {};
    for (const field of preset.envFields) {
      if (field.key === 'GITHUB_PERSONAL_ACCESS_TOKEN' && githubToken) {
        values[field.key] = githubToken;
      } else if (field.key === 'allowedPath' && defaultWorkspace) {
        values[field.key] = defaultWorkspace;
      }
    }
    setShowCustom(false);
    setPresetFields(values);
    setAddingPreset(preset.id);
  }

  async function confirmAddPreset() {
    if (!addingPreset) return;
    try {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'addPreset', presetId: addingPreset, fieldValues: presetFields }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast.success(`${data.server?.name || 'MCP server'} added`);
      setAddingPreset(null);
      setPresetFields({});
      await loadMcp();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to add MCP server');
    }
  }

  async function addCustom() {
    let env: Record<string, string> = {};
    try {
      env = customForm.envJson.trim() ? JSON.parse(customForm.envJson) : {};
    } catch {
      toast.error('Env must be valid JSON');
      return;
    }
    try {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'addCustom',
          name: customForm.name,
          command: customForm.command,
          args: customForm.args.split(/\s+/).filter(Boolean),
          env,
          notes: customForm.notes,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast.success(`Custom MCP "${data.server?.name}" added`);
      setShowCustom(false);
      setCustomForm({ name: '', command: 'npx', args: '-y @modelcontextprotocol/server-fetch', envJson: '{}', notes: '' });
      await loadMcp();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to add custom server');
    }
  }

  async function toggleServer(id: string, enabled: boolean) {
    await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', id, enabled }),
    });
    await loadMcp();
  }

  async function deleteServer(id: string, name: string) {
    const ok = await confirmDialog({
      title: `Remove MCP server "${name}"?`,
      message: 'Agents will no longer be able to call its tools.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    });
    toast.success('MCP server removed');
    if (expandedServerId === id) setExpandedServerId(null);
    await loadMcp();
  }

  async function testServer(id: string) {
    setTestingId(id);
    try {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id }),
      });
      const data = await res.json();
      setTests((t) => ({ ...t, [id]: data }));
      if (data.ok) {
        toast.success(`Connected · ${data.toolCount ?? 0} tools`);
        setExpandedServerId(id);
      } else toast.error(data.error || 'MCP test failed');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Test failed');
    }
    setTestingId(null);
  }

  const activePreset = addingPreset ? presets.find((p) => p.id === addingPreset) : null;
  const configuredPresetIds = new Set(servers.map((s) => s.presetId).filter(Boolean));
  const enabledCount = servers.filter((s) => s.enabled).length;

  return (
    <div className="mcp-section mt-10 pt-8 border-t border-default">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-xl font-semibold flex items-center gap-2">
            <Server size={18} className="opacity-70" />
            MCP Servers
          </div>
          <div className="text-sm text-muted mt-1 max-w-2xl">
            Plug-in tools for agents via the{' '}
            <ExternalDocsLink href={MCP_PROTOCOL_DOCS_URL}>Model Context Protocol</ExternalDocsLink>
            . Add a public preset (with docs), or connect any stdio MCP server.
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ExternalDocsLink href={MCP_SERVERS_REGISTRY_URL} className="grok-btn grok-btn-ghost text-xs">
            <BookOpen size={13} />
            MCP registry
          </ExternalDocsLink>
          <button type="button" onClick={loadMcp} disabled={loading} className="grok-btn grok-btn-ghost text-xs">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Status strip */}
      <div className="mcp-status-strip mb-6">
        <div className="mcp-status-pill">
          <Server size={13} />
          <span>{servers.length} installed</span>
        </div>
        <div className={`mcp-status-pill ${enabledCount > 0 ? 'mcp-status-pill-ok' : ''}`}>
          <Zap size={13} />
          <span>{enabledCount} enabled for agents</span>
        </div>
        <div className="mcp-status-pill mcp-status-pill-muted">
          <Wrench size={13} />
          <span>Tools appear after you Test a server</span>
        </div>
      </div>

      {/* Step 1 — catalog */}
      <div className="mcp-step-label">
        <span className="mcp-step-num">1</span>
        <div>
          <div className="font-medium text-sm">Browse &amp; add a server</div>
          <div className="text-[11px] text-dim">Public presets include docs. Click a card to configure, or open Docs without adding.</div>
        </div>
      </div>

      <div className="mcp-preset-grid mb-4">
        {presets.map((preset) => {
          const configured = configuredPresetIds.has(preset.id);
          const isActive = addingPreset === preset.id;
          return (
            <div
              key={preset.id}
              className={`mcp-preset-card grok-card ${configured ? 'mcp-preset-card-active' : ''} ${isActive ? 'mcp-preset-card-selected' : ''}`}
            >
              <button
                type="button"
                className="mcp-preset-card-main text-left"
                onClick={() => openPreset(preset)}
              >
                <div className="flex items-start gap-3">
                  <img src={preset.icon} alt="" className="integration-icon" width={24} height={24} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{preset.name}</span>
                      {preset.category && (
                        <span className="mcp-cat-chip">{preset.category}</span>
                      )}
                      {configured && (
                        <span className="mcp-badge-installed">
                          <CheckCircle2 size={11} /> Installed
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-dim mt-1 line-clamp-2">{preset.description}</div>
                    {preset.toolsHint && (
                      <div className="text-[10px] text-muted mt-1.5 flex items-start gap-1">
                        <Wrench size={10} className="mt-0.5 shrink-0 opacity-60" />
                        <span className="line-clamp-1">{preset.toolsHint}</span>
                      </div>
                    )}
                  </div>
                </div>
              </button>
              <div className="mcp-preset-card-footer">
                {preset.docsUrl ? (
                  <ExternalDocsLink href={preset.docsUrl} stopPropagation className="text-[11px]">
                    <BookOpen size={12} />
                    Docs
                  </ExternalDocsLink>
                ) : (
                  <span className="text-[11px] text-dim">Private / custom</span>
                )}
                <button
                  type="button"
                  className="grok-btn grok-btn-secondary text-[11px] py-0.5 px-2"
                  onClick={() => openPreset(preset)}
                >
                  {configured ? 'Add another' : 'Add'}
                </button>
              </div>
            </div>
          );
        })}

        <div className={`mcp-preset-card grok-card mcp-preset-card-custom ${showCustom ? 'mcp-preset-card-selected' : ''}`}>
          <button
            type="button"
            className="mcp-preset-card-main text-left"
            onClick={() => {
              setAddingPreset(null);
              setShowCustom((v) => !v);
            }}
          >
            <div className="flex items-start gap-3">
              <img src="/integrations/mcp-custom.svg" alt="" className="integration-icon" width={24} height={24} />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm flex items-center gap-2">
                  Custom server
                  <span className="mcp-cat-chip">Advanced</span>
                </div>
                <div className="text-[11px] text-dim mt-1">
                  Any stdio MCP — command, args, and env. Paste from a package README.
                </div>
              </div>
              <Plus size={16} className="shrink-0 opacity-50" />
            </div>
          </button>
          <div className="mcp-preset-card-footer">
            <ExternalDocsLink href={MCP_PROTOCOL_DOCS_URL} stopPropagation className="text-[11px]">
              <BookOpen size={12} />
              How MCP works
            </ExternalDocsLink>
            <button
              type="button"
              className="grok-btn grok-btn-secondary text-[11px] py-0.5 px-2"
              onClick={() => {
                setAddingPreset(null);
                setShowCustom(true);
              }}
            >
              Configure
            </button>
          </div>
        </div>
      </div>

      {/* Configure drawer for preset */}
      {activePreset && (
        <div className="grok-card p-4 mb-6 mcp-config-panel">
          <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <img src={activePreset.icon} alt="" width={20} height={20} className="integration-icon" />
              <div>
                <div className="font-medium text-sm">Configure {activePreset.name}</div>
                {activePreset.packageName && (
                  <div className="text-[10px] font-mono text-dim mt-0.5">{activePreset.packageName}</div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {activePreset.docsUrl && (
                <ExternalDocsLink href={activePreset.docsUrl} className="text-xs">
                  <BookOpen size={12} />
                  Documentation
                </ExternalDocsLink>
              )}
              {activePreset.homepageUrl && activePreset.homepageUrl !== activePreset.docsUrl && (
                <ExternalDocsLink href={activePreset.homepageUrl} className="text-xs">
                  Package
                </ExternalDocsLink>
              )}
            </div>
          </div>

          {activePreset.envFields.length === 0 ? (
            <div className="text-xs text-dim mb-3 p-2 rounded border border-default bg-elev">
              No credentials required — click Add server to install and enable it for agents.
            </div>
          ) : (
            <div className="space-y-3 mb-3">
              {activePreset.envFields.map((field) => (
                <div key={field.key}>
                  <div className="grok-label text-[10px]">
                    {field.label}
                    {field.required ? <span className="text-error"> *</span> : null}
                  </div>
                  {field.help && <div className="text-[10px] text-dim mb-1">{field.help}</div>}
                  <div className="flex gap-2">
                    <input
                      className="grok-input text-xs flex-1"
                      type={field.secret ? 'password' : 'text'}
                      placeholder={field.placeholder}
                      value={presetFields[field.key] || ''}
                      onChange={(e) => setPresetFields((f) => ({ ...f, [field.key]: e.target.value }))}
                      autoComplete="off"
                    />
                    {field.asArg && onBrowsePath && (
                      <button type="button" className="grok-btn grok-btn-secondary text-xs shrink-0" onClick={onBrowsePath}>
                        Browse
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={confirmAddPreset} className="grok-btn grok-btn-primary text-xs">
              <Plus size={13} /> Add server
            </button>
            <button type="button" onClick={() => setAddingPreset(null)} className="grok-btn grok-btn-secondary text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

      {showCustom && (
        <div className="grok-card p-4 mb-6 space-y-2 mcp-config-panel">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium text-sm">Custom MCP server</div>
            <ExternalDocsLink href={MCP_PROTOCOL_DOCS_URL} className="text-xs">
              <BookOpen size={12} />
              MCP docs
            </ExternalDocsLink>
          </div>
          <div className="text-[11px] text-dim">
            Run any local stdio server. Typical pattern: <span className="font-mono">npx -y @scope/package</span>
          </div>
          <input className="grok-input text-xs" placeholder="Display name" value={customForm.name} onChange={(e) => setCustomForm((f) => ({ ...f, name: e.target.value }))} />
          <input className="grok-input text-xs font-mono" placeholder="Command (npx, node, python…)" value={customForm.command} onChange={(e) => setCustomForm((f) => ({ ...f, command: e.target.value }))} />
          <input className="grok-input text-xs font-mono" placeholder="Args (space-separated)" value={customForm.args} onChange={(e) => setCustomForm((f) => ({ ...f, args: e.target.value }))} />
          <textarea className="grok-input text-xs font-mono h-16" placeholder='Env JSON e.g. {"API_KEY":"..."}' value={customForm.envJson} onChange={(e) => setCustomForm((f) => ({ ...f, envJson: e.target.value }))} />
          <input className="grok-input text-xs" placeholder="Notes (optional)" value={customForm.notes} onChange={(e) => setCustomForm((f) => ({ ...f, notes: e.target.value }))} />
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={addCustom} className="grok-btn grok-btn-primary text-xs">Save custom server</button>
            <button type="button" onClick={() => setShowCustom(false)} className="grok-btn grok-btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      )}

      {/* Step 2 — installed */}
      <div className="mcp-step-label mt-8">
        <span className="mcp-step-num">2</span>
        <div>
          <div className="font-medium text-sm">Your installed servers</div>
          <div className="text-[11px] text-dim">
            Enable for agents, Test to list tools, open Docs for public packages. Disabled servers stay saved but unused.
          </div>
        </div>
      </div>

      {servers.length === 0 && (
        <div className="grok-card p-8 text-center mcp-empty">
          <Plug size={28} className="mx-auto mb-3 opacity-40" />
          <div className="text-sm font-medium mb-1">No MCP servers yet</div>
          <div className="text-xs text-dim max-w-sm mx-auto">
            Pick a preset above — most public servers only need an API key or folder path.
            After adding, hit <strong>Test</strong> to verify tools load.
          </div>
        </div>
      )}

      <div className="space-y-3">
        {servers.map((server) => {
          const test = tests[server.id];
          const preset = server.presetId ? getMcpPreset(server.presetId) || presets.find((p) => p.id === server.presetId) : undefined;
          const expanded = expandedServerId === server.id;
          return (
            <div
              key={server.id}
              className={`grok-card mcp-server-card ${server.enabled ? 'mcp-server-card-enabled' : 'mcp-server-card-disabled'}`}
            >
              <div className="mcp-server-card-top">
                <button
                  type="button"
                  className="mcp-server-card-toggle-expand"
                  onClick={() => setExpandedServerId(expanded ? null : server.id)}
                  aria-expanded={expanded}
                >
                  {preset?.icon ? (
                    <img src={preset.icon} alt="" width={22} height={22} className="integration-icon shrink-0" />
                  ) : (
                    <Server size={18} className="opacity-50 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1 text-left">
                    <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
                      <span className="truncate">{server.name}</span>
                      {server.enabled ? (
                        <span className="mcp-badge-on">On</span>
                      ) : (
                        <span className="mcp-badge-off">Off</span>
                      )}
                      {test?.ok && (
                        <span className="mcp-badge-ok">
                          <CheckCircle2 size={11} /> {test.toolCount} tools
                        </span>
                      )}
                      {test && !test.ok && (
                        <span className="mcp-badge-err">Failed</span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-dim mt-0.5 truncate">
                      {server.command} {server.args.join(' ')}
                    </div>
                  </div>
                  {expanded ? <ChevronUp size={16} className="opacity-50 shrink-0" /> : <ChevronDown size={16} className="opacity-50 shrink-0" />}
                </button>

                <div className="mcp-server-card-actions" onClick={(e) => e.stopPropagation()}>
                  <label className="mcp-enable-switch" title={server.enabled ? 'Disable for agents' : 'Enable for agents'}>
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={(e) => toggleServer(server.id, e.target.checked)}
                    />
                    <span>{server.enabled ? 'Enabled' : 'Disabled'}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => testServer(server.id)}
                    disabled={testingId === server.id}
                    className="grok-btn grok-btn-secondary text-xs"
                  >
                    {testingId === server.id ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteServer(server.id, server.name)}
                    className="grok-btn grok-btn-ghost text-xs text-error"
                    title="Remove server"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {expanded && (
                <div className="mcp-server-card-body">
                  {preset?.docsUrl && (
                    <div className="mcp-server-docs-row">
                      <BookOpen size={13} className="opacity-60 shrink-0" />
                      <span className="text-xs text-dim">Public documentation</span>
                      <ExternalDocsLink href={preset.docsUrl} className="text-xs ml-auto">
                        Open docs
                      </ExternalDocsLink>
                      {preset.homepageUrl && preset.homepageUrl !== preset.docsUrl && (
                        <ExternalDocsLink href={preset.homepageUrl} className="text-xs">
                          Package / site
                        </ExternalDocsLink>
                      )}
                    </div>
                  )}
                  {!preset?.docsUrl && server.presetId == null && (
                    <div className="text-[11px] text-dim mb-2">
                      Custom server — documentation lives with the package you installed.
                      See the{' '}
                      <ExternalDocsLink href={MCP_PROTOCOL_DOCS_URL}>MCP docs</ExternalDocsLink>
                      {' '}for how stdio servers work.
                    </div>
                  )}

                  {server.notes && (
                    <div className="text-[11px] text-muted mb-2">{server.notes}</div>
                  )}

                  {test?.ok && test.tools && test.tools.length > 0 && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-dim mb-1.5">Tools exposed</div>
                      <div className="mcp-tool-chips">
                        {test.tools.map((tool) => (
                          <span key={tool} className="mcp-tool-chip font-mono">{tool}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {test && !test.ok && test.error && (
                    <div className="text-xs text-error mt-1 p-2 rounded border border-default bg-elev">
                      {test.error}
                    </div>
                  )}
                  {!test && (
                    <div className="text-[11px] text-dim">
                      Click <strong>Test</strong> to spawn the server and list tools agents can call.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
