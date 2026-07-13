'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ExternalLink, FileCode, FileText, Image as ImageIcon, Loader2, RefreshCw, Search, X,
} from 'lucide-react';
import { subscribeLiveEvents } from '@/lib/live-events';

const ChatMarkdown = dynamic(() => import('@/components/chat-markdown-lazy'));

interface CreatedFile {
  name: string;
  relPath: string;
  absPath: string;
  size: number;
  mtime: string | null;
  kind: 'image' | 'text' | 'other';
  preview?: string;
  agentName: string;
  createdAt: string | null;
}

interface FileView {
  file: CreatedFile;
  loading: boolean;
  binary?: boolean;
  truncated?: boolean;
  content?: string;
  error?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function KindIcon({ kind }: { kind: CreatedFile['kind'] }) {
  if (kind === 'image') return <ImageIcon size={14} className="text-muted shrink-0" />;
  if (kind === 'text') return <FileCode size={14} className="text-muted shrink-0" />;
  return <FileText size={14} className="text-muted shrink-0" />;
}

export default function FilesPanel() {
  const [files, setFiles] = useState<CreatedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [fileView, setFileView] = useState<FileView | null>(null);
  const fileModalRef = useRef<HTMLDivElement>(null);
  const fileCloseRef = useRef<HTMLButtonElement>(null);
  const fileReturnFocusRef = useRef<HTMLElement | null>(null);
  const fileViewOpen = fileView !== null;

  useEffect(() => {
    if (!fileViewOpen) return;
    fileReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => fileCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setFileView(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = fileModalRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      fileReturnFocusRef.current?.focus();
    };
  }, [fileViewOpen]);

  async function loadFiles() {
    setRefreshing(true);
    try {
      const res = await fetch('/api/files');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Could not load files');
      setFiles(data.files || []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load files');
      setFiles([]);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => { void loadFiles(); }, []);

  // Live-refresh when a run finishes (agents may have written new files).
  useEffect(() => {
    return subscribeLiveEvents(['runs', 'board'], () => { void loadFiles(); });
  }, []);

  async function openFileView(file: CreatedFile) {
    setFileView({ file, loading: true });
    try {
      const res = await fetch(`/api/files?file=${encodeURIComponent(file.absPath)}&inspect=1`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Could not read the file');
      setFileView({ file, loading: false, binary: data.binary, truncated: data.truncated, content: data.content });
    } catch (e: unknown) {
      setFileView({ file, loading: false, error: e instanceof Error ? e.message : 'Could not read the file' });
    }
  }

  const filtered = useMemo(() => {
    const list = files || [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (f) => f.relPath.toLowerCase().includes(q) || f.agentName.toLowerCase().includes(q),
    );
  }, [files, query]);

  return (
    <div className="page-content">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="page-title">Files</div>
          <div className="page-subtitle">
            Every file your agents have created that still exists on disk — deliverables from runs across the studio.
          </div>
        </div>
        <button
          type="button"
          className="grok-btn grok-btn-secondary text-sm shrink-0"
          onClick={() => void loadFiles()}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="relative mt-4 mb-3 max-w-md">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
        <input
          className="grok-input input-icon-pad-sm"
          placeholder="Filter by path or agent…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {files === null ? (
        <div className="data-loading-row py-8"><span className="data-spinner" /> Loading files…</div>
      ) : error ? (
        <div className="grok-card p-5 text-sm text-error">{error}</div>
      ) : filtered.length === 0 ? (
        <div className="grok-card p-8 text-center text-dim text-sm">
          {files.length === 0
            ? 'No files yet — when an agent writes a deliverable it will show up here.'
            : 'No files match your filter.'}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((f) => (
            <div key={f.absPath} className="grok-card p-2.5 flex items-center gap-3 min-w-0">
              <button
                type="button"
                className="flex items-center gap-2 min-w-0 shrink text-left link-accent"
                onClick={() => void openFileView(f)}
                title={`Read ${f.absPath}`}
              >
                <KindIcon kind={f.kind} />
                <span className="font-mono text-xs truncate">{f.relPath}</span>
              </button>
              {f.preview && (
                <span className="text-[11px] text-dim truncate hidden md:block min-w-0 flex-1" title="Opening line">{f.preview}</span>
              )}
              <div className="flex items-center gap-3 ml-auto shrink-0 text-[11px]">
                <span className="badge badge-muted">{f.agentName}</span>
                <span className="text-dim">{formatBytes(f.size)}</span>
                <span className="text-dim hidden sm:inline" title={f.createdAt || ''}>{timeAgo(f.createdAt)}</span>
                <a
                  className="kb-icon-btn"
                  href={`/api/files?file=${encodeURIComponent(f.absPath)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open raw / download"
                  aria-label="Open raw file"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink size={13} />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {fileView && (
        <div className="kb-work-overlay kb-file-view-overlay" onClick={() => setFileView(null)} role="presentation">
          <div
            ref={fileModalRef}
            className="kb-work-modal kb-file-view-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`File ${fileView.file.relPath}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="kb-work-head">
              <FileText size={15} className="opacity-70 shrink-0" />
              <div className="kb-work-title min-w-0">
                <span className="kb-work-title-text kb-file-view-name" title={fileView.file.relPath}>{fileView.file.relPath}</span>
                <span className="kb-file-meta">{formatBytes(fileView.file.size)} · {fileView.file.agentName}</span>
              </div>
              <a
                className="kb-icon-btn"
                href={`/api/files?file=${encodeURIComponent(fileView.file.absPath)}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open raw / download"
                aria-label="Open raw file"
              >
                <ExternalLink size={13} />
              </a>
              <button ref={fileCloseRef} type="button" className="kb-icon-btn" title="Close" aria-label="Close" onClick={() => setFileView(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="kb-work-body kb-file-view-body">
              {fileView.loading && (
                <div className="kb-col-empty"><Loader2 size={14} className="kb-spin" /> Reading the file…</div>
              )}
              {!fileView.loading && fileView.error && <div className="kb-col-empty">{fileView.error}</div>}
              {!fileView.loading && !fileView.error && fileView.binary && (
                <div className="kb-col-empty">
                  This is a binary file — no text preview. Use the raw link above to download it.
                </div>
              )}
              {!fileView.loading && !fileView.error && !fileView.binary && (() => {
                const ext = fileView.file.relPath.includes('.') ? fileView.file.relPath.split('.').pop()!.toLowerCase() : '';
                const body = fileView.content || '';
                const rendered = ext === 'md' || ext === 'markdown' ? body : `\`\`\`\`${ext}\n${body}\n\`\`\`\``;
                return (
                  <>
                    <ChatMarkdown content={rendered} className="kb-file-view-md" />
                    {fileView.truncated && (
                      <div className="kb-file-view-note">Preview truncated at 512 KB — the raw link has the full file.</div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
