'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, X } from 'lucide-react';

export interface PendingToolApproval {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
}

interface ToolApprovalModalProps {
  pending: PendingToolApproval | null;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
}

export default function ToolApprovalModal({ pending, onApprove, onDeny }: ToolApprovalModalProps) {
  return (
    <AnimatePresence>
      {pending && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60"
          onClick={() => onDeny(pending.approvalId)}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            className="modal w-full max-w-lg p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="font-semibold flex items-center gap-2">
                <Shield size={18} className="text-warning" />
                Approve tool execution?
              </div>
              <button type="button" onClick={() => onDeny(pending.approvalId)} className="grok-btn grok-btn-ghost p-1">
                <X size={16} />
              </button>
            </div>
            <div className="text-sm mb-2">
              Agent wants to run <span className="font-mono text-accent-2">{pending.toolName}</span>
            </div>
            <pre className="tool-approval-args text-xs font-mono p-3 rounded bg-black/30 overflow-auto max-h-[200px]">
              {JSON.stringify(pending.args, null, 2)}
            </pre>
            <div className="flex gap-2 mt-4">
              <button type="button" onClick={() => onDeny(pending.approvalId)} className="grok-btn grok-btn-secondary flex-1">
                Deny
              </button>
              <button type="button" onClick={() => onApprove(pending.approvalId)} className="grok-btn grok-btn-primary flex-1">
                Approve &amp; Run
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}