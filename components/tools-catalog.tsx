'use client';

// Built-in agent tool catalog — surfaced on the Capabilities page so users can
// see exactly what agents can call during runs (sourced live from the runtime
// definitions via /api/tools, never a hardcoded copy). Each tool has a toggle
// to disable it globally for agent runs and workspace chat.

import React, { useEffect, useState } from 'react';
import { Wrench, TerminalSquare, Globe, Plug2, Workflow, Boxes, Search, Compass, Brain, Image as ImageIcon, Container, KanbanSquare } from 'lucide-react';
import { toast } from '@/lib/toast';
import InfoHint from '@/components/info-hint';

interface ToolEntry {
  name: string;
  description: string;
  group: string;
  requires?: string;
  enabled: boolean;
}

const GROUP_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  'Workspace & Files': TerminalSquare,
  Sandbox: Container,
  'Web & Research': Compass,
  'Browser Automation': Globe,
  Memory: Brain,
  'AI Generation': ImageIcon,
  Integrations: Plug2,
  Orchestration: Workflow,
  Board: KanbanSquare,
  MCP: Boxes,
};

const GROUP_BLURBS: Record<string, string> = {
  'Workspace & Files': 'Read, write, search, and run commands inside the agent workspace.',
  Sandbox: 'Each agent\'s own Alpine Linux container — install packages and experiment in isolation.',
  'Web & Research': 'Search the web and read pages — no API keys required.',
  'Browser Automation': 'Drive the controlled Chrome browser — navigate, click, extract.',
  Memory: 'Save, recall, and forget durable knowledge. Relevant active memories load before runs; optional learning proposes or activates new ones afterward.',
  'AI Generation': 'Create images from prompts with xAI; results appear in the run trace.',
  Integrations: 'Act on connected services; each tool unlocks with its integration scope.',
  Orchestration: 'Agents coordinating agents — peer messages and self-scheduling.',
  Board: 'Read and edit the shared Kanban — assign, prioritize, label, and route work across agents.',
  MCP: 'Discover and invoke tools on configured MCP servers.',
};

// Stable presentation order — most-used groups first.
const GROUP_ORDER = ['Workspace & Files', 'Sandbox', 'Web & Research', 'Browser Automation', 'Memory', 'AI Generation', 'Integrations', 'Orchestration', 'Board', 'MCP'];

function requirementChip(tool: ToolEntry): { label: string; cls: string } {
  if (!tool.enabled) return { label: 'disabled', cls: 'tool-chip-disabled' };
  if (tool.requires === 'peers') return { label: 'needs peers', cls: 'tool-chip-req' };
  if (tool.requires === 'mcp') return { label: 'needs MCP server', cls: 'tool-chip-req' };
  if (tool.requires === 'xai') return { label: 'needs xAI auth', cls: 'tool-chip-req' };
  if (tool.requires) return { label: `${tool.requires} scope`, cls: 'tool-chip-req' };
  return { label: 'always on', cls: 'tool-chip-always' };
}

