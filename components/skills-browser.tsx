'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, ChevronDown, ChevronUp, Code2, MessageSquare, Palette, Pencil, Plus,
  RefreshCw, Search, Sparkles, Trash2, Users, Wand2, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/confirm-dialog';
import { SKILL_CATEGORIES, SKILL_PRESETS, type SkillCategory, type SkillPreset } from '@/lib/skills-catalog';

type UiSkill = SkillPreset & { custom?: boolean };

interface SkillsBrowserProps {
  installed: string[];
  onInstall: (skillId: string) => void;
  /** Remove a skill from the current agent (compact editor). */
  onUninstall?: (skillId: string) => void;
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

const CATEGORY_LABELS: Record<string, string> = {
  all: 'All',
  coding: 'Coding',
  research: 'Research',
  automation: 'Automation',
  communication: 'Communication',
  creative: 'Creative',
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
  installed, onInstall, onUninstall, compact, installedCounts, agents, onToggleAgentSkill,
}: SkillsBrowserProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [skills, setSkills] = useState<UiSkill[]>(SKILL_PRESETS);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [manageSkill, setManageSkill] = useState<UiSkill | null>(null);
  const [togglingAgent, setTogglingAgent] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
      return [s.name, s.id, s.description, s.category, s.promptHint].join(' ').toLowerCase().includes(q);
    });
  }, [skills, query, category]);

  const categories = ['all', ...SKILL_CATEGORIES];
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: skills.length };
    for (const c of SKILL_CATEGORIES) counts[c] = skills.filter((s) => s.category === c).length;
    return counts;
  }, [skills]);

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
        className="modal modal-pop w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={editor.mode === 'create' ? 'New skill' : 'Edit skill'}
      >
        <div className="text-lg font-semibold mb-1">
          {editor.mode === 'create' ? 'New skill' : `Edit “${editor.name || 'skill'}”`}
        </div>
        <div className="text-xs text-dim mb-4">
          Description is what you see here. Prompt guidance is injected into the agent when this skill is active.
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
                <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="grok-label">Short description</div>
            <textarea
              className="grok-input min-h-[4.5rem] resize-y"
              value={editor.description}
              placeholder="One or two sentences people can read at a glance"
              onChange={(e) => setEditor((p) => p && ({ ...p, description: e.target.value }))}
            />
          </div>
          <div>
            <div className="grok-label">Prompt guidance</div>
            <textarea
              className="grok-input min-h-[8rem] resize-y font-mono text-xs leading-relaxed"
              value={editor.promptHint}
              placeholder="Detailed instructions injected into the agent system prompt when this skill is on…"
              onChange={(e) => setEditor((p) => p && ({ ...p, promptHint: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button type="button" className="grok-btn grok-btn-primary flex-1" disabled={saving} onClick={() => void saveEditor()}>
            {saving ? 'Saving…' : editor.mode === 'create' ? 'Create skill' : 'Save changes'}
          </button>
          <button type="button" className="grok-btn grok-btn-secondary" onClick={() => setEditor(null)}>
            Cancel
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

  // Compact variant — agent editor: readable list of capabilities.
  if (compact) {
    return (
      <div className="agent-skills-browser">
        <div className="flex items-center gap-2 mb-2.5 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <Sparkles size={14} className="opacity-70" />
            Add capabilities
          </div>
          <span className="text-[10px] text-dim">
            {installed.length} active
          </span>
          <button
            type="button"
            className="grok-btn grok-btn-ghost text-xs py-0.5 ml-auto"
            onClick={() => setEditor({ mode: 'create', name: '', category: 'coding', description: '', promptHint: '' })}
          >
            <Plus size={12} /> New skill
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mb-2.5">
          <div className="relative flex-1 min-w-[140px]">
            <Search size={12} className="agent-skills-search-icon" />
            <input
              className="grok-input text-xs pl-7"
              placeholder="Search capabilities…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="agent-skills-cats">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className={`agent-skills-cat ${category === c ? 'active' : ''}`}
                onClick={() => setCategory(c)}
              >
                {CATEGORY_LABELS[c] || c}
              </button>
            ))}
          </div>
        </div>
        <div className="agent-skills-pick-grid">
          {filtered.length === 0 && (
            <div className="text-xs text-dim col-span-full py-3 text-center">No skills match that search.</div>
          )}
          {filtered.map((skill) => {
            const has = installed.includes(skill.id);
            const Icon = CATEGORY_ICONS[skill.category] || Sparkles;
            return (
              <button
                key={skill.id}
                type="button"
                className={`agent-skill-pick ${has ? 'agent-skill-pick-on' : ''}`}
                title={skill.description}
                onClick={() => {
                  if (has) onUninstall?.(skill.id);
                  else onInstall(skill.id);
                }}
              >
                <span className="agent-skill-pick-icon"><Icon size={14} /></span>
                <span className="agent-skill-pick-body">
                  <span className="agent-skill-pick-name">
                    {skill.name}
                    {skill.custom && <span className="badge badge-muted ml-1 text-[8px] align-middle">custom</span>}
                  </span>
                  <span className="agent-skill-pick-desc">{skill.description}</span>
                </span>
                <span className={`agent-skill-pick-toggle ${has ? 'on' : ''}`}>
                  {has ? <Check size={12} /> : <Plus size={12} />}
                </span>
              </button>
            );
          })}
        </div>
        {editorModal}
      </div>
    );
  }

  // Full-page variant — Capabilities: wide, readable skill cards (not MCP’s narrow grid).
  return (
    <div className="skills-section mt-10 pt-8 border-t border-default">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="text-xl font-semibold flex items-center gap-2">
            <Sparkles size={18} className="opacity-70 shrink-0" />
            Skills
          </div>
          <div className="text-sm text-muted mt-1 max-w-2xl">
            Capability presets agents can equip. Each skill injects focused prompt guidance when active — expand a card to read the full guidance.
          </div>
        </div>
        <button
          type="button"
          className="grok-btn grok-btn-primary text-xs shrink-0"
          onClick={() => setEditor({ mode: 'create', name: '', category: 'coding', description: '', promptHint: '' })}
        >
          <Plus size={13} /> New skill
        </button>
      </div>

      <div className="skills-toolbar mb-4">
        <div className="relative flex-1 min-w-[12rem] max-w-md">
          <Search size={14} className="skills-toolbar-search-icon" />
          <input
            className="grok-input text-sm pl-9"
            placeholder="Search skills by name or description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search skills"
          />
        </div>
        <div className="skills-cat-pills" role="tablist" aria-label="Skill categories">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={category === c}
              className={`skills-cat-pill ${category === c ? 'skills-cat-pill-active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {CATEGORY_LABELS[c] || c}
              <span className="skills-cat-count">{categoryCounts[c] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="grok-card p-8 text-center text-sm text-dim">
          No skills match{query ? ` “${query}”` : ''}. Try another category or create a new skill.
        </div>
      ) : (
        <div className="skills-grid">
          {filtered.map((skill) => {
            const has = installed.includes(skill.id);
            const count = installedCounts?.[skill.id] ?? 0;
            const Icon = CATEGORY_ICONS[skill.category] || Sparkles;
            const open = expandedId === skill.id;
            return (
              <article
                key={skill.id}
                className={`skills-card grok-card ${has ? 'skills-card-active' : ''} ${open ? 'skills-card-open' : ''}`}
              >
                <div className="skills-card-top">
                  <span className={`skills-card-icon skills-card-icon-${skill.category}`}>
                    <Icon size={18} />
                  </span>
                  <div className="skills-card-head min-w-0 flex-1">
                    <div className="skills-card-title-row">
                      <h3 className="skills-card-title">{skill.name}</h3>
                      {skill.custom && <span className="badge badge-muted text-[10px]">custom</span>}
                      {has && (
                        <span className="skills-card-installed">
                          {count > 0 ? `${count} agent${count === 1 ? '' : 's'}` : 'In use'}
                        </span>
                      )}
                    </div>
                    <div className="skills-card-meta">
                      <span className={`skills-cat-badge skills-cat-badge-${skill.category}`}>
                        {CATEGORY_LABELS[skill.category] || skill.category}
                      </span>
                      <span className="skills-card-id font-mono">{skill.id}</span>
                    </div>
                  </div>
                </div>

                <p className="skills-card-desc">{skill.description || 'No description yet.'}</p>

                {open && skill.promptHint && (
                  <div className="skills-card-guidance">
                    <div className="skills-card-guidance-label">Prompt guidance (injected when active)</div>
                    <p className="skills-card-guidance-body">{skill.promptHint}</p>
                  </div>
                )}

                <div className="skills-card-actions">
                  <button
                    type="button"
                    className="grok-btn grok-btn-ghost text-xs skills-card-expand"
                    onClick={() => setExpandedId(open ? null : skill.id)}
                    aria-expanded={open}
                  >
                    {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    {open ? 'Hide guidance' : 'Read full guidance'}
                  </button>
                  <div className="skills-card-action-btns">
                    <button
                      type="button"
                      onClick={() => (agents && onToggleAgentSkill ? setManageSkill(skill) : onInstall(skill.id))}
                      className="grok-btn grok-btn-secondary text-xs"
                      title="Assign to agents"
                    >
                      <Users size={13} />
                      Assign
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditor(skill)}
                      className="grok-btn grok-btn-ghost text-xs"
                      title={skill.custom ? 'Edit skill' : 'Customize — create an editable copy'}
                    >
                      <Pencil size={13} />
                      {skill.custom ? 'Edit' : 'Customize'}
                    </button>
                    {skill.custom && (
                      <button
                        type="button"
                        onClick={() => void regenerateSkill(skill)}
                        disabled={regeneratingId !== null}
                        className="grok-btn grok-btn-ghost text-xs"
                        title="Regenerate description and guidance from the title"
                      >
                        {regeneratingId === skill.id
                          ? <RefreshCw size={13} className="animate-spin" />
                          : <Wand2 size={13} />}
                        Rewrite
                      </button>
                    )}
                    {skill.custom && (
                      <button
                        type="button"
                        onClick={() => void removeSkill(skill)}
                        className="grok-btn grok-btn-ghost text-xs text-error"
                        title="Delete this custom skill"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {editorModal}
      {manageModal}
    </div>
  );
}
