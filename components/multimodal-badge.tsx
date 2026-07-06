'use client';

import React from 'react';
import { Image as ImageIcon, Paperclip } from 'lucide-react';

interface MultimodalBadgeProps {
  compact?: boolean;
  className?: string;
}

/** Marks UI that accepts text + images/files in one submission. */
export default function MultimodalBadge({ compact = false, className = '' }: MultimodalBadgeProps) {
  return (
    <span
      className={`multimodal-badge ${compact ? 'multimodal-badge-compact' : ''} ${className}`.trim()}
      title="Supports multimodal submissions — paste, drag, or attach images and files with your message"
    >
      <Paperclip size={compact ? 10 : 11} aria-hidden />
      <ImageIcon size={compact ? 10 : 11} aria-hidden />
      {!compact && <span>Multimodal</span>}
    </span>
  );
}