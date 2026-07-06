'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Command } from 'lucide-react';

export interface CommandPaletteItem {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  keywords?: string[];
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: CommandPaletteItem[];
}

export default function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((cmd) => {
      const hay = [cmd.label, cmd.hint, cmd.group, ...(cmd.keywords || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered[activeIdx]) {
        e.preventDefault();
        filtered[activeIdx].run();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, activeIdx, onClose]);

  const grouped = useMemo(() => {
    const map = new Map<string, CommandPaletteItem[]>();
    for (const cmd of filtered) {
      const g = cmd.group || 'Actions';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(cmd);
    }
    return [...map.entries()];
  }, [filtered]);

  let flatIdx = 0;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh] px-4" onClick={onClose}>
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="command-palette w-full max-w-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="command-palette-input-row">
              <Search size={16} className="text-dim shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search commands…"
                className="command-palette-input"
                aria-label="Command palette search"
              />
              <span className="command-palette-kbd"><Command size={10} />K</span>
            </div>

            <div className="command-palette-results max-h-[50vh] overflow-auto">
              {filtered.length === 0 ? (
                <div className="command-palette-empty">No matching commands</div>
              ) : (
                grouped.map(([group, items]) => (
                  <div key={group}>
                    <div className="command-palette-group">{group}</div>
                    {items.map((cmd) => {
                      const idx = flatIdx++;
                      const active = idx === activeIdx;
                      return (
                        <button
                          key={cmd.id}
                          type="button"
                          className={`command-palette-item ${active ? 'active' : ''}`}
                          onMouseEnter={() => setActiveIdx(idx)}
                          onClick={() => { cmd.run(); onClose(); }}
                        >
                          <span className="command-palette-label">{cmd.label}</span>
                          {cmd.hint && <span className="command-palette-hint">{cmd.hint}</span>}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}