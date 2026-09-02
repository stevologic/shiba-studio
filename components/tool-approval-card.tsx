'use client';

import { Check, ShieldCheck, X } from 'lucide-react';
import { canAlwaysApproveTool } from '@/lib/tool-approval-policy';

export interface ToolApprovalCardProps {
  toolName: string;
  args?: Record<string, unknown>;
  busy?: boolean;
  resolved?: 'approved' | 'denied';
  onApprove: () => void;
  onAlways?: () => void;
  onDeny: () => void;
}

export default function ToolApprovalCard({
  toolName,
  args,
  busy,
  resolved,
  onApprove,
  onAlways,
  onDeny,
}: ToolApprovalCardProps) {
  const showAlways = canAlwaysApproveTool(toolName) && !!onAlways;
  const argText = args && Object.keys(args).length > 0
    ? JSON.stringify(args, null, 2)
    : '';

  if (resolved) {
    return (
      <div className="grok-chat-approval grok-chat-approval-resolved" role="status">
        <ShieldCheck size={14} aria-hidden />
        <span>
          {resolved === 'approved' ? 'Approved' : 'Denied'}{' '}
          <span className="font-mono">{toolName}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="grok-chat-approval" role="group" aria-label={`Approve ${toolName}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <ShieldCheck size={14} style={{ color: 'var(--warning)' }} aria-hidden />
        <span className="font-medium text-sm">Approval required</span>
      </div>
      <div className="text-xs text-muted mb-2">
        Wants to run <span className="font-mono" style={{ color: 'var(--warning)' }}>{toolName}</span>
      </div>
      {argText && (
        <pre className="tool-approval-args text-[11px] font-mono p-2 rounded bg-black/40 overflow-auto max-h-32 mb-2">
          {argText}
        </pre>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="grok-btn grok-btn-primary text-xs"
          disabled={busy}
          onClick={onApprove}
        >
          <Check size={13} aria-hidden /> Approve
        </button>
        {showAlways && (
          <button
            type="button"
            className="grok-btn grok-btn-secondary text-xs"
            disabled={busy}
            onClick={onAlways}
            title="Do not ask again for this tool"
          >
            Always approve
          </button>
        )}
        <button
          type="button"
          className="grok-btn grok-btn-secondary text-xs text-error"
          disabled={busy}
          onClick={onDeny}
        >
          <X size={13} aria-hidden /> Deny
        </button>
      </div>
    </div>
  );
}
