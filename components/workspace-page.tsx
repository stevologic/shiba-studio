'use client';

/**
 * Workspace hub — VS Code–style shell for:
 *  • Global uploads (shared context)
 *  • Agent worktrees + who uses them (agents / chats / automations)
 *  • Folder explorer with optional editor (opens only when a file is selected)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Bot, CalendarClock, ChevronRight, ChevronsUp, Cloud, CloudDownload, CloudUpload,
  ExternalLink, FileCode, FileText, Folder, FolderOpen, GitBranch, HardDrive, MessageSquare,
  RefreshCw, Save, Search, Trash2, Upload, X,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { confirmDialog } from '@/components/confirm-dialog';
import type { Agent } from '@/lib/types';
import type { ChatSession } from '@/lib/chat-session-types';
import { loadClientJson } from '@/lib/client-json';

const FolderBrowseModal = dynamic(() => import('@/components/folder-browse-modal'));

type WsView = 'uploads' | 'worktrees' | 'explorer';

interface WsFile {
  name: string;
  path: string;
  isDir?: boolean;
  size?: number;
}

interface UploadEntry {
  name: string;
  path: string;
  size: number;
  uploadedAt?: string;
  checksum?: string;
  cloud?: { url?: string; cloudUrl?: string; xaiFileId?: string };
}

interface WorktreeEntry {
  agentId: string;
  path: string;
  branch?: string;
  exists: boolean;
}

interface ExplorerIntent {
  key: number;
  dir?: string;
  userInitiated?: boolean;
}

interface WorkspacePageProps {
  agents: Agent[];
  defaultWorkspace: string;
  hasCloudAuth: boolean;
  onOpenAgent?: (agentId: string) => void;
}

function fileIcon(name: string, isDir?: boolean) {
  if (isDir) return Folder;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'rb', 'php', 'swift'].includes(ext)) {
    return FileCode;
  }
  return FileText;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function pathSegments(p: string): string[] {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm) return [];
  // Keep drive letter on Windows: C:/Users → ["C:", "Users"]
  const parts = norm.split('/').filter(Boolean);
  return parts;
}

function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.replace(/[/\\]+$/, '') + sep + name;
}

function parentOf(p: string): string | null {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  if (i <= 0) return null;
  // "C:/" parent is null-ish
  if (i === 2 && norm[1] === ':') return null;
  return p.slice(0, i) || null;
}

export default function WorkspacePage({
  agents,
  defaultWorkspace,
  hasCloudAuth,
  onOpenAgent,
}: WorkspacePageProps) {
  const [view, setView] = useState<WsView>('uploads');
  const [wsPath, setWsPath] = useState(defaultWorkspace || '');
  const [wsFiles, setWsFiles] = useState<WsFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileBinary, setFileBinary] = useState(false);
  const [explorerLoading, setExplorerLoading] = useState(false);
  const [fileCtxMenu, setFileCtxMenu] = useState<{ x: number; y: number; path: string; name: string } | null>(null);
  const [pathInput, setPathInput] = useState(defaultWorkspace || '');
  const [showFolderBrowse, setShowFolderBrowse] = useState(false);
  const [treeFilter, setTreeFilter] = useState('');

  const [wsUploads, setWsUploads] = useState<UploadEntry[]>([]);
  const [wsUploadsPath, setWsUploadsPath] = useState('');
  const [cloudFiles, setCloudFiles] = useState<unknown[]>([]);
  const [wsLastSync, setWsLastSync] = useState<string | null>(null);
  const [wsDragging, setWsDragging] = useState(false);
  const [wsUploading, setWsUploading] = useState(false);
  const [wsSyncing, setWsSyncing] = useState<'upload' | 'download' | null>(null);

  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [wtLoading, setWtLoading] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  /** Once the user Browse… / navigates, stop overriding with Settings default. */
  const userPickedPathRef = useRef(false);
  const wsPathRef = useRef(wsPath);
  const wsUploadsPathRef = useRef(wsUploadsPath);
  const defaultWorkspaceRef = useRef(defaultWorkspace);
  const uploadsLoadRef = useRef<Promise<string> | null>(null);
  const explorerAbortRef = useRef<AbortController | null>(null);
  const explorerRequestRef = useRef(0);
  const fileReadAbortRef = useRef<AbortController | null>(null);
  const fileReadRequestRef = useRef(0);
  const [explorerIntent, setExplorerIntent] = useState<ExplorerIntent>({ key: 0 });

  useEffect(() => {
    wsPathRef.current = wsPath;
    wsUploadsPathRef.current = wsUploadsPath;
    defaultWorkspaceRef.current = defaultWorkspace;
  }, [defaultWorkspace, wsPath, wsUploadsPath]);

  // Follow the global default workspace until the user picks another folder.
  useEffect(() => {
    const next = (defaultWorkspace || '').trim();
    if (!next || userPickedPathRef.current) return;
    setWsPath(next);
    setPathInput(next);
  }, [defaultWorkspace]);

  const loadUploads = useCallback(async (force = false): Promise<string> => {
    if (force && uploadsLoadRef.current) await uploadsLoadRef.current;
    if (!force && uploadsLoadRef.current) return uploadsLoadRef.current;

    const run = (async () => {
      try {
        const res = await fetch('/api/workspace/sync');
        const data = await res.json();
        if (data.ok) {
          const uploadsPath = String(data.uploadsPath || '');
          wsUploadsPathRef.current = uploadsPath;
          setWsUploads(data.uploads || []);
          setWsUploadsPath(uploadsPath);
          setCloudFiles(data.cloudFiles || []);
          setWsLastSync(data.lastSyncAt || null);
          return uploadsPath.trim();
        }
      } catch { /* ignore */ }
      return wsUploadsPathRef.current.trim();
    })();
    uploadsLoadRef.current = run;
    try {
      return await run;
    } finally {
      if (uploadsLoadRef.current === run) uploadsLoadRef.current = null;
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const data = await loadClientJson<{ ok?: boolean; sessions?: ChatSession[] } | ChatSession[]>(
        '/api/chat-sessions',
        { maxAgeMs: 15_000 },
      );
      if (!Array.isArray(data) && data.ok && Array.isArray(data.sessions)) setSessions(data.sessions);
      else if (Array.isArray(data)) setSessions(data);
    } catch { /* ignore */ }
  }, []);

  const loadWorktrees = useCallback(async () => {
    const base = (wsPath || defaultWorkspace || '').trim();
    if (!base) return;
    setWtLoading(true);
    try {
      const res = await fetch(`/api/workspace/worktrees?workspace=${encodeURIComponent(base)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setIsGitRepo(!!data.isGitRepo);
      setWorktrees(data.worktrees || []);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to load worktrees');
    }
    setWtLoading(false);
  }, [wsPath, defaultWorkspace]);

  /** Resolve the global uploads folder path (creates it server-side if needed). */
  const resolveUploadsPath = useCallback(async (): Promise<string> => {
    const cached = wsUploadsPathRef.current.trim();
    if (cached) return cached;
    return loadUploads();
  }, [loadUploads]);

  const loadExplorer = useCallback(async (
    dir?: string,
    opts?: { userInitiated?: boolean },
  ) => {
    if (opts?.userInitiated) userPickedPathRef.current = true;

    explorerAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = ++explorerRequestRef.current;
    explorerAbortRef.current = controller;
    setExplorerLoading(true);
    try {
      // Non-user opens prefer the workspace uploads folder. Resolution may
      // share the already-running uploads request; a superseded navigation
      // stops here before it can issue or commit another directory request.
      let fallback = '';
      if (!opts?.userInitiated && !dir) fallback = await resolveUploadsPath();
      if (controller.signal.aborted || requestId !== explorerRequestRef.current) return;

      const currentPath = wsPathRef.current;
      const currentUploadsPath = wsUploadsPathRef.current;
      const currentDefault = defaultWorkspaceRef.current;
      const p = (
        opts?.userInitiated
          ? (dir ?? currentPath ?? currentDefault ?? '')
          : (dir || fallback || currentUploadsPath || currentDefault || currentPath || '')
      ).trim();
      if (!p) return;

      const res = await fetch(`/api/workspace?dir=${encodeURIComponent(p)}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (controller.signal.aborted || requestId !== explorerRequestRef.current) return;
      setWsFiles(data.files || []);
      if (data.resolved) {
        const resolved = String(data.resolved);
        wsPathRef.current = resolved;
        setWsPath(resolved);
        setPathInput(resolved);
      } else {
        wsPathRef.current = p;
        setWsPath(p);
        setPathInput(p);
      }
    } catch (e: unknown) {
      if (controller.signal.aborted || requestId !== explorerRequestRef.current) return;
      toast.error(e instanceof Error ? e.message : 'Could not open folder');
    } finally {
      if (explorerAbortRef.current === controller) explorerAbortRef.current = null;
      if (requestId === explorerRequestRef.current) setExplorerLoading(false);
    }
  }, [resolveUploadsPath]);

  const enterExplorer = useCallback((
    dir?: string,
    opts?: { userInitiated?: boolean; forceDefault?: boolean },
  ) => {
    if (opts?.forceDefault) userPickedPathRef.current = false;
    else if (opts?.userInitiated) userPickedPathRef.current = true;
    const preserveCurrent = !dir && userPickedPathRef.current && !opts?.forceDefault;
    const target = preserveCurrent
      ? (wsPathRef.current || defaultWorkspaceRef.current).trim() || undefined
      : dir;
    const userInitiated = opts?.userInitiated || preserveCurrent || undefined;
    setExplorerIntent((current) => ({ key: current.key + 1, dir: target, userInitiated }));
    setView('explorer');
  }, []);

  /** Open Explorer on the workspace uploads folder unless the user already navigated elsewhere. */
  const openExplorer = useCallback((opts?: { forceDefault?: boolean }) => {
    enterExplorer(undefined, opts);
  }, [enterExplorer]);

  useEffect(() => {
    void loadUploads();
    void loadSessions();
  }, [loadUploads, loadSessions]);

  useEffect(() => {
    if (view === 'worktrees') void loadWorktrees();
  }, [view, loadWorktrees]);

  // Entering Explorer has one loading owner. The intent and view transition
  // batch into this effect, avoiding the former manual load + enter-view load
  // + uploads-path follow-up load sequence.
  useEffect(() => {
    if (view !== 'explorer') return;
    const timer = window.setTimeout(() => {
      void loadExplorer(explorerIntent.dir, { userInitiated: explorerIntent.userInitiated });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      explorerAbortRef.current?.abort();
    };
  }, [defaultWorkspace, explorerIntent, loadExplorer, view]);

  useEffect(() => () => {
    explorerRequestRef.current += 1;
    fileReadRequestRef.current += 1;
    explorerAbortRef.current?.abort();
    fileReadAbortRef.current?.abort();
  }, []);

  async function deleteUpload(name: string) {
    const ok = await confirmDialog({
      title: `Remove “${name}” from global uploads?`,
      message: 'It will no longer be included in chat context.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/workspace/upload?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast.success(`Removed ${name}`);
      await loadUploads(true);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Remove failed');
    }
  }

  async function uploadFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (!files.length) return;
    setWsUploading(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      const res = await fetch('/api/workspace/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.errors?.length) toast.error(data.errors.join('; '));
      toast.success(`Uploaded ${data.saved?.length || 0} file(s)`);
      await loadUploads(true);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    }
    setWsUploading(false);
  }

  async function syncToCloud() {
    setWsSyncing('upload');
    try {
      const res = await fetch('/api/workspace/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upload' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success(`Synced ${data.uploaded?.length || 0} file(s) to Grok cloud`);
      if (data.errors?.length) toast.error(data.errors.join('; '));
      await loadUploads(true);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    }
    setWsSyncing(null);
  }

  async function syncFromCloud() {
    setWsSyncing('download');
    try {
      const res = await fetch('/api/workspace/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'download' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success(`Downloaded ${data.downloaded?.length || 0} file(s) from Grok cloud`);
      if (data.errors?.length) toast.error(data.errors.join('; '));
      await loadUploads(true);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Download failed');
    }
    setWsSyncing(null);
  }

  /** Open a workspace file in a real browser tab — images and PDFs render,
   *  HTML and code are served as text/plain (never executed against the studio
   *  origin). Served same-origin only. */
  function openFileInNewTab(fpath: string) {
    window.open(`/api/workspace?file=${encodeURIComponent(fpath)}`, '_blank', 'noopener,noreferrer');
  }

  async function openFile(fpath: string, isDir?: boolean) {
    if (isDir) {
      if (fileDirty) {
        const leave = await confirmDialog({
          title: 'Unsaved changes',
          message: 'Discard edits and open this folder?',
          confirmLabel: 'Discard',
          danger: true,
        });
        if (!leave) return;
      }
      fileReadRequestRef.current += 1;
      fileReadAbortRef.current?.abort();
      fileReadAbortRef.current = null;
      setSelectedFile('');
      setFileContent('');
      setFileDirty(false);
      setFileLoading(false);
      setFileBinary(false);
      await loadExplorer(fpath, { userInitiated: true });
      return;
    }

    fileReadAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = ++fileReadRequestRef.current;
    fileReadAbortRef.current = controller;
    setSelectedFile(fpath);
    setFileLoading(true);
    setFileBinary(false);
    setFileDirty(false);
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'read', path: fpath }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (controller.signal.aborted || requestId !== fileReadRequestRef.current) return;
      if (data.binary || data.encoding === 'binary') {
        setFileBinary(true);
        setFileContent('');
      } else {
        setFileContent(typeof data.content === 'string' ? data.content : JSON.stringify(data, null, 2));
      }
    } catch (e: unknown) {
      if (controller.signal.aborted || requestId !== fileReadRequestRef.current) return;
      setFileContent(`// Could not read file\n// ${e instanceof Error ? e.message : 'error'}`);
    } finally {
      if (fileReadAbortRef.current === controller) fileReadAbortRef.current = null;
      if (requestId === fileReadRequestRef.current) setFileLoading(false);
    }
  }

  async function saveFile() {
    if (!selectedFile || fileBinary) return;
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: fileContent }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFileDirty(false);
      toast.success('Saved');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function closeEditor() {
    if (fileDirty) {
      const leave = await confirmDialog({
        title: 'Unsaved changes',
        message: 'Close without saving?',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!leave) return;
    }
    fileReadRequestRef.current += 1;
    fileReadAbortRef.current?.abort();
    fileReadAbortRef.current = null;
    setSelectedFile('');
    setFileContent('');
    setFileDirty(false);
    setFileLoading(false);
    setFileBinary(false);
  }

  async function createWorktree(agentId: string) {
    const base = (wsPath || defaultWorkspace || '').trim();
    try {
      const res = await fetch('/api/workspace/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', workspace: base, agentId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setWorktrees(data.worktrees || []);
      toast.success('Worktree ready');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Create failed');
    }
  }

  async function removeWorktree(agentId: string) {
    const ok = await confirmDialog({
      title: 'Remove worktree?',
      message: 'Deletes the isolated working copy. Committed work in the main repo is kept.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const base = (wsPath || defaultWorkspace || '').trim();
    try {
      const res = await fetch('/api/workspace/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', workspace: base, agentId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setWorktrees(data.worktrees || []);
      toast.success('Worktree removed');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Remove failed');
    }
  }

  const agentById = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  /** Who is using each worktree path (agents, chat sessions, automations). */
  function consumersFor(wt: WorktreeEntry) {
    const agent = agentById.get(wt.agentId);
    const chats = sessions.filter((s) => {
      const d = s.workspaceDir?.trim();
      if (!d) return false;
      const a = d.replace(/\\/g, '/').toLowerCase();
      const b = wt.path.replace(/\\/g, '/').toLowerCase();
      return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
    });
    const schedCount = agent
      ? (agent.schedules?.length
        ? agent.schedules.filter((s) => s.enabled).length
        : agent.schedule?.enabled ? 1 : 0)
      : 0;
    return { agent, chats, schedCount };
  }

  const filteredFiles = useMemo(() => {
    const q = treeFilter.trim().toLowerCase();
    let list = [...wsFiles];
    list.sort((a, b) => {
      if (!!a.isDir !== !!b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));
    return list;
  }, [wsFiles, treeFilter]);

  const crumbs = pathSegments(wsPath);
  const parentPath = parentOf(wsPath);

  const navItems: Array<{ id: WsView; icon: React.ComponentType<{ size?: number }>; label: string; hint: string }> = [
    { id: 'uploads', icon: Upload, label: 'Uploads', hint: 'Global files every chat & agent can read' },
    { id: 'worktrees', icon: GitBranch, label: 'Worktrees', hint: 'Isolated agent sandboxes' },
    { id: 'explorer', icon: FolderOpen, label: 'Explorer', hint: 'Browse any folder on disk' },
  ];

  return (
    <div className="ws-shell page-content">
      <header className="ws-header">
        <div className="min-w-0 flex-1">
          <div className="page-title">Workspace</div>
          <div className="page-subtitle">
            Uploads, worktrees, and files — shared context, agent sandboxes, and a folder explorer.
          </div>
        </div>
        <div className="ws-header-path" title={wsPath || defaultWorkspace || undefined}>
          <HardDrive size={14} className="opacity-50 shrink-0" />
          <span className="font-mono text-xs truncate">
            {wsPath || defaultWorkspace || 'No folder open'}
          </span>
        </div>
      </header>

      <div className="ws-body">
        {/* Activity bar */}
        <nav className="ws-activity" aria-label="Workspace sections">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`ws-activity-btn ${active ? 'ws-activity-btn-active' : ''}`}
                title={item.hint}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  if (item.id === 'explorer') openExplorer();
                  else setView(item.id);
                }}
              >
                <Icon size={20} />
                <span className="ws-activity-label">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Main panel */}
        <div className="ws-main">
          {/* ── UPLOADS ── */}
          {view === 'uploads' && (
            <div className="ws-panel">
              <div className="ws-panel-head">
                <div>
                  <h2 className="ws-panel-title">Global uploads</h2>
                  <p className="ws-panel-sub">
                    Always-on context for every chat and agent run
                    {wsUploadsPath ? (
                      <> · <span className="font-mono text-[11px]">{wsUploadsPath}</span></>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void syncToCloud()}
                    disabled={wsSyncing !== null || !hasCloudAuth}
                    className="grok-btn grok-btn-secondary text-xs"
                    title={!hasCloudAuth ? 'Connect xAI cloud first' : 'Push uploads to Grok cloud'}
                  >
                    <CloudUpload size={14} className={wsSyncing === 'upload' ? 'animate-pulse' : ''} />
                    Sync up
                  </button>
                  <button
                    type="button"
                    onClick={() => void syncFromCloud()}
                    disabled={wsSyncing !== null || !hasCloudAuth}
                    className="grok-btn grok-btn-secondary text-xs"
                  >
                    <CloudDownload size={14} className={wsSyncing === 'download' ? 'animate-pulse' : ''} />
                    Sync down
                  </button>
                  <label className="grok-btn grok-btn-primary text-xs cursor-pointer">
                    <Upload size={14} /> Add files
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
                    />
                  </label>
                </div>
              </div>

              <div
                className={`ws-dropzone ${wsDragging ? 'ws-dropzone-active' : ''} ${wsUploading ? 'opacity-70' : ''}`}
                onDragEnter={(e) => { e.preventDefault(); setWsDragging(true); }}
                onDragOver={(e) => { e.preventDefault(); setWsDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); setWsDragging(false); }}
                onDrop={(e) => {
                  e.preventDefault();
                  setWsDragging(false);
                  if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
                }}
              >
                <Upload size={20} className="opacity-40 mb-1.5" />
                <div className="text-sm">{wsUploading ? 'Uploading…' : 'Drop files here'}</div>
                <div className="text-xs text-dim mt-0.5">PDF, code, markdown, CSV, JSON — up to 48 MB each</div>
                {wsLastSync && (
                  <div className="text-[10px] text-dim mt-2">
                    Last cloud sync: {new Date(wsLastSync).toLocaleString()}
                  </div>
                )}
              </div>

              <div className="ws-panel-scroll">
                <div className="ws-upload-grid">
                  {wsUploads.length === 0 && (
                    <div className="ws-empty col-span-full">
                      No uploads yet — drag files above or use <strong>Add files</strong>.
                    </div>
                  )}
                  {wsUploads.map((u) => (
                    <div key={u.path} className="ws-upload-card">
                      <div className="flex items-start gap-2 min-w-0">
                        <FileText size={16} className="opacity-50 shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-xs font-medium truncate" title={u.name}>{u.name}</div>
                          <div className="text-[10px] text-dim mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                            <span>{formatBytes(u.size || 0)}</span>
                            {u.uploadedAt && <span>{new Date(u.uploadedAt).toLocaleDateString()}</span>}
                            {u.cloud ? (
                              <span className="text-success inline-flex items-center gap-0.5">
                                <Cloud size={10} /> synced
                              </span>
                            ) : (
                              <span>local only</span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="grok-btn grok-btn-ghost text-error p-1 shrink-0"
                          title="Remove"
                          onClick={() => void deleteUpload(u.name)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {cloudFiles.length > 0 && (
                  <div className="text-xs text-dim mt-3">
                    {cloudFiles.length} file(s) also in xAI Grok cloud storage
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── WORKTREES ── */}
          {view === 'worktrees' && (
            <div className="ws-panel">
              <div className="ws-panel-head">
                <div>
                  <h2 className="ws-panel-title">Agent worktrees</h2>
                  <p className="ws-panel-sub">
                    Isolated git copies under <span className="font-mono text-[11px]">.worktrees/</span> — see which agent, chat, or automation is attached
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadWorktrees()}
                  disabled={wtLoading}
                  className="grok-btn grok-btn-secondary text-xs"
                >
                  <RefreshCw size={14} className={wtLoading ? 'animate-spin' : ''} /> Refresh
                </button>
              </div>

              <div className="ws-panel-scroll">
              {!isGitRepo ? (
                <div className="ws-empty">
                  This workspace is not a git repository. Point default workspace at a repo (Settings) or open one in Explorer.
                </div>
              ) : worktrees.length === 0 ? (
                <div className="ws-empty">
                  No worktrees yet. Enable “isolated git worktree” on a local agent and run it, or create one below.
                </div>
              ) : (
                <div className="ws-wt-list">
                  {worktrees.map((wt) => {
                    const { agent, chats, schedCount } = consumersFor(wt);
                    return (
                      <article key={wt.agentId} className={`ws-wt-card ${wt.exists ? '' : 'ws-wt-card-missing'}`}>
                        <div className="ws-wt-card-top">
                          <div className="flex items-center gap-2 min-w-0">
                            <GitBranch size={16} className="opacity-60 shrink-0" />
                            <div className="min-w-0">
                              <div className="font-semibold text-sm truncate">
                                {agent?.name || wt.agentId.slice(0, 10)}
                              </div>
                              <div className="font-mono text-[11px] text-dim truncate" title={wt.path}>
                                {wt.exists ? wt.path : 'Not created on disk'}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {wt.exists && (
                              <button
                                type="button"
                                className="grok-btn grok-btn-ghost text-xs"
                                title="Open in Explorer"
                                onClick={() => enterExplorer(wt.path, { userInitiated: true })}
                              >
                                <FolderOpen size={13} /> Open
                              </button>
                            )}
                            {!wt.exists ? (
                              <button
                                type="button"
                                className="grok-btn grok-btn-secondary text-xs"
                                onClick={() => void createWorktree(wt.agentId)}
                              >
                                Create
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="grok-btn grok-btn-ghost text-xs text-error"
                                onClick={() => void removeWorktree(wt.agentId)}
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="ws-wt-meta">
                          {wt.branch && (
                            <span className="ws-chip">
                              <GitBranch size={11} /> {wt.branch}
                            </span>
                          )}
                          <span className={`ws-chip ${wt.exists ? 'ws-chip-ok' : 'ws-chip-warn'}`}>
                            {wt.exists ? 'On disk' : 'Missing'}
                          </span>
                        </div>

                        <div className="ws-wt-usage">
                          <div className="ws-wt-usage-label">Used by</div>
                          <div className="ws-wt-usage-row">
                            {agent ? (
                              <button
                                type="button"
                                className="ws-usage-pill"
                                onClick={() => onOpenAgent?.(agent.id)}
                                title="Agent"
                              >
                                <Bot size={12} /> {agent.name}
                              </button>
                            ) : (
                              <span className="ws-usage-pill ws-usage-pill-muted">
                                <Bot size={12} /> Unknown agent
                              </span>
                            )}
                            {schedCount > 0 && (
                              <span className="ws-usage-pill" title="Enabled automations on this agent">
                                <CalendarClock size={12} /> {schedCount} automation{schedCount === 1 ? '' : 's'}
                              </span>
                            )}
                            {chats.map((s) => (
                              <span key={s.id} className="ws-usage-pill" title={`Chat session · ${s.title}`}>
                                <MessageSquare size={12} /> {s.title || 'Chat'}
                              </span>
                            ))}
                            {!agent && chats.length === 0 && schedCount === 0 && (
                              <span className="text-[11px] text-dim">No linked agent or chat found</span>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}

              {isGitRepo && agents.filter((a) => a.workspace?.useWorktree).length > 0 && (
                <div className="ws-wt-create mt-4">
                  <div className="text-xs font-medium text-muted mb-2">Create worktree for agent</div>
                  <div className="flex flex-wrap gap-1.5">
                    {agents
                      .filter((a) => a.workspace?.useWorktree)
                      .map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className="grok-btn grok-btn-secondary text-xs"
                          onClick={() => void createWorktree(a.id)}
                        >
                          {a.name}
                        </button>
                      ))}
                  </div>
                </div>
              )}
              </div>
            </div>
          )}

          {/* ── EXPLORER ── */}
          {view === 'explorer' && (
            <div className="ws-explorer">
              <div className="ws-explorer-toolbar">
                <div className="ws-breadcrumb" aria-label="Path">
                  <button
                    type="button"
                    className="ws-crumb-root"
                    title="Browse folders"
                    onClick={() => setShowFolderBrowse(true)}
                  >
                    <FolderOpen size={14} />
                  </button>
                  {crumbs.map((seg, i) => {
                    const isWin = /\\/.test(wsPath) || /^[A-Za-z]:/.test(wsPath);
                    let rebuilt: string;
                    if (isWin) {
                      const drive = crumbs[0];
                      rebuilt = i === 0
                        ? `${drive}\\`
                        : `${drive}\\${crumbs.slice(1, i + 1).join('\\')}`;
                    } else {
                      rebuilt = '/' + crumbs.slice(0, i + 1).join('/');
                    }
                    const isLast = i === crumbs.length - 1;
                    return (
                      <React.Fragment key={`${seg}-${i}`}>
                        <ChevronRight size={12} className="ws-crumb-sep" />
                        <button
                          type="button"
                          className={`ws-crumb ${isLast ? 'ws-crumb-current' : ''}`}
                          disabled={isLast}
                          onClick={() => void loadExplorer(rebuilt, { userInitiated: true })}
                        >
                          {seg}
                        </button>
                      </React.Fragment>
                    );
                  })}
                  {crumbs.length === 0 && (
                    <span className="text-xs text-dim ml-1">No folder open</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    className="grok-btn grok-btn-ghost text-xs p-1.5"
                    disabled={!parentPath}
                    title="Parent folder"
                    onClick={() => parentPath && void loadExplorer(parentPath, { userInitiated: true })}
                  >
                    <ChevronsUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="grok-btn grok-btn-secondary text-xs"
                    onClick={() => setShowFolderBrowse(true)}
                  >
                    Browse…
                  </button>
                  <button
                    type="button"
                    className="grok-btn grok-btn-ghost text-xs p-1.5"
                    title="Refresh"
                    onClick={() => void loadExplorer()}
                  >
                    <RefreshCw size={14} className={explorerLoading ? 'animate-spin' : ''} />
                  </button>
                </div>
              </div>

              <div className={`ws-explorer-split ${selectedFile ? 'ws-explorer-split-open' : ''}`}>
                {/* Sidebar tree */}
                <aside className="ws-tree">
                  <div className="ws-tree-search">
                    <Search size={13} className="opacity-45" />
                    <input
                      className="ws-tree-search-input"
                      placeholder="Filter files…"
                      value={treeFilter}
                      onChange={(e) => setTreeFilter(e.target.value)}
                    />
                  </div>
                  <div className="ws-tree-list">
                    {explorerLoading && (
                      <div className="data-loading-row text-xs p-3">
                        <span className="data-spinner" /> Loading…
                      </div>
                    )}
                    {!explorerLoading && filteredFiles.length === 0 && (
                      <div className="p-3 text-xs text-dim">
                        {wsPath
                          ? (treeFilter ? 'No matches.' : 'Empty folder — use Browse to pick another.')
                          : 'Browse a folder to get started.'}
                      </div>
                    )}
                    {filteredFiles.map((f) => {
                      const Icon = fileIcon(f.name, f.isDir);
                      const active = selectedFile === f.path;
                      return (
                        <button
                          key={f.path}
                          type="button"
                          className={`ws-tree-item ${active ? 'ws-tree-item-active' : ''} ${f.isDir ? 'ws-tree-item-dir' : ''}`}
                          onClick={() => void openFile(f.path, !!f.isDir)}
                          onContextMenu={(e) => {
                            if (f.isDir) return; // folders open in-place, not in a tab
                            e.preventDefault();
                            setFileCtxMenu({ x: e.clientX, y: e.clientY, path: f.path, name: f.name });
                          }}
                          title={f.isDir ? f.path : `${f.path}\nRight-click to open in a new browser tab`}
                        >
                          <Icon size={14} className="shrink-0 opacity-70" />
                          <span className="truncate">{f.name}</span>
                          {f.isDir && <ChevronRight size={12} className="ml-auto opacity-40 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                  <div className="ws-tree-footer font-mono text-[10px] text-dim truncate px-2 py-1.5" title={wsPath}>
                    {wsPath || '—'}
                  </div>
                </aside>

                {/* Editor — only when a file is open */}
                {selectedFile ? (
                  <section className="ws-editor">
                    <div className="ws-editor-tabbar">
                      <div className="ws-editor-tab">
                        <FileCode size={13} className="opacity-60" />
                        <span className="truncate max-w-[14rem]">
                          {selectedFile.split(/[/\\]/).pop()}
                        </span>
                        {fileDirty && <span className="ws-editor-dirty" title="Unsaved">●</span>}
                        <button
                          type="button"
                          className="ws-editor-tab-close"
                          onClick={() => void closeEditor()}
                          title="Close"
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <div className="ml-auto flex items-center gap-1.5">
                        <button
                          type="button"
                          className="grok-btn grok-btn-primary text-xs"
                          disabled={fileBinary || fileLoading || !fileDirty}
                          onClick={() => void saveFile()}
                        >
                          <Save size={13} /> Save
                        </button>
                      </div>
                    </div>
                    <div className="ws-editor-path font-mono" title={selectedFile}>
                      {selectedFile}
                    </div>
                    {fileLoading ? (
                      <div className="data-loading-row flex-1 p-6 text-sm">
                        <span className="data-spinner" /> Opening…
                      </div>
                    ) : fileBinary ? (
                      <div className="ws-empty flex-1 m-4">
                        Binary file — preview is not available. Open it in your system editor.
                      </div>
                    ) : (
                      <textarea
                        className="ws-editor-area"
                        value={fileContent}
                        spellCheck={false}
                        onChange={(e) => {
                          setFileContent(e.target.value);
                          setFileDirty(true);
                        }}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                            e.preventDefault();
                            void saveFile();
                          }
                        }}
                      />
                    )}
                    <div className="ws-editor-statusbar">
                      <span>{fileDirty ? 'Modified' : 'Saved'}</span>
                      <span className="opacity-50">UTF-8</span>
                      <span className="opacity-50">Ctrl+S to save</span>
                    </div>
                  </section>
                ) : (
                  <section className="ws-explorer-welcome">
                    <Folder size={40} className="opacity-25 mb-3" />
                    <div className="text-sm font-medium">No file open</div>
                    <div className="text-xs text-dim mt-1 max-w-xs text-center leading-relaxed">
                      Pick a folder with <strong>Browse…</strong>, then click a file to open the editor.
                      Folders open in place like a normal file tree.
                    </div>
                    <button
                      type="button"
                      className="grok-btn grok-btn-primary text-xs mt-4"
                      onClick={() => setShowFolderBrowse(true)}
                    >
                      <FolderOpen size={14} /> Browse for folder
                    </button>
                    <div className="flex flex-wrap gap-2 mt-4 justify-center">
                      <button
                        type="button"
                        className="grok-btn grok-btn-secondary text-xs"
                        onClick={() => {
                          userPickedPathRef.current = false;
                          void (async () => {
                            const uploads = await resolveUploadsPath();
                            const target = (uploads || defaultWorkspace || wsPath || '').trim();
                            if (target) void loadExplorer(target);
                          })();
                        }}
                      >
                        Open uploads folder
                      </button>
                      {(defaultWorkspace || wsPath) && (
                        <button
                          type="button"
                          className="grok-btn grok-btn-ghost text-xs"
                          onClick={() => {
                            userPickedPathRef.current = true;
                            void loadExplorer(defaultWorkspace || wsPath, { userInitiated: true });
                          }}
                        >
                          Open default workspace
                        </button>
                      )}
                      {worktrees.filter((w) => w.exists).slice(0, 3).map((w) => (
                        <button
                          key={w.agentId}
                          type="button"
                          className="grok-btn grok-btn-ghost text-xs"
                          onClick={() => void loadExplorer(w.path, { userInitiated: true })}
                        >
                          {agentById.get(w.agentId)?.name || 'Worktree'}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showFolderBrowse && (
        <FolderBrowseModal
          open={showFolderBrowse}
          title="Open folder"
          initialPath={wsPath || defaultWorkspace}
          onClose={() => setShowFolderBrowse(false)}
          onSelect={(p) => {
            setShowFolderBrowse(false);
            enterExplorer(p, { userInitiated: true });
          }}
        />
      )}

      {fileCtxMenu && (
        <div
          className="fixed inset-0 z-[90]"
          onClick={() => setFileCtxMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setFileCtxMenu(null); }}
        >
          <div
            className="grok-card p-1 absolute shadow-xl"
            style={{
              top: Math.min(fileCtxMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 60),
              left: Math.min(fileCtxMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 240),
              minWidth: 220,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2 py-1 text-[11px] text-dim truncate max-w-[220px]" title={fileCtxMenu.path}>{fileCtxMenu.name}</div>
            <button
              type="button"
              className="grok-btn grok-btn-ghost text-xs w-full justify-start gap-2"
              onClick={() => { openFileInNewTab(fileCtxMenu.path); setFileCtxMenu(null); }}
            >
              <ExternalLink size={13} /> Open in new browser tab
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
