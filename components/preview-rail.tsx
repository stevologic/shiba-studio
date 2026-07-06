'use client';

import React, { useMemo } from 'react';
import { Image, FileText, Globe, Terminal } from 'lucide-react';
import type { TraceStep } from '@/lib/types';

interface PreviewRailProps {
  trace: TraceStep[];
  selectedIdx: number | null;
  onSelect: (idx: number) => void;
}

function previewIcon(step: TraceStep) {
  if (step.screenshot) return Image;
  if (step.tool?.name?.startsWith('browser')) return Globe;
  if (step.tool?.name === 'shell_exec') return Terminal;
  if (step.tool?.name === 'fs_read' || step.tool?.name === 'fs_write') return FileText;
  return FileText;
}

export default function PreviewRail({ trace, selectedIdx, onSelect }: PreviewRailProps) {
  const previewable = useMemo(
    () => trace
      .map((step, idx) => ({ step, idx }))
      .filter(({ step }) =>
        step.screenshot
        || step.type === 'result'
        || (step.type === 'tool' && ['fs_read', 'browser_screenshot', 'browser_extract', 'shell_exec'].includes(step.tool?.name || '')),
      ),
    [trace],
  );

  const active = selectedIdx != null ? trace[selectedIdx] : previewable[previewable.length - 1]?.step;

  if (!trace.length) return null;

  return (
    <div className="preview-rail grok-card overflow-hidden mt-4">
      <div className="preview-rail-header px-3 py-2 border-b border-default text-sm font-medium">
        Preview Rail
      </div>
      <div className="preview-rail-body grid grid-cols-1 lg:grid-cols-[200px_1fr] min-h-[200px]">
        <div className="preview-rail-list border-r border-default max-h-[280px] overflow-auto">
          {previewable.length === 0 && (
            <div className="p-3 text-xs text-dim">Tool outputs will appear here during runs.</div>
          )}
          {previewable.map(({ step, idx }) => {
            const Icon = previewIcon(step);
            const activeItem = selectedIdx === idx || (selectedIdx == null && idx === previewable[previewable.length - 1]?.idx);
            return (
              <button
                key={step.id || idx}
                type="button"
                onClick={() => onSelect(idx)}
                className={`preview-rail-item w-full text-left ${activeItem ? 'active' : ''}`}
              >
                <Icon size={12} className="shrink-0 opacity-60" />
                <span className="truncate text-xs">{step.tool?.name || step.type}</span>
              </button>
            );
          })}
        </div>
        <div className="preview-rail-viewer p-3 overflow-auto max-h-[280px]">
          {!active ? (
            <div className="text-xs text-dim">Select a trace step to preview.</div>
          ) : active.screenshot ? (
            <img src={active.screenshot} alt="Tool preview" className="max-w-full rounded border border-default" />
          ) : (
            <pre className="text-xs font-mono whitespace-pre-wrap break-words text-muted">
              {active.tool?.result != null
                ? JSON.stringify(active.tool.result, null, 2)
                : active.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}