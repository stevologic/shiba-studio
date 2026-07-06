'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle, Check, CloudDownload, CloudUpload, Clock, FolderKanban, FolderOpen, Loader2,
  MessageSquare, RefreshCw, Server, Users, X,
} from 'lucide-react';
import { toast } from 'sonner';

type SyncKind = 'agents' | 'automations' | 'projects' | 'chats' | 'workspace' | 'models';
type ItemStatus = 'pending' | 'syncing' | 'done' | 'error' | 'skipped';

interface SyncItem {
  kind: SyncKind;
  label: string;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  count: number;
  status: ItemStatus;
  detail?: string;
}

interface SyncModalProps {
  open: boolean;
  onClose: () => void;
  /** Local model settings only sync when a local model is actually in use. */
  localModelInUse: boolean;
  onSynced: () => void;
}

const KIND_META: Array<{ kind: SyncKind; label: string; icon: SyncItem['icon'] }> = [
  { kind: 'agents', label: 'Agents', icon: Users },
  { kind: 'automations', label: 'Automations', icon: Clock },
  { kind: 'projects', label: 'Projects', icon: FolderKanban },
  { kind: 'chats', label: 'Chats', icon: MessageSquare },
  { kind: 'workspace', label: 'Workspace uploads', icon: FolderOpen },
  { kind: 'models', label: 'Local model settings', icon: Server },
];

export default function SyncModal({ open, onClose, localModelInUse, onSynced }: SyncModalProps) {
  const [direction, setDirection] = useState<'push' | 'pull'>('push');
  const [items, setItems] = useState<SyncItem[]>([]);
  const [running, setRunning] = useState(false);
  const [hasCloudAuth, setHasCloudAuth] = useState(true);
  const [countsLoaded, setCountsLoaded] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    cancelRef.current = false;
    setRunning(false);
    setCountsLoaded(false);
    setItems(
      KIND_META
        .filter((m) => m.kind !== 'models' || localModelInUse)
        .map((m) => ({ ...m, count: 0, status: 'pending' as ItemStatus })),
    );
    fetch('/api/cloud/entities')
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) return;
        setHasCloudAuth(!!data.hasCloudAuth);
        setItems((prev) =>
          prev.map((it) => ({ ...it, count: data.counts?.[it.kind] ?? 0 })),
        );
        setCountsLoaded(true);
      })
      .catch(() => {});
  }, [open, localModelInUse]);

  useEffect(() => {
    if (!open) cancelRef.current = true;
  }, [open]);

  const doneCount = items.filter((i) => i.status === 'done' || i.status === 'error' || i.status === 'skipped').length;
  const progressPct = items.length ? Math.round((doneCount / items.length) * 100) : 0;
  const finished = !running && doneCount > 0 && doneCount === items.length;

  async function startSync() {
    if (running) return;
    setRunning(true);
    cancelRef.current = false;
    setItems((prev) => prev.map((it) => ({ ...it, status: 'pending', detail: undefined })));

    for (const meta of KIND_META) {
      if (cancelRef.current) break;
      if (meta.kind === 'models' && !localModelInUse) continue;

      setItems((prev) => prev.map((it) => (it.kind === meta.kind ? { ...it, status: 'syncing' } : it)));
      try {
        const res = await fetch('/api/cloud/entities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: direction, kind: meta.kind }),
        });
        const data = await res.json();
        const detail: string = data.result?.detail || data.error || '';
        const skipped = detail.toLowerCase().startsWith('skipped');
        setItems((prev) =>
          prev.map((it) =>
            it.kind === meta.kind
              ? {
                  ...it,
                  status: data.ok ? (skipped ? 'skipped' : 'done') : 'error',
                  detail: data.ok ? detail : (data.result?.error || data.error || 'Failed'),
                }
              : it,
          ),
        );
      } catch (e: unknown) {
        setItems((prev) =>
          prev.map((it) =>
            it.kind === meta.kind
              ? { ...it, status: 'error', detail: e instanceof Error ? e.message : 'Failed' }
              : it,
          ),
        );
      }
    }

    setRunning(false);
    if (!cancelRef.current) {
      onSynced();
      toast.success(direction === 'push' ? 'Sync to Grok cloud finished' : 'Pull from Grok cloud finished');
    }
  }

  function statusIcon(status: ItemStatus) {
    if (status === 'syncing') return <Loader2 size={14} className="animate-spin text-muted" />;
    if (status === 'done') return <Check size={14} className="text-success" />;
    if (status === 'skipped') return <Check size={14} className="text-dim" />;
    if (status === 'error') return <AlertTriangle size={14} className="text-error" />;
    return <span className="sync-item-dot" />;
  }

  if (!open) return null;

  return (
    (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-[75] p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.15 }}
            className="modal w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Sync with Grok cloud"
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <div className="text-lg font-semibold">Sync with Grok cloud</div>
                <div className="text-xs text-dim mt-0.5">
                  Everything routes through your xAI account — nothing leaves Grok.
                </div>
              </div>
              <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={onClose} title="Close">
                <X size={16} />
              </button>
            </div>

            {!hasCloudAuth && (
              <div className="sync-warning mb-4">
                <AlertTriangle size={14} />
                No cloud credentials — add an xAI API key or sign in with X in Settings first.
              </div>
            )}

            <div className="sync-direction mb-4">
              <button
                type="button"
                disabled={running}
                onClick={() => setDirection('push')}
                className={`sync-direction-option ${direction === 'push' ? 'sync-direction-active' : ''}`}
              >
                <CloudUpload size={15} /> Send to cloud
              </button>
              <button
                type="button"
                disabled={running}
                onClick={() => setDirection('pull')}
                className={`sync-direction-option ${direction === 'pull' ? 'sync-direction-active' : ''}`}
              >
                <CloudDownload size={15} /> Pull to local
              </button>
            </div>

            <div className="space-y-1.5 mb-4">
              {items.map((it) => {
                const Icon = it.icon;
                return (
                  <div key={it.kind} className={`sync-item ${it.status === 'syncing' ? 'sync-item-active' : ''}`}>
                    <Icon size={14} className="text-muted shrink-0" />
                    <span className="text-sm">{it.label}</span>
                    {countsLoaded ? (
                      <span className="text-[10px] text-dim font-mono">{it.count}</span>
                    ) : (
                      <span className="data-spinner" aria-label="Loading count" />
                    )}
                    <span className="ml-auto flex items-center gap-1.5 min-w-0">
                      {it.detail && (
                        <span className={`text-[10px] truncate max-w-[180px] ${it.status === 'error' ? 'text-error' : 'text-dim'}`} title={it.detail}>
                          {it.detail}
                        </span>
                      )}
                      {statusIcon(it.status)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="sync-progress-track mb-1" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
              <div className="sync-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="text-[10px] text-dim text-right mb-4">{progressPct}%</div>

            <div className="flex gap-2.5">
              <button type="button" onClick={onClose} className="grok-btn grok-btn-secondary flex-1">
                {finished ? 'Done' : 'Close'}
              </button>
              <button
                type="button"
                onClick={startSync}
                disabled={running || !hasCloudAuth}
                className="grok-btn grok-btn-primary flex-1"
              >
                {running ? (
                  <><Loader2 size={14} className="animate-spin" /> Syncing…</>
                ) : (
                  <><RefreshCw size={14} /> {direction === 'push' ? 'Send to cloud' : 'Pull to local'}</>
                )}
              </button>
            </div>
          </motion.div>
        </div>
    )
  );
}
