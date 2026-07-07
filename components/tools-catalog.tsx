'use client';

// Built-in agent tool catalog — surfaced on the Capabilities page so users can
// see exactly what agents can call during runs (sourced live from the runtime
// definitions via /api/tools, never a hardcoded copy).

import React, { useEffect, useState } from 'react';
import { Wrench, TerminalSquare, Globe, Plug2, Workflow, Boxes, Search, Compass, Brain, Image as ImageIcon } from 'lucide-react';
import InfoHint from '@/components/info-hint';

interface ToolEntry {
  name: string;
  description: string;
  group: string;
  requires?: string;
  localOnly: boolean;
}

const GROUP_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  'Workspace & Files': TerminalSquare,
  'Web & Research': Compass,
  'Browser Automation': Globe,
  Memory: Brain,
  'AI Generation': ImageIcon,
  Integrations: Plug2,
  Orchestration: Workflow,
  MCP: Boxes,
};

const GROUP_BLURBS: Record<string, string> = {
  'Workspace & Files': 'Read, write, search, and run commands inside the agent workspace.',
  'Web & Research': 'Search the web and read pages — no API keys required.',
  'Browser Automation': 'Drive the controlled Chrome browser — navigate, click, extract.',
  Memory: 'Facts persist across runs — agents remember and recall on their own.',
  'AI Generation': 'Create images from prompts with xAI; results appear in the run trace.',
  Integrations: 'Act on connected services; each tool unlocks with its integration scope.',
  Orchestration: 'Agents coordinating agents — peer messages and self-scheduling.',
  MCP: 'Discover and invoke tools on configured MCP servers.',
};

// Stable presentation order — most-used groups first.
const GROUP_ORDER = ['Workspace & Files', 'Web & Research', 'Browser Automation', 'Memory', 'AI Generation', 'Integrations', 'Orchestration', 'MCP'];

function requirementChip(tool: ToolEntry): { label: string; cls: string } {
  if (tool.localOnly) return { label: 'local agents', cls: 'tool-chip-local' };
  if (tool.requires === 'peers') return { label: 'needs peers', cls: 'tool-chip-req' };
  if (tool.requires === 'mcp') return { label: 'needs MCP server', cls: 'tool-chip-req' };
  if (tool.requires === 'xai') return { label: 'needs xAI auth', cls: 'tool-chip-req' };
  if (tool.requires) return { label: `${tool.requires} scope`, cls: 'tool-chip-req' };
  return { label: 'always on', cls: 'tool-chip-always' };
}

export default function ToolsCatalog() {
  const [tools, setTools] = useState<ToolEntry[] | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const res = await fetch('/api/tools');
        const data = await res.json();
        if (!stale && data.ok) setTools(data.tools || []);
      } catch {
        if (!stale) setTools([]);
      }
    })();
    return () => { stale = true; };
  }, []);

  const q = filter.trim().toLowerCase();
  const visible = (tools || []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.group.toLowerCase().includes(q),
  );
  const groupNames = [
    ...GROUP_ORDER.filter((g) => visible.some((t) => t.group === g)),
    ...[...new Set(visible.map((t) => t.group))].filter((g) => !GROUP_ORDER.includes(g)),
  ];

  return (
    <div className="tools-section mt-10 pt-8 border-t border-default">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-xl font-semibold flex items-center gap-2">
            <Wrench size={18} className="opacity-70" />
            Tools
            <InfoHint text="This catalog is sourced live from the runtime — what you see is exactly what agents can call. Chips show what unlocks each tool." />
          </div>
          <div className="text-sm text-muted mt-1">
            Built-in abilities every agent can call during runs — scoped by agent type (local/cloud) and enabled integrations.
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
            return (
              <div key={group} className="grok-card p-4 tool-group">
                <div className="tool-group-head">
                  <Icon size={16} className="opacity-70 shrink-0" />
                  <span className="font-medium text-sm">{group}</span>
                  <span className="text-[11px] text-dim tool-group-blurb">{GROUP_BLURBS[group] || ''}</span>
                  <span className="text-[10px] text-dim font-mono ml-auto shrink-0">
                    {groupTools.length} tool{groupTools.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="tool-grid">
                  {groupTools.map((tool) => {
                    const chip = requirementChip(tool);
                    return (
                      <div key={tool.name} className="tool-tile">
                        <div className="tool-tile-head">
                          <span className="font-mono text-[11px] tool-row-name">{tool.name}</span>
                          <span className={`tool-chip ${chip.cls}`}>{chip.label}</span>
                        </div>
                        <div className="tool-tile-desc">{tool.description}</div>
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
