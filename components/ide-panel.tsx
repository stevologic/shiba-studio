'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Editor, {
  DiffEditor,
  loader,
  type BeforeMount,
  type OnMount,
  type OnValidate,
} from '@monaco-editor/react';
import Link from 'next/link';
import {
  AlertCircle,
  AlertTriangle,
  Braces,
  Check,
  CircleDot,
  Code2,
  Command,
  ExternalLink,
  FileCode2,
  FilePlus2,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommit,
  GitFork,
  GitPullRequest,
  Info,
  Loader2,
  Minus,
  PanelBottom,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { createClientId } from '@/lib/client-id';
import type {
  IdeWorkspaceOption,
  IdeWorkspaceOptionsResponse,
} from '@/lib/ide-workspace-options-types';
import { setTerminalOpen } from '@/lib/terminal-ui-store';
import { FileTree, type IdeFileNode } from '@/components/ide/file-tree';
import { WorkspacePicker } from '@/components/ide/workspace-picker';
import styles from './ide-panel.module.css';

if (typeof window !== 'undefined') {
  loader.config({ paths: { vs: '/api/monaco/vs' } });
}

const IDE_THEME = 'shiba-studio-ide';

type ActivityId = 'explorer' | 'search' | 'source-control' | 'github';
type BottomPanelId = 'problems' | 'output';
type GitDiffArea = 'working' | 'staged';

interface ApiEnvelope {
  ok?: boolean;
  error?: string;
  code?: string;
}

interface FileEntryResponse {
  name: string;
  path: string;
  kind?: 'file' | 'directory';
  type?: 'file' | 'directory';
  isDirectory?: boolean;
  isDir?: boolean;
  children?: FileEntryResponse[];
  entries?: FileEntryResponse[];
  size?: number;
}

interface FilesBootstrapResponse extends ApiEnvelope {
  workspace?: string;
  root?: { path?: string; name?: string };
  entries?: FileEntryResponse[];
  files?: FileEntryResponse[];
  tree?: FileEntryResponse[] | FileEntryResponse;
  truncated?: boolean;
}

interface FileReadResponse extends ApiEnvelope {
  workspace?: string;
  path?: string;
  content?: string;
  size?: number;
  mtimeMs?: number;
  version?: string;
  binary?: boolean;
}

interface FileSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

interface FileSearchResponse extends ApiEnvelope {
  matches?: FileSearchMatch[];
  results?: FileSearchMatch[];
  truncated?: boolean;
}

interface GitStatusEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  renamed: boolean;
}

interface GitBranchEntry {
  name: string;
  current: boolean;
  oid: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  lastCommitAt: string | null;
  subject: string;
}

interface GitCommitEntry {
  oid: string;
  shortOid: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
}

interface GitSnapshot {
  repoRoot: string;
  workspace: string;
  head: {
    oid: string | null;
    branch: string | null;
    detached: boolean;
    unborn: boolean;
  };
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  status: GitStatusEntry[];
  branches: GitBranchEntry[];
  commits: GitCommitEntry[];
  remotes: Array<{ name: string; fetchUrls: string[]; pushUrls: string[] }>;
  github: {
    remote: string;
    host: string;
    owner: string;
    repo: string;
    slug: string;
    webUrl: string;
  } | null;
}

interface GitResponse extends ApiEnvelope {
  snapshot?: GitSnapshot;
  output?: string;
}

interface GitDiffResponse extends ApiEnvelope {
  diff?: {
    path: string;
    area: GitDiffArea;
    patch: string;
    original: { source: string; content: string } | null;
    modified: { source: string; content: string } | null;
    binary: boolean;
    truncated: boolean;
  };
}

interface GitHubPullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  head: string;
  base: string;
  draft: boolean;
  updatedAt: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  author: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
}

interface GitHubWorkflowRun {
  id: number;
  name: string;
  url: string;
  branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  updatedAt: string;
}

interface GitHubSnapshot extends ApiEnvelope {
  workspace?: string;
  configured?: boolean;
  connected?: boolean;
  login?: string;
  repository?: {
    owner: string;
    name: string;
    fullName: string;
    url: string;
    defaultBranch?: string;
    private?: boolean;
    description?: string;
  };
  pullRequests?: GitHubPullRequest[];
  issues?: GitHubIssue[];
  workflowRuns?: GitHubWorkflowRun[];
  actionsError?: string;
}

interface FileEditorTab {
  id: string;
  kind: 'file';
  path: string;
  name: string;
  language: string;
  content: string;
  savedContent: string;
  version?: string;
  loading?: boolean;
  binary?: boolean;
  revealLine?: number;
}

interface DiffEditorTab {
  id: string;
  kind: 'diff';
  path: string;
  name: string;
  language: string;
  area: GitDiffArea;
  original: string | null;
  modified: string | null;
  patch: string;
  binary: boolean;
  truncated: boolean;
  loading?: boolean;
}

type EditorTab = FileEditorTab | DiffEditorTab;

interface ProblemItem {
  id: string;
  path: string;
  message: string;
  severity: number;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
  code?: string | number;
}

interface OutputEntry {
  id: string;
  at: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  message: string;
  detail?: string;
}

interface MutationDialogState {
  type: 'file' | 'directory' | 'rename';
  value: string;
  targetPath?: string;
}

interface WorkspaceRefreshRequest {
  id: number;
  path: string;
}

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  keywords?: string[];
  path?: string;
}

export interface IdePanelProps {
  defaultWorkspace: string;
  className?: string;
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized || 'workspace';
}

function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => value
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  const bothWindowsPaths = (
    (/^[A-Za-z]:\//.test(normalizedLeft) && /^[A-Za-z]:\//.test(normalizedRight))
    || (normalizedLeft.startsWith('//') && normalizedRight.startsWith('//'))
  );
  if (bothWindowsPaths) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function parentPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

function joinRelative(parent: string, name: string): string {
  const left = parent.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const right = name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return left ? `${left}/${right}` : right;
}

function modelUri(workspace: string, relativePath: string, suffix = ''): string {
  const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = joinRelative(root, relativePath);
  const windowsPath = /^[A-Za-z]:\//.test(path) ? `/${path}` : path.startsWith('/') ? path : `/${path}`;
  return `file://${windowsPath}${suffix}`;
}

function languageForPath(path: string): string {
  const name = basename(path).toLowerCase();
  const extension = name.includes('.') ? name.split('.').pop() || '' : '';
  const languages: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    mdx: 'markdown',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    sql: 'sql',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    dockerfile: 'dockerfile',
  };
  if (name === 'dockerfile') return 'dockerfile';
  return languages[extension] || 'plaintext';
}

function titleForLanguage(language: string): string {
  const labels: Record<string, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    json: 'JSON',
    css: 'CSS',
    scss: 'SCSS',
    html: 'HTML',
    markdown: 'Markdown',
    python: 'Python',
    shell: 'Shell',
    powershell: 'PowerShell',
    plaintext: 'Plain Text',
  };
  return labels[language] || language.charAt(0).toUpperCase() + language.slice(1);
}

function normalizeFileNode(entry: FileEntryResponse): IdeFileNode {
  const type = entry.kind === 'directory'
    || entry.type === 'directory'
    || entry.isDirectory
    || entry.isDir
    ? 'directory'
    : 'file';
  const rawChildren = entry.children || entry.entries;
  return {
    name: entry.name || basename(entry.path),
    path: entry.path.replace(/\\/g, '/').replace(/^\/+/, ''),
    type,
    ...(rawChildren ? { children: rawChildren.map(normalizeFileNode), loaded: true } : {}),
    ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
  };
}

function normalizeEntries(response: FilesBootstrapResponse): IdeFileNode[] {
  const tree = response.tree;
  const source = response.entries
    || response.files
    || (Array.isArray(tree) ? tree : tree?.children)
    || [];
  return source.map(normalizeFileNode);
}

function replaceNodeChildren(
  nodes: IdeFileNode[],
  targetPath: string,
  children: IdeFileNode[],
): IdeFileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) return { ...node, children, loaded: true };
    if (!node.children) return node;
    return { ...node, children: replaceNodeChildren(node.children, targetPath, children) };
  });
}

function flattenNodes(nodes: IdeFileNode[]): IdeFileNode[] {
  const output: IdeFileNode[] = [];
  for (const node of nodes) {
    output.push(node);
    if (node.children) output.push(...flattenNodes(node.children));
  }
  return output;
}

function shortStatus(change: GitStatusEntry, area: GitDiffArea): string {
  if (change.conflicted) return '!';
  if (change.untracked) return 'U';
  const status = area === 'staged' ? change.indexStatus : change.workingTreeStatus;
  return status && status !== '.' && status !== ' ' ? status.slice(0, 1) : 'M';
}

function markerTone(severity: number): 'error' | 'warning' | 'info' {
  if (severity >= 8) return 'error';
  if (severity >= 4) return 'warning';
  return 'info';
}

function formatRelativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function requestJson<T extends ApiEnvelope>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function filesUrl(action: 'bootstrap' | 'list' | 'read' | 'search', workspace: string, extra?: Record<string, string>) {
  const params = new URLSearchParams({ action });
  if (workspace.trim()) params.set('workspace', workspace.trim());
  for (const [key, value] of Object.entries(extra || {})) params.set(key, value);
  return `/api/ide/files?${params.toString()}`;
}

