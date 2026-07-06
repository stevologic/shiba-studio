'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Plug, RefreshCw, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/confirm-dialog';
import type { McpPreset } from '@/lib/mcp-catalog';

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

export default function McpPanel({ githubToken, defaultWorkspace, onBrowsePath, externalAllowedPath }: McpPanelProps) {
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [tests, setTests] = useState<McpTestState>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [addingPreset, setAddingPreset] = useState<string | null>(null);
  const [presetFields, setPresetFields] = useState<Record<string, string>>({});
  const [showCustom, setShowCustom] = useState(false);
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
      if (data.ok) toast.success(`Connected · ${data.toolCount ?? 0} tools`);
      else toast.error(data.error || 'MCP test failed');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Test failed');
    }
    setTestingId(null);
  }

  const activePreset = addingPreset ? presets.find((p) => p.id === addingPreset) : null;
  const configuredPresetIds = new Set(servers.map((s) => s.presetId).filter(Boolean));

  return (
    <div className="mcp-section mt-10 pt-8 border-t border-default">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-xl font-semibold flex items-center gap-2">
            <Plug size={18} className="opacity-70" />
            MCP Servers
          </div>
          <div className="text-sm text-muted mt-1">
            Model Context Protocol tools for agents — one-click presets or roll your own.
          </div>
        </div>
        <button type="button" onClick={loadMcp} disabled={loading} className="grok-btn grok-btn-ghost text-xs">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="text-xs text-dim mb-3 uppercase tracking-wide">One-click add</div>
      <div className="mcp-preset-grid mb-6">
        {presets.map((preset) => {
          const configured = configuredPresetIds.has(preset.id);
          return (
            <button
              key={preset.id}
              type="button"
              className={`mcp-preset-card grok-card p-4 text-left ${configured ? 'mcp-preset-card-active' : ''}`}
              onClick={() => openPreset(preset)}
            >
              <div className="flex items-start gap-3">
                <img src={preset.icon} alt="" className="integration-icon" width={22} height={22} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{preset.name}</div>
                  <div className="text-[11px] text-dim mt-0.5 line-clamp-2">{preset.description}</div>
                  {configured && <div className="text-[10px] text-success mt-1">Configured</div>}
                </div>
                <Zap size={14} className="shrink-0 opacity-40" />
              </div>
            </button>
          );
        })}
        <button
          type="button"
          className="mcp-preset-card grok-card p-4 text-left mcp-preset-card-custom"
          onClick={() => setShowCustom((v) => !v)}
        >
          <div className="flex items-start gap-3">
            <img src="/integrations/mcp-custom.svg" alt="" className="integration-icon" width={22} height={22} />
            <div>
              <div className="font-medium text-sm">Custom</div>
              <div className="text-[11px] text-dim mt-0.5">Any stdio MCP server — command, args, env</div>
            </div>
            <Plus size={14} className="shrink-0 opacity-40" />
          </div>
        </button>
      </div>

      {activePreset && (
        <div className="grok-card p-4 mb-6 mcp-preset-form">
          <div className="font-medium mb-2">Add {activePreset.name}</div>
          {activePreset.envFields.length === 0 ? (
            <div className="text-xs text-dim mb-3">No extra configuration required.</div>
          ) : (
            <div className="space-y-2 mb-3">
              {activePreset.envFields.map((field) => (
                <div key={field.key}>
                  <div className="grok-label text-[10px]">{field.label}</div>
                  <div className="flex gap-2">
                    <input
                      className="grok-input text-xs flex-1"
                      type={field.secret ? 'password' : 'text'}
                      placeholder={field.placeholder}
                      value={presetFields[field.key] || ''}
                      onChange={(e) => setPresetFields((f) => ({ ...f, [field.key]: e.target.value }))}
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
            <button type="button" onClick={confirmAddPreset} className="grok-btn grok-btn-primary text-xs">Add server</button>
            <button type="button" onClick={() => setAddingPreset(null)} className="grok-btn grok-btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      )}

      {showCustom && (
        <div className="grok-card p-4 mb-6 space-y-2">
          <div className="font-medium text-sm">Custom MCP server</div>
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

      <div className="text-xs text-dim mb-3 uppercase tracking-wide">Configured servers</div>
      {servers.length === 0 && (
        <div className="grok-card p-6 text-center text-dim text-sm">No MCP servers yet — pick a preset above.</div>
      )}
      <div className="space-y-3">
        {servers.map((server) => {
          const test = tests[server.id];
          return (
            <div key={server.id} className="grok-card p-4 mcp-server-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium flex items-center gap-2 flex-wrap">
                    {server.name}
                    <label className="flex items-center gap-1.5 text-xs text-dim cursor-pointer">
                      <input
                        type="checkbox"
                        checked={server.enabled}
                        onChange={(e) => toggleServer(server.id, e.target.checked)}
                      />
                      {server.enabled ? 'Enabled' : 'Disabled'}
                    </label>
                  </div>
                  <div className="text-[11px] font-mono text-dim mt-1 truncate">
                    {server.command} {server.args.join(' ')}
                  </div>
                  {test?.ok && (
                    <div className="text-[10px] text-success mt-1">
                      {test.toolCount} tool{test.toolCount === 1 ? '' : 's'}
                      {test.tools?.length ? ` · ${test.tools.slice(0, 4).join(', ')}${(test.tools.length > 4) ? '…' : ''}` : ''}
                    </div>
                  )}
                  {test && !test.ok && test.error && (
                    <div className="text-[10px] text-error mt-1">{test.error}</div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => testServer(server.id)}
                    disabled={testingId === server.id}
                    className="grok-btn grok-btn-secondary text-xs"
                  >
                    {testingId === server.id ? 'Testing…' : 'Test'}
                  </button>
                  <button type="button" onClick={() => deleteServer(server.id, server.name)} className="grok-btn grok-btn-ghost text-xs text-error">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}