'use client';

import React, { useEffect, useMemo } from 'react';
import { Keyboard, X } from 'lucide-react';
import {
  STUDIO_SHORTCUTS,
  prefersMacShortcuts,
  shortcutLabel,
} from '@/lib/keyboard-shortcuts';

interface KeyboardShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

export default function KeyboardShortcutsOverlay({ open, onClose }: KeyboardShortcutsOverlayProps) {
  const mac = useMemo(
    () => (typeof navigator === 'undefined' ? false : prefersMacShortcuts(navigator.userAgent)),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="shortcuts-backdrop" onClick={onClose}>
      <div
        className="shortcuts-dialog modal modal-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-heading"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shortcuts-header">
          <div className="shortcuts-title">
            <Keyboard size={16} aria-hidden />
            <h2 id="shortcuts-heading">Keyboard shortcuts</h2>
          </div>
          <button
            type="button"
            className="grok-btn grok-btn-ghost p-1.5"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
          >
            <X size={16} />
          </button>
        </div>
        <p className="shortcuts-lead">
          Studio-wide keys stay out of the Code editor so Monaco can keep its own chords.
        </p>
        <div className="shortcuts-groups">
          {STUDIO_SHORTCUTS.map((group) => (
            <section key={group.id} className="shortcuts-group">
              <h3>{group.title}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={`${group.id}-${item.keys}`}>
                    <kbd>{shortcutLabel(item, mac)}</kbd>
                    <span>{item.action}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