const configureMonaco: BeforeMount = (monaco) => {
  monaco.editor.defineTheme(IDE_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '707070', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'C4B5FD' },
      { token: 'string', foreground: '86EFAC' },
      { token: 'number', foreground: 'FDBA74' },
      { token: 'type', foreground: '67E8F9' },
      { token: 'type.identifier', foreground: '67E8F9' },
      { token: 'identifier', foreground: 'E5E5E5' },
      { token: 'delimiter', foreground: 'A3A3A3' },
    ],
    colors: {
      'editor.background': '#000000',
      'editor.foreground': '#F5F5F5',
      'editorLineNumber.foreground': '#555555',
      'editorLineNumber.activeForeground': '#A3A3A3',
      'editorCursor.foreground': '#FFFFFF',
      'editor.selectionBackground': '#FFFFFF2C',
      'editor.inactiveSelectionBackground': '#FFFFFF18',
      'editor.lineHighlightBackground': '#FFFFFF08',
      'editorIndentGuide.background1': '#202020',
      'editorIndentGuide.activeBackground1': '#404040',
      'editorWhitespace.foreground': '#303030',
      'editorGutter.background': '#000000',
      'editorWidget.background': '#111111',
      'editorWidget.border': '#303030',
      'editorSuggestWidget.background': '#111111',
      'editorSuggestWidget.border': '#303030',
      'editorSuggestWidget.selectedBackground': '#262626',
      'input.background': '#0A0A0A',
      'input.border': '#303030',
      'focusBorder': '#767676',
      'scrollbarSlider.background': '#FFFFFF18',
      'scrollbarSlider.hoverBackground': '#FFFFFF28',
      'scrollbarSlider.activeBackground': '#FFFFFF38',
      'diffEditor.insertedTextBackground': '#22C55E18',
      'diffEditor.removedTextBackground': '#EF444418',
      'diffEditor.insertedLineBackground': '#22C55E0C',
      'diffEditor.removedLineBackground': '#EF44440C',
    },
  });
  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
};

