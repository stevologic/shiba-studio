'use client';

// Tiny info icon with a hover/focus tooltip — used next to features that
// benefit from a one-line explanation without cluttering the layout.
// The tip renders in a portal with fixed positioning so it can never be
// clipped by overflow containers, and it flips below the icon when the icon
// sits near the top of the viewport.

import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

const TIP_MAX_WIDTH = 280;
const EDGE_MARGIN = 10;
/** Rough room needed above the icon for a few lines of text. */
const FLIP_THRESHOLD = 150;

export default function InfoHint({ text, className = '' }: { text: string; className?: string }) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [tip, setTip] = useState<{ top: number; left: number; below: boolean } | null>(null);

  function show() {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const half = TIP_MAX_WIDTH / 2;
    const left = Math.min(
      Math.max(r.left + r.width / 2, half + EDGE_MARGIN),
      window.innerWidth - half - EDGE_MARGIN,
    );
    const below = r.top < FLIP_THRESHOLD;
    setTip({ top: below ? r.bottom + 8 : r.top - 8, left, below });
  }

  const hide = () => setTip(null);

  return (
    <span
      ref={anchorRef}
      className={`info-hint ${className}`}
      tabIndex={0}
      role="note"
      aria-label={text}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <Info size={13} aria-hidden />
      {tip && typeof document !== 'undefined' && createPortal(
        <span
          className={`info-hint-tip info-hint-tip-portal ${tip.below ? 'info-hint-tip-below' : ''}`}
          style={{ top: tip.top, left: tip.left }}
          role="tooltip"
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
