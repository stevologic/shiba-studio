'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, X } from 'lucide-react';
import ToolApprovalCard from '@/components/tool-approval-card';

export interface PendingToolApproval {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
}

interface ToolApprovalModalProps {
  pending: PendingToolApproval | null;
  onApprove: (approvalId: string) => void;
  onAlways?: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
}

export default function ToolApprovalModal({ pending, onApprove, onAlways, onDeny }: ToolApprovalModalProps) {
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
            <ToolApprovalCard
              toolName={pending.toolName}
              args={pending.args}
              onApprove={() => onApprove(pending.approvalId)}
              onAlways={onAlways ? () => onAlways(pending.approvalId) : undefined}
              onDeny={() => onDeny(pending.approvalId)}
            />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
