'use client';

import React, { useMemo, useState } from 'react';
import { Sparkles, Plus, Check } from 'lucide-react';
import { SKILL_PRESETS } from '@/lib/skills-catalog';

interface SkillsBrowserProps {
  installed: string[];
  onInstall: (skillId: string) => void;
  compact?: boolean;
}

export default function SkillsBrowser({ installed, onInstall, compact }: SkillsBrowserProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SKILL_PRESETS.filter((s) => {
      if (category !== 'all' && s.category !== category) return false;
      if (!q) return true;
      return [s.name, s.id, s.description, s.category].join(' ').toLowerCase().includes(q);
    });
  }, [query, category]);

  const categories = ['all', ...new Set(SKILL_PRESETS.map((s) => s.category))];

  return (
    <div className={compact ? '' : 'grok-card p-4'}>
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={16} />
        <div className="font-semibold">Skills Browser</div>
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
      <div className={`skills-grid ${compact ? 'max-h-[240px]' : 'max-h-[360px]'} overflow-auto space-y-2`}>
        {filtered.map((skill) => {
          const has = installed.includes(skill.id);
          return (
            <div key={skill.id} className="skills-card p-3 border border-default rounded-md">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium text-sm">{skill.name}</div>
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
    </div>
  );
}