export default function ToolsCatalog() {
  const [tools, setTools] = useState<ToolEntry[] | null>(null);
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // Tool names whose description is expanded past the 2-line clamp.
  const [openDescs, setOpenDescs] = useState<Set<string>>(new Set());

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const res = await fetch('/api/tools');
        const data = await res.json();
        if (!stale && data.ok) {
          setTools((data.tools || []).map((t: ToolEntry) => ({
            ...t,
            enabled: t.enabled !== false,
          })));
        }
      } catch {
        if (!stale) setTools([]);
      }
    })();
    return () => { stale = true; };
  }, []);

  async function toggleTool(tool: ToolEntry, enabled: boolean) {
    if (pending[tool.name]) return;
    setPending((p) => ({ ...p, [tool.name]: true }));
    // Optimistic update
    setTools((list) =>
      (list || []).map((t) => (t.name === tool.name ? { ...t, enabled } : t)),
    );
    try {
      const res = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: tool.name, enabled }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Update failed');
      // Reconcile from server list if provided
      if (Array.isArray(data.disabledTools)) {
        const disabled = new Set(data.disabledTools as string[]);
        setTools((list) =>
          (list || []).map((t) => ({ ...t, enabled: !disabled.has(t.name) })),
        );
      }
    } catch (e: unknown) {
      // Revert
      setTools((list) =>
        (list || []).map((t) => (t.name === tool.name ? { ...t, enabled: tool.enabled } : t)),
      );
      toast.error(e instanceof Error ? e.message : 'Could not update tool');
    }
    setPending((p) => {
      const next = { ...p };
      delete next[tool.name];
      return next;
    });
  }

  async function setGroupEnabled(group: string, enabled: boolean) {
    const groupTools = (tools || []).filter((t) => t.group === group);
    if (!groupTools.length) return;
    setPending((p) => {
      const next = { ...p };
      for (const t of groupTools) next[t.name] = true;
      return next;
    });
    setTools((list) =>
      (list || []).map((t) => (t.group === group ? { ...t, enabled } : t)),
    );
    try {
      // Build next disabled list from current catalog + this group change
      const disabled = new Set(
        (tools || []).filter((t) => !t.enabled && t.group !== group).map((t) => t.name),
      );
      if (!enabled) {
        for (const t of groupTools) disabled.add(t.name);
      } else {
        for (const t of groupTools) disabled.delete(t.name);
      }
      const res = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabledTools: [...disabled] }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Update failed');
      if (Array.isArray(data.disabledTools)) {
        const set = new Set(data.disabledTools as string[]);
        setTools((list) =>
          (list || []).map((t) => ({ ...t, enabled: !set.has(t.name) })),
        );
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not update group');
      // Reload
      try {
        const res = await fetch('/api/tools');
        const data = await res.json();
        if (data.ok) setTools(data.tools || []);
      } catch { /* */ }
    }
    setPending((p) => {
      const next = { ...p };
      for (const t of groupTools) delete next[t.name];
      return next;
    });
  }

  const q = filter.trim().toLowerCase();
  const visible = (tools || []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.group.toLowerCase().includes(q),
  );
  const groupNames = [
    ...GROUP_ORDER.filter((g) => visible.some((t) => t.group === g)),
    ...[...new Set(visible.map((t) => t.group))].filter((g) => !GROUP_ORDER.includes(g)),
  ];
  const disabledCount = (tools || []).filter((t) => !t.enabled).length;

  return (
    <div className="tools-section mt-10 pt-8 border-t border-default">
      <div className="page-head-row mb-4">
        <div className="min-w-0">
          <div className="page-section-title">
            <Wrench size={18} className="opacity-70" />
            Tools
            <InfoHint text="Toggle any tool off to hide it from agents and workspace chat. Disabled tools are never offered to the model and are blocked if still called. Changes apply to the next run." />
          </div>
          <div className="page-section-sub">
            Built-in abilities every agent can call during runs — use the switch on each tile to disable a function globally.
            {disabledCount > 0 && (
              <span className="ml-1 cap-card-meta inline">· {disabledCount} disabled</span>
            )}
          </div>
        </div>
        <div className="tool-filter">
          <Search size={13} className="text-dim shrink-0" />
          <input
            className="grok-input text-xs flex-1 min-w-0"
            placeholder="Filter tools…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter tools"
          />
        </div>
      </div>

      {tools === null ? (
        <div className="data-loading-row py-6"><span className="data-spinner" /> Loading tool catalog…</div>
      ) : visible.length === 0 ? (
        <div className="grok-card p-6 text-center text-dim text-sm">No tools match “{filter}”.</div>
      ) : (
        <div className="space-y-5">
          {groupNames.map((group) => {
            const Icon = GROUP_ICONS[group] || Wrench;
            const groupTools = visible.filter((t) => t.group === group);
            const allOn = groupTools.every((t) => t.enabled);
            const allOff = groupTools.every((t) => !t.enabled);
            return (
              <div key={group} className="grok-card p-4 tool-group">
                <div className="tool-group-head">
                  <Icon size={16} className="opacity-70 shrink-0" />
                  <span className="cap-card-title">{group}</span>
                  <span className="tool-group-blurb">{GROUP_BLURBS[group] || ''}</span>
                  <div className="ml-auto shrink-0 flex items-center gap-2">
                    <button
                      type="button"
                      className="cap-card-meta hover:text-muted underline-offset-2 hover:underline"
                      onClick={() => void setGroupEnabled(group, true)}
                      disabled={allOn}
                      title="Enable all tools in this group"
                    >
                      All on
                    </button>
                    <button
                      type="button"
                      className="cap-card-meta hover:text-muted underline-offset-2 hover:underline"
                      onClick={() => void setGroupEnabled(group, false)}
                      disabled={allOff}
                      title="Disable all tools in this group"
                    >
                      All off
                    </button>
                    <span className="cap-card-meta font-mono">
                      {groupTools.filter((t) => t.enabled).length}/{groupTools.length}
                    </span>
                  </div>
                </div>
                <div className="tool-grid">
                  {groupTools.map((tool) => {
                    const chip = requirementChip(tool);
                    const busy = !!pending[tool.name];
                    return (
                      <div
                        key={tool.name}
                        className={`tool-tile ${tool.enabled ? '' : 'tool-tile-disabled'}`}
                      >
                        <div className="tool-tile-head">
                          <span className="font-mono tool-row-name">{tool.name}</span>
                          <label
                            className={`tool-toggle ${busy ? 'tool-toggle-busy' : ''}`}
                            title={tool.enabled ? `Disable ${tool.name}` : `Enable ${tool.name}`}
                          >
                            <input
                              type="checkbox"
                              role="switch"
                              checked={tool.enabled}
                              disabled={busy}
                              onChange={(e) => void toggleTool(tool, e.target.checked)}
                              aria-label={`${tool.enabled ? 'Disable' : 'Enable'} ${tool.name}`}
                            />
                            <span className="tool-toggle-track" aria-hidden>
                              <span className="tool-toggle-thumb" />
                            </span>
                          </label>
                        </div>
                        <div
                          id={`tool-desc-${tool.name}`}
                          className={`tool-tile-desc ${openDescs.has(tool.name) ? 'tool-tile-desc-open' : ''}`}
                        >
                          {tool.description}
                        </div>
                        {tool.description.length > 100 && (
                          <button
                            type="button"
                            className="tool-desc-more"
                            aria-expanded={openDescs.has(tool.name)}
                            aria-controls={`tool-desc-${tool.name}`}
                            onClick={() => setOpenDescs((s) => {
                              const next = new Set(s);
                              if (next.has(tool.name)) next.delete(tool.name); else next.add(tool.name);
                              return next;
                            })}
                          >
                            {openDescs.has(tool.name) ? 'Show less' : 'Read all'}
                          </button>
                        )}
                        <div className="mt-2">
                          <span className={`tool-chip ${chip.cls}`}>{chip.label}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
