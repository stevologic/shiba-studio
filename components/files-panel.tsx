'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import {
  ChevronRight,
  ExternalLink,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Search,
  X,
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
  workspaceRoot?: string;
}

interface FileView {
  file: CreatedFile;
  loading: boolean;
  binary?: boolean;
  truncated?: boolean;
  content?: string;
  error?: string;
}

interface PreviewResult {
  binary: boolean;
  truncated: boolean;
  content: string;
}

interface NormalizedFile {
  file: CreatedFile;
  path: string;
}

type ExplorerEntry =
  | { type: 'folder'; name: string; path: string; fileCount: number }
  | { type: 'file'; name: string; path: string; file: CreatedFile };

const MAX_PREVIEW_CACHE_ENTRIES = 16;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function normalizeRelPath(file: CreatedFile): string {
  const stack: string[] = [];
  for (const part of (file.relPath || file.name).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/') || file.name;
}

function rawFileHref(file: CreatedFile): string {
  return `/api/files?file=${encodeURIComponent(file.absPath)}`;
}

function previewCacheKey(file: CreatedFile): string {
  return `${file.absPath}\u0000${file.mtime || ''}\u0000${file.size}`;
}

function imagePreviewHref(file: CreatedFile): string {
  return `${rawFileHref(file)}&revision=${encodeURIComponent(`${file.mtime || 'unknown'}:${file.size}`)}`;
}

function workspaceLabel(root: string): string {
  const parts = root.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) || root.replace(/[\\/:]+/g, '') || 'Workspace';
}

function normalizeFilesForExplorer(files: CreatedFile[]): NormalizedFile[] {
  const roots = [...new Set(files.map((file) => file.workspaceRoot?.trim()).filter((root): root is string => Boolean(root)))].sort();
  const labels = new Map<string, string>();
  const labelCounts = new Map<string, number>();
  for (const root of roots) {
    const rawLabel = workspaceLabel(root);
    const agent = files.find((file) => file.workspaceRoot?.trim() === root)?.agentName;
    const base = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(rawLabel) && agent
      ? `${agent} worktree`
      : rawLabel;
    const count = (labelCounts.get(base) || 0) + 1;
    labelCounts.set(base, count);
    labels.set(root, count === 1 ? base : `${base} (${count})`);
  }
  const groupByWorkspace = roots.length > 1;
  return files.map((file) => {
    const relativePath = normalizeRelPath(file);
    const root = file.workspaceRoot?.trim();
    const prefix = groupByWorkspace ? (root ? labels.get(root) : 'Other') : '';
    return { file, path: prefix ? `${prefix}/${relativePath}` : relativePath };
  });
}

function KindIcon({ kind }: { kind: CreatedFile['kind'] }) {
  if (kind === 'image') return <ImageIcon size={14} className="shrink-0 opacity-70" aria-hidden="true" />;
  if (kind === 'text') return <FileCode size={14} className="shrink-0 opacity-70" aria-hidden="true" />;
  return <FileText size={14} className="shrink-0 opacity-70" aria-hidden="true" />;
}

