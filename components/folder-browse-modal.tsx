'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronUp, Folder, FolderOpen, X } from 'lucide-react';

interface FolderBrowseModalProps {
  open: boolean;
  title?: string;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

export default function FolderBrowseModal({
  open,
  title = 'Choose folder',
  initialPath,
  onClose,
  onSelect,
}: FolderBrowseModalProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<Array<{ name: string; path: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (dir?: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : '';
      const res = await fetch(`/api/fs/browse${qs}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCurrentPath(data.path);
      setParentPath(data.parent);
      setDirectories(data.directories || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load folders');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadDir(initialPath?.trim() || undefined);
  }, [open, initialPath, loadDir]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="modal folder-browse-modal w-full max-w-lg p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="font-semibold">{title}</div>
          <button type="button" onClick={onClose} className="grok-btn grok-btn-ghost p-1" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="folder-browse-path font-mono text-xs break-all">{currentPath || '…'}</div>

        <div className="flex gap-2 mt-2 mb-3">
          <button
            type="button"
            onClick={() => parentPath && loadDir(parentPath)}
            disabled={!parentPath || loading}
            className="grok-btn grok-btn-secondary text-xs"
          >
            <ChevronUp size={14} /> Up
          </button>
          <button
            type="button"
            onClick={() => loadDir(currentPath)}
            disabled={loading || !currentPath}
            className="grok-btn grok-btn-ghost text-xs"
          >
            Refresh
          </button>
        </div>

        <div className="folder-browse-list grok-card p-2 max-h-64 overflow-auto">
          {loading && <div className="text-xs text-dim p-2">Loading folders…</div>}
          {error && <div className="text-xs text-error p-2">{error}</div>}
          {!loading && !error && directories.length === 0 && (
            <div className="text-xs text-dim p-2">No subfolders here.</div>
          )}
          {!loading && directories.map((d) => (
            <button
              key={d.path}
              type="button"
              className="folder-browse-item"
              onClick={() => loadDir(d.path)}
            >
              <Folder size={14} className="shrink-0 opacity-70" />
              <span className="truncate">{d.name}</span>
            </button>
          ))}
        </div>

        <div className="flex gap-3 mt-4">
          <button type="button" onClick={onClose} className="grok-btn grok-btn-secondary flex-1">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { if (currentPath) onSelect(currentPath); }}
            disabled={!currentPath || loading}
            className="grok-btn grok-btn-primary flex-1"
          >
            <FolderOpen size={14} /> Select this folder
          </button>
        </div>
      </motion.div>
    </div>
  );
}