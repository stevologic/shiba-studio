'use client';

// Chat workspace picker — bind a chat session to a folder on disk (typically a
// cloned repo) so file reads/writes/searches and /git commands all run there.

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUp, Check, Folder, FolderGit2, Loader2, Unlink, X } from 'lucide-react';
import { toast } from '@/lib/toast';

interface DirEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

interface Listing {
  path: string;
  parent: string | null;
  isRepo: boolean;
  dirs: DirEntry[];
}

interface WorkspacePickerProps {
  open: boolean;
  /** Currently bound folder, if any. */
  value: string | null;
  /** Settings default workspace — used when the chat has no bound folder yet. */
  defaultPath?: string | null;
  onClose: () => void;
  /** null = detach the workspace from this chat. */
  onSelect: (dir: string | null) => void;
}

export default function WorkspacePicker({ open, value, defaultPath, onClose, onSelect }: WorkspacePickerProps) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [busy, setBusy] = useState(false);

  const browse = useCallback(async (p?: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/fs/browse?dir=${encodeURIComponent(p || '')}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Could not open that folder');
      // Repos surface first — they're what chats usually get bound to.
      const dirs: DirEntry[] = [...(data.directories || [])]
        .sort((a: DirEntry, b: DirEntry) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name));
      setListing({ path: data.path, parent: data.parent, isRepo: !!data.isRepo, dirs });
      setPathInput(data.path);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not open that folder');
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Prefer the chat binding; otherwise land on Settings default workspace
    // (not the user home directory).
    const start = (value || defaultPath || '').trim() || undefined;
    void browse(start);
  }, [open, value, defaultPath, browse]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="modal modal-pop w-full max-w-lg p-5 max-h-[82vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-lg font-semibold flex items-center gap-2">
              <FolderGit2 size={17} className="opacity-70" /> Chat workspace
            </div>
            <div className="text-xs text-dim mt-0.5">
              Bind this chat to a folder — e.g. a cloned GitHub repo. File reads, writes,
              searches, and <span className="font-mono">/git</span> commands then run inside it.
            </div>
          </div>
          <button type="button" className="grok-btn grok-btn-ghost p-1.5" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 mb-2">
          <input
            className="grok-input flex-1 min-w-0 font-mono text-xs"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void browse(pathInput); }}
            placeholder="Type a folder path and press Enter, or browse below"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => listing?.parent && void browse(listing.parent)}
            disabled={!listing?.parent || busy}
            className="grok-btn grok-btn-ghost text-xs p-1.5 shrink-0"
            title="Up one folder"
          >
            <ArrowUp size={14} />
          </button>
        </div>

        <div className="workspace-dir-list flex-1 min-h-0 overflow-auto">
          {busy && !listing ? (
            <div className="data-loading-row text-xs p-3"><span className="data-spinner" /> Reading folders…</div>
          ) : listing?.dirs.length ? (
            listing.dirs.map((d) => (
              <button key={d.path} type="button" className="workspace-dir-item" onClick={() => void browse(d.path)} title={d.path}>
                <Folder size={14} className="opacity-60 shrink-0" />
                <span className="truncate min-w-0">{d.name}</span>
                {d.isRepo && <span className="tool-chip tool-chip-local shrink-0">git</span>}
              </button>
            ))
          ) : (
            <div className="text-xs text-dim p-3">No subfolders here — you can still use this folder.</div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-3">
          <div className="text-xs text-dim flex-1 min-w-0 truncate" title={listing?.path || ''}>
            {busy ? <Loader2 size={12} className="animate-spin inline" /> : listing?.isRepo ? '✓ git repository — ' : ''}
            <span className="font-mono">{listing?.path || ''}</span>
          </div>
          {value && (
            <button
              type="button"
              onClick={() => { onSelect(null); onClose(); }}
              className="grok-btn grok-btn-ghost text-xs shrink-0"
              title="Remove the workspace binding from this chat"
            >
              <Unlink size={13} /> Detach
            </button>
          )}
          <button
            type="button"
            onClick={() => { if (listing) { onSelect(listing.path); onClose(); } }}
            disabled={!listing || busy}
            className="grok-btn grok-btn-primary text-xs shrink-0"
          >
            <Check size={13} /> Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