export default function IdePanel({ defaultWorkspace, className }: IdePanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const workspaceLoadSequenceRef = useRef(0);
  const workspaceOptionsLoadSequenceRef = useRef(0);
  const workspaceContentSequenceRef = useRef(0);

  const [workspace, setWorkspace] = useState(defaultWorkspace.trim());
  const [workspaceName, setWorkspaceName] = useState(basename(defaultWorkspace));
  const [workspaceOptions, setWorkspaceOptions] = useState<IdeWorkspaceOption[]>([]);
  const [workspaceOptionsLoading, setWorkspaceOptionsLoading] = useState(true);
  const [workspaceRefreshRequest, setWorkspaceRefreshRequest] = useState<WorkspaceRefreshRequest | null>(null);
  const [tree, setTree] = useState<IdeFileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);

  const [activity, setActivity] = useState<ActivityId>('explorer');
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [busyFilePaths, setBusyFilePaths] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [markersByPath, setMarkersByPath] = useState<Record<string, ProblemItem[]>>({});

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FileSearchMatch[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);

  const [git, setGit] = useState<GitSnapshot | null>(null);
  const [gitRefreshRequest, setGitRefreshRequest] = useState(0);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');

  const [github, setGithub] = useState<GitHubSnapshot | null>(null);
  const [githubRefreshRequest, setGithubRefreshRequest] = useState(0);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubSection, setGithubSection] = useState<'pulls' | 'issues' | 'actions'>('pulls');
  const [prComposerOpen, setPrComposerOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prBase, setPrBase] = useState('');
  const [issueComposerOpen, setIssueComposerOpen] = useState(false);
  const [issueTitle, setIssueTitle] = useState('');
  const [issueBody, setIssueBody] = useState('');

  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomPanel, setBottomPanel] = useState<BottomPanelId>('problems');
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const [mutationDialog, setMutationDialog] = useState<MutationDialogState | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'commands' | 'files' | null>(null);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) || null,
    [activeTabId, tabs],
  );
  const activeFileTab = activeTab?.kind === 'file' ? activeTab : null;
  const dirtyTabs = useMemo(
    () => tabs.filter((tab): tab is FileEditorTab => tab.kind === 'file' && tab.content !== tab.savedContent),
    [tabs],
  );
  const allFiles = useMemo(
    () => flattenNodes(tree).filter((node) => node.type === 'file'),
    [tree],
  );
  const problems = useMemo(
    () => Object.values(markersByPath).flat().sort((left, right) => (
      right.severity - left.severity
      || left.path.localeCompare(right.path)
      || left.startLineNumber - right.startLineNumber
    )),
    [markersByPath],
  );

  const addOutput = useCallback((
    tone: OutputEntry['tone'],
    message: string,
    detail?: string,
  ) => {
    const entry: OutputEntry = {
      id: createClientId(),
      at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      tone,
      message,
      detail,
    };
    setOutput((current) => [...current.slice(-149), entry]);
  }, []);

  const loadWorkspaceOptions = useCallback(async () => {
    const sequence = ++workspaceOptionsLoadSequenceRef.current;
    setWorkspaceOptionsLoading(true);
    try {
      const data = await requestJson<IdeWorkspaceOptionsResponse & ApiEnvelope>(
        '/api/ide/workspaces',
      );
      if (sequence !== workspaceOptionsLoadSequenceRef.current) return;
      setWorkspaceOptions(data.options);
    } catch (error) {
      if (sequence !== workspaceOptionsLoadSequenceRef.current) return;
      addOutput(
        'warning',
        'Could not refresh workspace choices',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (sequence === workspaceOptionsLoadSequenceRef.current) {
        setWorkspaceOptionsLoading(false);
      }
    }
  }, [addOutput]);

  const loadBootstrap = useCallback(async (
    workspacePath: string,
    preserveCurrentOnError = false,
  ) => {
    const requestedWorkspace = workspacePath.trim() || defaultWorkspace.trim() || '.';
    const sequence = ++workspaceLoadSequenceRef.current;
    setTreeLoading(true);
    setFatalError(null);
    try {
      const data = await requestJson<FilesBootstrapResponse>(
        filesUrl('bootstrap', requestedWorkspace),
      );
      if (sequence !== workspaceLoadSequenceRef.current) return false;
      const nextWorkspace = data.workspace?.trim() || requestedWorkspace;
      setWorkspace(nextWorkspace);
      setWorkspaceName(data.root?.name || basename(nextWorkspace));
      setTree(normalizeEntries(data));
      setTreeTruncated(Boolean(data.truncated));
      addOutput('success', `Opened ${data.root?.name || basename(nextWorkspace)}`, nextWorkspace);
      return true;
    } catch (error) {
      if (sequence !== workspaceLoadSequenceRef.current) return false;
      const message = error instanceof Error ? error.message : 'Could not open workspace';
      if (!preserveCurrentOnError) setFatalError(message);
      addOutput('error', 'Workspace failed to open', message);
      return false;
    } finally {
      if (sequence === workspaceLoadSequenceRef.current) setTreeLoading(false);
    }
  }, [addOutput, defaultWorkspace]);

  const loadGit = useCallback(() => {
    setGitRefreshRequest((current) => current + 1);
  }, []);

  const loadGitHub = useCallback(() => {
    setGithubRefreshRequest((current) => current + 1);
  }, []);

  const requestWorkspaceRefresh = useCallback(() => {
    setWorkspaceRefreshRequest((current) => ({
      id: (current?.id || 0) + 1,
      path: workspace,
    }));
  }, [workspace]);

  useEffect(() => {
    const scheduledAtWorkspaceSequence = workspaceLoadSequenceRef.current;
    const timer = window.setTimeout(() => {
      // The picker can become interactive before this deferred bootstrap runs.
      // Do not let that stale default request replace a project/worktree the
      // user already selected in the meantime.
      if (workspaceLoadSequenceRef.current === scheduledAtWorkspaceSequence) {
        void loadBootstrap(defaultWorkspace.trim() || '.');
      }
      void loadWorkspaceOptions();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [defaultWorkspace, loadBootstrap, loadWorkspaceOptions]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    const params = new URLSearchParams({ workspace, view: 'snapshot' });
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setGitLoading(true);
      setGitError(null);
      void requestJson<GitResponse>(`/api/ide/git?${params.toString()}`)
        .then((data) => {
          if (!cancelled) setGit(data.snapshot || null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : 'Git is unavailable';
          setGit(null);
          setGitError(message);
        })
        .finally(() => {
          if (!cancelled) setGitLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [gitRefreshRequest, workspace]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    const params = new URLSearchParams({ workspace });
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setGithubLoading(true);
      void requestJson<GitHubSnapshot>(`/api/ide/github?${params.toString()}`)
        .then((data) => {
          if (cancelled) return;
          setGithub(data);
          if (data.repository?.defaultBranch) {
            setPrBase((current) => current || data.repository?.defaultBranch || '');
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setGithub({
            ok: false,
            configured: false,
            connected: false,
            error: error instanceof Error ? error.message : 'GitHub is unavailable',
          });
        })
        .finally(() => {
          if (!cancelled) setGithubLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [githubRefreshRequest, workspace]);

  useEffect(() => {
    if (!workspaceRefreshRequest) return;
    const requestedPath = workspaceRefreshRequest.path;
    void (async () => {
      await Promise.all([
        loadBootstrap(requestedPath),
        loadWorkspaceOptions(),
      ]);
      loadGit();
      loadGitHub();
    })();
  }, [
    loadBootstrap,
    loadGit,
    loadGitHub,
    loadWorkspaceOptions,
    workspaceRefreshRequest,
  ]);

  const switchWorkspace = useCallback(async (option: IdeWorkspaceOption) => {
    if (!option.available || sameWorkspacePath(option.path, workspace)) return;
    if (
      dirtyTabs.length > 0
      && !window.confirm(
        `Open ${option.label} and discard ${dirtyTabs.length} unsaved ${
          dirtyTabs.length === 1 ? 'file' : 'files'
        }?`,
      )
    ) return;

    const opened = await loadBootstrap(option.path, true);
    if (!opened) return;

    workspaceContentSequenceRef.current += 1;
    setExpanded(new Set());
    setLoadingPaths(new Set());
    setSelectedNodePath(null);
    setTabs([]);
    setActiveTabId(null);
    setBusyFilePaths(new Set());
    setCursor({ line: 1, column: 1 });
    setMarkersByPath({});
    setSearchQuery('');
    setSearchResults([]);
    setSearchLoading(false);
    setSearchTruncated(false);
    setGit(null);
    setGitLoading(false);
    setGitError(null);
    setGitBusy(null);
    setCommitMessage('');
    setBranchMenuOpen(false);
    setNewBranchName('');
    setGithub(null);
    setGithubLoading(false);
    setPrComposerOpen(false);
    setPrTitle('');
    setPrBody('');
    setPrBase('');
    setIssueComposerOpen(false);
    setIssueTitle('');
    setIssueBody('');
    setMutationDialog(null);
    setMutationBusy(false);
    setPaletteMode(null);
  }, [dirtyTabs.length, loadBootstrap, workspace]);

  useEffect(() => {
    if (activity !== 'search') return;
    const query = searchQuery.trim();
    if (query.length < 2 || !workspace) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchLoading(true);
      try {
        const data = await requestJson<FileSearchResponse>(
          filesUrl('search', workspace, { q: query, limit: '200' }),
          { signal: controller.signal },
        );
        setSearchResults(data.matches || data.results || []);
        setSearchTruncated(Boolean(data.truncated));
      } catch (error) {
        if (controller.signal.aborted) return;
        addOutput('error', 'Search failed', error instanceof Error ? error.message : String(error));
        setSearchResults([]);
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activity, addOutput, searchQuery, workspace]);

  useEffect(() => {
    if (!paletteMode) return;
    const frame = window.requestAnimationFrame(() => paletteInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [paletteMode]);

  const openFile = useCallback(async (path: string, revealLine?: number) => {
    const workspaceSequence = workspaceContentSequenceRef.current;
    const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const id = `file:${normalizedPath}`;
    const existing = tabs.find((tab) => tab.id === id);
    if (existing) {
      if (typeof revealLine === 'number') {
        setTabs((current) => current.map((tab) => (
          tab.id === id && tab.kind === 'file' ? { ...tab, revealLine } : tab
        )));
      }
      setActiveTabId(id);
      return;
    }

    const placeholder: FileEditorTab = {
      id,
      kind: 'file',
      path: normalizedPath,
      name: basename(normalizedPath),
      language: languageForPath(normalizedPath),
      content: '',
      savedContent: '',
      loading: true,
      revealLine,
    };
    setTabs((current) => [...current, placeholder]);
    setActiveTabId(id);
    setBusyFilePaths((current) => new Set(current).add(normalizedPath));
    try {
      const data = await requestJson<FileReadResponse>(
        filesUrl('read', workspace, { path: normalizedPath }),
      );
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      setTabs((current) => current.map((tab) => (
        tab.id === id && tab.kind === 'file'
          ? {
            ...tab,
            content: data.content || '',
            savedContent: data.content || '',
            version: data.version,
            binary: Boolean(data.binary),
            loading: false,
          }
          : tab
      )));
    } catch (error) {
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      const message = error instanceof Error ? error.message : 'Could not read file';
      setTabs((current) => current.filter((tab) => tab.id !== id));
      setActiveTabId((current) => current === id ? null : current);
      addOutput('error', `Could not open ${basename(normalizedPath)}`, message);
    } finally {
      if (workspaceSequence === workspaceContentSequenceRef.current) {
        setBusyFilePaths((current) => {
          const next = new Set(current);
          next.delete(normalizedPath);
          return next;
        });
      }
    }
  }, [addOutput, tabs, workspace]);

  const saveFile = useCallback(async (tab: FileEditorTab) => {
    if (tab.loading || tab.binary || tab.content === tab.savedContent) return true;
    const workspaceSequence = workspaceContentSequenceRef.current;
    setBusyFilePaths((current) => new Set(current).add(tab.path));
    try {
      const data = await requestJson<FileReadResponse>('/api/ide/files', {
        method: 'POST',
        body: JSON.stringify({
          action: 'save',
          workspace,
          path: tab.path,
          content: tab.content,
          ...(tab.version ? { expectedVersion: tab.version } : {}),
        }),
      });
      if (workspaceSequence !== workspaceContentSequenceRef.current) return false;
      setTabs((current) => current.map((candidate) => (
        candidate.id === tab.id && candidate.kind === 'file'
          ? {
            ...candidate,
            // The editor can keep changing while the request is in flight.
            // Only mark the exact bytes sent to disk as saved.
            savedContent: tab.content,
            version: data.version || candidate.version,
          }
          : candidate
      )));
      addOutput('success', `Saved ${tab.name}`, tab.path);
      void loadGit();
      return true;
    } catch (error) {
      if (workspaceSequence !== workspaceContentSequenceRef.current) return false;
      const message = error instanceof Error ? error.message : 'Save failed';
      addOutput('error', `Could not save ${tab.name}`, message);
      setBottomPanel('output');
      setBottomOpen(true);
      return false;
    } finally {
      if (workspaceSequence === workspaceContentSequenceRef.current) {
        setBusyFilePaths((current) => {
          const next = new Set(current);
          next.delete(tab.path);
          return next;
        });
      }
    }
  }, [addOutput, loadGit, workspace]);

  const saveAll = useCallback(async () => {
    const files = tabs.filter(
      (tab): tab is FileEditorTab => tab.kind === 'file' && tab.content !== tab.savedContent,
    );
    for (const tab of files) await saveFile(tab);
  }, [saveFile, tabs]);

  const closeTab = useCallback((id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const target = tabs[index];
    if (
      target.kind === 'file'
      && target.content !== target.savedContent
      && !window.confirm(`Close ${target.name} without saving?`)
    ) return;
    const nextTabs = tabs.filter((tab) => tab.id !== id);
    setTabs(nextTabs);
    setActiveTabId((active) => {
      if (active !== id) return active;
      return nextTabs[Math.min(index, nextTabs.length - 1)]?.id || null;
    });
    if (target.kind === 'file') {
      setMarkersByPath((currentMarkers) => {
        const next = { ...currentMarkers };
        delete next[target.path];
        return next;
      });
    }
  }, [tabs]);

  const toggleDirectory = useCallback(async (node: IdeFileNode) => {
    const workspaceSequence = workspaceContentSequenceRef.current;
    if (node.type !== 'directory') return;
    if (expanded.has(node.path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(node.path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(node.path));
    if (node.loaded) return;
    setLoadingPaths((current) => new Set(current).add(node.path));
    try {
      const data = await requestJson<FilesBootstrapResponse>(
        filesUrl('list', workspace, { path: node.path }),
      );
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      setTree((current) => replaceNodeChildren(current, node.path, normalizeEntries(data)));
    } catch (error) {
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      addOutput('error', `Could not open ${node.name}`, error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceSequence === workspaceContentSequenceRef.current) {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(node.path);
          return next;
        });
      }
    }
  }, [addOutput, expanded, workspace]);

  const selectedNode = useMemo(
    () => flattenNodes(tree).find((node) => node.path === selectedNodePath) || null,
    [selectedNodePath, tree],
  );

  const mutationParent = selectedNode?.type === 'directory'
    ? selectedNode.path
    : selectedNode
      ? parentPath(selectedNode.path)
      : '';

  const runFileMutation = useCallback(async () => {
    if (!mutationDialog || !workspace) return;
    const value = mutationDialog.value.trim();
    if (!value) return;
    const workspaceSequence = workspaceContentSequenceRef.current;
    setMutationBusy(true);
    try {
      if (mutationDialog.type === 'rename' && mutationDialog.targetPath) {
        const oldPath = mutationDialog.targetPath;
        const nextPath = joinRelative(parentPath(oldPath), value);
        await requestJson<ApiEnvelope>('/api/ide/files', {
          method: 'POST',
          body: JSON.stringify({
            action: 'rename',
            workspace,
            path: oldPath,
            newPath: nextPath,
          }),
        });
        if (workspaceSequence !== workspaceContentSequenceRef.current) return;
        setTabs((current) => current.map((tab) => {
          if (tab.kind !== 'file') return tab;
          if (tab.path !== oldPath && !tab.path.startsWith(`${oldPath}/`)) return tab;
          const renamedPath = `${nextPath}${tab.path.slice(oldPath.length)}`;
          return {
            ...tab,
            id: `file:${renamedPath}`,
            path: renamedPath,
            name: basename(renamedPath),
            language: languageForPath(renamedPath),
          };
        }));
        setActiveTabId((current) => (
          current === `file:${oldPath}` || current?.startsWith(`file:${oldPath}/`)
            ? `file:${nextPath}${current.slice(`file:${oldPath}`.length)}`
            : current
        ));
        addOutput('success', `Renamed ${basename(oldPath)}`, nextPath);
      } else {
        const nextPath = joinRelative(mutationParent, value);
        await requestJson<ApiEnvelope>('/api/ide/files', {
          method: 'POST',
          body: JSON.stringify({
            action: 'create',
            workspace,
            path: nextPath,
            kind: mutationDialog.type === 'directory' ? 'directory' : 'file',
            ...(mutationDialog.type === 'file' ? { content: '' } : {}),
          }),
        });
        if (workspaceSequence !== workspaceContentSequenceRef.current) return;
        addOutput('success', `Created ${value}`, nextPath);
        if (mutationDialog.type === 'file') void openFile(nextPath);
      }
      setMutationDialog(null);
      await loadBootstrap(workspace);
      void loadGit();
    } catch (error) {
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      addOutput('error', 'File operation failed', error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceSequence === workspaceContentSequenceRef.current) {
        setMutationBusy(false);
      }
    }
  }, [
    addOutput,
    loadBootstrap,
    loadGit,
    mutationDialog,
    mutationParent,
    openFile,
    workspace,
  ]);

  const deleteSelected = useCallback(async () => {
    if (!selectedNode || !workspace) return;
    const message = selectedNode.type === 'directory'
      ? `Delete ${selectedNode.name} and everything inside it?`
      : `Delete ${selectedNode.name}?`;
    if (!window.confirm(message)) return;
    const workspaceSequence = workspaceContentSequenceRef.current;
    setMutationBusy(true);
    try {
      await requestJson<ApiEnvelope>('/api/ide/files', {
        method: 'POST',
        body: JSON.stringify({
          action: 'delete',
          workspace,
          path: selectedNode.path,
          ...(selectedNode.type === 'directory' ? { recursive: true } : {}),
        }),
      });
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      setTabs((current) => current.filter((tab) => (
        tab.kind !== 'file'
        || (tab.path !== selectedNode.path && !tab.path.startsWith(`${selectedNode.path}/`))
      )));
      setActiveTabId((current) => {
        const deleted = tabs.find((tab) => tab.id === current);
        if (
          deleted?.kind === 'file'
          && (deleted.path === selectedNode.path || deleted.path.startsWith(`${selectedNode.path}/`))
        ) return null;
        return current;
      });
      setSelectedNodePath(null);
      addOutput('success', `Deleted ${selectedNode.name}`, selectedNode.path);
      await loadBootstrap(workspace);
      void loadGit();
    } catch (error) {
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      addOutput('error', `Could not delete ${selectedNode.name}`, error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceSequence === workspaceContentSequenceRef.current) {
        setMutationBusy(false);
      }
    }
  }, [addOutput, loadBootstrap, loadGit, selectedNode, tabs, workspace]);

  const reloadCleanEditorFiles = useCallback(async () => {
    const workspaceSequence = workspaceContentSequenceRef.current;
    const cleanFiles = tabs.filter(
      (tab): tab is FileEditorTab => (
        tab.kind === 'file'
        && !tab.loading
        && !tab.binary
        && tab.content === tab.savedContent
      ),
    );
    if (!cleanFiles.length) return;

    const refreshed = await Promise.all(cleanFiles.map(async (tab) => {
      try {
        const data = await requestJson<FileReadResponse>(
          filesUrl('read', workspace, { path: tab.path }),
        );
        return { tab, data };
      } catch {
        return null;
      }
    }));
    const byId = new Map(
      refreshed
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .map((item) => [item.tab.id, item.data]),
    );
    if (workspaceSequence !== workspaceContentSequenceRef.current) return;
    setTabs((current) => current.map((candidate) => {
      if (candidate.kind !== 'file' || candidate.content !== candidate.savedContent) return candidate;
      const data = byId.get(candidate.id);
      if (!data) return candidate;
      return {
        ...candidate,
        content: data.content || '',
        savedContent: data.content || '',
        version: data.version || candidate.version,
      };
    }));
  }, [tabs, workspace]);

  const runGitAction = useCallback(async (
    action: 'stage' | 'unstage' | 'discard' | 'commit' | 'pull' | 'push' | 'fetch' | 'checkout' | 'createBranch',
    values?: Record<string, unknown>,
  ) => {
    if (!workspace) return false;
    if (action === 'discard' && !window.confirm('Discard the selected working-tree changes?')) return false;
    const workspaceSequence = workspaceContentSequenceRef.current;
    setGitBusy(action);
    try {
      const data = await requestJson<GitResponse>('/api/ide/git', {
        method: 'POST',
        body: JSON.stringify({ workspace, action, ...(values || {}) }),
      });
      if (workspaceSequence !== workspaceContentSequenceRef.current) return false;
      if (data.snapshot) setGit(data.snapshot);
      const staleDiffIds = new Set(
        tabs.filter((tab) => tab.kind === 'diff').map((tab) => tab.id),
      );
      if (staleDiffIds.size) {
        const remainingTabs = tabs.filter((tab) => tab.kind !== 'diff');
        setTabs((current) => current.filter((tab) => tab.kind !== 'diff'));
        setActiveTabId((current) => (
          current && staleDiffIds.has(current)
            ? remainingTabs.at(-1)?.id || null
            : current
        ));
      }
      if (action === 'commit') setCommitMessage('');
      if (action === 'checkout' || action === 'createBranch') setBranchMenuOpen(false);
      addOutput('success', `Git ${action} completed`, data.output);
      if (
        action === 'discard'
        || action === 'pull'
        || action === 'checkout'
        || action === 'createBranch'
      ) {
        await loadBootstrap(workspace);
        await reloadCleanEditorFiles();
      }
      if (action === 'push' || action === 'pull' || action === 'fetch' || action === 'commit') {
        void loadGitHub();
      }
      return true;
    } catch (error) {
      if (workspaceSequence !== workspaceContentSequenceRef.current) return false;
      const message = error instanceof Error ? error.message : `Git ${action} failed`;
      addOutput('error', `Git ${action} failed`, message);
      setGitError(message);
      setBottomPanel('output');
      setBottomOpen(true);
      return false;
    } finally {
      if (workspaceSequence === workspaceContentSequenceRef.current) {
        setGitBusy(null);
      }
    }
  }, [addOutput, loadBootstrap, loadGitHub, reloadCleanEditorFiles, tabs, workspace]);

  const openDiff = useCallback(async (change: GitStatusEntry, area: GitDiffArea) => {
    const workspaceSequence = workspaceContentSequenceRef.current;
    const id = `diff:${area}:${change.path}`;
    const existing = tabs.find((tab) => tab.id === id);
    if (existing) {
      setActiveTabId(id);
      return;
    }
    const placeholder: DiffEditorTab = {
      id,
      kind: 'diff',
      path: change.path,
      name: `${basename(change.path)} (${area === 'staged' ? 'staged' : 'working'})`,
      language: languageForPath(change.path),
      area,
      original: null,
      modified: null,
      patch: '',
      binary: false,
      truncated: false,
      loading: true,
    };
    setTabs((current) => [...current, placeholder]);
    setActiveTabId(id);
    const params = new URLSearchParams({
      workspace,
      view: 'diff',
      path: change.path,
      area,
    });
    try {
      const data = await requestJson<GitDiffResponse>(`/api/ide/git?${params.toString()}`);
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      setTabs((current) => current.map((tab) => (
        tab.id === id && tab.kind === 'diff'
          ? {
            ...tab,
            original: data.diff?.original?.content ?? null,
            modified: data.diff?.modified?.content ?? null,
            patch: data.diff?.patch || '',
            binary: Boolean(data.diff?.binary),
            truncated: Boolean(data.diff?.truncated),
            loading: false,
          }
          : tab
      )));
    } catch (error) {
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      setTabs((current) => current.filter((tab) => tab.id !== id));
      setActiveTabId((current) => current === id ? null : current);
      addOutput('error', `Could not open diff for ${change.path}`, error instanceof Error ? error.message : String(error));
    }
  }, [addOutput, tabs, workspace]);

  const createPullRequest = useCallback(async () => {
    const title = prTitle.trim();
    if (!title || !workspace) return;
    const workspaceSequence = workspaceContentSequenceRef.current;
    setGithubLoading(true);
    try {
      const data = await requestJson<ApiEnvelope & { result?: { number: number; url: string } }>(
        '/api/ide/github',
        {
          method: 'POST',
          body: JSON.stringify({
            action: 'create-pr',
            workspace,
            title,
            ...(prBody.trim() ? { body: prBody.trim() } : {}),
            ...(prBase.trim() ? { base: prBase.trim() } : {}),
          }),
        },
      );
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      addOutput(
        'success',
        data.result ? `Opened pull request #${data.result.number}` : 'Opened pull request',
        data.result?.url,
      );
      setPrTitle('');
      setPrBody('');
      setPrComposerOpen(false);
      await Promise.all([loadGit(), loadGitHub()]);
    } catch (error) {
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      addOutput('error', 'Could not create pull request', error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceSequence === workspaceContentSequenceRef.current) {
        setGithubLoading(false);
      }
    }
  }, [addOutput, loadGit, loadGitHub, prBase, prBody, prTitle, workspace]);

  const createIssue = useCallback(async () => {
    const title = issueTitle.trim();
    if (!title || !workspace) return;
    const workspaceSequence = workspaceContentSequenceRef.current;
    setGithubLoading(true);
    try {
      const data = await requestJson<ApiEnvelope & { result?: { number: number; url: string } }>(
        '/api/ide/github',
        {
          method: 'POST',
          body: JSON.stringify({
            action: 'create-issue',
            workspace,
            title,
            ...(issueBody.trim() ? { body: issueBody.trim() } : {}),
          }),
        },
      );
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      addOutput(
        'success',
        data.result ? `Opened issue #${data.result.number}` : 'Opened issue',
        data.result?.url,
      );
      setIssueTitle('');
      setIssueBody('');
      setIssueComposerOpen(false);
      await loadGitHub();
    } catch (error) {
      if (workspaceSequence !== workspaceContentSequenceRef.current) return;
      addOutput('error', 'Could not create issue', error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceSequence === workspaceContentSequenceRef.current) {
        setGithubLoading(false);
      }
    }
  }, [addOutput, issueBody, issueTitle, loadGitHub, workspace]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editor.focus();
    const disposable = editor.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column });
    });
    editor.onDidDispose(() => disposable.dispose());
  }, []);

  const handleValidate: OnValidate = useCallback((editorMarkers) => {
    const tab = tabs.find((candidate) => candidate.id === activeTabId);
    if (!tab || tab.kind !== 'file') return;
    const next = editorMarkers.map((marker, index): ProblemItem => ({
      id: `${tab.path}:${marker.startLineNumber}:${marker.startColumn}:${index}`,
      path: tab.path,
      message: marker.message,
      severity: marker.severity,
      startLineNumber: marker.startLineNumber,
      startColumn: marker.startColumn,
      endLineNumber: marker.endLineNumber,
      endColumn: marker.endColumn,
      source: marker.source,
      code: typeof marker.code === 'object' ? marker.code.value : marker.code,
    }));
    setMarkersByPath((current) => ({ ...current, [tab.path]: next }));
  }, [activeTabId, tabs]);

  const openPalette = useCallback((mode: 'commands' | 'files') => {
    setPaletteMode(mode);
    setPaletteQuery('');
    setPaletteIndex(0);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (event.shiftKey) void saveAll();
        else if (activeFileTab) void saveFile(activeFileTab);
      } else if (command && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        openPalette(event.shiftKey ? 'commands' : 'files');
      } else if (command && event.key.toLowerCase() === 'w' && activeTabId) {
        event.preventDefault();
        closeTab(activeTabId);
      } else if (command && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setBottomOpen((value) => !value);
      } else if (command && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setActivity('explorer');
      } else if (command && event.shiftKey && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        setActivity('source-control');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeFileTab, activeTabId, closeTab, openPalette, saveAll, saveFile]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyTabs.length === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirtyTabs.length]);

  const runCommand = useCallback((id: string) => {
    switch (id) {
      case 'save':
        if (activeFileTab) void saveFile(activeFileTab);
        break;
      case 'save-all':
        void saveAll();
        break;
      case 'quick-open':
        openPalette('files');
        break;
      case 'new-file':
        setMutationDialog({ type: 'file', value: '' });
        break;
      case 'new-folder':
        setMutationDialog({ type: 'directory', value: '' });
        break;
      case 'explorer':
        setActivity('explorer');
        break;
      case 'source-control':
        setActivity('source-control');
        break;
      case 'github':
        setActivity('github');
        break;
      case 'toggle-panel':
        setBottomOpen((value) => !value);
        break;
      case 'terminal':
        setTerminalOpen(true);
        break;
      case 'refresh':
        requestWorkspaceRefresh();
        break;
      case 'git-pull':
        void runGitAction('pull');
        break;
      case 'git-push':
        void runGitAction('push');
        break;
      case 'git-fetch':
        void runGitAction('fetch');
        break;
      default:
        break;
    }
  }, [
    activeFileTab,
    openPalette,
    requestWorkspaceRefresh,
    runGitAction,
    saveAll,
    saveFile,
  ]);

  const commands: CommandItem[] = [
    {
      id: 'save',
      label: 'File: Save',
      hint: 'Ctrl+S',
      keywords: ['write', 'file'],
    },
    {
      id: 'save-all',
      label: 'File: Save All',
      hint: 'Ctrl+Shift+S',
      keywords: ['write', 'files'],
    },
    {
      id: 'quick-open',
      label: 'File: Quick Open',
      hint: 'Ctrl+P',
      keywords: ['find', 'file'],
    },
    {
      id: 'new-file',
      label: 'File: New File',
      keywords: ['create'],
    },
    {
      id: 'new-folder',
      label: 'File: New Folder',
      keywords: ['create', 'directory'],
    },
    {
      id: 'explorer',
      label: 'View: Show Explorer',
      hint: 'Ctrl+Shift+E',
    },
    {
      id: 'source-control',
      label: 'View: Show Source Control',
      hint: 'Ctrl+Shift+G',
    },
    {
      id: 'github',
      label: 'View: Show GitHub',
    },
    {
      id: 'toggle-panel',
      label: 'View: Toggle Bottom Panel',
      hint: 'Ctrl+J',
    },
    {
      id: 'terminal',
      label: 'Terminal: Open Host Terminal',
      hint: 'Ctrl+`',
      keywords: ['shell', 'pty'],
    },
    {
      id: 'refresh',
      label: 'Developer: Refresh Workspace',
      keywords: ['reload', 'files', 'git'],
    },
    {
      id: 'git-pull',
      label: 'Git: Pull',
    },
    {
      id: 'git-push',
      label: 'Git: Push',
    },
    {
      id: 'git-fetch',
      label: 'Git: Fetch',
    },
  ];

  const normalizedPaletteQuery = paletteQuery.trim().toLowerCase();
  let paletteEntries: CommandItem[];
  if (paletteMode === 'files') {
    paletteEntries = allFiles
      .filter((file) => (
        !normalizedPaletteQuery
        || file.path.toLowerCase().includes(normalizedPaletteQuery)
      ))
      .slice(0, 100)
      .map((file) => ({
        id: `palette-file:${file.path}`,
        label: file.name,
        hint: parentPath(file.path),
        path: file.path,
      }));
  } else if (!normalizedPaletteQuery) {
    paletteEntries = commands;
  } else {
    paletteEntries = commands.filter((command) => (
      [command.label, command.hint, ...(command.keywords || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalizedPaletteQuery)
    ));
  }

  const runPaletteEntry = useCallback((entry: CommandItem) => {
    setPaletteMode(null);
    if (entry.path) {
      void openFile(entry.path);
      return;
    }
    runCommand(entry.id);
  }, [openFile, runCommand]);

  const stagedChanges = useMemo(
    () => git?.status.filter((change) => change.staged) || [],
    [git],
  );
  const workingChanges = useMemo(
    () => git?.status.filter((change) => change.unstaged) || [],
    [git],
  );

  const renderChange = (change: GitStatusEntry, area: GitDiffArea) => {
    const code = shortStatus(change, area);
    return (
      <div className={styles.changeRow} key={`${area}:${change.path}`}>
        <button
          type="button"
          className={styles.changeOpen}
          onClick={() => void openDiff(change, area)}
          title={`Open ${area} diff for ${change.path}`}
        >
          <span
            className={`${styles.changeStatus} ${
              code === '!' ? styles.statusConflict : styles[`status${code}` as keyof typeof styles] || ''
            }`}
          >
            {code}
          </span>
          <span className={styles.changePath}>
            <span>{basename(change.path)}</span>
            <small>{parentPath(change.path)}</small>
          </span>
        </button>
        <button
          type="button"
          className={styles.iconButton}
          title={area === 'staged' ? `Unstage ${change.path}` : `Stage ${change.path}`}
          aria-label={area === 'staged' ? `Unstage ${change.path}` : `Stage ${change.path}`}
          disabled={Boolean(gitBusy) || (change.conflicted && area === 'staged')}
          onClick={() => void runGitAction(area === 'staged' ? 'unstage' : 'stage', { paths: [change.path] })}
        >
          {area === 'staged' ? <Minus size={13} /> : <Plus size={13} />}
        </button>
        {area === 'working' && (
          <button
            type="button"
            className={styles.iconButton}
            title={`Discard changes to ${change.path}`}
            aria-label={`Discard changes to ${change.path}`}
            disabled={Boolean(gitBusy) || change.conflicted}
            onClick={() => void runGitAction('discard', { paths: [change.path] })}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
    );
  };

  const activityItems: Array<{ id: ActivityId; label: string; icon: React.ComponentType<{ size?: number }> }> = [
    { id: 'explorer', label: 'Explorer', icon: Files },
    { id: 'search', label: 'Search', icon: Search },
    { id: 'source-control', label: 'Source Control', icon: GitBranch },
    { id: 'github', label: 'GitHub', icon: GitFork },
  ];

  return (
    <div
      ref={rootRef}
      className={[styles.ide, className || ''].filter(Boolean).join(' ')}
      aria-label="Code workspace"
    >
      <nav className={styles.activityRail} aria-label="Code workspace tools">
        <div className={styles.activityRailMain}>
          {activityItems.map((item) => {
            const Icon = item.icon;
            const active = activity === item.id;
            const badge = item.id === 'source-control'
              ? git?.status.length
              : item.id === 'github'
                ? (github?.pullRequests?.length || 0) + (github?.issues?.length || 0)
                : undefined;
            return (
              <button
                key={item.id}
                type="button"
                className={`${styles.activityButton} ${active ? styles.activityButtonActive : ''}`}
                onClick={() => setActivity(item.id)}
                title={item.label}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={21} />
                {badge ? <span className={styles.activityBadge}>{badge > 99 ? '99+' : badge}</span> : null}
              </button>
            );
          })}
        </div>
        <div className={styles.activityRailBottom}>
          <button
            type="button"
            className={styles.activityButton}
            onClick={() => openPalette('commands')}
            title="Command palette (Ctrl+Shift+P)"
            aria-label="Open command palette"
          >
            <Command size={20} />
          </button>
          <button
            type="button"
            className={styles.activityButton}
            onClick={() => setTerminalOpen(true)}
            title="Open host terminal (Ctrl+`)"
            aria-label="Open host terminal"
          >
            <Terminal size={20} />
          </button>
        </div>
      </nav>

      <aside className={styles.sidePane} aria-label={`${activityItems.find((item) => item.id === activity)?.label} panel`}>
        {activity === 'explorer' && (
          <>
            <div className={styles.sideHeader}>
              <div className={styles.sideHeading}>
                <span>Explorer</span>
                <small title={workspace}>{workspaceName || 'Workspace'}</small>
              </div>
              <div className={styles.sideHeaderActions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="New file"
                  aria-label="New file"
                  onClick={() => setMutationDialog({ type: 'file', value: '' })}
                >
                  <FilePlus2 size={14} />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="New folder"
                  aria-label="New folder"
                  onClick={() => setMutationDialog({ type: 'directory', value: '' })}
                >
                  <FolderPlus size={14} />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="Refresh Explorer"
                  aria-label="Refresh Explorer"
                  disabled={treeLoading}
                  onClick={requestWorkspaceRefresh}
                >
                  <RefreshCw size={14} className={treeLoading ? styles.spin : ''} />
                </button>
              </div>
            </div>

            {tabs.length > 0 && (
              <section className={styles.openEditors}>
                <div className={styles.sectionHeading}>
                  <span>Open editors</span>
                  <span>{tabs.length}</span>
                </div>
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`${styles.openEditorRow} ${tab.id === activeTabId ? styles.openEditorRowActive : ''}`}
                    onClick={() => setActiveTabId(tab.id)}
                    title={tab.path}
                  >
                    <FileCode2 size={13} aria-hidden />
                    <span>{tab.name}</span>
                    {tab.kind === 'file' && tab.content !== tab.savedContent && (
                      <span className={styles.dirtyDot} title="Unsaved changes" aria-label="Unsaved changes" />
                    )}
                    <span
                      role="button"
                      tabIndex={0}
                      className={styles.inlineClose}
                      aria-label={`Close ${tab.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') closeTab(tab.id);
                      }}
                    >
                      <X size={11} />
                    </span>
                  </button>
                ))}
              </section>
            )}

            <div className={styles.explorerToolbar}>
              <WorkspacePicker
                currentPath={workspace}
                currentLabel={workspaceName || 'Workspace'}
                options={workspaceOptions}
                loading={
                  workspaceOptionsLoading
                  || treeLoading
                  || Boolean(gitBusy)
                  || mutationBusy
                  || busyFilePaths.size > 0
                  || loadingPaths.size > 0
                  || tabs.some((tab) => tab.loading)
                }
                onSelect={(option) => void switchWorkspace(option)}
              />
              <div className={styles.selectionActions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="Rename selected item"
                  aria-label="Rename selected item"
                  disabled={!selectedNode}
                  onClick={() => selectedNode && setMutationDialog({
                    type: 'rename',
                    value: selectedNode.name,
                    targetPath: selectedNode.path,
                  })}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="Delete selected item"
                  aria-label="Delete selected item"
                  disabled={!selectedNode}
                  onClick={() => void deleteSelected()}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <div className={styles.sideScroll}>
              {treeLoading && tree.length === 0 ? (
                <div className={styles.loadingState}><Loader2 size={15} className={styles.spin} /> Loading files…</div>
              ) : fatalError ? (
                <div className={styles.emptyState}>
                  <AlertCircle size={22} />
                  <strong>Workspace unavailable</strong>
                  <span>{fatalError}</span>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void loadBootstrap(workspace || defaultWorkspace || '.')}
                  >
                    Try again
                  </button>
                </div>
              ) : tree.length === 0 ? (
                <div className={styles.emptyState}>
                  <FolderOpen size={24} />
                  <strong>Empty workspace</strong>
                  <span>Create a file to start coding.</span>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => setMutationDialog({ type: 'file', value: '' })}
                  >
                    New file
                  </button>
                </div>
              ) : (
                <FileTree
                  nodes={tree}
                  expanded={expanded}
                  selectedPath={selectedNodePath}
                  activePath={activeFileTab?.path || null}
                  loadingPaths={loadingPaths}
                  onToggle={(node) => void toggleDirectory(node)}
                  onOpen={(node) => void openFile(node.path)}
                  onSelect={(node) => setSelectedNodePath(node.path)}
                />
              )}
              {treeTruncated && (
                <div className={styles.notice}><AlertTriangle size={13} /> Some entries are hidden by workspace limits.</div>
              )}
            </div>
          </>
        )}

        {activity === 'search' && (
          <>
            <div className={styles.sideHeader}>
              <div className={styles.sideHeading}><span>Search</span><small>Workspace content</small></div>
            </div>
            <label className={styles.searchBox}>
              <Search size={14} aria-hidden />
              <input
                value={searchQuery}
                onChange={(event) => {
                  const value = event.target.value;
                  setSearchQuery(value);
                  if (value.trim().length < 2) {
                    setSearchResults([]);
                    setSearchTruncated(false);
                    setSearchLoading(false);
                  }
                }}
                placeholder="Search files"
                aria-label="Search workspace files"
                autoFocus
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSearchResults([]);
                    setSearchTruncated(false);
                    setSearchLoading(false);
                  }}
                  aria-label="Clear search"
                >
                  <X size={12} />
                </button>
              )}
            </label>
            <div className={styles.sideScroll}>
              {searchLoading ? (
                <div className={styles.loadingState}><Loader2 size={15} className={styles.spin} /> Searching…</div>
              ) : searchQuery.trim().length < 2 ? (
                <div className={styles.emptyStateCompact}>Type at least two characters to search file contents.</div>
              ) : searchResults.length === 0 ? (
                <div className={styles.emptyStateCompact}>No results for “{searchQuery.trim()}”.</div>
              ) : (
                <div className={styles.searchResults}>
                  {searchResults.map((match, index) => (
                    <button
                      key={`${match.path}:${match.line}:${match.column}:${index}`}
                      type="button"
                      className={styles.searchResult}
                      onClick={() => void openFile(match.path, match.line)}
                    >
                      <span className={styles.searchResultPath}>
                        <FileCode2 size={12} />
                        {match.path}
                        <small>{match.line}:{match.column}</small>
                      </span>
                      <code>{match.text}</code>
                    </button>
                  ))}
                  {searchTruncated && <div className={styles.notice}>Results truncated. Refine your search.</div>}
                </div>
              )}
            </div>
          </>
        )}

        {activity === 'source-control' && (
          <>
            <div className={styles.sideHeader}>
              <div className={styles.sideHeading}>
                <span>Source Control</span>
                <small>{git?.head.branch || (git?.head.detached ? 'Detached HEAD' : 'Git')}</small>
              </div>
              <div className={styles.sideHeaderActions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="Fetch"
                  aria-label="Fetch"
                  disabled={Boolean(gitBusy) || !git}
                  onClick={() => void runGitAction('fetch')}
                >
                  <RefreshCw size={14} className={gitBusy === 'fetch' ? styles.spin : ''} />
                </button>
              </div>
            </div>
            <div className={styles.commitBox}>
              <textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Message (Ctrl+Enter to commit)"
                aria-label="Commit message"
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    if (commitMessage.trim() && stagedChanges.length) {
                      void runGitAction('commit', { message: commitMessage.trim() });
                    }
                  }
                }}
              />
              <button
                type="button"
                className={styles.primaryButton}
                disabled={!commitMessage.trim() || stagedChanges.length === 0 || Boolean(gitBusy)}
                onClick={() => void runGitAction('commit', { message: commitMessage.trim() })}
              >
                {gitBusy === 'commit' ? <Loader2 size={13} className={styles.spin} /> : <GitCommit size={13} />}
                Commit staged
              </button>
              <div className={styles.gitSyncButtons}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={Boolean(gitBusy) || !git}
                  onClick={() => void runGitAction('pull')}
                >
                  Pull{git?.behind ? ` ${git.behind}↓` : ''}
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={Boolean(gitBusy) || !git}
                  onClick={() => void runGitAction('push')}
                >
                  Push{git?.ahead ? ` ${git.ahead}↑` : ''}
                </button>
              </div>
            </div>
            <div className={styles.sideScroll}>
              {gitLoading ? (
                <div className={styles.loadingState}><Loader2 size={15} className={styles.spin} /> Reading repository…</div>
              ) : gitError || !git ? (
                <div className={styles.emptyState}>
                  <GitBranch size={23} />
                  <strong>Source control unavailable</strong>
                  <span>{gitError || 'Open a Git repository to use source control.'}</span>
                  <button type="button" className={styles.secondaryButton} onClick={() => void loadGit()}>
                    Refresh
                  </button>
                </div>
              ) : git.clean ? (
                <div className={styles.emptyState}>
                  <Check size={24} />
                  <strong>No pending changes</strong>
                  <span>Your working tree is clean.</span>
                </div>
              ) : (
                <>
                  <section className={styles.changeGroup}>
                    <div className={styles.sectionHeading}>
                      <span>Staged changes</span>
                      <span>{stagedChanges.length}</span>
                      {stagedChanges.length > 0 && (
                        <button
                          type="button"
                          className={styles.iconButton}
                          title="Unstage all"
                          aria-label="Unstage all changes"
                          onClick={() => void runGitAction('unstage', { paths: stagedChanges.map((change) => change.path) })}
                        >
                          <Minus size={12} />
                        </button>
                      )}
                    </div>
                    {stagedChanges.length === 0
                      ? <div className={styles.groupEmpty}>Stage files to prepare a focused commit.</div>
                      : stagedChanges.map((change) => renderChange(change, 'staged'))}
                  </section>
                  <section className={styles.changeGroup}>
                    <div className={styles.sectionHeading}>
                      <span>Changes</span>
                      <span>{workingChanges.length}</span>
                      {workingChanges.length > 0 && (
                        <button
                          type="button"
                          className={styles.iconButton}
                          title="Stage all"
                          aria-label="Stage all changes"
                          onClick={() => void runGitAction('stage', { paths: workingChanges.map((change) => change.path) })}
                        >
                          <Plus size={12} />
                        </button>
                      )}
                    </div>
                    {workingChanges.map((change) => renderChange(change, 'working'))}
                  </section>
                  <section className={styles.historyGroup}>
                    <div className={styles.sectionHeading}><span>Recent commits</span></div>
                    {git.commits.slice(0, 8).map((commit) => (
                      <div className={styles.commitRow} key={commit.oid} title={`${commit.oid}\n${commit.authorName}`}>
                        <code>{commit.shortOid}</code>
                        <span>{commit.subject}</span>
                      </div>
                    ))}
                  </section>
                </>
              )}
            </div>
          </>
        )}

        {activity === 'github' && (
          <>
            <div className={styles.sideHeader}>
              <div className={styles.sideHeading}>
                <span>GitHub</span>
                <small>{github?.repository?.fullName || github?.login || 'Repository'}</small>
              </div>
              <div className={styles.sideHeaderActions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="Refresh GitHub"
                  aria-label="Refresh GitHub"
                  disabled={githubLoading}
                  onClick={() => void loadGitHub()}
                >
                  <RefreshCw size={14} className={githubLoading ? styles.spin : ''} />
                </button>
              </div>
            </div>
            {github?.connected && (
              <div className={styles.githubTabs} role="tablist" aria-label="GitHub views">
                {([
                  ['pulls', 'Pull requests', github.pullRequests?.length || 0],
                  ['issues', 'Issues', github.issues?.length || 0],
                  ['actions', 'Actions', github.workflowRuns?.length || 0],
                ] as const).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={githubSection === id}
                    className={githubSection === id ? styles.githubTabActive : ''}
                    onClick={() => setGithubSection(id)}
                  >
                    {label}<span>{count}</span>
                  </button>
                ))}
              </div>
            )}
            <div className={styles.sideScroll}>
              {githubLoading && !github ? (
                <div className={styles.loadingState}><Loader2 size={15} className={styles.spin} /> Connecting to GitHub…</div>
              ) : !github?.configured ? (
                <div className={styles.emptyState}>
                  <GitFork size={25} />
                  <strong>Connect GitHub</strong>
                  <span>Add a personal access token to browse pull requests, issues, and Actions.</span>
                  <Link className={styles.secondaryButton} href="/capabilities">Open Capabilities</Link>
                </div>
              ) : !github.connected ? (
                <div className={styles.emptyState}>
                  <AlertCircle size={24} />
                  <strong>GitHub unavailable</strong>
                  <span>{github.error || 'This workspace does not have a supported GitHub origin.'}</span>
                </div>
              ) : (
                <>
                  {github.repository && (
                    <a
                      className={styles.repositoryCard}
                      href={github.repository.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span><GitFork size={15} /> {github.repository.fullName}</span>
                      <ExternalLink size={12} />
                      {github.repository.description && <small>{github.repository.description}</small>}
                    </a>
                  )}

                  {githubSection === 'pulls' && (
                    <section className={styles.githubList}>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        onClick={() => setPrComposerOpen((value) => !value)}
                      >
                        <GitPullRequest size={13} /> Push & create pull request
                      </button>
                      {prComposerOpen && (
                        <div className={styles.prComposer}>
                          <input
                            value={prTitle}
                            onChange={(event) => setPrTitle(event.target.value)}
                            placeholder="Pull request title"
                            aria-label="Pull request title"
                          />
                          <textarea
                            value={prBody}
                            onChange={(event) => setPrBody(event.target.value)}
                            placeholder="Describe the change"
                            aria-label="Pull request description"
                          />
                          <label>
                            <span>Base</span>
                            <input
                              value={prBase}
                              onChange={(event) => setPrBase(event.target.value)}
                              placeholder={github.repository?.defaultBranch || 'main'}
                            />
                          </label>
                          <div>
                            <button
                              type="button"
                              className={styles.secondaryButton}
                              onClick={() => setPrComposerOpen(false)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className={styles.primaryButton}
                              disabled={!prTitle.trim() || githubLoading}
                              onClick={() => void createPullRequest()}
                            >
                              {githubLoading && <Loader2 size={12} className={styles.spin} />}
                              Push & create PR
                            </button>
                          </div>
                        </div>
                      )}
                      {(github.pullRequests || []).map((pull) => (
                        <a className={styles.githubRow} href={pull.url} target="_blank" rel="noreferrer" key={pull.number}>
                          <GitPullRequest size={14} />
                          <span>
                            <strong>{pull.title}</strong>
                            <small>#{pull.number} · {pull.head} → {pull.base} · {pull.author}</small>
                          </span>
                          {pull.draft && <em>Draft</em>}
                        </a>
                      ))}
                      {(github.pullRequests || []).length === 0 && (
                        <div className={styles.emptyStateCompact}>No open pull requests.</div>
                      )}
                    </section>
                  )}

                  {githubSection === 'issues' && (
                    <section className={styles.githubList}>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        onClick={() => setIssueComposerOpen((value) => !value)}
                      >
                        <CircleDot size={13} /> Create issue
                      </button>
                      {issueComposerOpen && (
                        <div className={styles.prComposer}>
                          <input
                            value={issueTitle}
                            onChange={(event) => setIssueTitle(event.target.value)}
                            placeholder="Issue title"
                            aria-label="Issue title"
                          />
                          <textarea
                            value={issueBody}
                            onChange={(event) => setIssueBody(event.target.value)}
                            placeholder="Describe the issue"
                            aria-label="Issue description"
                          />
                          <div>
                            <button
                              type="button"
                              className={styles.secondaryButton}
                              onClick={() => setIssueComposerOpen(false)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className={styles.primaryButton}
                              disabled={!issueTitle.trim() || githubLoading}
                              onClick={() => void createIssue()}
                            >
                              {githubLoading && <Loader2 size={12} className={styles.spin} />}
                              Create issue
                            </button>
                          </div>
                        </div>
                      )}
                      {(github.issues || []).map((issue) => (
                        <a className={styles.githubRow} href={issue.url} target="_blank" rel="noreferrer" key={issue.number}>
                          <CircleDot size={14} />
                          <span>
                            <strong>{issue.title}</strong>
                            <small>#{issue.number} · {issue.author} · {formatRelativeTime(issue.updatedAt)}</small>
                            {issue.labels.length > 0 && (
                              <span className={styles.labelList}>
                                {issue.labels.slice(0, 3).map((label) => <em key={label}>{label}</em>)}
                              </span>
                            )}
                          </span>
                        </a>
                      ))}
                      {(github.issues || []).length === 0 && (
                        <div className={styles.emptyStateCompact}>No open issues.</div>
                      )}
                    </section>
                  )}

                  {githubSection === 'actions' && (
                    <section className={styles.githubList}>
                      {github.actionsError && <div className={styles.notice}><AlertTriangle size={13} /> {github.actionsError}</div>}
                      {(github.workflowRuns || []).map((run) => {
                        const tone = run.conclusion === 'success'
                          ? styles.actionSuccess
                          : run.conclusion === 'failure'
                            ? styles.actionFailure
                            : styles.actionPending;
                        return (
                          <a className={styles.githubRow} href={run.url} target="_blank" rel="noreferrer" key={run.id}>
                            <span className={`${styles.actionDot} ${tone}`} />
                            <span>
                              <strong>{run.name}</strong>
                              <small>{run.branch} · {run.conclusion || run.status} · {formatRelativeTime(run.updatedAt)}</small>
                            </span>
                          </a>
                        );
                      })}
                      {(github.workflowRuns || []).length === 0 && !github.actionsError && (
                        <div className={styles.emptyStateCompact}>No recent workflow runs.</div>
                      )}
                    </section>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </aside>

      <main className={styles.editorArea}>
        <div className={styles.editorTopline}>
          <div className={styles.tabs} role="tablist" aria-label="Open files">
            {tabs.map((tab) => {
              const active = tab.id === activeTabId;
              const dirty = tab.kind === 'file' && tab.content !== tab.savedContent;
              return (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  key={tab.id}
                  className={`${styles.editorTab} ${active ? styles.editorTabActive : ''}`}
                  onClick={() => setActiveTabId(tab.id)}
                  title={tab.path}
                >
                  {tab.kind === 'diff' ? <Braces size={13} /> : <FileCode2 size={13} />}
                  <span>{tab.name}</span>
                  {dirty
                    ? <span className={styles.dirtyDot} title="Unsaved changes" aria-label="Unsaved changes" />
                    : (
                      <span
                        role="button"
                        tabIndex={0}
                        className={styles.tabClose}
                        aria-label={`Close ${tab.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeTab(tab.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') closeTab(tab.id);
                        }}
                      >
                        <X size={11} />
                      </span>
                    )}
                </button>
              );
            })}
          </div>
          <div className={styles.editorActions}>
            <button
              type="button"
              className={styles.iconButton}
              title="Quick open (Ctrl+P)"
              aria-label="Quick open"
              onClick={() => openPalette('files')}
            >
              <Search size={14} />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              title="Save (Ctrl+S)"
              aria-label="Save active file"
              disabled={!activeFileTab || activeFileTab.content === activeFileTab.savedContent}
              onClick={() => activeFileTab && void saveFile(activeFileTab)}
            >
              {activeFileTab && busyFilePaths.has(activeFileTab.path)
                ? <Loader2 size={14} className={styles.spin} />
                : <Save size={14} />}
            </button>
            <button
              type="button"
              className={`${styles.iconButton} ${bottomOpen ? styles.iconButtonActive : ''}`}
              title="Toggle bottom panel (Ctrl+J)"
              aria-label="Toggle bottom panel"
              aria-pressed={bottomOpen}
              onClick={() => setBottomOpen((value) => !value)}
            >
              <PanelBottom size={14} />
            </button>
          </div>
        </div>

        {activeTab && (
          <div className={styles.breadcrumbs} aria-label="File path">
            <span>{workspaceName}</span>
            {activeTab.path.split('/').map((part, index) => (
              <React.Fragment key={`${part}:${index}`}>
                <span aria-hidden>/</span>
                <span>{part}</span>
              </React.Fragment>
            ))}
            {activeTab.kind === 'diff' && <em>{activeTab.area}</em>}
          </div>
        )}

        <div className={styles.editorHost}>
          {!activeTab ? (
            <div className={styles.welcome}>
              <div className={styles.welcomeMark}><Code2 size={30} /></div>
              <h1>Shiba Code</h1>
              <p>Open a file, review changes, or jump straight to a command.</p>
              <div className={styles.welcomeActions}>
                <button type="button" onClick={() => openPalette('files')}>
                  <span>Quick open file</span><kbd>Ctrl P</kbd>
                </button>
                <button type="button" onClick={() => openPalette('commands')}>
                  <span>Show commands</span><kbd>Ctrl Shift P</kbd>
                </button>
                <button type="button" onClick={() => setActivity('source-control')}>
                  <span>Open source control</span><kbd>Ctrl Shift G</kbd>
                </button>
                <button type="button" onClick={() => setTerminalOpen(true)}>
                  <span>Open terminal</span><kbd>Ctrl `</kbd>
                </button>
              </div>
            </div>
          ) : activeTab.loading ? (
            <div className={styles.editorLoading}><Loader2 size={18} className={styles.spin} /> Opening {activeTab.name}…</div>
          ) : activeTab.kind === 'file' ? (
            activeTab.binary ? (
              <div className={styles.welcome}>
                <FileCode2 size={32} />
                <h2>Binary file</h2>
                <p>{activeTab.path} cannot be edited as text.</p>
              </div>
            ) : (
              <Editor
                height="100%"
                width="100%"
                path={modelUri(workspace, activeTab.path)}
                value={activeTab.content}
                language={activeTab.language}
                line={activeTab.revealLine}
                theme={IDE_THEME}
                beforeMount={configureMonaco}
                onMount={handleEditorMount}
                onValidate={handleValidate}
                onChange={(value) => {
                  setTabs((current) => current.map((tab) => (
                    tab.id === activeTab.id && tab.kind === 'file'
                      ? { ...tab, content: value ?? '' }
                      : tab
                  )));
                }}
                loading={<div className={styles.editorLoading}><Loader2 size={18} className={styles.spin} /> Starting editor…</div>}
                saveViewState
                keepCurrentModel
                options={{
                  automaticLayout: true,
                  accessibilitySupport: 'auto',
                  bracketPairColorization: { enabled: true },
                  cursorBlinking: 'smooth',
                  cursorSmoothCaretAnimation: 'on',
                  fontFamily: 'var(--font-geist-mono), "Geist Mono", Consolas, monospace',
                  fontLigatures: true,
                  fontSize: 13,
                  lineHeight: 21,
                  minimap: { enabled: true, maxColumn: 80, scale: 1, showSlider: 'mouseover' },
                  padding: { top: 10, bottom: 16 },
                  renderLineHighlight: 'gutter',
                  roundedSelection: false,
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  stickyScroll: { enabled: true },
                  tabSize: 2,
                  wordWrap: 'off',
                }}
              />
            )
          ) : activeTab.binary ? (
            <div className={styles.welcome}>
              <Braces size={32} />
              <h2>Binary change</h2>
              <p>Git cannot display a text diff for {activeTab.path}.</p>
            </div>
          ) : activeTab.original !== null || activeTab.modified !== null ? (
            <DiffEditor
              height="100%"
              width="100%"
              original={activeTab.original || ''}
              modified={activeTab.modified || ''}
              language={activeTab.language}
              originalModelPath={modelUri(workspace, activeTab.path, `?${activeTab.area}=base`)}
              modifiedModelPath={modelUri(workspace, activeTab.path, `?${activeTab.area}=current`)}
              theme={IDE_THEME}
              beforeMount={configureMonaco}
              loading={<div className={styles.editorLoading}><Loader2 size={18} className={styles.spin} /> Building diff…</div>}
              options={{
                automaticLayout: true,
                fontFamily: 'var(--font-geist-mono), "Geist Mono", Consolas, monospace',
                fontSize: 13,
                lineHeight: 21,
                minimap: { enabled: false },
                originalEditable: false,
                readOnly: true,
                renderSideBySide: true,
                scrollBeyondLastLine: false,
              }}
            />
          ) : (
            <Editor
              height="100%"
              width="100%"
              value={activeTab.patch}
              language="diff"
              theme={IDE_THEME}
              beforeMount={configureMonaco}
              options={{
                automaticLayout: true,
                fontFamily: 'var(--font-geist-mono), "Geist Mono", Consolas, monospace',
                fontSize: 13,
                lineHeight: 21,
                minimap: { enabled: false },
                readOnly: true,
                scrollBeyondLastLine: false,
              }}
            />
          )}
        </div>

        {bottomOpen && (
          <section className={styles.bottomPanel} aria-label="Editor bottom panel">
            <div className={styles.bottomTabs} role="tablist" aria-label="Bottom panel views">
              <button
                type="button"
                role="tab"
                aria-selected={bottomPanel === 'problems'}
                className={bottomPanel === 'problems' ? styles.bottomTabActive : ''}
                onClick={() => setBottomPanel('problems')}
              >
                Problems <span>{problems.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={bottomPanel === 'output'}
                className={bottomPanel === 'output' ? styles.bottomTabActive : ''}
                onClick={() => setBottomPanel('output')}
              >
                Output <span>{output.length}</span>
              </button>
              <button
                type="button"
                className={styles.bottomTerminalButton}
                onClick={() => setTerminalOpen(true)}
              >
                <Terminal size={12} /> Terminal
              </button>
              <button
                type="button"
                className={`${styles.iconButton} ${styles.bottomClose}`}
                onClick={() => setBottomOpen(false)}
                title="Close panel"
                aria-label="Close bottom panel"
              >
                <X size={13} />
              </button>
            </div>
            <div className={styles.bottomContent}>
              {bottomPanel === 'problems' ? (
                problems.length === 0 ? (
                  <div className={styles.bottomEmpty}><Check size={15} /> No problems detected in open files.</div>
                ) : (
                  <div className={styles.problemsList}>
                    {problems.map((problem) => {
                      const tone = markerTone(problem.severity);
                      const Icon = tone === 'error' ? AlertCircle : tone === 'warning' ? AlertTriangle : Info;
                      return (
                        <button
                          type="button"
                          className={styles.problemRow}
                          key={problem.id}
                          onClick={() => void openFile(problem.path, problem.startLineNumber)}
                        >
                          <Icon size={13} className={styles[`problem${tone}` as keyof typeof styles] || ''} />
                          <span>{problem.message}</span>
                          <small>{problem.path} [{problem.startLineNumber}, {problem.startColumn}]</small>
                        </button>
                      );
                    })}
                  </div>
                )
              ) : output.length === 0 ? (
                <div className={styles.bottomEmpty}><Info size={15} /> IDE actions and Git output appear here.</div>
              ) : (
                <div className={styles.outputList} aria-live="polite">
                  {output.map((entry) => (
                    <div className={styles.outputRow} key={entry.id}>
                      <time>{entry.at}</time>
                      <span className={styles[`output${entry.tone}` as keyof typeof styles] || ''}>{entry.message}</span>
                      {entry.detail && <code>{entry.detail}</code>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <footer className={styles.statusBar}>
        <div className={styles.statusLeft}>
          <div className={styles.branchControl}>
            <button
              type="button"
              onClick={() => setBranchMenuOpen((value) => !value)}
              disabled={!git}
              title="Switch or create branch"
              aria-expanded={branchMenuOpen}
            >
              <GitBranch size={12} />
              <span>{git?.head.branch || (git?.head.detached ? 'detached' : 'No repository')}</span>
            </button>
            {branchMenuOpen && git && (
              <div className={styles.branchMenu}>
                <div className={styles.branchMenuHeader}>
                  <strong>Branches</strong>
                  <button type="button" onClick={() => setBranchMenuOpen(false)} aria-label="Close branch menu"><X size={12} /></button>
                </div>
                <div className={styles.newBranch}>
                  <input
                    value={newBranchName}
                    onChange={(event) => setNewBranchName(event.target.value)}
                    placeholder="New branch name"
                    aria-label="New branch name"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && newBranchName.trim()) {
                        void runGitAction('createBranch', { branch: newBranchName.trim() }).then((ok) => {
                          if (ok) setNewBranchName('');
                        });
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={!newBranchName.trim() || Boolean(gitBusy)}
                    onClick={() => void runGitAction('createBranch', { branch: newBranchName.trim() }).then((ok) => {
                      if (ok) setNewBranchName('');
                    })}
                    aria-label="Create branch"
                    title="Create branch"
                  >
                    <Plus size={13} />
                  </button>
                </div>
                <div className={styles.branchList}>
                  {git.branches.map((branch) => (
                    <button
                      type="button"
                      key={branch.name}
                      className={branch.current ? styles.branchCurrent : ''}
                      onClick={() => !branch.current && void runGitAction('checkout', { branch: branch.name })}
                    >
                      {branch.current ? <Check size={12} /> : <GitBranch size={12} />}
                      <span>{branch.name}</span>
                      {(branch.ahead || branch.behind) ? <small>{branch.ahead}↑ {branch.behind}↓</small> : null}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {git && (
            <button type="button" onClick={() => setActivity('source-control')} title="Open Source Control">
              {git.ahead ? `${git.ahead}↑` : ''}{git.behind ? ` ${git.behind}↓` : ''}{!git.ahead && !git.behind ? '✓' : ''}
            </button>
          )}
          {git?.status.length ? (
            <button type="button" onClick={() => setActivity('source-control')} title="Pending changes">
              <GitBranch size={11} /> {git.status.length}
            </button>
          ) : null}
        </div>
        <div className={styles.statusRight}>
          <button
            type="button"
            onClick={() => {
              setBottomOpen(true);
              setBottomPanel('problems');
            }}
            title="Show problems"
          >
            <AlertCircle size={11} /> {problems.filter((problem) => markerTone(problem.severity) === 'error').length}
            <AlertTriangle size={11} /> {problems.filter((problem) => markerTone(problem.severity) === 'warning').length}
          </button>
          {activeFileTab && (
            <>
              <span>Ln {cursor.line}, Col {cursor.column}</span>
              <span>Spaces: 2</span>
              <span>UTF-8</span>
              <span>{titleForLanguage(activeFileTab.language)}</span>
            </>
          )}
          <button type="button" onClick={() => setTerminalOpen(true)} title="Open host terminal">
            <Terminal size={11} /> Terminal
          </button>
        </div>
      </footer>

      {paletteMode && (
        <div
          className={styles.paletteBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPaletteMode(null);
          }}
        >
          <div className={styles.palette} role="dialog" aria-modal="true" aria-label={paletteMode === 'files' ? 'Quick open' : 'Command palette'}>
            <div className={styles.paletteInput}>
              {paletteMode === 'files' ? <Search size={15} /> : <Command size={15} />}
              <input
                ref={paletteInputRef}
                role="combobox"
                aria-expanded="true"
                aria-controls="ide-palette-results"
                aria-activedescendant={paletteEntries[paletteIndex]?.id}
                value={paletteQuery}
                onChange={(event) => {
                  setPaletteQuery(event.target.value);
                  setPaletteIndex(0);
                }}
                placeholder={paletteMode === 'files' ? 'Search files by name' : 'Type a command'}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setPaletteMode(null);
                  } else if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setPaletteIndex((index) => Math.min(index + 1, Math.max(0, paletteEntries.length - 1)));
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setPaletteIndex((index) => Math.max(0, index - 1));
                  } else if (event.key === 'Enter' && paletteEntries[paletteIndex]) {
                    event.preventDefault();
                    const entry = paletteEntries[paletteIndex];
                    runPaletteEntry(entry);
                  }
                }}
              />
              <kbd>Esc</kbd>
            </div>
            <div className={styles.paletteResults} id="ide-palette-results" role="listbox">
              {paletteEntries.length === 0 ? (
                <div className={styles.paletteEmpty}>No matching {paletteMode === 'files' ? 'files' : 'commands'}.</div>
              ) : paletteEntries.map((entry, index) => (
                <button
                  type="button"
                  id={entry.id}
                  role="option"
                  aria-selected={index === paletteIndex}
                  key={entry.id}
                  className={index === paletteIndex ? styles.paletteItemActive : ''}
                  onMouseEnter={() => setPaletteIndex(index)}
                  onClick={() => runPaletteEntry(entry)}
                >
                  <span>{entry.label}</span>
                  {entry.hint && <small>{entry.hint}</small>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {mutationDialog && (
        <div className={styles.mutationBackdrop} role="presentation">
          <form
            className={styles.mutationDialog}
            role="dialog"
            aria-modal="true"
            aria-label={mutationDialog.type === 'rename'
              ? 'Rename item'
              : mutationDialog.type === 'directory'
                ? 'Create folder'
                : 'Create file'}
            onSubmit={(event) => {
              event.preventDefault();
              void runFileMutation();
            }}
          >
            <div className={styles.mutationTitle}>
              {mutationDialog.type === 'rename' ? <Pencil size={15} /> : mutationDialog.type === 'directory' ? <FolderPlus size={15} /> : <FilePlus2 size={15} />}
              <strong>{mutationDialog.type === 'rename' ? 'Rename' : mutationDialog.type === 'directory' ? 'New folder' : 'New file'}</strong>
            </div>
            <label>
              <span>Name</span>
              <input
                autoFocus
                value={mutationDialog.value}
                onChange={(event) => setMutationDialog((current) => current ? { ...current, value: event.target.value } : null)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setMutationDialog(null);
                  }
                }}
              />
            </label>
            <small>
              {mutationDialog.type === 'rename'
                ? mutationDialog.targetPath
                : mutationParent || workspaceName}
            </small>
            <div className={styles.mutationActions}>
              <button type="button" className={styles.secondaryButton} onClick={() => setMutationDialog(null)} disabled={mutationBusy}>Cancel</button>
              <button type="submit" className={styles.primaryButton} disabled={!mutationDialog.value.trim() || mutationBusy}>
                {mutationBusy && <Loader2 size={12} className={styles.spin} />}
                {mutationDialog.type === 'rename' ? 'Rename' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className={styles.srLive} aria-live="polite" aria-atomic="true">
        {dirtyTabs.length ? `${dirtyTabs.length} unsaved file${dirtyTabs.length === 1 ? '' : 's'}` : 'All files saved'}
      </div>
    </div>
  );
}