export default function FilesPanel() {
  const [files, setFiles] = useState<CreatedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [currentFolder, setCurrentFolder] = useState('');
  const [fileView, setFileView] = useState<FileView | null>(null);
  const filesAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewRequestRef = useRef(0);
  const previewCacheRef = useRef(new Map<string, PreviewResult>());
  const selectedFileRef = useRef<CreatedFile | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const explorerListRef = useRef<HTMLUListElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rootCrumbRef = useRef<HTMLButtonElement | null>(null);

  const closeFileView = useCallback((restoreFocus = true) => {
    const focusTarget = previewReturnFocusRef.current;
    selectedFileRef.current = null;
    previewRequestRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setFileView(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        if (focusTarget?.isConnected) focusTarget.focus();
        else rootCrumbRef.current?.focus();
      });
    }
  }, []);

  const openFileView = useCallback(async (file: CreatedFile, returnFocus?: HTMLElement) => {
    selectedFileRef.current = file;
    if (returnFocus) previewReturnFocusRef.current = returnFocus;
    previewAbortRef.current?.abort();
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;

    if (file.kind === 'image') {
      previewAbortRef.current = null;
      setFileView({ file, loading: false, binary: false });
      return;
    }

    const cacheKey = previewCacheKey(file);
    const cached = previewCacheRef.current.get(cacheKey);
    if (cached) {
      previewCacheRef.current.delete(cacheKey);
      previewCacheRef.current.set(cacheKey, cached);
      previewAbortRef.current = null;
      setFileView({ file, loading: false, ...cached });
      return;
    }

    const controller = new AbortController();
    previewAbortRef.current = controller;
    setFileView({ file, loading: true });

    try {
      const response = await fetch(`${rawFileHref(file)}&inspect=1`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await response.json() as {
        ok?: boolean;
        binary?: boolean;
        truncated?: boolean;
        content?: string;
        error?: string;
      };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not read the file');
      const result: PreviewResult = {
        binary: Boolean(data.binary),
        truncated: Boolean(data.truncated),
        content: typeof data.content === 'string' ? data.content : '',
      };
      previewCacheRef.current.delete(cacheKey);
      previewCacheRef.current.set(cacheKey, result);
      while (previewCacheRef.current.size > MAX_PREVIEW_CACHE_ENTRIES) {
        const oldest = previewCacheRef.current.keys().next().value as string | undefined;
        if (!oldest) break;
        previewCacheRef.current.delete(oldest);
      }
      if (previewRequestRef.current === requestId) setFileView({ file, loading: false, ...result });
    } catch (previewError: unknown) {
      if (controller.signal.aborted || previewRequestRef.current !== requestId) return;
      setFileView({
        file,
        loading: false,
        error: previewError instanceof Error ? previewError.message : 'Could not read the file',
      });
    } finally {
      if (previewRequestRef.current === requestId) previewAbortRef.current = null;
    }
  }, []);

  const loadFiles = useCallback(async () => {
    filesAbortRef.current?.abort();
    const controller = new AbortController();
    filesAbortRef.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch('/api/files', { cache: 'no-store', signal: controller.signal });
      const data = await response.json() as { ok?: boolean; files?: CreatedFile[]; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load files');
      if (controller.signal.aborted) return;
      const nextFiles = Array.isArray(data.files) ? data.files : [];
      const validCacheKeys = new Set(nextFiles.map(previewCacheKey));
      for (const cacheKey of previewCacheRef.current.keys()) {
        if (!validCacheKeys.has(cacheKey)) previewCacheRef.current.delete(cacheKey);
      }
      setFiles(nextFiles);
      setCurrentFolder((folder) => {
        if (!folder) return folder;
        const prefix = `${folder}/`;
        return normalizeFilesForExplorer(nextFiles).some((item) => item.path.startsWith(prefix)) ? folder : '';
      });

      const selected = selectedFileRef.current;
      if (selected) {
        const updated = nextFiles.find((file) => file.absPath === selected.absPath);
        if (!updated) closeFileView(false);
        else if (previewCacheKey(updated) !== previewCacheKey(selected)) void openFileView(updated);
        else {
          selectedFileRef.current = updated;
          setFileView((current) => current ? { ...current, file: updated } : current);
        }
      }
      setError(null);
    } catch (loadError: unknown) {
      if (controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : 'Could not load files');
      setFiles([]);
    } finally {
      if (filesAbortRef.current === controller) {
        filesAbortRef.current = null;
        setRefreshing(false);
      }
    }
  }, [closeFileView, openFileView]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadFiles());
    return () => window.cancelAnimationFrame(frame);
  }, [loadFiles]);

  useEffect(() => subscribeLiveEvents(['runs', 'board'], () => {
    void loadFiles();
  }), [loadFiles]);

  useEffect(() => () => {
    filesAbortRef.current?.abort();
    previewAbortRef.current?.abort();
  }, []);

  const normalizedFiles = useMemo<NormalizedFile[]>(() => normalizeFilesForExplorer(files || []), [files]);

  const activeFolder = useMemo(() => {
    if (!currentFolder || files === null) return currentFolder;
    const prefix = `${currentFolder}/`;
    return normalizedFiles.some((item) => item.path.startsWith(prefix)) ? currentFolder : '';
  }, [currentFolder, files, normalizedFiles]);

  const entries = useMemo<ExplorerEntry[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery) {
      return normalizedFiles
        .filter(({ file, path }) => path.toLowerCase().includes(normalizedQuery)
          || file.agentName.toLowerCase().includes(normalizedQuery))
        .map(({ file, path }) => ({ type: 'file' as const, name: file.name, path, file }))
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    }

    const prefix = activeFolder ? `${activeFolder}/` : '';
    const folders = new Map<string, { name: string; path: string; fileCount: number }>();
    const directFiles: ExplorerEntry[] = [];

    for (const item of normalizedFiles) {
      if (prefix && !item.path.startsWith(prefix)) continue;
      const remainder = prefix ? item.path.slice(prefix.length) : item.path;
      if (!remainder) continue;
      const [nextSegment, ...rest] = remainder.split('/');
      if (rest.length > 0) {
        const folderPath = prefix ? `${activeFolder}/${nextSegment}` : nextSegment;
        const existing = folders.get(folderPath);
        if (existing) existing.fileCount += 1;
        else folders.set(folderPath, { name: nextSegment, path: folderPath, fileCount: 1 });
      } else {
        directFiles.push({ type: 'file', name: nextSegment, path: item.path, file: item.file });
      }
    }

    return [
      ...[...folders.values()]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((folder) => ({ type: 'folder' as const, ...folder })),
      ...directFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    ];
  }, [activeFolder, normalizedFiles, query]);

  const navigateToFolder = useCallback((folder: string) => {
    setCurrentFolder(folder);
    setQuery('');
    window.requestAnimationFrame(() => {
      explorerListRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    });
  }, []);

  const isSearching = query.trim().length > 0;
  const folderSegments = !isSearching && activeFolder ? activeFolder.split('/') : [];
  const selectedPath = fileView
    ? normalizedFiles.find((item) => item.file.absPath === fileView.file.absPath)?.path || normalizeRelPath(fileView.file)
    : null;

  return (
    <div className="ws-shell page-content files-explorer-page">
      <header className="ws-header">
        <div>
          <h1 className="page-title">Files</h1>
          <p className="page-subtitle">
            Browse the deliverables your agents created, organized into familiar folders with a read-only preview.
          </p>
        </div>
        <button
          type="button"
          className="grok-btn grok-btn-secondary text-sm shrink-0"
          onClick={() => void loadFiles()}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
        </button>
      </header>

      <div className="ws-body">
        <main className="ws-main">
          <div className="ws-explorer">
            <div className="ws-explorer-toolbar">
              <nav className="ws-breadcrumb" aria-label="File breadcrumb">
                <button
                  ref={rootCrumbRef}
                  type="button"
                  className="ws-crumb-root"
                  title="Files root"
                  aria-label="Files root"
                  onClick={() => navigateToFolder('')}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                </button>
                {folderSegments.map((segment, index) => {
                  const folderPath = folderSegments.slice(0, index + 1).join('/');
                  const isCurrent = index === folderSegments.length - 1;
                  return (
                    <React.Fragment key={folderPath}>
                      <ChevronRight size={12} className="ws-crumb-sep" aria-hidden="true" />
                      {isCurrent ? (
                        <span className="ws-crumb ws-crumb-current" aria-current="page">{segment}</span>
                      ) : (
                        <button type="button" className="ws-crumb" onClick={() => navigateToFolder(folderPath)}>
                          {segment}
                        </button>
                      )}
                    </React.Fragment>
                  );
                })}
                {isSearching && (
                  <>
                    <ChevronRight size={12} className="ws-crumb-sep" aria-hidden="true" />
                    <span className="ws-crumb ws-crumb-current" aria-current="page">Search results</span>
                  </>
                )}
                {!activeFolder && !isSearching && <span className="text-xs text-dim ml-1">Tracked deliverables</span>}
              </nav>
            </div>

            <div className={`ws-explorer-split ${fileView ? 'ws-explorer-split-open' : ''}`}>
              <aside className="ws-tree" aria-label="Files explorer">
                <div className="ws-tree-search">
                  <Search size={13} className="opacity-45" aria-hidden="true" />
                  <input
                    ref={searchInputRef}
                    className="ws-tree-search-input"
                    type="search"
                    aria-label="Search files"
                    placeholder="Search files or agents…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {query && (
                    <button
                      type="button"
                      className="ws-editor-tab-close"
                      aria-label="Clear file search"
                      onClick={() => {
                        setQuery('');
                        window.requestAnimationFrame(() => searchInputRef.current?.focus());
                      }}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>

                <ul ref={explorerListRef} className="ws-tree-list" aria-label={isSearching ? 'Matching files' : 'Folder contents'}>
                  {files === null && (
                    <li className="data-loading-row text-xs p-3" aria-live="polite">
                      <span className="data-spinner" /> Loading files…
                    </li>
                  )}
                  {files !== null && error && (
                    <li>
                      <div className="files-tree-message text-error" role="alert">
                        <span>{error}</span>
                        <button type="button" className="grok-btn grok-btn-secondary text-xs" onClick={() => void loadFiles()}>
                          Try again
                        </button>
                      </div>
                    </li>
                  )}
                  {files !== null && !error && entries.length === 0 && (
                    <li className="files-tree-message text-dim">
                      {files.length === 0
                        ? 'No tracked files yet. New agent deliverables will appear here.'
                        : isSearching
                          ? 'No files match your search.'
                          : 'This folder is empty.'}
                    </li>
                  )}
                  {files !== null && !error && entries.map((entry) => {
                    if (entry.type === 'folder') {
                      return (
                        <li key={`folder:${entry.path}`}>
                          <button
                            type="button"
                            className="ws-tree-item ws-tree-item-dir"
                            title={`${entry.path} · ${entry.fileCount} file${entry.fileCount === 1 ? '' : 's'}`}
                            onClick={() => navigateToFolder(entry.path)}
                          >
                            <Folder size={14} className="shrink-0 opacity-70" aria-hidden="true" />
                            <span className="truncate">{entry.name}</span>
                            <span className="files-tree-count">{entry.fileCount}</span>
                            <ChevronRight size={12} className="opacity-40 shrink-0" aria-hidden="true" />
                          </button>
                        </li>
                      );
                    }

                    const active = fileView?.file.absPath === entry.file.absPath;
                    return (
                      <li key={entry.file.absPath}>
                        <button
                          type="button"
                          className={`ws-tree-item ${active ? 'ws-tree-item-active' : ''}`}
                          title={`${entry.path}\n${entry.file.agentName} · ${formatBytes(entry.file.size)}`}
                          onClick={(event) => void openFileView(entry.file, event.currentTarget)}
                        >
                          <KindIcon kind={entry.file.kind} />
                          <span className="files-tree-copy">
                            <span className="truncate">{isSearching ? entry.path : entry.name}</span>
                            <span className="files-tree-meta">{entry.file.agentName} · {formatBytes(entry.file.size)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                <div className="ws-tree-footer files-tree-footer" aria-live="polite">
                  {files === null
                    ? 'Loading…'
                    : isSearching
                      ? `${entries.length} result${entries.length === 1 ? '' : 's'}`
                      : `${entries.length} item${entries.length === 1 ? '' : 's'} · ${files.length} tracked`}
                </div>
              </aside>

              {fileView ? (
                <section className="ws-editor" aria-label="File preview">
                  <div className="ws-editor-tabbar">
                    <div className="ws-editor-tab">
                      <KindIcon kind={fileView.file.kind} />
                      <span className="truncate max-w-[14rem]">{fileView.file.name}</span>
                      <button type="button" className="ws-editor-tab-close" onClick={() => closeFileView()} title="Close preview" aria-label="Close file preview">
                        <X size={12} aria-hidden="true" />
                      </button>
                    </div>
                    <a
                      className="grok-btn grok-btn-secondary text-xs ml-auto"
                      href={rawFileHref(fileView.file)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} aria-hidden="true" /> Open raw
                    </a>
                  </div>
                  <div className="ws-editor-path font-mono" title={fileView.file.absPath}>{selectedPath}</div>

                  <div className="files-preview-body">
                    {fileView.loading && (
                      <div className="files-preview-state" aria-live="polite">
                        <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Reading the file…
                      </div>
                    )}
                    {!fileView.loading && fileView.error && (
                      <div className="files-preview-state text-error" role="alert">{fileView.error}</div>
                    )}
                    {!fileView.loading && !fileView.error && fileView.file.kind === 'image' && (
                      <div className="files-preview-image-wrap">
                        <Image
                          unoptimized
                          src={imagePreviewHref(fileView.file)}
                          alt={fileView.file.name}
                          width={1200}
                          height={800}
                          className="files-preview-image"
                          onError={() => setFileView((current) => current?.file.absPath === fileView.file.absPath
                            ? { ...current, error: 'Image preview is unavailable. Open the raw file to retry or download it.' }
                            : current)}
                        />
                      </div>
                    )}
                    {!fileView.loading && !fileView.error && fileView.file.kind !== 'image' && fileView.binary && (
                      <div className="files-preview-state">
                        <FileText size={32} className="opacity-30" aria-hidden="true" />
                        <span>This binary file does not have a text preview.</span>
                        <a className="grok-btn grok-btn-secondary text-xs" href={rawFileHref(fileView.file)} target="_blank" rel="noopener noreferrer">
                          <ExternalLink size={13} aria-hidden="true" /> Open or download
                        </a>
                      </div>
                    )}
                    {!fileView.loading && !fileView.error && fileView.file.kind !== 'image' && !fileView.binary && (() => {
                      const extension = fileView.file.name.includes('.')
                        ? fileView.file.name.split('.').pop()!.toLowerCase()
                        : '';
                      const body = fileView.content || '';
                      const rendered = extension === 'md' || extension === 'markdown'
                        ? body
                        : `\`\`\`${extension}\n${body}\n\`\`\``;
                      return <ChatMarkdown content={rendered} className="files-preview-markdown" />;
                    })()}
                    {!fileView.loading && !fileView.error && fileView.truncated && (
                      <div className="files-preview-note">Preview limited to 512 KB. Open the raw file to see the rest.</div>
                    )}
                  </div>

                  <div className="ws-editor-statusbar">
                    <span>{formatBytes(fileView.file.size)}</span>
                    <span>{fileView.file.agentName}</span>
                    {fileView.file.createdAt && <span title={fileView.file.createdAt}>{timeAgo(fileView.file.createdAt)}</span>}
                    <span className="ml-auto">Read only</span>
                  </div>
                </section>
              ) : (
                <section className="ws-explorer-welcome" aria-label="File preview">
                  <FolderOpen size={40} className="opacity-25 mb-3" aria-hidden="true" />
                  <div className="text-sm font-medium">No file open</div>
                  <div className="text-xs text-dim mt-1 max-w-xs text-center leading-relaxed">
                    Open folders from the explorer, then select a file to preview it here.
                  </div>
                </section>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
