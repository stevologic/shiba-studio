'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, Code2, MessageSquare, Palette, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, Users, Wand2, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/confirm-dialog';
import { SKILL_CATEGORIES, SKILL_PRESETS, type SkillCategory, type SkillPreset } from '@/lib/skills-catalog';

type UiSkill = SkillPreset & { custom?: boolean };

interface SkillsBrowserProps {
  installed: string[];
  onInstall: (skillId: string) => void;
  compact?: boolean;
  /** Per-skill usage counts (e.g. how many agents have it) for the status line. */
  installedCounts?: Record<string, number>;
  /** Agents for the manage-assignments modal (full-page variant). */
  agents?: Array<{ id: string; name: string; skills?: string[] }>;
  /** Toggle a skill on/off for an agent — persists and refreshes upstream. */
  onToggleAgentSkill?: (agentId: string, skillId: string, enabled: boolean) => Promise<void>;
}

const CATEGORY_ICONS: Record<string, React.ComponentType<{ size?: number | string; className?: string }>> = {
  coding: Code2,
  research: Search,
  automation: Zap,
  communication: MessageSquare,
  creative: Palette,
};

interface EditorState {
  mode: 'create' | 'edit';
  id?: string;
  name: string;
  category: SkillCategory;
  description: string;
  promptHint: string;
}

export default function SkillsBrowser({
  installed, onInstall, compact, installedCounts, agents, onToggleAgentSkill,
}: SkillsBrowserProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [skills, setSkills] = useState<UiSkill[]>(SKILL_PRESETS);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [manageSkill, setManageSkill] = useState<UiSkill | null>(null);
  const [togglingAgent, setTogglingAgent] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/skills');
      const data = await res.json();
      if (data.ok && Array.isArray(data.skills)) setSkills(data.skills);
    } catch {
      /* built-in presets remain as fallback */
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (!editor) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditor(null);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [editor]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (category !== 'all' && s.category !== category) return false;
      if (!q) return true;
      return [s.name, s.id, s.description, s.category].join(' ').toLowerCase().includes(q);
    });
  }, [skills, query, category]);

  const categories = ['all', ...SKILL_CATEGORIES];

  async function saveEditor() {
    if (!editor || saving) return;
    if (!editor.name.trim()) {
      toast.error('Give the skill a name');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: editor.mode === 'create' ? 'create' : 'update',
          id: editor.id,
          name: editor.name,
          category: editor.category,
          description: editor.description,
          promptHint: editor.promptHint,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Save failed');
      toast.success(editor.mode === 'create' ? `Skill "${data.skill.name}" created` : 'Skill updated');
      setEditor(null);
      await loadSkills();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
    setSaving(false);
  }

  /** Model rewrites the skill's description + prompt guidance from its title alone. */
  async function regenerateSkill(skill: UiSkill) {
    if (regeneratingId) return;
    setRegeneratingId(skill.id);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate', id: skill.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Regenerate failed');
      toast.success(`"${data.skill.name}" rewritten from its title by the model`);
      await loadSkills();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Regenerate failed');
    }
    setRegeneratingId(null);
  }

  /** Built-in presets can't be changed in place — editing one forks an editable custom copy. */
  function openEditor(skill: UiSkill) {
    setEditor(skill.custom
      ? { mode: 'edit', id: skill.id, name: skill.name, category: skill.category, description: skill.description, promptHint: skill.promptHint }
      : { mode: 'create', name: `${skill.name} (custom)`, category: skill.category, description: skill.description, promptHint: skill.promptHint });
  }

  async function removeSkill(skill: UiSkill) {
    const ok = await confirmDialog({
      title: `Delete skill "${skill.name}"?`,
      message: 'Agents that reference it keep the tag, but its prompt guidance stops applying.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: skill.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Delete failed');
      toast.success('Skill deleted');
      await loadSkills();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const editorModal = editor && (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4"
      onClick={() => setEditor(null)}
    >
      <div
        className="modal modal-pop w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={editor.mode === 'create' ? 'New skill' : 'Edit skill'}
      >
        <div className="text-lg font-semibold mb-4">
          {editor.mode === 'create' ? 'New skill' : `Edit "${editor.name || 'skill'}"`}
        </div>
        <div className="space-y-3">
          <div>
            <div className="grok-label">Name</div>
            <input
              className="grok-input"
              value={editor.name}
              autoFocus
              placeholder="e.g. API Integrator"
              onChange={(e) => setEditor((p) => p && ({ ...p, name: e.target.value }))}
            />
          </div>
          <div>
            <div className="grok-label">Category</div>
            <select
              className="grok-select w-full"
              value={editor.category}
              onChange={(e) => setEditor((p) => p && ({ ...p, category: e.target.value as SkillCategory }))}
            >
              {SKILL_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="grok-label">Description</div>
            <input
              className="grok-input"
              value={editor.description}
              placeholder="One line on what this skill is for"
              onChange={(e) => setEditor((p) => p && ({ ...p, description: e.target.value }))}
            />
          </div>
          <div>
            <div className="grok-label">Prompt guidance</div>
            <textarea
              className="grok-input schedule-instructions-input text-xs"
              value={editor.promptHint}
              placeholder="Injected into the agent's system prompt when this skill is active, e.g. 'Always validate API responses; retry idempotent calls once.'"
              onChange={(e) => setEditor((p) => p && ({ ...p, promptHint: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex gap-2.5 mt-5">
          <button type="button" className="grok-btn grok-btn-secondary flex-1" onClick={() => setEditor(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="grok-btn grok-btn-primary flex-1"
            disabled={saving || !editor.name.trim()}
            onClick={saveEditor}
          >
            {saving ? 'Saving…' : editor.mode === 'create' ? 'Create skill' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );

  const manageModal = manageSkill && agents && onToggleAgentSkill && (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4"
      onClick={() => setManageSkill(null)}
    >
      <div
        className="modal modal-pop w-full max-w-sm p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Manage "${manageSkill.name}"`}
      >
        <div className="text-lg font-semibold">Manage “{manageSkill.name}”</div>
        <div className="text-xs text-dim mt-1 mb-4">Choose which agents carry this skill — changes apply immediately.</div>
        {agents.length === 0 ? (
          <div className="text-sm text-dim">No agents yet — create one on the Agents page first.</div>
        ) : (
          <div className="local-model-list">
            {agents.map((a) => {
              const has = (a.skills || []).includes(manageSkill.id);
              return (
                <label key={a.id} className="local-model-item">
                  <input
                    type="checkbox"
                    checked={has}
                    disabled={togglingAgent === a.id}
                    onChange={async () => {
                      setTogglingAgent(a.id);
                      try {
                        await onToggleAgentSkill(a.id, manageSkill.id, !has);
                      } finally {
                        setTogglingAgent(null);
                      }
                    }}
                  />
                  <span className="text-xs truncate">{a.name}</span>
                  {togglingAgent === a.id && <span className="data-spinner ml-auto" />}
                </label>
              );
            })}
          </div>
        )}
        <button type="button" className="grok-btn grok-btn-secondary w-full mt-5" onClick={() => setManageSkill(null)}>
          Done
        </button>
      </div>
    </div>
  );

  // Compact variant — list layout for the agent editor modal (includes custom skills).
  if (compact) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={16} />
          <div className="font-semibold">Skills Browser</div>
          <button
            type="button"
            className="grok-btn grok-btn-ghost text-xs py-0.5 ml-auto"
            onClick={() => setEditor({ mode: 'create', name: '', category: 'coding', description: '', promptHint: '' })}
          >
            <Plus size={12} /> New
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          <input
            className="grok-input text-xs flex-1 min-w-[140px]"
            placeholder="Search skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="grok-select text-xs" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>
            ))}
          </select>
        </div>
        <div className="skills-grid max-h-[240px] overflow-auto space-y-2">
          {filtered.map((skill) => {
            const has = installed.includes(skill.id);
            return (
              <div key={skill.id} className="skills-card p-3 border border-default rounded-md">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-sm">
                      {skill.name}
                      {skill.custom && <span className="badge badge-muted ml-1.5 text-[9px] align-middle">custom</span>}
                    </div>
                    <div className="text-[10px] text-dim uppercase tracking-wide mt-0.5">{skill.category}</div>
                  </div>
                  <button
                    type="button"
                    disabled={has}
                    onClick={() => onInstall(skill.id)}
                    className={`grok-btn text-xs ${has ? 'grok-btn-ghost opacity-60' : 'grok-btn-secondary'}`}
                  >
                    {has ? <><Check size={12} /> Installed</> : <><Plus size={12} /> Add</>}
                  </button>
                </div>
                <div className="text-xs text-dim mt-2">{skill.description}</div>
              </div>
            );
          })}
        </div>
        {editorModal}
      </div>
    );
  }

  // Full-page variant — mirrors the Core Integrations / MCP Servers sections.
  return (
    <div className="mt-10 pt-8 border-t border-default">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-xl font-semibold flex items-center gap-2">
            <Sparkles size={18} className="opacity-70" />
            Skills
          </div>
          <div className="text-sm text-muted mt-1">
            Reusable capability presets for agents — create your own or manage them from any agent&apos;s editor.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="grok-input text-xs w-[170px]"
            placeholder="Search skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="grok-select text-xs" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>
            ))}
          </select>
          <button
            type="button"
            className="grok-btn grok-btn-primary text-xs"
            onClick={() => setEditor({ mode: 'create', name: '', category: 'coding', description: '', promptHint: '' })}
          >
            <Plus size={13} /> New Skill
          </button>
        </div>
      </div>

      <div className="mcp-preset-grid">
        {filtered.map((skill) => {
          const has = installed.includes(skill.id);
          const count = installedCounts?.[skill.id] ?? 0;
          const Icon = CATEGORY_ICONS[skill.category] || Sparkles;
          return (
            <div key={skill.id} className={`mcp-preset-card grok-card p-4 text-left ${has ? 'mcp-preset-card-active' : ''}`}>
              <div className="flex items-start gap-3">
                <span className="skill-card-icon"><Icon size={16} /></span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">
                    {skill.name}
                    {skill.custom && <span className="badge badge-muted ml-1.5 text-[9px] align-middle">custom</span>}
                  </div>
                  <div className="text-[10px] text-dim uppercase tracking-wide mt-0.5">{skill.category}</div>
                  <div className="text-[11px] text-dim mt-1 line-clamp-2">{skill.description}</div>
                  {has && (
                    <div className="text-[10px] text-success mt-1">
                      {count > 0 ? `Installed on ${count} agent${count === 1 ? '' : 's'}` : 'Installed'}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => (agents && onToggleAgentSkill ? setManageSkill(skill) : onInstall(skill.id))}
                    className="grok-btn grok-btn-secondary text-xs"
                    title="Manage which agents have this skill"
                    aria-label="Manage skill assignments"
                  >
                    <Users size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditor(skill)}
                    className="grok-btn grok-btn-ghost text-xs"
                    title={skill.custom ? "Edit this skill's definition" : 'Customize — edit an editable copy of this built-in skill'}
                    aria-label="Edit skill definition"
                  >
                    <Pencil size={12} />
                  </button>
                  {skill.custom && (
                    <button
                      type="button"
                      onClick={() => void regenerateSkill(skill)}
                      disabled={regeneratingId !== null}
                      className="grok-btn grok-btn-ghost text-xs"
                      title="Regenerate — the model rewrites the description and prompt guidance from the title alone"
                      aria-label="Regenerate skill with the model"
                    >
                      {regeneratingId === skill.id ? <RefreshCw size={12} className="animate-spin" /> : <Wand2 size={12} />}
                    </button>
                  )}
                  {skill.custom && (
                    <button
                      type="button"
                      onClick={() => void removeSkill(skill)}
                      className="grok-btn grok-btn-ghost text-xs text-error"
                      title="Delete this custom skill"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="text-sm text-dim py-4">No skills match “{query}”.</div>
        )}
      </div>
      {editorModal}
      {manageModal}
    </div>
  );
}
