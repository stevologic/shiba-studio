"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Home, MessageSquare, Users, FolderOpen, FolderKanban, Clock, Plug, Settings, Play, Plus, Trash2, Edit2,
  CalendarClock, Check, ChevronDown, ChevronUp, X, RefreshCw, Terminal, Globe, Camera, BarChart3, Upload,
  CloudUpload, CloudDownload, Command, Menu, Pencil, ScrollText, History, Eye, ChevronsLeft, ChevronsRight,
  KeyRound, Server, Cpu, ShieldCheck, Sparkles, Volume2
} from 'lucide-react';
import dynamic from 'next/dynamic';
import type { CommandPaletteItem } from '@/components/command-palette';
import ConfirmHost, { confirmDialog } from '@/components/confirm-dialog';
import MultitaskSidebar from '@/components/multitask-sidebar';
import VoiceAgentNavDock from '@/components/voice-agent-nav-dock';
import type { PendingToolApproval } from '@/components/tool-approval-modal';
import type { ToolApprovalMode } from '@/lib/types';
import MultimodalBadge from '@/components/multimodal-badge';
import InfoHint from '@/components/info-hint';

// Heavy tab panels and open-on-demand modals are code-split so the first
// paint only ships the shell — each chunk loads when its tab/modal is used.
const panelLoading = () => (
  <div className="data-loading-row py-6"><span className="data-spinner" /> Loading…</div>
);
const ChatSessionsPanel = dynamic(() => import('@/components/chat-sessions-panel'), { loading: panelLoading });
const ProjectsPanel = dynamic(() => import('@/components/projects-panel'), { loading: panelLoading });
const UsageDashboard = dynamic(() => import('@/components/usage-dashboard'), { loading: panelLoading });
const LogsPanel = dynamic(() => import('@/components/logs-panel'), { loading: panelLoading });
const McpPanel = dynamic(() => import('@/components/mcp-panel'), { loading: panelLoading });
const SkillsBrowser = dynamic(() => import('@/components/skills-browser'), { loading: panelLoading });
const WorkspaceDiffPanel = dynamic(() => import('@/components/workspace-diff-panel'), { loading: panelLoading });
const WorkspacePage = dynamic(() => import('@/components/workspace-page'), { loading: panelLoading });
const PreviewRail = dynamic(() => import('@/components/preview-rail'), { loading: panelLoading });
const ToolsCatalog = dynamic(() => import('@/components/tools-catalog'), { loading: panelLoading });
const ChatMarkdown = dynamic(() => import('@/components/chat-markdown-lazy'));
const SyncModal = dynamic(() => import('@/components/sync-modal'));
const CommandPalette = dynamic(() => import('@/components/command-palette'));
const FolderBrowseModal = dynamic(() => import('@/components/folder-browse-modal'));
const ToolApprovalModal = dynamic(() => import('@/components/tool-approval-modal'));
import { toast } from 'sonner';
import { getTerminalOpen, setTerminalOpen, toggleTerminalOpen, subscribeTerminalOpen } from '@/lib/terminal-ui-store';
import {
  endVoiceIfSessionChanges,
  getVoiceAgentUiState,
  subscribeVoiceAgentUi,
} from '@/lib/voice-agent-ui-store';
import { Agent, AgentRun, AppConfig, GrokModel, EMPTY_INTEGRATION_SCOPE } from '@/lib/types';
import { THEME_IDENTITY } from '@/lib/theme';
import { ALIEN_AVATARS, MISSING_AGENT_AVATAR_PATH, resolveAgentAvatar, resolveAgentAvatarPath } from '@/lib/agent-avatars';
import {
  SCHEDULE_PRESETS,
  SchedulePresetId,
  describeCron,
  enrichScheduleForForm,
  defaultScheduleEntry,
  presetToCron,
  schedulesForSave,
} from '@/lib/schedule-presets';
import { INTEGRATION_CATALOG, INTEGRATION_IDS, getIntegrationMeta } from '@/lib/integration-catalog';
import { modelDisplayName, parseModelRef, providerLabel, providerTitle, type ModelProvider } from '@/lib/model-providers';
import { resolveProjectWorkspace } from '@/lib/project-types';
import {
  AppTab,
  chatSessionPath,
  isKnownAppPath,
  pathToChatSessionId,
  pathToTab,
  readLastChatSessionId,
  tabToPath,
  writeLastChatSessionId,
} from '@/lib/app-navigation';
import { formatUsageCostUsd, type NavStats } from '@/lib/nav-stats-types';
import {
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_VOICE,
  GROK_TTS_SPEEDS,
  GROK_TTS_VOICES,
  clampTtsSpeed,
} from '@/lib/xai-tts';
import pkg from '@/package.json';

type ModelOption = { id: string; label: string; provider?: ModelProvider; reasoning?: boolean };

/** Run summary as served by /api/runs (no trace payload). */
type RunSummaryLite = {
  id: string; agentId: string; agentName: string; model: string; status: string;
  prompt: string; startedAt: string; completedAt?: string; finalOutput?: string;
  scheduleId?: string; scheduleInstructions?: string; traceSteps?: number;
};

// One source of truth for tab display names (nav, top bar, document titles).
const TAB_LABELS: Record<string, string> = {
  dashboard: 'Dashboard', chat: 'Grok Chat', projects: 'Projects', agents: 'Agents',
  workspace: 'Workspace', automations: 'Automations', integrations: 'Capabilities',
  usage: 'Usage', logs: 'Logs', settings: 'Settings',
};

function ModelProviderBadge({ modelId, size = 'sm' }: { modelId?: string; size?: 'sm' | 'xs' }) {
  const ref = parseModelRef(modelId || '');
  const cls = size === 'xs' ? 'model-provider-badge model-provider-badge-xs' : 'model-provider-badge';
  const text = ref.authSource === 'oauth' ? 'OAuth' : ref.authSource === 'token' ? 'Token' : providerLabel(ref.provider);
  return (
    <span className={`${cls} model-provider-${ref.provider}`} title={providerTitle(ref.provider, ref.authSource)}>
      {text}
    </span>
  );
}

function ModelLine({ modelId, mono = true }: { modelId: string; mono?: boolean }) {
  const ref = parseModelRef(modelId);
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <ModelProviderBadge modelId={modelId} size="xs" />
      <span className={mono ? 'font-mono' : ''}>{ref.id}</span>
    </span>
  );
}

function IntegrationIcon({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' | 'lg' }) {
  const meta = getIntegrationMeta(id);
  if (!meta) return null;
  const dim = size === 'sm' ? 14 : size === 'lg' ? 28 : 22;
  const cls = size === 'sm' ? 'integration-icon-sm' : size === 'lg' ? 'integration-icon-lg' : 'integration-icon';
  return <img src={meta.icon} alt="" className={cls} width={dim} height={dim} />;
}

const OAUTH_POLL_MS = 2000;
const OAUTH_POLL_MAX_MS = 5 * 60_000;
const APP_VERSION = pkg.version;
/** Build-time fallback only — live SHA is fetched from /api/version. */
const GIT_COMMIT_FALLBACK = process.env.NEXT_PUBLIC_GIT_COMMIT || 'unreleased';
const DOGE_DONATION_ADDRESS = 'DTW2M5oEW97WbmYJRM71qD7uE6xfJs1MUK';

/** Per-agent credential override fields, by integration. Only shown for the
 *  integrations an agent has enabled — lets an agent use its own account. */
const AGENT_OVERRIDE_FIELDS: Record<string, Array<{ key: string; label: string; secret?: boolean }>> = {
  github: [{ key: 'token', label: 'GitHub token (ghp_…)', secret: true }],
  slack: [{ key: 'token', label: 'Slack bot token (xoxb-…)', secret: true }, { key: 'defaultChannel', label: 'Default channel (#…)' }],
  discord: [{ key: 'token', label: 'Discord bot token', secret: true }, { key: 'defaultChannelId', label: 'Default channel id' }],
  x: [
    { key: 'apiKey', label: 'API Key' }, { key: 'apiSecret', label: 'API Secret', secret: true },
    { key: 'accessToken', label: 'Access Token' }, { key: 'accessTokenSecret', label: 'Access Token Secret', secret: true },
  ],
  obsidian: [{ key: 'restApiUrl', label: 'REST API URL' }, { key: 'restApiKey', label: 'REST API key', secret: true }, { key: 'vaultPath', label: 'Vault path (local mode)' }],
  googledrive: [{ key: 'accessToken', label: 'OAuth access token', secret: true }, { key: 'serviceAccountJson', label: 'Service account JSON', secret: true }],
};

export default function ShibaStudio() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = pathToTab(pathname);
  const oauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const oauthPollStartedRef = useRef<number | null>(null);
  // The sign-in popup — the opener force-closes it once tokens are stored
  // (a popup's own window.close() can be blocked after cross-origin hops).
  const oauthPopupRef = useRef<Window | null>(null);
  const drivePopupRef = useRef<Window | null>(null);
  const [driveStarting, setDriveStarting] = useState(false);
  // Drive's Advanced (one-time OAuth client setup) — collapsed by default;
  // the Sign-in button opens it only if no client is configured yet.
  const [driveAdvancedOpen, setDriveAdvancedOpen] = useState(false);
  // App origin for OAuth redirect URIs (SSR-safe — filled in after mount).
  const [appOrigin, setAppOrigin] = useState('');
  // Client-only so the Chat nav link points at the last session after hydrate
  // (avoids always linking bare `/chat`, which remounts and double-loads).
  const [chatNavHref, setChatNavHref] = useState('/chat');
  useEffect(() => { setAppOrigin(window.location.origin); }, []);
  useEffect(() => {
    const last = readLastChatSessionId();
    setChatNavHref(last ? chatSessionPath(last) : '/chat');
  }, [pathname]);

  const navigateToTab = useCallback((next: AppTab) => {
    // Open Chat on the last session when possible so we never hit bare `/chat`
    // first (that extra hop remounts the catch-all route and double-loaded).
    if (next === 'chat') {
      const last = readLastChatSessionId();
      const path = last ? chatSessionPath(last) : tabToPath('chat');
      if (pathname !== path) router.push(path);
      return;
    }
    const path = tabToPath(next);
    if (pathname !== path) router.push(path);
  }, [pathname, router]);

  const navigateToChatSession = useCallback((id: string) => {
    const path = chatSessionPath(id);
    // Switching chats (or opening a different session from elsewhere) ends voice.
    endVoiceIfSessionChanges(id);
    if (pathname === path) return;
    writeLastChatSessionId(id);
    // `/chat` → `/chat/:id` is a bootstrap rewrite, not a user navigation.
    if (pathname === '/chat' || pathname === '/chat/') router.replace(path);
    else router.push(path);
  }, [pathname, router]);

  /** Top-bar New Chat — create a fresh session and jump straight into it. */
  const startNewChat = useCallback(async () => {
    try {
      const res = await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', defaults: {} }),
      });
      const data = await res.json();
      if (!data.ok || !data.session) throw new Error(data.error || 'Could not create chat');
      // New chat ends any active Grok Voice session.
      endVoiceIfSessionChanges(data.session.id);
      navigateToChatSession(data.session.id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not create chat');
    }
  }, [navigateToChatSession]);

  useEffect(() => {
    if (!isKnownAppPath(pathname)) router.replace('/');
  }, [pathname, router]);

  const stopOAuthPolling = useCallback(() => {
    if (oauthPollRef.current) {
      clearInterval(oauthPollRef.current);
      oauthPollRef.current = null;
    }
    oauthPollStartedRef.current = null;
  }, []);

  const handleOAuthConnected = useCallback(async (message?: string) => {
    stopOAuthPolling();
    try { oauthPopupRef.current?.close(); } catch { /* already closed */ }
    oauthPopupRef.current = null;
    toast.success(message || 'Signed in with X (OAuth)');
    await loadAll();
    await loadModels();
    await refreshOAuthStatus();
  }, [stopOAuthPolling]);

  // The Google Drive popup announces success on its own channel; the opener
  // closes it and refreshes the Drive connection status.
  const handleDriveConnected = useCallback(async () => {
    try { drivePopupRef.current?.close(); } catch { /* gone */ }
    drivePopupRef.current = null;
    setDriveStarting(false);
    toast.success('Google Drive connected');
    await loadAll();
    try {
      const res = await fetch('/api/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test', which: 'googledrive' }) });
      const data = await res.json();
      setIntTest((t: any) => ({ ...t, googledrive: data }));
    } catch { /* status refresh is best-effort */ }
  }, []);

  useEffect(() => {
    return () => stopOAuthPolling();
  }, [stopOAuthPolling]);

  // The OAuth popup's callback page announces success the instant tokens are
  // stored — no waiting on the status poll (which stays as the fallback).
  // The hand-back page is served by a loopback listener on 127.0.0.1 (any
  // port — the only redirect shape auth.x.ai accepts), so allow that origin.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const loopback = /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(e.origin);
      if (e.origin !== window.location.origin && !loopback) return;
      if (e.data === 'shiba-oauth:connected') void handleOAuthConnected();
      else if (e.data === 'shiba-drive:connected') void handleDriveConnected();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [handleOAuthConnected, handleDriveConnected]);

  useEffect(() => {
    if (tab === 'settings') void refreshOAuthStatus();
  }, [tab]);

  useEffect(() => {
    if (tab !== 'settings') return;
    const oauth = searchParams.get('oauth');
    const drive = searchParams.get('drive');
    if (!oauth && !drive) return;

    const message = searchParams.get('message') || undefined;
    if (oauth === 'connected') {
      void handleOAuthConnected();
    } else if (oauth === 'error') {
      toast.error(message || 'OAuth sign-in failed');
      void refreshOAuthStatus();
    }
    if (drive === 'connected') {
      void handleDriveConnected();
    } else if (drive === 'error') {
      toast.error(message || 'Google sign-in failed');
    }
    router.replace('/settings');
  }, [tab, searchParams, router, handleOAuthConnected, handleDriveConnected]);

  // Fetched once on mount — the top bar shows a Grok CLI badge on every tab.
  useEffect(() => {
    fetch('/api/grok-cli/status')
      .then((r) => r.json())
      .then((data) => setGrokCliStatus({ installed: !!data.installed, version: data.version, path: data.path }))
      .catch(() => setGrokCliStatus({ installed: false }));
  }, []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [liveTrace, setLiveTrace] = useState<any[]>([]);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  // Terminal open state is global (root layout) so it survives tab navigation.
  const [showTerminal, setShowTerminalLocal] = useState(false);
  useEffect(() => {
    setShowTerminalLocal(getTerminalOpen());
    return subscribeTerminalOpen(() => setShowTerminalLocal(getTerminalOpen()));
  }, []);
  // Keep Chat mounted (hidden) while Grok Voice is active so the engine survives navigation.
  const [voiceAgentActive, setVoiceAgentActiveLocal] = useState(false);
  useEffect(() => {
    setVoiceAgentActiveLocal(getVoiceAgentUiState().active);
    return subscribeVoiceAgentUi(() => setVoiceAgentActiveLocal(getVoiceAgentUiState().active));
  }, []);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Donate button briefly shows its own "copied" state instead of a toast.
  const [dogeCopied, setDogeCopied] = useState(false);
  // Execution Trace lives in a modal — opened manually, on Run now, or by a
  // /automations?run=<id> deep link. The page itself stays uncluttered.
  const [showTraceModal, setShowTraceModal] = useState(false);
  // First-run banner / nav collapse — SSR-safe defaults; restore after mount.
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem('shiba-welcome') === 'dismissed') setWelcomeDismissed(true);
    } catch { /* private mode */ }
    try {
      if (window.localStorage.getItem('shiba-nav') === 'collapsed') setNavCollapsed(true);
    } catch { /* private mode */ }
  }, []);

  function toggleNavCollapsed() {
    setNavCollapsed((c) => {
      try { window.localStorage.setItem('shiba-nav', c ? 'open' : 'collapsed'); } catch { /* private mode */ }
      return !c;
    });
  }
  const [previewSelectedIdx, setPreviewSelectedIdx] = useState<number | null>(null);
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | null>(null);
  const [toolApprovalMode, setToolApprovalMode] = useState<ToolApprovalMode>('yolo');
  const [globalInstructionsInput, setGlobalInstructionsInput] = useState('');
  const [useAgentsMd, setUseAgentsMd] = useState(true);

  // Direct Grok Chat
  const [chatModel, setChatModel] = useState<GrokModel>('grok-4');
  const chatModelRef = useRef(chatModel);
  useEffect(() => { chatModelRef.current = chatModel; }, [chatModel]);

  // Run agent prompt modal
  const [showRunModal, setShowRunModal] = useState(false);
  const [runModalAgent, setRunModalAgent] = useState<Agent | null>(null);
  const [runModalPrompt, setRunModalPrompt] = useState(
    'Explore the workspace and summarize what we can build here. Then propose next steps.',
  );

  // Agent form
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [highlightScheduleIdx, setHighlightScheduleIdx] = useState<number | null>(null);
  const [agentForm, setAgentForm] = useState<any>({
    name: 'Builder Agent', avatar: 'alien-01', origin: 'local', model: 'grok-4', workspace: { path: '', useWorktree: true },
    integrations: { ...EMPTY_INTEGRATION_SCOPE },
    peers: [], skills: [], chatSkill: '', voiceId: '', schedules: [defaultScheduleEntry()], driveFolders: []
  });
  // TTS voice catalog for agent editor (live xAI list when signed in).
  type AgentVoiceOpt = { id: string; name: string; description?: string };
  const [agentVoiceOptions, setAgentVoiceOptions] = useState<AgentVoiceOpt[]>(GROK_TTS_VOICES);
  // Drive folder picker (agent editor) — the connected Drive's folders.
  const [driveFolderOptions, setDriveFolderOptions] = useState<Array<{ id: string; name: string }> | null>(null);
  const [driveFoldersLoading, setDriveFoldersLoading] = useState(false);
  const loadDriveFolders = useCallback(async () => {
    setDriveFoldersLoading(true);
    try {
      const res = await fetch('/api/google-drive/folders');
      const data = await res.json();
      setDriveFolderOptions(data.ok ? (data.folders || []) : []);
      if (!data.ok) toast.error(data.error || 'Could not list Drive folders — sign in to Google Drive first');
    } catch {
      setDriveFolderOptions([]);
    }
    setDriveFoldersLoading(false);
  }, []);

  // Workspace
  const [wsFiles, setWsFiles] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [fileContent, setFileContent] = useState('');
  const [wsPath, setWsPath] = useState(process.cwd ? process.cwd() : '');
  const [wsUploads, setWsUploads] = useState<any[]>([]);
  const [wsUploadsPath, setWsUploadsPath] = useState('');
  const [cloudFiles, setCloudFiles] = useState<any[]>([]);
  const [wsLastSync, setWsLastSync] = useState<string | null>(null);
  const [wsDragging, setWsDragging] = useState(false);
  const [wsUploading, setWsUploading] = useState(false);
  const [wsSyncing, setWsSyncing] = useState<'upload' | 'download' | null>(null);

  // Integrations form state
  const [intCreds, setIntCreds] = useState<any>({ github: {}, slack: {}, googledrive: {}, discord: {}, x: {}, obsidian: { mode: 'local' } });
  const [intTest, setIntTest] = useState<any>({});
  const [intSaving, setIntSaving] = useState<Record<string, boolean>>({});
  const [expandedIntegration, setExpandedIntegration] = useState<string | null>(null);

  function integrationConfigured(id: string): boolean {
    const creds = (intCreds as Record<string, Record<string, string>>)[id] || {};
    if (id === 'obsidian') return !!(creds.vaultPath?.trim() || creds.restApiUrl?.trim());
    return Object.entries(creds).some(([k, v]) => k !== 'mode' && typeof v === 'string' && v.trim().length > 0);
  }
  const [folderBrowseFor, setFolderBrowseFor] = useState<'obsidian' | 'workspace' | 'mcp' | null>(null);
  const [mcpBrowsePath, setMcpBrowsePath] = useState<string | null>(null);
  const [grokCliStatus, setGrokCliStatus] = useState<{ installed: boolean; version?: string; path?: string } | null>(null);

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [managementKeyInput, setManagementKeyInput] = useState('');
  const [oauthStatus, setOauthStatus] = useState<{
    connected: boolean;
    expired: boolean;
    email?: string;
    displayName?: string;
    error?: string;
  }>({ connected: false, expired: false });
  const [cloudAuthMode, setCloudAuthMode] = useState<'api_key' | 'oauth'>('api_key');
  const [oauthCallbackInput, setOauthCallbackInput] = useState('');
  const [oauthStarting, setOauthStarting] = useState(false);
  const [defaultModelInput, setDefaultModelInput] = useState('');
  const [defaultTtsVoiceInput, setDefaultTtsVoiceInput] = useState(DEFAULT_TTS_VOICE);
  const [defaultTtsSpeedInput, setDefaultTtsSpeedInput] = useState(DEFAULT_TTS_SPEED);
  const [defaultWorkspaceInput, setDefaultWorkspaceInput] = useState('');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [localGrokEnabled, setLocalGrokEnabled] = useState(false);
  const [localGrokBaseUrl, setLocalGrokBaseUrl] = useState('http://127.0.0.1:1234/v1');
  const [localGrokReachable, setLocalGrokReachable] = useState(false);
  const [localModelOptions, setLocalModelOptions] = useState<string[]>([]);
  const [localModelAllowlist, setLocalModelAllowlist] = useState<string[]>([]);
  const [localModelsFetching, setLocalModelsFetching] = useState(false);
  const [navStats, setNavStats] = useState<NavStats>({
    chatSessions: 0,
    projects: 0,
    workspaceFiles: 0,
    automationsScheduled: 0,
    integrationsConfigured: 0,
    usageCostUsd: 0,
    usageBudgetUsd: 0,
  });
  const [navStatsLoaded, setNavStatsLoaded] = useState(false);
  const [usageBudgetInput, setUsageBudgetInput] = useState('25');
  const [cliUpdate, setCliUpdate] = useState<{ checking: boolean; text?: string; available?: boolean }>({ checking: false });
  /** Live commit of the tree this server process is serving (refreshed via /api/version). */
  const [runtimeVersion, setRuntimeVersion] = useState<{
    version: string;
    commit: string;
    commitFull: string | null;
    dirty: boolean;
    root?: string;
  }>({ version: APP_VERSION, commit: GIT_COMMIT_FALLBACK, commitFull: null, dirty: false });

  async function refreshRuntimeVersion() {
    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok && data.commit) {
        setRuntimeVersion({
          version: data.version || APP_VERSION,
          commit: data.commit,
          commitFull: data.commitFull || null,
          dirty: !!data.dirty,
          root: data.root,
        });
      }
    } catch {
      /* keep last known / fallback */
    }
  }

  async function checkCliUpdate() {
    setCliUpdate({ checking: true });
    try {
      const data = await fetch('/api/grok-cli/status?checkUpdate=1').then((r) => r.json());
      const u = data.update;
      if (!u || !u.ok) {
        setCliUpdate({ checking: false, text: u?.error || 'Update check failed' });
        return;
      }
      setCliUpdate({
        checking: false,
        available: !!u.updateAvailable,
        text: u.updateAvailable
          ? `Update available: ${u.latest || 'newer version'} (run "grok update" in a terminal)`
          : `Up to date (${u.current || 'current version'})`,
      });
    } catch {
      setCliUpdate({ checking: false, text: 'Update check failed' });
    }
  }

  async function loadNavStats() {
    try {
      const res = await fetch('/api/nav-stats');
      const data = await res.json();
      if (data.ok) {
        setNavStats({
          chatSessions: data.chatSessions ?? 0,
          projects: data.projects ?? 0,
          workspaceFiles: data.workspaceFiles ?? 0,
          automationsScheduled: data.automationsScheduled ?? 0,
          integrationsConfigured: data.integrationsConfigured ?? 0,
          usageCostUsd: data.usageCostUsd ?? 0,
          usageBudgetUsd: data.usageBudgetUsd ?? 0,
        });
        setNavStatsLoaded(true);
      }
    } catch {
      /* ignore */
    }
  }

  function pickDefaultModel(current?: string): string {
    if (current && availableModels.some(m => m.id === current)) return current;
    const configured = config?.defaultGrokModel || defaultModelInput;
    if (configured && availableModels.some(m => m.id === configured)) return configured;
    const preferred = availableModels.find(m => /grok-4(?!.*fast)/i.test(m.id))
      || availableModels.find(m => m.id.includes('grok-4'))
      || availableModels.find(m => m.id.includes('grok-3'))
      || availableModels.find(m => m.id.includes('grok'))
      || availableModels[0];
    return preferred?.id || current || configured || 'cloud:grok-4';
  }

  async function loadModels() {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
        setAvailableModels(data.models.map((m: ModelOption) => ({
          id: m.id,
          label: m.label || modelDisplayName(m.id),
          provider: m.provider || (m.id.startsWith('local:') ? 'local' : 'cloud'),
          reasoning: m.reasoning,
        })));
        setLocalGrokReachable(!!data.localReachable);
        setChatModel((current) => pickDefaultModel(current));
        const resolvedDefault = pickDefaultModel(config?.defaultGrokModel || defaultModelInput || undefined);
        if (config?.defaultGrokModel) setDefaultModelInput(config.defaultGrokModel);
        else if (!defaultModelInput) setDefaultModelInput(resolvedDefault);
        setAgentForm((f: any) => ({ ...f, model: pickDefaultModel(f.model) }));
      } else {
        setAvailableModels([]);
        setModelsError(data.error || (data.hasCloudAuth || data.localEnabled ? 'No models returned' : 'Add xAI API key, sign in with X (OAuth), or enable local models in Settings'));
      }
    } catch (e: any) {
      setAvailableModels([]);
      setModelsError(e.message);
    }
    setModelsLoading(false);
  }

  function renderModelOptions(currentValue?: string) {
    const opts: React.ReactNode[] = [];
    if (modelsLoading && availableModels.length === 0) {
      opts.push(<option key="_loading" value={currentValue || ''}>Loading models…</option>);
    } else if (availableModels.length === 0) {
      opts.push(<option key="_empty" value={currentValue || ''}>{modelsError || 'Configure a cloud key or local models in Settings'}</option>);
    } else {
      const cloud = availableModels.filter(m => m.provider === 'cloud');
      const local = availableModels.filter(m => m.provider === 'local');
      const cli = availableModels.filter(m => m.provider === 'cli');
      if (cloud.length > 0) {
        opts.push(<optgroup key="cloud" label="Cloud — xAI API">{cloud.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>);
      }
      if (local.length > 0) {
        opts.push(<optgroup key="local" label="Local — this machine">{local.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>);
      }
      if (cli.length > 0) {
        opts.push(<optgroup key="cli" label="CLI — Grok CLI">{cli.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>);
      }
      const other = availableModels.filter(m => m.provider !== 'cloud' && m.provider !== 'local' && m.provider !== 'cli');
      other.forEach(m => opts.push(<option key={m.id} value={m.id}>{m.label}</option>));
    }
    if (currentValue && !availableModels.some(m => m.id === currentValue)) {
      const ref = parseModelRef(currentValue);
      opts.push(<option key="_saved" value={currentValue}>[{providerLabel(ref.provider)}] {ref.id} (saved)</option>);
    }
    return opts;
  }

  // Load everything
  async function loadAll() {
    try {
      const [aRes, rRes, cRes, intRes] = await Promise.all([
        fetch('/api/agents').then(r => r.json()),
        fetch('/api/runs').then(r => r.json()),
        fetch('/api/config').then(r => r.json()),
        fetch('/api/integrations').then(r => r.json()),
      ]);
      setAgents(aRes.agents || []);
      setRuns(rRes.runs || []);
      const cfg = cRes;
      setConfig(cfg as any);
      if (intRes.integrations) {
        setIntCreds({ github: {}, slack: {}, googledrive: {}, discord: {}, x: {}, obsidian: { mode: 'local' }, ...intRes.integrations });
      }
      if ((cfg as any).hasKey) setApiKeyInput('••••••••'); // masked
      if ((cfg as any).hasManagementKey) setManagementKeyInput('••••••••');
      if ((cfg as any).oauthStatus) setOauthStatus((cfg as any).oauthStatus);
      if ((cfg as any).cloudAuthMode) setCloudAuthMode((cfg as any).cloudAuthMode);
      if (cfg.localGrokEnabled !== undefined) setLocalGrokEnabled(!!cfg.localGrokEnabled);
      if (cfg.localGrokBaseUrl) setLocalGrokBaseUrl(cfg.localGrokBaseUrl);
      if (Array.isArray(cfg.localModelAllowlist)) setLocalModelAllowlist(cfg.localModelAllowlist);
      if (cfg.defaultGrokModel) {
        setDefaultModelInput(cfg.defaultGrokModel);
        setChatModel((current) => (
          current === 'grok-4' || current === 'cloud:grok-4' || current === 'grok-3' || current === 'cloud:grok-3'
            ? cfg.defaultGrokModel
            : current
        ) as GrokModel);
      }
      {
        const studioVoice = String(cfg.defaultTtsVoice || '').trim().toLowerCase() || DEFAULT_TTS_VOICE;
        setDefaultTtsVoiceInput(studioVoice);
        const studioSpeed = clampTtsSpeed(cfg.defaultTtsSpeed ?? DEFAULT_TTS_SPEED);
        setDefaultTtsSpeedInput(studioSpeed);
        // Seed chat prefs when the user has never chosen a session override.
        try {
          if (!window.localStorage.getItem('shiba-tts-voice')) {
            window.localStorage.setItem('shiba-tts-voice', studioVoice);
          }
          if (!window.localStorage.getItem('shiba-tts-speed')) {
            window.localStorage.setItem('shiba-tts-speed', String(studioSpeed));
          }
        } catch { /* private mode */ }
      }
      if (cfg.defaultWorkspace) {
        setDefaultWorkspaceInput(cfg.defaultWorkspace);
        setWsPath(cfg.defaultWorkspace);
      }
      if (cfg.toolApprovalMode) setToolApprovalMode(cfg.toolApprovalMode);
      if (cfg.globalInstructions != null) setGlobalInstructionsInput(cfg.globalInstructions);
      if (cfg.useAgentsMd != null) setUseAgentsMd(!!cfg.useAgentsMd);
      setUsageBudgetInput(String(cfg.usageBudgetUsd ?? 25));
      // Boot ping — hydrates server config; schedule arming is idempotent
      // (instrumentation.ts already armed everything at server start).
      // Also carries live commit SHA of the tree Node is serving.
      fetch('/api/boot')
        .then((r) => r.json())
        .then((data) => {
          if (data?.commit) {
            setRuntimeVersion({
              version: data.version || APP_VERSION,
              commit: data.commit,
              commitFull: data.commitFull || null,
              dirty: !!data.dirty,
              root: data.root,
            });
          }
        })
        .catch(() => { void refreshRuntimeVersion(); });
    } catch (e) {
      console.error(e);
    }
  }

  // Nav counts load ONCE at startup; afterwards only mutation sites refresh
  // them (delete/create/sync handlers call loadNavStats directly).
  useEffect(() => {
    loadAll();
    void loadNavStats();
  }, []);

  // The usage badge alone refreshes on a 15-minute cadence (server caches the
  // ledger aggregation for the same window).
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch('/api/nav-stats');
        const data = await res.json();
        if (data.ok) {
          setNavStats((prev) => ({ ...prev, usageCostUsd: data.usageCostUsd ?? prev.usageCostUsd }));
        }
      } catch {
        /* keep previous figure */
      }
    }, 15 * 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (tab === 'workspace') loadUploads();
  }, [tab]);

  useEffect(() => {
    if (tab === 'settings' && localGrokEnabled) void fetchLocalModelOptions({ silent: true });
  }, [tab, localGrokEnabled]);

  useEffect(() => {
    if ((config as any)?.hasCloudAuth || (config as any)?.localGrokEnabled) loadModels();
  }, [(config as any)?.hasCloudAuth, (config as any)?.localGrokEnabled]);

  /**
   * A run hyperlink targets its agent's configuration + log. Execution traces
   * live on the Automations page. Cross-tab navigation remounts this component
   * (each path is its own route segment), so state set before router.push is
   * lost — the run id rides in the URL instead and the effects below hydrate
   * after mount.
   */
  function openRunTrace(runId: string) {
    router.push(`/automations?run=${encodeURIComponent(runId)}`);
  }

  /** Nested drill-in from run details → execution trace (keeps the stack). */
  function openExecutionTraceFromDetails(run: AgentRun) {
    setActiveRun(run);
    setLiveTrace(Array.isArray(run.trace) ? run.trace : []);
    setPreviewSelectedIdx(null);
    setShowTraceModal(true);
    // Intentionally keep runDetail + historyAgent so closing the trace returns
    // to details, and closing details returns to the run log.
  }

  function closeTraceModal() {
    setShowTraceModal(false);
    // Drop deep-link query so the URL effect does not reopen this trace.
    if (searchParams.get('run')) {
      router.replace(tabToPath('automations'));
    }
  }

  function closeRunDetail() {
    setRunDetail(null);
    setRunDetailLoading(false);
  }

  const [pendingRunAgent, setPendingRunAgent] = useState<{ agentId: string; agentName?: string } | null>(null);

  useEffect(() => {
    if (tab !== 'automations') return;
    const runId = searchParams.get('run');
    if (!runId) return;
    let cancelled = false;
    (async () => {
      try {
        // Runs list holds lightweight summaries — fetch the full trace here.
        const res = await fetch(`/api/runs?id=${encodeURIComponent(runId)}`);
        const data = await res.json();
        if (!data.ok || !data.run) throw new Error(data.error || 'Run not found');
        if (cancelled) return;
        setActiveRun(data.run);
        setLiveTrace(Array.isArray(data.run.trace) ? data.run.trace : []);
        setPreviewSelectedIdx(null);
        setPendingRunAgent({ agentId: data.run.agentId, agentName: data.run.agentName });
        setShowTraceModal(true); // deep link = explicit intent to see the trace
      } catch (e: unknown) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : 'Could not load run');
      }
    })();
    return () => { cancelled = true; };
  }, [tab, searchParams]);

  // Run deep links open the trace modal only — never the agent editor. This
  // effect just surfaces a note when the run's agent no longer exists.
  useEffect(() => {
    if (!pendingRunAgent || agents.length === 0) return;
    const agent =
      agents.find((a) => a.id === pendingRunAgent.agentId) ||
      agents.find((a) => a.name === pendingRunAgent.agentName);
    setPendingRunAgent(null);
    if (!agent) toast.info("This run's agent was deleted — its automation is retired. Showing the historical log.");
  }, [pendingRunAgent, agents]);

  // Per-agent run history (History button on agent cards)
  const [historyAgent, setHistoryAgent] = useState<Agent | null>(null);
  const [historyRuns, setHistoryRuns] = useState<RunSummaryLite[] | null>(null);

  async function openRunHistory(agent: Agent) {
    setHistoryAgent(agent);
    setHistoryRuns(null);
    try {
      const res = await fetch(`/api/runs?agentId=${encodeURIComponent(agent.id)}&limit=50`);
      const data = await res.json();
      let list: RunSummaryLite[] = data.ok ? (data.runs || []) : [];
      if (list.length === 0) {
        // Agent may have been re-created with a new id — fall back to name match.
        const all = await fetch('/api/runs?limit=200').then((r) => r.json()).catch(() => null);
        list = ((all?.ok && all.runs) || []).filter((r: RunSummaryLite) => r.agentName === agent.name);
      }
      setHistoryRuns(list);
    } catch {
      setHistoryRuns([]);
    }
  }

  // "View answer" quick look on run rows (final output without the full trace)
  const [answerRun, setAnswerRun] = useState<RunSummaryLite | null>(null);

  // Full run-details modal (automations run log) — prompt, trace, outcome,
  // tools, skills, side effects in one place.
  const [runDetail, setRunDetail] = useState<AgentRun | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);

  async function openRunDetails(runId: string) {
    setRunDetailLoading(true);
    try {
      const res = await fetch(`/api/runs?id=${encodeURIComponent(runId)}`);
      const data = await res.json();
      if (!data.ok || !data.run) throw new Error(data.error || 'Run not found');
      setRunDetail(data.run);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not load run');
    }
    setRunDetailLoading(false);
  }

  // Automations tab: what has actually run (scheduled executions), per agent
  const [scheduledRuns, setScheduledRuns] = useState<RunSummaryLite[] | null>(null);
  useEffect(() => {
    if (tab !== 'automations') return;
    let stale = false;
    (async () => {
      try {
        const res = await fetch('/api/runs?scheduledOnly=1&limit=200');
        const data = await res.json();
        if (!stale && data.ok) setScheduledRuns(data.runs || []);
      } catch {
        if (!stale) setScheduledRuns([]);
      }
    })();
    return () => { stale = true; };
  }, [tab]);

  // Agents CRUD
  async function refreshAgents() {
    const res = await fetch('/api/agents').then(r => r.json());
    setAgents(res.agents || []);
  }

  const [cloudAgentSyncing, setCloudAgentSyncing] = useState(false);

  async function syncCloudAgents() {
    setCloudAgentSyncing(true);
    try {
      const res = await fetch('/api/agents/cloud-sync', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Cloud agent sync failed');
      toast.success(data.message || 'Cloud agents synced');
      await refreshAgents();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Cloud agent sync failed');
    }
    setCloudAgentSyncing(false);
  }

  async function createOrUpdateAgent() {
    setLoading(true);
    try {
      // Empty string clears a previously saved agent voice (JSON omits undefined).
      const voiceRaw = typeof agentForm.voiceId === 'string' ? agentForm.voiceId.trim().toLowerCase() : '';
      const payload = {
        ...agentForm,
        voiceId: voiceRaw,
        schedules: schedulesForSave(agentForm.schedules || []),
      };
      const isEdit = !!editingAgent;
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isEdit ? { action: 'update', agent: { ...editingAgent, ...payload } } : payload),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      toast.success(isEdit ? 'Agent updated' : 'Agent created');
      setShowAgentModal(false);
      setEditingAgent(null);
      setHighlightScheduleIdx(null);
      await refreshAgents();
      await loadAll();
    } catch (e: any) { toast.error(e.message); }
    setLoading(false);
  }

  function openCreateAgent() {
    setEditingAgent(null);
    setAgentForm({
      name: 'Code Agent ' + (agents.length + 1),
      avatar: ALIEN_AVATARS[agents.length % ALIEN_AVATARS.length].id,
      origin: 'local',
      model: pickDefaultModel(),
      workspace: { path: config?.defaultWorkspace || process.cwd?.() || '', useWorktree: true },
      integrations: { ...EMPTY_INTEGRATION_SCOPE },
      peers: [],
      skills: [],
      chatSkill: '',
      voiceId: '',
      schedules: [enrichScheduleForForm({ ...defaultScheduleEntry(), instructions: 'Perform the scheduled task using your skills.' })],
    });
    setShowAgentModal(true);
  }

  /** Pre-fill a new agent from a project (workspace + instructions as chat skill). */
  function openCreateAgentFromProject(project: import('@/lib/project-types').Project) {
    const ws = resolveProjectWorkspace(project, config?.defaultWorkspace || defaultWorkspaceInput || '');
    const skill = (project.instructions || '').trim()
      || `You help build and maintain the "${project.name}" project. Follow the project goals, respect the workspace, and make focused changes.`;
    setEditingAgent(null);
    setAgentForm({
      name: `${project.name} Agent`,
      avatar: ALIEN_AVATARS[agents.length % ALIEN_AVATARS.length].id,
      origin: 'local',
      model: pickDefaultModel(),
      description: project.description || `Agent for project: ${project.name}`,
      workspace: { path: ws, useWorktree: true },
      integrations: { ...EMPTY_INTEGRATION_SCOPE },
      peers: [],
      skills: [],
      chatSkill: skill.slice(0, 4000),
      voiceId: '',
      schedules: [enrichScheduleForForm({
        ...defaultScheduleEntry(),
        enabled: false,
        instructions: `Advance the "${project.name}" project: explore the workspace, apply the project instructions, and implement the next clear step.`,
      })],
    });
    navigateToTab('agents');
    setShowAgentModal(true);
    toast.success('Agent draft ready — review and save');
  }

  function patchSchedule(idx: number, patch: Record<string, unknown>) {
    const news = [...(agentForm.schedules || [])];
    news[idx] = { ...news[idx], ...patch };
    setAgentForm({ ...agentForm, schedules: news });
  }

  function onSchedulePresetChange(idx: number, presetId: SchedulePresetId) {
    const sch = agentForm.schedules[idx];
    const time = sch._time || '09:00';
    const customCron = sch._customCron || sch.cron;
    patchSchedule(idx, {
      _preset: presetId,
      cron: presetToCron(presetId, time, customCron),
    });
  }

  function onScheduleTimeChange(idx: number, time: string) {
    const sch = agentForm.schedules[idx];
    const preset: SchedulePresetId = sch._preset || 'daily';
    patchSchedule(idx, {
      _time: time,
      cron: presetToCron(preset, time, sch._customCron),
    });
  }

  function agentSchedules(agent: Agent) {
    return agent.schedules?.length
      ? agent.schedules
      : agent.schedule
        ? [{ ...agent.schedule, id: 'legacy', instructions: agent.schedule.description || agent.description || 'Scheduled task' }]
        : [];
  }

  function resolveScheduledPrompt(agent: Agent, scheduleIndex?: number) {
    const scheds = agentSchedules(agent);
    const entry =
      scheduleIndex != null && scheds[scheduleIndex]
        ? scheds[scheduleIndex]
        : scheds.find((s) => s.enabled) || scheds[0];
    const instructions = entry?.instructions?.trim();
    return {
      prompt: instructions || agent.description?.trim() || `Run scheduled task for ${agent.name}.`,
      scheduleId: entry?.id,
      scheduleInstructions: instructions,
    };
  }

  function scheduleStats(agent: Agent) {
    const scheds = agentSchedules(agent);
    return {
      configured: scheds.length,
      active: scheds.filter((s) => s.enabled).length,
    };
  }

  function formatScheduleSummary(agent: Agent): string {
    const { configured, active } = scheduleStats(agent);
    const scheduleWord = configured === 1 ? 'schedule' : 'schedules';
    const sessionWord = active === 1 ? 'session' : 'sessions';
    return `${configured} configured ${scheduleWord}, ${active} active ${sessionWord}`;
  }

  function openEditAgent(a: Agent) {
    setEditingAgent(a);
    const norm = { ...a };
    if (!norm.skills) norm.skills = [];
    if (!norm.schedules || norm.schedules.length === 0) {
      norm.schedules = norm.schedule ? [{ id: 'legacy', enabled: norm.schedule.enabled, cron: norm.schedule.cron, instructions: norm.schedule.description || norm.description || 'Scheduled task' }] : [];
    }
    setAgentForm({
      ...norm,
      avatar: resolveAgentAvatar(norm),
      origin: norm.origin === 'cloud' ? 'cloud' : 'local',
      voiceId: typeof norm.voiceId === 'string' ? norm.voiceId : '',
      workspace: { ...norm.workspace },
      integrations: { ...norm.integrations },
      integrationOverrides: (norm as any).integrationOverrides ? JSON.parse(JSON.stringify((norm as any).integrationOverrides)) : {},
      driveFolders: [...((norm as any).driveFolders || [])],
      peers: [...(norm.peers || [])],
      schedules: (norm.schedules || []).map((s: any) => enrichScheduleForForm(s)),
    });
    setDriveFolderOptions(null); // reset the picker; user loads on demand
    setShowAgentModal(true);
  }

  // Load Grok TTS voices when the agent editor opens (for default voice picker).
  useEffect(() => {
    if (!showAgentModal) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/tts');
        const data = await res.json();
        if (cancelled || !data.ok || !Array.isArray(data.voices) || !data.voices.length) return;
        setAgentVoiceOptions(data.voices);
      } catch {
        /* keep built-in list */
      }
    })();
    return () => { cancelled = true; };
  }, [showAgentModal]);

  function openEditAgentSchedule(a: Agent, scheduleIndex = 0) {
    openEditAgent(a);
    setHighlightScheduleIdx(scheduleIndex);
  }

  useEffect(() => {
    if (!showAgentModal || highlightScheduleIdx === null) return;
    const scrollTimer = window.setTimeout(() => {
      const target = document.getElementById(`agent-schedule-${highlightScheduleIdx}`)
        || document.getElementById('agent-schedules-section');
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    const clearTimer = window.setTimeout(() => setHighlightScheduleIdx(null), 2800);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [showAgentModal, highlightScheduleIdx]);

  async function deleteAgent(id: string) {
    const agent = agents.find((a) => a.id === id);
    const ok = await confirmDialog({
      title: `Delete ${agent?.name || 'this agent'}?`,
      message: 'The agent and its automations are removed. Stored run history is kept.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await fetch('/api/agents', { method: 'POST', body: JSON.stringify({ action: 'delete', id }) });
    await refreshAgents();
    await loadNavStats();
    toast('Agent deleted');
  }

  type RunAgentOptions = {
    prompt?: string;
    /** Use configured schedule instructions — no popup (automations). */
    useScheduleInstructions?: boolean;
    scheduleIndex?: number;
  };

  function openRunModal(agent: Agent) {
    setRunModalAgent(agent);
    setRunModalPrompt('Explore the workspace and summarize what we can build here. Then propose next steps.');
    setShowRunModal(true);
  }

  type ExecuteRunScope = {
    stayOnTab?: boolean;
    projectId?: string;
  };

  function clearProjectRunTrace() {
    setActiveRun(null);
    setLiveTrace([]);
    setPreviewSelectedIdx(null);
    setPendingToolApproval(null);
  }

  async function executeAgentRun(
    agent: Agent,
    p: string,
    scheduled: boolean,
    scheduleId?: string,
    scheduleInstructions?: string,
    scope?: ExecuteRunScope,
  ) {
    // Live traces render on the Automations page (runs + execution live there)
    if (!scope?.stayOnTab) navigateToTab('automations');
    const runProjectId = scope?.projectId;
    setActiveRun(null);
    setLiveTrace([{
      ts: new Date().toISOString(),
      type: 'think',
      content: `Starting ${agent.name} on "${p}"...`,
    }]);
    setPreviewSelectedIdx(null);
    setPendingToolApproval(null);
    if (!runProjectId) setShowTraceModal(true); // watch the run live

    try {
      const res = await fetch('/api/execute/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: agent.id,
          prompt: p,
          scheduled,
          scheduleId,
          scheduleInstructions,
          projectId: runProjectId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';
      let run: AgentRun | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          for (const line of part.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            let event: {
              type: string;
              step?: any;
              run?: AgentRun;
              message?: string;
              approvalId?: string;
              toolName?: string;
              args?: Record<string, unknown>;
            };
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }

            if (event.type === 'trace' && event.step) {
              setLiveTrace((prev) => [...prev, event.step]);
              setActiveRun((prev) => {
                const base: AgentRun = prev || {
                  id: 'streaming',
                  agentId: agent.id,
                  agentName: agent.name,
                  prompt: p,
                  model: agent.model,
                  startedAt: new Date().toISOString(),
                  status: 'running',
                  trace: [],
                  sideEffects: [],
                  ...(runProjectId ? { projectId: runProjectId } : {}),
                };
                return {
                  ...base,
                  status: 'running',
                  projectId: runProjectId || base.projectId,
                  trace: [...(base.trace || []), event.step],
                };
              });
            } else if (event.type === 'approval_required' && event.approvalId) {
              setPendingToolApproval({
                approvalId: event.approvalId,
                toolName: event.toolName || 'tool',
                args: event.args || {},
              });
            } else if (event.type === 'run' && event.run) {
              run = event.run;
              setActiveRun(run);
              setLiveTrace(run.trace || []);
              setPendingToolApproval(null);
            } else if (event.type === 'error') {
              throw new Error(event.message || 'Stream error');
            }
          }
        }
      }

      if (!run) throw new Error('Agent run did not complete');
      await loadAll();
      toast.success(`Agent "${agent.name}" finished — ${run.status}`);
    } catch (e: any) {
      toast.error(e.message);
      setLiveTrace((prev) => [...prev, { type: 'error', content: e.message }]);
    }
  }

  async function runAgent(agent: Agent, options?: RunAgentOptions | string) {
    const opts: RunAgentOptions = typeof options === 'string' ? { prompt: options } : (options || {});
    let scheduled = false;
    let scheduleId: string | undefined;
    let scheduleInstructions: string | undefined;

    let p = opts.prompt?.trim();
    if (!p && opts.useScheduleInstructions) {
      const resolved = resolveScheduledPrompt(agent, opts.scheduleIndex);
      p = resolved.prompt;
      scheduleId = resolved.scheduleId;
      scheduleInstructions = resolved.scheduleInstructions;
      scheduled = true;
      if (!resolved.scheduleInstructions) {
        toast.error(`${agent.name} has no schedule instructions — add a schedule first.`);
        return;
      }
    }
    if (!p) {
      openRunModal(agent);
      return;
    }

    await executeAgentRun(agent, p, scheduled, scheduleId, scheduleInstructions);
  }

  async function submitRunModal() {
    if (!runModalAgent) return;
    const p = runModalPrompt.trim();
    if (!p) {
      toast.error('Enter instructions for the agent.');
      return;
    }
    setShowRunModal(false);
    const agent = runModalAgent;
    setRunModalAgent(null);
    await executeAgentRun(agent, p, false);
  }

  // Workspace explorer
  async function loadWorkspace(dir?: string) {
    const p = dir || wsPath || '';
    const res = await fetch(`/api/workspace?dir=${encodeURIComponent(p)}`);
    const data = await res.json();
    setWsFiles(data.files || []);
    if (data.resolved) setWsPath(data.resolved);
    await loadUploads();
  }

  async function loadUploads() {
    try {
      const res = await fetch('/api/workspace/sync');
      const data = await res.json();
      if (data.ok) {
        setWsUploads(data.uploads || []);
        setWsUploadsPath(data.uploadsPath || '');
        setCloudFiles(data.cloudFiles || []);
        setWsLastSync(data.lastSyncAt || null);
      }
      void loadNavStats();
    } catch {
      /* ignore */
    }
  }

  async function deleteWorkspaceUpload(name: string) {
    const ok = await confirmDialog({
      title: `Remove "${name}" from global uploads?`,
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
      await loadUploads();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function uploadWorkspaceFiles(fileList: FileList | File[]) {
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
      toast.success(`Uploaded ${data.saved?.length || 0} file(s) to global uploads`);
      await loadUploads();
    } catch (e: any) {
      toast.error(e.message);
    }
    setWsUploading(false);
  }

  function onWorkspaceDrop(e: React.DragEvent) {
    e.preventDefault();
    setWsDragging(false);
    if (e.dataTransfer.files?.length) uploadWorkspaceFiles(e.dataTransfer.files);
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
      await loadUploads();
    } catch (e: any) {
      toast.error(e.message);
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
      await loadUploads();
      await loadWorkspace();
    } catch (e: any) {
      toast.error(e.message);
    }
    setWsSyncing(null);
  }

  async function openFile(fpath: string) {
    setSelectedFile(fpath);
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'read', path: fpath })
      });
      const data = await res.json();
      setFileContent(data.content || JSON.stringify(data));
    } catch {
      setFileContent('(Preview) ' + fpath + '\n\n(Use agent tools or paste + Save)');
    }
  }

  async function saveWorkspaceFile() {
    if (!selectedFile) return;
    await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selectedFile, content: fileContent }) });
    toast.success('File saved');
  }

  // Integrations
  async function saveIntegration(which: string) {
    setIntSaving((s) => ({ ...s, [which]: true }));
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', which, creds: intCreds }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.integrations) {
        setIntCreds({ github: {}, slack: {}, googledrive: {}, discord: {}, x: {}, obsidian: { mode: 'local' }, ...data.integrations });
      }
      const label = getIntegrationMeta(which)?.label || which;
      toast.success(`${label} credentials saved`);
    } catch (e: any) {
      toast.error(e.message);
    }
    setIntSaving((s) => ({ ...s, [which]: false }));
  }

  async function deleteIntegration(which: string) {
    const label = getIntegrationMeta(which)?.label || which;
    const ok = await confirmDialog({
      title: `Remove ${label} credentials?`,
      message: 'Stored credentials for this integration are deleted from this machine. Agents lose access until you reconfigure it.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', which }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.integrations) {
        setIntCreds({ github: {}, slack: {}, googledrive: {}, discord: {}, x: {}, obsidian: { mode: 'local' }, ...data.integrations });
      }
      setIntTest((t: any) => ({ ...t, [which]: undefined }));
      await loadNavStats();
      toast.success(`${label} credentials removed`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Remove failed');
    }
  }

  async function testIntegration(which: string) {
    const res = await fetch('/api/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test', which, creds: intCreds }) });
    const data = await res.json();
    setIntTest((t: any) => ({ ...t, [which]: data }));
    if (data.ok) toast.success(`${which} connected`); else toast.error(`${which}: ${data.error || 'failed'}`);
  }

  // API Key
  async function saveApiKey() {
    if (!apiKeyInput || apiKeyInput.startsWith('••••')) return;
    const res = await fetch('/api/grok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'validate', key: apiKeyInput }) });
    const data = await res.json();
    if (data.ok) {
      toast.success('Grok API key validated & saved');
      await loadAll();
      await loadModels();
    } else {
      toast.error('Key validation failed: ' + (data.error || 'bad key'));
    }
  }

  async function quickValidate() {
    const res = await fetch('/api/grok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'validate', key: apiKeyInput }) });
    const data = await res.json();
    toast(data.ok ? 'Valid Grok key!' : 'Invalid: ' + data.error);
  }

  async function clearApiKey() {
    const ok = await confirmDialog({
      title: 'Clear the stored xAI API key?',
      message: 'Cloud Grok falls back to OAuth if connected — otherwise cloud models stop working until a key is saved again.',
      confirmLabel: 'Clear key',
      danger: true,
    });
    if (!ok) return;
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xaiApiKey: '' }),
    });
    setApiKeyInput('');
    toast.success('API key cleared');
    await loadAll();
    await loadModels();
  }

  async function saveManagementKey() {
    if (!managementKeyInput || managementKeyInput.startsWith('••••')) return;
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xaiManagementKey: managementKeyInput }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      toast.success('Management key saved — Usage will pull xAI billing data');
      setManagementKeyInput('••••••••');
      await loadAll();
    } else {
      toast.error(data.error || 'Failed to save management key');
    }
  }

  async function testManagementKey() {
    const key = managementKeyInput?.trim() || '';
    const usingSaved = !key || key.startsWith('••••');
    if (usingSaved && !(config as any)?.hasManagementKey) {
      toast.error('Paste a management key (or save one) before testing');
      return;
    }
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'testManagementKey',
          // Only send a real key; masked placeholder uses the saved secret server-side.
          ...(usingSaved ? {} : { key }),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        toast.success(data.note || 'Management key is valid');
      } else {
        toast.error(
          [data.error, data.note].filter(Boolean).join(' — ') || 'Management key test failed',
        );
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Management key test failed');
    }
  }

  async function clearManagementKey() {
    const ok = await confirmDialog({
      title: 'Clear the xAI Management key?',
      message: 'Account billing usage on the Usage page may fall back to inference-key access only.',
      confirmLabel: 'Clear key',
      danger: true,
    });
    if (!ok) return;
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xaiManagementKey: '' }),
    });
    setManagementKeyInput('');
    toast.success('Management key cleared');
    await loadAll();
  }

  async function refreshOAuthStatus() {
    try {
      const res = await fetch('/api/xai-oauth/status');
      const data = await res.json();
      if (data.ok) {
        setOauthStatus({
          connected: !!data.connected,
          expired: !!data.expired,
          email: data.email,
          displayName: data.displayName,
          error: data.error,
        });
      }
    } catch {
      /* ignore */
    }
  }

  function startOAuthStatusPolling() {
    stopOAuthPolling();
    oauthPollStartedRef.current = Date.now();
    oauthPollRef.current = setInterval(async () => {
      const started = oauthPollStartedRef.current;
      if (!started || Date.now() - started > OAUTH_POLL_MAX_MS) {
        stopOAuthPolling();
        return;
      }
      try {
        const res = await fetch('/api/xai-oauth/status');
        const data = await res.json();
        if (data.ok && data.connected) {
          await handleOAuthConnected('Signed in with X (OAuth)');
        }
      } catch {
        /* keep polling */
      }
    }, OAUTH_POLL_MS);
  }

  async function startOAuthLogin() {
    setOauthStarting(true);
    // The popup MUST open synchronously with the click — blockers kill
    // window.open calls made after an await. It starts blank and is pointed
    // at accounts.x.ai once the PKCE flow is prepared; the callback page
    // postMessages back and closes itself, so nothing is ever pasted.
    const popup = window.open('about:blank', 'shiba-oauth', 'width=520,height=760,menubar=no,toolbar=no,location=yes');
    oauthPopupRef.current = popup;
    try {
      const res = await fetch('/api/xai-oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const data = await res.json();
      if (!data.ok || !data.authorizeUrl) throw new Error(data.error || 'Failed to start OAuth');
      if (popup && !popup.closed) {
        popup.location.href = data.authorizeUrl;
        popup.focus();
        startOAuthStatusPolling();
        toast.success('Approve the sign-in in the popup — this window updates by itself');
      } else {
        // Popup blocked → same-tab redirect; the callback page routes back here.
        window.location.assign(data.authorizeUrl);
        return;
      }
    } catch (e: unknown) {
      try { popup?.close(); } catch { /* already gone */ }
      toast.error(e instanceof Error ? e.message : 'OAuth start failed');
    }
    setOauthStarting(false);
  }

  async function startGoogleDriveLogin() {
    // Persist the client id/secret first so the server can build the flow.
    await saveIntegration('googledrive');
    setDriveStarting(true);
    const popup = window.open('about:blank', 'shiba-drive-oauth', 'width=520,height=760,menubar=no,toolbar=no,location=yes');
    drivePopupRef.current = popup;
    try {
      const res = await fetch('/api/google-oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const data = await res.json();
      if (!data.ok || !data.authorizeUrl) throw new Error(data.error || 'Failed to start Google sign-in');
      if (popup && !popup.closed) {
        popup.location.href = data.authorizeUrl;
        popup.focus();
        toast.success('Approve access in the Google popup — this window updates by itself');
      } else {
        window.location.assign(data.authorizeUrl);
        return;
      }
    } catch (e: unknown) {
      try { popup?.close(); } catch { /* gone */ }
      toast.error(e instanceof Error ? e.message : 'Google sign-in failed');
    }
    setDriveStarting(false);
  }

  async function disconnectGoogleDrive() {
    const ok = await confirmDialog({
      title: 'Disconnect Google Drive?',
      message: 'The captured tokens are removed. Your saved OAuth client ID/secret stay so you can sign in again.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    await fetch('/api/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect-drive' }) });
    setIntTest((t: any) => ({ ...t, googledrive: undefined }));
    toast.success('Google Drive disconnected');
    await loadAll();
  }

  async function exchangeOAuthCallback() {
    if (!oauthCallbackInput.trim()) return;
    try {
      const res = await fetch('/api/xai-oauth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback: oauthCallbackInput.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Exchange failed');
      setOauthCallbackInput('');
      await handleOAuthConnected();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'OAuth exchange failed');
    }
  }

  async function disconnectOAuth() {
    const ok = await confirmDialog({
      title: 'Disconnect OAuth with X?',
      message: 'Cloud features will fall back to your API key if one is configured.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    stopOAuthPolling();
    await fetch('/api/xai-oauth/logout', { method: 'POST' });
    setOauthStatus({ connected: false, expired: false });
    toast.success('OAuth disconnected');
    await loadAll();
    await loadModels();
  }

  async function saveCloudAuthMode(mode: 'api_key' | 'oauth') {
    setCloudAuthMode(mode);
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudAuthMode: mode }),
    });
    const data = await res.json();
    if (data.ok) {
      setConfig((c: any) => ({ ...c, cloudAuthMode: mode, activeCloudSource: data.activeCloudSource }));
      toast.success(mode === 'oauth' ? 'Using OAuth for cloud Grok' : 'Using API key for cloud Grok');
      await loadModels();
    }
  }

  async function saveLocalGrokSettings() {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localGrokEnabled, localGrokBaseUrl }),
    });
    const data = await res.json();
    if (!data.ok) {
      toast.error('Failed to save local model settings');
      return;
    }
    setConfig((c: any) => ({ ...c, localGrokEnabled, localGrokBaseUrl }));
    toast.success(localGrokEnabled ? 'Local models enabled' : 'Local models disabled');
    await loadModels();
  }

  function localIdOf(model: { id?: string; label?: string }): string {
    return String(model.label || model.id || '').replace(/^local:/, '');
  }

  /** Ask the local server what it currently offers (raw list, before the allowlist). */
  async function fetchLocalModelOptions(opts?: { silent?: boolean }) {
    setLocalModelsFetching(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'testLocalGrok', localGrokBaseUrl }),
      });
      const data = await res.json();
      if (data.ok) {
        setLocalGrokReachable(true);
        setLocalModelOptions(((data.models || []) as Array<{ id?: string; label?: string }>).map(localIdOf).filter(Boolean));
        if (!opts?.silent) toast.success(`Local server reachable — ${data.models?.length || 0} model(s) found`);
      } else {
        setLocalGrokReachable(false);
        setLocalModelOptions([]);
        if (!opts?.silent) toast.error(data.error || 'Local server not reachable');
      }
      return !!data.ok;
    } catch {
      setLocalGrokReachable(false);
      setLocalModelOptions([]);
      return false;
    } finally {
      setLocalModelsFetching(false);
    }
  }

  async function testLocalGrok() {
    const ok = await fetchLocalModelOptions();
    if (ok) await loadModels();
  }

  async function saveLocalModelAllowlist(next: string[]) {
    setLocalModelAllowlist(next);
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localModelAllowlist: next }),
      });
      await loadModels();
    } catch {
      toast.error('Failed to save model availability');
    }
  }

  function toggleLocalModelAllowed(id: string) {
    // Empty allowlist means "everything available" — expand it before editing.
    const effective = localModelAllowlist.length ? [...localModelAllowlist] : [...localModelOptions];
    const next = effective.includes(id) ? effective.filter((m) => m !== id) : [...effective, id];
    const coversAll = localModelOptions.length > 0 && localModelOptions.every((m) => next.includes(m));
    void saveLocalModelAllowlist(coversAll ? [] : next);
  }

  async function saveDefaultWorkspace() {
    const path = defaultWorkspaceInput.trim();
    if (!path) {
      toast.error('Enter or browse to a workspace folder');
      return;
    }
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultWorkspace: path }),
    });
    const data = await res.json();
    if (!data.ok) {
      toast.error('Failed to save default workspace');
      return;
    }
    setConfig((c: any) => ({ ...c, defaultWorkspace: path }));
    setWsPath(path);
    toast.success('Default workspace saved');
    await loadUploads();
  }

  async function resolveToolApproval(approvalId: string, approved: boolean) {
    try {
      await fetch('/api/execute/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, approved }),
      });
      setPendingToolApproval(null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Approval failed');
    }
  }

  async function saveAgentBehaviorSettings() {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolApprovalMode, globalInstructions: globalInstructionsInput, useAgentsMd }),
    });
    const data = await res.json();
    if (!data.ok) {
      toast.error('Failed to save agent behavior settings');
      return;
    }
    setConfig((c: any) => ({ ...c, toolApprovalMode, globalInstructions: globalInstructionsInput, useAgentsMd }));
    toast.success('Agent behavior settings saved');
  }

  async function saveDefaultModel() {
    if (!defaultModelInput) {
      toast.error('Select a default model first');
      return;
    }
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultGrokModel: defaultModelInput }),
    });
    const data = await res.json();
    if (!data.ok) {
      toast.error('Failed to save default model');
      return;
    }
    setConfig((c: any) => ({ ...c, defaultGrokModel: defaultModelInput }));
    setChatModel(defaultModelInput);
    toast.success(`Default model set to ${defaultModelInput}`);
  }

  async function saveDefaultTtsVoice() {
    const voice = (defaultTtsVoiceInput || DEFAULT_TTS_VOICE).trim().toLowerCase() || DEFAULT_TTS_VOICE;
    const speed = clampTtsSpeed(defaultTtsSpeedInput);
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultTtsVoice: voice, defaultTtsSpeed: speed }),
    });
    const data = await res.json();
    if (!data.ok) {
      toast.error('Failed to save default voice settings');
      return;
    }
    setDefaultTtsVoiceInput(voice);
    setDefaultTtsSpeedInput(speed);
    setConfig((c: any) => ({ ...c, defaultTtsVoice: voice, defaultTtsSpeed: speed }));
    try {
      window.localStorage.setItem('shiba-tts-voice', voice);
      window.localStorage.setItem('shiba-tts-speed', String(speed));
    } catch { /* private mode */ }
    const label = agentVoiceOptions.find((v) => v.id === voice)?.name
      || GROK_TTS_VOICES.find((v) => v.id === voice)?.name
      || voice;
    const speedLabel = GROK_TTS_SPEEDS.find((s) => Math.abs(s.value - speed) < 0.01)?.label || `${speed}×`;
    toast.success(`Default voice ${label} · ${speedLabel}`);
  }

  // Load TTS voices when Settings is open (default voice picker).
  useEffect(() => {
    if (tab !== 'settings') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/tts');
        const data = await res.json();
        if (cancelled || !data.ok || !Array.isArray(data.voices) || !data.voices.length) return;
        setAgentVoiceOptions(data.voices);
      } catch {
        /* keep built-in list */
      }
    })();
    return () => { cancelled = true; };
  }, [tab]);

  // Schedule run from UI
  /** Flip one schedule entry's Active/Paused state — each cron row has its own pill. */
  async function toggleScheduleEntry(agent: Agent, index: number) {
    const current = agentSchedules(agent);
    const nextEnabled = !current[index]?.enabled;
    const scheds = current.map((s, i) => (i === index ? { ...s, enabled: nextEnabled } : s));
    await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', agent: { ...agent, schedules: scheds, schedule: undefined } }),
    });
    await refreshAgents();
    toast(nextEnabled ? 'Schedule activated' : 'Schedule paused');
  }

  /** Delete a single schedule entry; the agent and its other automations stay. */
  async function deleteScheduleEntry(agent: Agent, index: number) {
    const entry = agentSchedules(agent)[index];
    const ok = await confirmDialog({
      title: 'Delete this automation?',
      message: `${describeCron(entry?.cron || '')} — ${agent.name} keeps any other schedules and can still be run manually.`,
      confirmLabel: 'Delete automation',
      danger: true,
    });
    if (!ok) return;
    const scheds = agentSchedules(agent).filter((_, i) => i !== index);
    await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', agent: { ...agent, schedules: scheds, schedule: undefined } }),
    });
    await refreshAgents();
    await loadNavStats();
    toast('Automation deleted');
  }

  // Seed a sample agent if none
  useEffect(() => {
    if (agents.length === 0 && config) {
      // seed one demo
      (async () => {
        await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          name: 'Explorer Agent', model: config?.defaultGrokModel || pickDefaultModel(), description: 'Default exploration + automation agent',
          workspace: { path: config.defaultWorkspace || '.', useWorktree: true },
          integrations: { ...EMPTY_INTEGRATION_SCOPE },
          peers: [], schedule: { enabled: true, cron: '0 */2 * * *' }
        }) });
        await refreshAgents();
      })();
    }
  }, [agents.length, config]);

  // Poll runs occasionally
  useEffect(() => {
    const t = setInterval(() => { loadAll(); }, 22000);
    return () => clearInterval(t);
  }, []);

  // Keep sidebar/footer commit SHA in sync with the tree Node is actually serving.
  useEffect(() => {
    void refreshRuntimeVersion();
    const t = setInterval(() => { void refreshRuntimeVersion(); }, 15_000);
    return () => clearInterval(t);
  }, []);

  const currentAgent = agents[0];

  const paletteCommands = useMemo((): CommandPaletteItem[] => {
    const nav: CommandPaletteItem[] = ([
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'chat', label: 'Grok Chat' },
      { id: 'projects', label: 'Projects' },
      { id: 'agents', label: 'Agents' },
      { id: 'workspace', label: 'Workspace' },
      { id: 'automations', label: 'Automations' },
      { id: 'integrations', label: 'Capabilities' },
      { id: 'usage', label: 'Usage' },
      { id: 'logs', label: 'Logs' },
      { id: 'settings', label: 'Settings' },
    ] as const).map((t) => ({
      id: `nav-${t.id}`,
      label: `Go to ${t.label}`,
      group: 'Navigate',
      keywords: [t.id, t.label],
      run: () => navigateToTab(t.id),
    }));

    const agentCmds: CommandPaletteItem[] = agents.flatMap((a) => [
      {
        id: `run-${a.id}`,
        label: `Run ${a.name}`,
        hint: 'Execute agent',
        group: 'Agents',
        keywords: ['run', 'execute', a.name],
        run: () => void runAgent(a),
      },
      {
        id: `edit-${a.id}`,
        label: `Edit ${a.name}`,
        group: 'Agents',
        keywords: ['edit', a.name],
        run: () => openEditAgent(a),
      },
    ]);

    return [
      ...nav,
      {
        id: 'new-agent',
        label: 'New Agent',
        group: 'Actions',
        keywords: ['create', 'agent'],
        run: () => openCreateAgent(),
      },
      {
        id: 'new-chat',
        label: 'New Chat Session',
        group: 'Actions',
        keywords: ['chat', 'session'],
        run: () => navigateToTab('chat'),
      },
      {
        id: 'sync',
        label: 'Sync Data',
        hint: 'Reload agents, runs, config',
        group: 'Actions',
        keywords: ['refresh', 'reload'],
        run: () => void loadAll(),
      },
      {
        id: 'terminal',
        label: 'Open Terminal',
        hint: 'Real host PTY (Ctrl+`)',
        group: 'Actions',
        keywords: ['terminal', 'shell', 'bash', 'pty', 'console'],
        run: () => setTerminalOpen(true),
      },
      ...agentCmds,
    ];
  }, [agents, navigateToTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      }
      // Ctrl+` is also handled in StudioTerminal; keep palette-only here to avoid double-toggle.
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Escape closes the topmost modal only (stack: trace → details → run log).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showTraceModal) {
        closeTraceModal();
      } else if (showAgentModal) {
        setShowAgentModal(false);
        setEditingAgent(null);
        setHighlightScheduleIdx(null);
      } else if (showRunModal) {
        setShowRunModal(false);
        setRunModalAgent(null);
      } else if (showSyncModal) {
        setShowSyncModal(false);
      } else if (folderBrowseFor !== null) {
        setFolderBrowseFor(null);
      } else if (answerRun) {
        setAnswerRun(null);
      } else if (runDetail || runDetailLoading) {
        closeRunDetail();
      } else if (historyAgent) {
        setHistoryAgent(null);
        setHistoryRuns(null);
      } else if (mobileNavOpen) {
        setMobileNavOpen(false);
      }
      // Do not bind Escape to the host terminal — real PTY apps (vim/less)
      // need Escape. Use Ctrl+` or the panel chrome to close.
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [showTraceModal, showAgentModal, showRunModal, showSyncModal, folderBrowseFor, mobileNavOpen, answerRun, historyAgent, runDetail, runDetailLoading, searchParams]);

  // Dynamic document titles (C7) — tabs are distinguishable in the browser.
  useEffect(() => {
    document.title = `${TAB_LABELS[tab] || 'Shiba Studio'} — Shiba Studio`;
  }, [tab]);

  return (
    <div className="app-root flex h-screen overflow-hidden bg-shell text-primary">
      {/* Sidebar — fixed on desktop, slide-over drawer on mobile */}
      {mobileNavOpen && (
        <div className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden />
      )}
      <div
        className={`sidebar w-64 flex-shrink-0 flex flex-col ${mobileNavOpen ? 'sidebar-open' : ''} ${navCollapsed ? 'sidebar-collapsed' : ''}`}
        onClickCapture={(e) => {
          const el = e.target as HTMLElement;
          if (el.closest('a, .multitask-item, .multitask-section-head')) setMobileNavOpen(false);
        }}
      >
        <div className={`py-5 border-b border-default ${navCollapsed ? 'px-2' : 'px-5'}`}>
          <div className="flex items-center gap-3">
            <Link href="/" className={`flex items-center gap-3 brand-home-link min-w-0 ${navCollapsed ? 'mx-auto' : 'flex-1'}`} title="Go to Dashboard">
              <img src={THEME_IDENTITY.logoPath} alt={THEME_IDENTITY.logoAlt} className="brand-logo" width={36} height={36} />
              {!navCollapsed && (
                <div className="min-w-0">
                  <div className="font-semibold tracking-tighter text-xl logo-text truncate">{THEME_IDENTITY.brandName}</div>
                  <div
                    className="text-[10px] text-dim -mt-1 font-mono"
                    title={
                      `Source commit of the code this server is running`
                      + (runtimeVersion.commitFull ? `\n${runtimeVersion.commitFull}` : '')
                      + (runtimeVersion.dirty ? '\nWorking tree has uncommitted changes' : '')
                      + (runtimeVersion.root ? `\n${runtimeVersion.root}` : '')
                    }
                  >
                    {runtimeVersion.commit}{runtimeVersion.dirty ? '*' : ''}
                  </div>
                </div>
              )}
            </Link>
            {!navCollapsed && (
              <button
                type="button"
                onClick={toggleNavCollapsed}
                className="nav-collapse-btn shrink-0"
                title="Collapse the navigation"
                aria-label="Collapse navigation"
              >
                <ChevronsLeft size={15} />
              </button>
            )}
          </div>
          {navCollapsed && (
            <button
              type="button"
              onClick={toggleNavCollapsed}
              className="nav-collapse-btn mx-auto mt-3 flex"
              title="Expand the navigation"
              aria-label="Expand navigation"
            >
              <ChevronsRight size={15} />
            </button>
          )}
        </div>

        {/* Main menu — always fully visible, never scrolls */}
        <div className="px-2 py-3 flex-shrink-0">
          {([
            { id: 'dashboard', label: 'Dashboard', icon: Home, stat: null as string | null },
            { id: 'chat', label: 'Grok Chat', icon: MessageSquare, stat: navStats.chatSessions > 0 ? String(navStats.chatSessions) : null },
            { id: 'projects', label: 'Projects', icon: FolderKanban, stat: navStats.projects > 0 ? String(navStats.projects) : null },
            { id: 'agents', label: 'Agents', icon: Users, stat: agents.length > 0 ? String(agents.length) : null },
            { id: 'workspace', label: 'Workspace', icon: FolderOpen, stat: navStats.workspaceFiles > 0 ? String(navStats.workspaceFiles) : null },
            { id: 'automations', label: 'Automations', icon: Clock, stat: navStats.automationsScheduled > 0 ? String(navStats.automationsScheduled) : null },
            { id: 'integrations', label: 'Capabilities', icon: Plug, stat: navStats.integrationsConfigured > 0 ? String(navStats.integrationsConfigured) : null },
            { id: 'usage', label: 'Usage', icon: BarChart3, stat: navStats.usageCostUsd > 0 ? formatUsageCostUsd(navStats.usageCostUsd) : null },
            { id: 'logs', label: 'Logs', icon: ScrollText, stat: null },
            { id: 'settings', label: 'Settings', icon: Settings, stat: null },
          ] as const).map(item => {
            const Icon = item.icon;
            const active = tab === item.id;
            const linkHref = item.id === 'chat' ? chatNavHref : tabToPath(item.id as AppTab);
            return (
              <Link
                key={item.id}
                href={linkHref}
                className={`nav-item ${active ? 'active' : ''} ${navCollapsed ? 'nav-item-collapsed' : ''}`}
                title={navCollapsed ? item.label : undefined}
              >
                <Icon size={16} className="nav-item-icon" aria-hidden />
                <span className="nav-item-label">{item.label}</span>
                {!navStatsLoaded && item.id !== 'dashboard' && item.id !== 'settings' && item.id !== 'agents' && item.id !== 'logs' && (
                  <span className="data-spinner nav-item-meta ml-auto" aria-label={`Loading ${item.label} count`} />
                )}
                {item.stat != null && (
                  <span className={`nav-stat-badge nav-item-meta ${item.id === 'usage' ? 'nav-stat-badge-cost' : ''}`} title={
                    item.id === 'chat' ? `${item.stat} open session(s)`
                    : item.id === 'projects' ? `${item.stat} project(s)`
                    : item.id === 'workspace' ? `${item.stat} file(s) in workspace`
                    : item.id === 'automations' ? `${item.stat} scheduled automation(s)`
                    : item.id === 'integrations' ? `${item.stat} configured integration(s)`
                    : item.id === 'usage' ? `${formatUsageCostUsd(navStats.usageCostUsd)} consumed`
                    : undefined
                  }>
                    {item.stat}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        {/* Minimized Grok Voice — docks cleanly under primary nav */}
        <VoiceAgentNavDock navCollapsed={navCollapsed} />

        {!navCollapsed && (
          <MultitaskSidebar
            agents={agents}
            onNavigate={(next, extra) => {
              navigateToTab(next);
              if (extra?.sessionId) navigateToChatSession(extra.sessionId);
            }}
            onDataChanged={() => { void refreshAgents(); void loadNavStats(); }}
          />
        )}

        {!navCollapsed && (
          <div className={`sidebar-foot p-4 border-t border-default text-xs text-dim ${process.env.NODE_ENV === 'development' ? 'sidebar-foot-dev' : ''}`}>
            <div className="pl-3">localhost • Cloud + local models</div>
            <div className="mt-1 pl-3 text-[10px]">Chat that acts • agents that run while you sleep</div>
          </div>
        )}
      </div>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Animated deep-space scene — behind every page, pure CSS, honors reduced-motion */}
        <div className="space-scene space-scene-app" aria-hidden>
          <div className="space-stars space-stars-far" />
          <div className="space-stars space-stars-mid" />
          <div className="space-stars space-stars-near" />
          <div className="space-nebula" />
          <div className="space-comet" />
          <div className="space-comet space-comet-2" />
        </div>
        {/* Top bar */}
        <div className="top-bar h-14 px-3 sm:px-5 flex items-center justify-between relative z-[1]">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              type="button"
              className="grok-btn grok-btn-ghost sidebar-toggle p-1.5"
              onClick={() => setMobileNavOpen(true)}
              title="Open navigation"
              aria-label="Open navigation"
            >
              <Menu size={18} />
            </button>
            <div className="font-medium text-sm tracking-tight">{TAB_LABELS[tab] || tab}</div>
            {/* Readiness — one badge per model source */}
            <div className="readiness-badges hidden sm:flex items-center gap-1.5">
              <div
                className={`status-pill ${(config as any)?.hasKey ? 'text-success' : 'status-pill-off'}`}
                title={(config as any)?.hasKey
                  ? `xAI API key configured${(config as any)?.activeCloudSource !== 'oauth' ? ' — active cloud source' : ''}`
                  : 'No xAI API key — add one in Settings'}
              >
                XAI TOKEN{(config as any)?.hasKey ? '' : ' · OFF'}
              </div>
              <div
                className={`status-pill ${oauthStatus.connected ? 'text-success' : 'status-pill-off'}`}
                title={oauthStatus.connected
                  ? `Signed in with X (OAuth 2.0)${(config as any)?.activeCloudSource === 'oauth' ? ' — active cloud source' : ''}`
                  : 'OAuth 2.0 not connected — sign in with X from Settings'}
              >
                OAUTH 2.0{oauthStatus.connected ? '' : ' · OFF'}
              </div>
              <div
                className={`status-pill ${grokCliStatus?.installed ? 'text-success' : 'status-pill-off'}`}
                title={grokCliStatus?.installed
                  ? `Grok CLI on this machine${grokCliStatus.version ? ` — ${grokCliStatus.version}` : ''}. Route chats through it with the composer's terminal toggle.`
                  : 'Grok CLI not detected on this machine'}
              >
                GROK CLI{grokCliStatus?.installed
                  ? (grokCliStatus.version ? ` · ${grokCliStatus.version.replace(/^grok\s*/i, '').split(' ')[0]}` : '')
                  : ' · OFF'}
              </div>
              <div
                className={`status-pill ${(config as any)?.localGrokEnabled ? (localGrokReachable ? 'text-success' : 'text-warning') : 'status-pill-off'}`}
                title={(config as any)?.localGrokEnabled
                  ? (localGrokReachable ? 'Local model server reachable' : 'Local models enabled but the server is not responding')
                  : 'Local models disabled — enable an OpenAI-compatible server in Settings'}
              >
                LOCAL{(config as any)?.localGrokEnabled ? (localGrokReachable ? '' : ' · OFFLINE') : ' · OFF'}
              </div>
            </div>
            {/* Compact summary for the smallest screens */}
            <div className="sm:hidden">
              {(config as any)?.hasCloudAuth || ((config as any)?.localGrokEnabled && localGrokReachable)
                ? <div className="status-pill text-success">READY</div>
                : <div className="status-pill text-warning">NO MODEL SOURCE</div>}
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {/* Chat quota — spend as a share of the monthly budget */}
            {tab === 'chat' && navStats.usageBudgetUsd > 0 && (() => {
              const pct = Math.min(999, (navStats.usageCostUsd / navStats.usageBudgetUsd) * 100);
              const tone = pct >= 90 ? 'text-error' : pct >= 60 ? 'text-warning' : 'text-success';
              return (
                <div
                  className={`status-pill ${tone}`}
                  title={`${formatUsageCostUsd(navStats.usageCostUsd)} used of your $${navStats.usageBudgetUsd}/month quota (set it in Settings). Refreshes every 15 minutes.`}
                >
                  QUOTA {pct < 0.05 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)}%
                </div>
              );
            })()}
            <button
              type="button"
              onClick={() => setShowCommandPalette(true)}
              className="grok-btn grok-btn-ghost hidden sm:inline-flex items-center gap-1.5"
              title="Command palette (Ctrl+K)"
            >
              <Command size={14} /> <span className="text-dim text-xs">Ctrl+K</span>
            </button>
            <button
              type="button"
              onClick={() => toggleTerminalOpen()}
              className={`grok-btn grok-btn-ghost inline-flex items-center gap-1.5 ${showTerminal ? 'ring-1 ring-border-light' : ''}`}
              title="Host terminal (Ctrl+`)"
            >
              <Terminal size={14} /> <span className="hidden sm:inline">Terminal</span>
            </button>
            <button onClick={() => setShowSyncModal(true)} className="grok-btn grok-btn-ghost"><RefreshCw size={14}/> <span className="hidden sm:inline">Sync</span></button>
            <button onClick={() => void startNewChat()} className="grok-btn grok-btn-secondary" title="Start a fresh Grok chat session">
              <MessageSquare size={14}/> <span className="hidden sm:inline">New Chat</span>
            </button>
            <button onClick={openCreateAgent} className="grok-btn grok-btn-primary"><Plus size={15}/> <span className="hidden sm:inline">New Agent</span></button>
          </div>
        </div>

        {/* Content surfaces — workspace locks outer scroll; lists scroll inside */}
        <div
          className={
            tab === 'workspace'
              ? 'flex-1 min-h-0 overflow-hidden p-3 sm:p-5 relative z-[1] flex flex-col'
              : 'flex-1 overflow-auto p-3 sm:p-5 space-y-5 relative z-[1]'
          }
        >
          {/* DASHBOARD */}
          {tab === 'dashboard' && (
            <div className="relative dashboard-page">
            <div className="space-y-5 relative z-[1]">
              {/* First-run: nothing connected yet → one-click OAuth, no key hunting */}
              {config && !(config as any).hasCloudAuth && !oauthStatus.connected && !welcomeDismissed && (
                <div className="grok-card p-6 relative">
                  <button
                    type="button"
                    className="grok-btn grok-btn-ghost p-1 absolute top-3 right-3"
                    onClick={() => { setWelcomeDismissed(true); try { window.localStorage.setItem('shiba-welcome', 'dismissed'); } catch { /* private mode */ } }}
                    title="Dismiss — you can always connect from Settings"
                    aria-label="Dismiss welcome banner"
                  >
                    <X size={14} />
                  </button>
                  <div className="text-xl font-semibold tracking-tight">Connect Grok in one click</div>
                  <div className="text-sm text-muted mt-1.5 max-w-2xl">
                    Sign in with your X account — a popup opens the official <span className="font-mono">accounts.x.ai</span> login
                    and closes itself when done. Tokens are cached encrypted on this machine and refresh automatically,
                    and your SuperGrok / Premium+ quota is used. No API keys to create, copy, or paste.
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button onClick={startOAuthLogin} disabled={oauthStarting} className="grok-btn grok-btn-primary">
                      {oauthStarting ? 'Opening accounts.x.ai…' : '🔑 Sign in with X'}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateToTab('settings')}
                      className="text-xs text-dim underline underline-offset-2 hover:text-primary"
                    >
                      or paste an xAI API key in Settings
                    </button>
                  </div>
                </div>
              )}
              <div className="flex flex-col lg:flex-row gap-4">
                <div className="grok-card p-6 flex-1">
                  <div className="hero-eyebrow">{THEME_IDENTITY.heroEyebrow}</div>
                  <div className="mt-2 text-4xl font-semibold tracking-tighter">{THEME_IDENTITY.heroTitle}</div>
                  <div className="mt-3 text-muted">{THEME_IDENTITY.heroSubtitle}</div>
                  <div className="mt-5 flex gap-3">
                    <button onClick={() => navigateToTab('agents')} className="grok-btn grok-btn-primary">Open Agents</button>
                    <button onClick={() => navigateToTab('chat')} className="grok-btn grok-btn-secondary">Talk to Grok</button>
                  </div>
                </div>
                <div className="grok-card p-5 w-full lg:w-80 text-sm">
                  <div className="font-semibold mb-3">Quick Stats</div>
                  <div className="grid grid-cols-2 gap-y-3 text-xs">
                    <div>Agents</div><div className="font-mono text-right">{agents.length}</div>
                    <div>Runs (stored)</div><div className="font-mono text-right">{runs.length}</div>
                    <div>Active schedules</div><div className="font-mono text-right">{agents.filter(a => (a.schedules||[]).some((s:any)=>s.enabled) || (a.schedule && a.schedule.enabled)).length}</div>
                    <div>Connected</div><div className="font-mono text-right text-success">Grok only</div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-default text-[11px] text-dim">{THEME_IDENTITY.sidebarTagline} — local agents with git worktrees.</div>
                </div>
              </div>

              <div>
                <div className="flex justify-between items-center mb-3 gap-2 flex-wrap">
                  <div className="page-section-title mb-0">
                    Recent Agent Runs
                    <InfoHint text="Click a row to open the run's full execution log and its agent's configuration. 'view answer' shows just the final output." />
                  </div>
                  <button onClick={() => navigateToTab('agents')} className="text-xs link-accent">All agents →</button>
                </div>
                {runs.length === 0 ? (
                  <div className="text-dim text-sm">No runs yet — create an agent and press Run.</div>
                ) : (
                  <div className="grok-card runs-table-wrap">
                    <table className="runs-table w-full text-xs">
                      <thead>
                        <tr>
                          <th className="runs-col-agent">Agent</th>
                          <th>Prompt</th>
                          <th className="runs-col-status">Status</th>
                          <th className="runs-col-model">Model</th>
                          <th className="runs-col-started">Started</th>
                          <th className="runs-col-answer"><span className="sr-only">Answer</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.slice(0, 10).map(r => {
                          const runAgent = agents.find(a => a.id === r.agentId);
                          return (
                            <tr
                              key={r.id}
                              onClick={() => void openRunTrace(r.id)}
                              title="Open run trace"
                            >
                              <td>
                                <span className="flex items-center gap-2 min-w-0">
                                  <img
                                    src={runAgent ? resolveAgentAvatarPath(runAgent) : MISSING_AGENT_AVATAR_PATH}
                                    alt=""
                                    className="agent-avatar-xs shrink-0"
                                    width={18}
                                    height={18}
                                    title={runAgent ? undefined : 'This agent has since been deleted'}
                                  />
                                  <span className="truncate font-medium">{r.agentName}</span>
                                </span>
                              </td>
                              <td className="text-muted"><span className="line-clamp-1" title={r.prompt}>{r.prompt}</span></td>
                              <td><span className={`run-status run-status-${r.status}`}>{r.status}</span></td>
                              <td className="text-dim runs-model" title={modelDisplayName(r.model)}>{modelDisplayName(r.model)}</td>
                              <td className="text-dim runs-started">{new Date(r.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                              <td className="runs-col-answer">
                                {r.finalOutput ? (
                                  <button
                                    type="button"
                                    className="link-accent text-[11px] whitespace-nowrap inline-flex items-center gap-1"
                                    onClick={(e) => { e.stopPropagation(); setAnswerRun(r); }}
                                    title="View this run's final answer"
                                  >
                                    <Eye size={11} /> view answer
                                  </button>
                                ) : (
                                  <span className="text-dim">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
            </div>
          )}

          {/* GROK CHAT — keep mounted while voice is active so mic/TTS keep running off-tab.
              Freeze the bound session id off-chat so pathname changes don't remount the engine. */}
          {(tab === 'chat' || voiceAgentActive) && (
            <div
              className={tab === 'chat' ? undefined : 'voice-agent-chat-keepalive'}
              aria-hidden={tab !== 'chat'}
              style={tab === 'chat' ? undefined : { display: 'none' }}
            >
              <ChatSessionsPanel
                sessionId={(() => {
                  const fromUrl = pathToChatSessionId(pathname);
                  if (tab === 'chat') return fromUrl || readLastChatSessionId();
                  // Off chat with live voice: pin the bound session so the panel never remounts.
                  if (voiceAgentActive) {
                    return getVoiceAgentUiState().boundSessionId || readLastChatSessionId();
                  }
                  return fromUrl;
                })()}
                onSessionChange={navigateToChatSession}
                onStatsChange={loadNavStats}
                defaultChatModel={chatModel}
                availableModels={availableModels}
                modelsLoading={modelsLoading}
                modelsError={modelsError}
                onRefreshModels={loadModels}
                agents={agents}
              />
            </div>
          )}

          {tab === 'projects' && (
            <ProjectsPanel
              agents={agents}
              defaultWorkspace={config?.defaultWorkspace || defaultWorkspaceInput || ''}
              defaultChatModel={chatModel}
              onOpenProjectChat={(sessionId) => {
                void loadNavStats();
                navigateToChatSession(sessionId);
              }}
              onCreateAgentFromProject={openCreateAgentFromProject}
              onProjectSelect={(id) => {
                if (activeRun?.projectId && id !== activeRun.projectId) {
                  clearProjectRunTrace();
                }
              }}
              onStatsChange={loadNavStats}
            />
          )}

          {/* AGENTS + RUNS + TRACE — the heart */}
          {tab === 'agents' && (
            <div className="page-content-wide">
              <div className="page-head-row">
                <div className="min-w-0">
                  <div className="page-title">
                    Agents
                    <InfoHint text="Local agents get full machine access (files, shell, browser, MCP); cloud agents run against Grok cloud services only. Each agent has its own model, workspace, integrations, schedules, and peers." />
                  </div>
                  <div className="page-subtitle">
                    Local and cloud Grok agents — models, workspaces, schedules, integrations, and peers.
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={syncCloudAgents}
                    disabled={cloudAgentSyncing}
                    className="grok-btn grok-btn-secondary"
                    title="Import heavy Grok cloud agents from your xAI account"
                  >
                    <CloudDownload size={15} className={cloudAgentSyncing ? 'animate-pulse' : ''} />
                    {cloudAgentSyncing ? 'Syncing…' : 'Sync cloud agents'}
                  </button>
                  <button onClick={openCreateAgent} className="grok-btn grok-btn-primary"><Plus size={15}/> Create Agent</button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {agents.map(agent => (
                  <div key={agent.id} className="grok-card p-5 flex flex-col min-w-0">
                    <div className="flex items-start gap-3 min-w-0">
                      <img src={resolveAgentAvatarPath(agent)} alt="" className="agent-avatar shrink-0" width={40} height={40} />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-base flex items-center gap-2 min-w-0">
                          <span className="truncate">{agent.name}</span>
                          <span
                            className={`agent-origin-badge shrink-0 ${agent.origin === 'cloud' ? 'agent-origin-cloud' : 'agent-origin-local'}`}
                            title={agent.origin === 'cloud'
                              ? 'Cloud agent — runs in the Grok cloud, no local system access'
                              : 'Local agent — full access to this machine plus cloud services'}
                          >
                            {agent.origin === 'cloud' ? 'CLOUD' : 'LOCAL'}
                          </span>
                        </div>
                        <div className="text-xs text-dim flex items-center gap-1.5 min-w-0 mt-0.5">
                          <span className="min-w-0 truncate" title={modelDisplayName(agent.model)}>
                            <ModelLine modelId={agent.model} />
                          </span>
                          <span className="shrink-0">• {agent.origin === 'cloud' ? 'cloud' : (agent.workspace.useWorktree ? 'worktree' : 'workspace')}</span>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 text-xs space-y-2">
                      {(Object.entries(agent.integrations).some(([, v]) => v) || agent.peers.length > 0) && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-dim shrink-0 w-20">Integrations</span>
                          {Object.entries(agent.integrations).filter(([, v]) => v).map(([k]) => (
                            <span key={k} className="badge badge-accent integration-badge">
                              <IntegrationIcon id={k} size="sm" />
                              {getIntegrationMeta(k)?.shortLabel ?? k}
                            </span>
                          ))}
                          {agent.peers.length > 0 && <span className="badge badge-muted">{agent.peers.length} peers</span>}
                        </div>
                      )}
                      {agent.voiceId?.trim() && (
                        <div className="flex items-center gap-1">
                          <span className="text-dim shrink-0 w-20">Voice</span>
                          <span className="badge badge-muted capitalize" title="Default Grok TTS voice for chat / voice mode">
                            {agentVoiceOptions.find((v) => v.id === agent.voiceId)?.name
                              || GROK_TTS_VOICES.find((v) => v.id === agent.voiceId)?.name
                              || agent.voiceId}
                          </span>
                        </div>
                      )}
                      {agent.chatSkill?.trim() && (
                        <div className="flex items-start gap-1">
                          <span className="text-dim shrink-0 w-20">Skill</span>
                          <span className="text-xs text-muted line-clamp-2">{agent.chatSkill.trim()}</span>
                        </div>
                      )}
                      {(agent.skills || []).length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-dim shrink-0 w-20">Capabilities</span>
                          {(agent.skills || []).map((skill) => (
                            <span key={skill} className="badge badge-accent">{skill}</span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="mt-auto pt-3">
                      <div className="flex items-center justify-between text-xs gap-2 min-w-0">
                        <div className="text-dim font-mono truncate min-w-0" title={agent.workspace.path}>
                          {agent.origin === 'cloud' ? 'Grok cloud services' : agent.workspace.path}
                        </div>
                        <button
                          onClick={() => void toggleScheduleEntry(agent, 0)}
                          className={`text-[10px] px-2 py-0.5 rounded border shrink-0 ${scheduleStats(agent).active > 0 ? 'border-success text-success' : 'border-default text-dim'}`}
                        >
                          {scheduleStats(agent).active > 0 ? 'SCHEDULED' : 'schedule off'}
                        </button>
                      </div>
                      <div className="text-xs mt-2 text-muted italic truncate" title={agent.description || undefined}>
                        {agent.description || 'No description'}
                      </div>
                      <div className="text-[10px] mt-1 text-dim truncate">{formatScheduleSummary(agent)}</div>
                      {/* Agents page = view/edit/create. Running + traces live on Automations. */}
                      <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-default">
                        <button onClick={() => openEditAgent(agent)} className="grok-btn grok-btn-primary text-xs py-1 flex-1 min-w-0" title="Edit this agent's configuration">
                          <Edit2 size={14}/> Edit
                        </button>
                        <button
                          onClick={() => navigateToTab('automations')}
                          className="grok-btn grok-btn-ghost text-xs py-1 shrink-0"
                          title="Runs, execution traces & automations for this agent"
                          aria-label="Open runs and automations"
                        >
                          <Terminal size={14}/>
                        </button>
                        <button onClick={() => void openRunHistory(agent)} className="grok-btn grok-btn-ghost text-xs py-1 shrink-0" title="Run history" aria-label="Run history">
                          <History size={14}/>
                        </button>
                        <button onClick={() => deleteAgent(agent.id)} className="grok-btn grok-btn-ghost text-xs py-1 shrink-0 text-error" title="Delete agent" aria-label="Delete agent">
                          <Trash2 size={14}/>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {agents.length === 0 && (
                  <div className="grok-card p-8 text-center text-dim text-sm col-span-full">
                    No agents yet. Create one to start orchestrating.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* WORKSPACE — uploads, worktrees, VS Code-style explorer */}
          {tab === 'workspace' && (
            <WorkspacePage
              agents={agents}
              defaultWorkspace={config?.defaultWorkspace || defaultWorkspaceInput || ''}
              hasCloudAuth={!!(config as any)?.hasCloudAuth}
              onOpenAgent={(id) => {
                const a = agents.find((x) => x.id === id);
                if (a) openEditAgent(a);
              }}
            />
          )}

          {/* AUTOMATIONS — schedules & orchestration */}
          {tab === 'automations' && (
            <div className="page-content">
              <div className="page-title">
                Automations
                <InfoHint text="Automations run agents on cron schedules with their own instructions. Open an agent’s run log to inspect past executions — each entry opens a full details modal." />
              </div>
              <div className="page-subtitle">
                Scheduled &amp; orchestrated agents — cron jobs with their own instructions, run logs, and one-click replay.
              </div>
              <div className="space-y-3">
                {/* Only agents with actual schedules — no placeholder cards */}
                {agents.filter((a) => agentSchedules(a).length > 0).map(a => {
                  const scheds = agentSchedules(a);
                  const runCount = scheduledRuns
                    ? scheduledRuns.filter((r) => r.agentId === a.id || r.agentName === a.name).length
                    : null;
                  return (
                  <div key={a.id} className="grok-card p-5 automation-card">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <img src={resolveAgentAvatarPath(a)} alt="" className="agent-avatar-sm" width={28} height={28} />
                        <div className="min-w-0">
                          <div className="truncate flex flex-wrap items-center gap-1.5">
                            <span>{a.name}</span>
                            <ModelLine modelId={a.model} />
                          </div>
                          {(a.skills||[]).length > 0 && <span className="text-xs badge badge-accent mt-1 inline-block">skills: {(a.skills||[]).join(', ')}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => void openRunHistory(a)}
                          className="grok-btn grok-btn-ghost text-xs p-1.5 relative"
                          title={
                            scheduledRuns === null
                              ? 'Open run log'
                              : runCount === 0
                                ? 'Run log — no runs yet'
                                : `Run log — ${runCount} run${runCount === 1 ? '' : 's'}`
                          }
                          aria-label="View run log"
                        >
                          <History size={14} />
                          {runCount != null && runCount > 0 && (
                            <span className="automation-runlog-badge">{runCount > 99 ? '99+' : runCount}</span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditAgentSchedule(a, scheds.length)}
                          className="grok-btn grok-btn-ghost text-xs py-1 px-2"
                          title="Add a schedule in the agent editor"
                        >
                          <CalendarClock size={14}/> Add
                        </button>
                      </div>
                    </div>
                    {/* One row per automation — its own status pill + run/edit/delete */}
                    <div className="mt-2 text-xs space-y-1">
                      {scheds.map((s: any, i: number) => (
                        <div key={s.id || i} className="text-muted flex items-center gap-x-2 gap-y-1 min-w-0">
                          <button
                            type="button"
                            onClick={() => void toggleScheduleEntry(a, i)}
                            className={`automation-status-tag shrink-0 ${s.enabled ? 'automation-status-active' : 'automation-status-paused'}`}
                            title={s.enabled ? 'Pause this automation' : 'Activate this automation'}
                          >
                            {s.enabled ? 'Active' : 'Paused'}
                          </button>
                          <span className="font-mono text-[11px] shrink-0">{describeCron(s.cron)}</span>
                          {s.instructions && <span className="text-dim truncate min-w-0">· {s.instructions.slice(0, 60)}{s.instructions.length > 60 ? '…' : ''}</span>}
                          <span className="ml-auto flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => runAgent(a, { useScheduleInstructions: true, scheduleIndex: i })}
                              className="grok-btn grok-btn-ghost text-xs p-1"
                              title="Run this automation now with its instructions"
                              aria-label="Run automation now"
                            >
                              <Play size={12}/>
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditAgentSchedule(a, i)}
                              className="grok-btn grok-btn-ghost text-xs p-1"
                              title="Edit this automation (cron + instructions)"
                              aria-label="Edit automation"
                            >
                              <Pencil size={12}/>
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteScheduleEntry(a, i)}
                              className="grok-btn grok-btn-ghost text-xs p-1 text-error"
                              title="Delete this automation"
                              aria-label="Delete automation"
                            >
                              <Trash2 size={12}/>
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )})}
                {agents.filter((a) => agentSchedules(a).length > 0).length === 0 && (
                  <div className="grok-card p-8 text-center text-dim text-sm">
                    No scheduled automations yet — open an agent&apos;s editor (Agents → Edit) and add a schedule to see it here.
                  </div>
                )}
              </div>
              <div className="mt-6 text-xs text-dim">
                Agents can schedule themselves via the <span className="font-mono">schedule_task</span> tool and message other agents using <span className="font-mono">send_to_peer</span>. Everything is scoped per agent.
              </div>

              {/* Execution Trace — top of the stack. Closing returns to run
                  details (if any) or the page; never leaves run log visible under it. */}
              {showTraceModal && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4" onClick={closeTraceModal}>
                  <div className="modal modal-pop w-full max-w-4xl p-5 max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Execution trace">
                    <div className="flex items-center gap-2 mb-3 shrink-0">
                      <Terminal size={16}/>
                      <div className="font-medium">Execution Trace</div>
                      {activeRun && !activeRun.projectId && <span className={`badge ${activeRun.status === 'running' ? 'badge-accent' : ''}`}>{activeRun.status}</span>}
                      {activeRun && !activeRun.projectId && (
                        <span className="text-xs text-muted truncate min-w-0 flex items-center gap-1.5">
                          {activeRun.agentName} <ModelLine modelId={activeRun.model} />
                        </span>
                      )}
                      <button
                        type="button"
                        className="grok-btn grok-btn-ghost p-1.5 ml-auto shrink-0"
                        onClick={closeTraceModal}
                        title={runDetail ? 'Back to run details' : 'Close'}
                      >
                        <X size={16}/>
                      </button>
                    </div>
                    <div className="flex-1 min-h-0 overflow-auto space-y-3 pr-1">
                      <div className="grok-card p-4 font-mono text-xs bg-black/40">
                        {liveTrace.length > 0 && !activeRun?.projectId ? liveTrace.map((step, idx) => (
                          <div key={idx} className={`trace-step mb-3 ${step.type}`}>
                            <div className="text-[10px] text-dim">{new Date(step.ts).toLocaleTimeString()} — {step.type.toUpperCase()}</div>
                            <div className="mt-0.5">{step.content}</div>
                            {step.tool && <div className="tool-call mt-1">{step.tool.name} {JSON.stringify(step.tool.args)}</div>}
                            {step.screenshot && <div className="mt-2 screenshot"><img src={step.screenshot} alt="browser" /></div>}
                          </div>
                        )) : <div className="text-dim">Run any agent to see live detailed traces here (tools, thoughts, screenshots, side effects).</div>}
                      </div>
                      {activeRun && !activeRun.projectId && (
                        <div className="text-xs text-muted flex flex-wrap items-center gap-2">
                          <span>Final: {activeRun.finalOutput?.slice(0,200)}</span>
                          <ModelLine modelId={activeRun.model} />
                        </div>
                      )}
                      {!activeRun?.projectId && (
                        <PreviewRail
                          trace={liveTrace}
                          selectedIdx={previewSelectedIdx}
                          onSelect={setPreviewSelectedIdx}
                        />
                      )}
                      {activeRun && !activeRun.projectId && activeRun.status !== 'running' && (
                        <WorkspaceDiffPanel
                          workspaceDir={activeRun?.workspaceSnapshot}
                          runId={activeRun?.id}
                        />
                      )}
                    </div>
                    {(runDetail || historyAgent) && (
                      <div className="flex justify-end mt-3 shrink-0">
                        <button type="button" className="grok-btn grok-btn-secondary text-xs" onClick={closeTraceModal}>
                          {runDetail ? 'Back to run details' : historyAgent ? 'Back to run log' : 'Close'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* CAPABILITIES — core integrations, skills, MCP servers, tools */}
          {tab === 'integrations' && (
            <div className="integrations-page page-content-wide">
              <div className="page-title">
                Capabilities
                <InfoHint text="Everything on this page becomes available to agents during runs and to Grok Chat when the matching scope is enabled on the agent." />
              </div>
              <div className="page-subtitle">Everything your agents can reach — core integrations, skills, MCP servers, and built-in tools.</div>

              <div className="page-section-title">
                <Plug size={18} className="opacity-70" />
                Core Integrations
                <InfoHint text="Credentials are AES-256-GCM encrypted at rest on this machine and never leave it except toward the service itself." />
              </div>
              <div className="page-section-sub">Provide credentials once. Agents that have the scope enabled will be able to call GitHub, Slack, Drive, Discord, X, and Obsidian during runs.</div>

              <div className="integrations-grid">
                {INTEGRATION_CATALOG.map((integration) => {
                  const connected = !!intTest[integration.id]?.ok;
                  const configured = integrationConfigured(integration.id);
                  const expanded = expandedIntegration === integration.id;
                  return (
                  <div
                    key={integration.id}
                    className={`grok-card p-5 integration-card ${
                      connected ? 'integration-card-connected' : configured ? 'integration-card-configured' : 'integration-card-unset'
                    }`}
                  >
                    <div
                      className="integration-card-header integration-card-header-clickable"
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpandedIntegration(expanded ? null : integration.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setExpandedIntegration(expanded ? null : integration.id);
                        }
                      }}
                    >
                      <IntegrationIcon id={integration.id} size="lg" />
                      <div className="integration-card-meta min-w-0">
                        <div className="font-semibold flex items-center gap-2 flex-wrap">
                          {integration.label}
                          <span className={`integration-status-chip ${connected ? 'integration-chip-connected' : configured ? 'integration-chip-configured' : 'integration-chip-unset'}`}>
                            {connected ? 'Connected' : configured ? 'Configured' : 'Not set up'}
                          </span>
                        </div>
                        <div className="text-xs text-dim">{integration.description}</div>
                        {integration.docsUrl && (
                          <a
                            href={integration.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="integration-docs-link"
                            onClick={(e) => e.stopPropagation()}
                            title={integration.docsLabel || 'API documentation'}
                          >
                            {integration.docsLabel || 'API docs'}
                            <span className="opacity-60" aria-hidden> ↗</span>
                          </a>
                        )}
                        {integration.id === 'github' && intTest.github?.ok && (
                          <span className="integration-card-status text-success">connected as {intTest.github.login}</span>
                        )}
                        {integration.id === 'slack' && intTest.slack?.ok && (
                          <span className="integration-card-status text-success">connected to {intTest.slack.team}</span>
                        )}
                        {integration.id === 'discord' && intTest.discord?.ok && (
                          <span className="integration-card-status text-success">connected as {intTest.discord.username}</span>
                        )}
                        {integration.id === 'x' && intTest.x?.ok && (
                          <span className="integration-card-status text-success">connected as @{intTest.x.username}</span>
                        )}
                        {integration.id === 'obsidian' && intTest.obsidian?.ok && (
                          <span className="integration-card-status text-success">
                            {intTest.obsidian.mode === 'cloud' ? 'cloud REST' : 'local vault'}
                            {intTest.obsidian.noteCount != null ? ` · ${intTest.obsidian.noteCount} notes` : ''}
                          </span>
                        )}
                      </div>
                      <span className="integration-card-chevron" aria-hidden>
                        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </span>
                    </div>
                    {expanded && (
                    <div className="integration-card-body">
                    {integration.id === 'github' && (
                      <input className="grok-input mb-2" placeholder="GitHub Personal Access Token (ghp_...)" value={intCreds.github?.token || ''} onChange={e => setIntCreds((c:any)=>({...c, github: {...(c.github||{}), token: e.target.value}}))} />
                    )}
                    {integration.id === 'slack' && (
                      <>
                        <input className="grok-input mb-2" placeholder="Slack Bot Token (xoxb-...)" value={intCreds.slack?.token || ''} onChange={e => setIntCreds((c:any)=>({...c, slack: {...(c.slack||{}), token: e.target.value}}))} />
                        <input className="grok-input" placeholder="Default channel (#general)" value={intCreds.slack?.defaultChannel || ''} onChange={e => setIntCreds((c:any)=>({...c, slack: {...(c.slack||{}), defaultChannel: e.target.value}}))} />
                      </>
                    )}
                    {integration.id === 'googledrive' && (() => {
                      const gd = intCreds.googledrive || {};
                      // A bundled env-var client (project default) means the user
                      // needs no setup at all — just sign in. Otherwise fall back
                      // to a per-user client from Advanced.
                      const bundled = !!(config as any)?.driveBundledClient;
                      const clientReady = bundled || (!!gd.clientId?.trim() && !!gd.clientSecret?.trim());
                      return (
                      <>
                        <div className="text-xs text-dim mb-3">
                          A new window opens Google&apos;s sign-in and asks you to grant Drive read/write access, then closes itself.
                          Tokens are captured and refreshed automatically.
                        </div>
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          {intTest.googledrive?.ok ? (
                            <span className="status-pill text-success">Connected{intTest.googledrive.email ? ` · ${intTest.googledrive.email}` : ''}</span>
                          ) : (
                            <span className="status-pill text-dim">Not signed in</span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (!clientReady) {
                                setDriveAdvancedOpen(true);
                                toast('One-time: add your Google OAuth client below, Save, then Sign in with Google.');
                                return;
                              }
                              void startGoogleDriveLogin();
                            }}
                            disabled={driveStarting}
                            className="grok-btn grok-btn-primary text-xs"
                            title="Open the Google consent popup"
                          >
                            {driveStarting ? 'Opening Google…' : '🔑 Sign in with Google'}
                          </button>
                          {intTest.googledrive?.ok && (
                            <button type="button" onClick={() => void disconnectGoogleDrive()} className="grok-btn grok-btn-ghost text-xs text-error">Disconnect</button>
                          )}
                        </div>
                        {bundled && !intTest.googledrive?.ok && (
                          <div className="text-[11px] text-dim mb-1">Ready — click Sign in with Google, no setup needed.</div>
                        )}
                        <details className="text-xs mt-1" open={driveAdvancedOpen} onToggle={(e) => setDriveAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}>
                          <summary className="text-dim cursor-pointer select-none">{bundled ? 'Advanced — override client or use a service account' : 'Advanced — one-time OAuth client setup & fallbacks'}</summary>
                          <div className="mt-2 space-y-2">
                            <div className="text-[11px] text-dim">
                              One-time: <span className="font-mono">Google Cloud Console → APIs &amp; Services → Credentials → Create OAuth client ID</span> —
                              pick <strong>Desktop app</strong> (simplest) or <strong>Web application</strong> with this exact <strong>Authorized redirect URI</strong>, and enable the <span className="font-mono">Google Drive API</span>.
                            </div>
                            <div className="flex items-center gap-2">
                              <code className="grok-input flex-1 min-w-0 text-[11px] font-mono py-1.5 truncate" title={`${appOrigin}/api/google-oauth/callback`}>{appOrigin}/api/google-oauth/callback</code>
                              <button type="button" className="grok-btn grok-btn-ghost text-xs shrink-0" onClick={() => { navigator.clipboard.writeText(`${appOrigin}/api/google-oauth/callback`).then(() => toast.success('Redirect URI copied')); }}>Copy</button>
                            </div>
                            <input className="grok-input font-mono text-xs" placeholder="Google OAuth Client ID" value={gd.clientId || ''} onChange={e => setIntCreds((c:any)=>({...c, googledrive: {...(c.googledrive||{}), clientId: e.target.value}}))} />
                            <input className="grok-input font-mono text-xs" type="password" placeholder="Google OAuth Client Secret" value={gd.clientSecret || ''} onChange={e => setIntCreds((c:any)=>({...c, googledrive: {...(c.googledrive||{}), clientSecret: e.target.value}}))} />
                            <div className="text-[10px] text-dim pt-1">Save after pasting, then Sign in with Google above. Or skip OAuth entirely with a service account / manual token:</div>
                            <input className="grok-input" placeholder="OAuth Access Token (manual)" value={gd.accessToken || ''} onChange={e => setIntCreds((c:any)=>({...c, googledrive: {...(c.googledrive||{}), accessToken: e.target.value}}))} />
                            <textarea className="grok-input h-24 font-mono text-xs" placeholder="Paste full Service Account JSON for server-side auth" value={gd.serviceAccountJson || ''} onChange={e => setIntCreds((c:any)=>({...c, googledrive: {...(c.googledrive||{}), serviceAccountJson: e.target.value}}))} />
                          </div>
                        </details>
                      </>
                      );
                    })()}
                    {integration.id === 'discord' && (
                      <>
                        <input className="grok-input mb-2" placeholder="Discord Bot Token" value={intCreds.discord?.token || ''} onChange={e => setIntCreds((c:any)=>({...c, discord: {...(c.discord||{}), token: e.target.value}}))} />
                        <input className="grok-input" placeholder="Default channel ID (snowflake, optional)" value={intCreds.discord?.defaultChannelId || ''} onChange={e => setIntCreds((c:any)=>({...c, discord: {...(c.discord||{}), defaultChannelId: e.target.value}}))} />
                      </>
                    )}
                    {integration.id === 'x' && (
                      <>
                        <input className="grok-input mb-2" placeholder="API Key (Consumer Key)" value={intCreds.x?.apiKey || ''} onChange={e => setIntCreds((c:any)=>({...c, x: {...(c.x||{}), apiKey: e.target.value}}))} />
                        <input className="grok-input mb-2" placeholder="API Secret (Consumer Secret)" value={intCreds.x?.apiSecret || ''} onChange={e => setIntCreds((c:any)=>({...c, x: {...(c.x||{}), apiSecret: e.target.value}}))} />
                        <input className="grok-input mb-2" placeholder="Access Token" value={intCreds.x?.accessToken || ''} onChange={e => setIntCreds((c:any)=>({...c, x: {...(c.x||{}), accessToken: e.target.value}}))} />
                        <input className="grok-input" placeholder="Access Token Secret" value={intCreds.x?.accessTokenSecret || ''} onChange={e => setIntCreds((c:any)=>({...c, x: {...(c.x||{}), accessTokenSecret: e.target.value}}))} />
                        <div className="mt-2 text-xs text-dim">Create an app at developer.x.com with Read and Write permissions, then generate user access tokens.</div>
                      </>
                    )}
                    {integration.id === 'obsidian' && (() => {
                      const obsidianMode = intCreds.obsidian?.mode || 'local';
                      const isCloud = obsidianMode === 'cloud';
                      return (
                      <>
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="text-xs text-dim">Mode</span>
                          <select
                            className="grok-select text-xs flex-1 min-w-[120px]"
                            value={obsidianMode}
                            onChange={e => setIntCreds((c: any) => ({ ...c, obsidian: { ...(c.obsidian || {}), mode: e.target.value } }))}
                          >
                            <option value="local">Local — vault on this machine</option>
                            <option value="cloud">Cloud — remote REST API</option>
                          </select>
                        </div>
                        {!isCloud && (
                          <div className="flex gap-2 mb-2">
                            <input
                              className="grok-input flex-1 min-w-0"
                              placeholder="Vault path (e.g. C:\Users\you\Documents\MyVault)"
                              value={intCreds.obsidian?.vaultPath || ''}
                              onChange={e => setIntCreds((c: any) => ({ ...c, obsidian: { ...(c.obsidian || { mode: 'local' }), vaultPath: e.target.value } }))}
                            />
                            <button
                              type="button"
                              onClick={() => setFolderBrowseFor('obsidian')}
                              className="grok-btn grok-btn-secondary text-xs shrink-0"
                              title="Browse for vault folder"
                            >
                              <FolderOpen size={14} /> Browse
                            </button>
                          </div>
                        )}
                        {isCloud && (
                          <>
                            <input
                              className="grok-input mb-2"
                              placeholder="REST API URL (required, e.g. https://your-tunnel:27124)"
                              value={intCreds.obsidian?.restApiUrl || ''}
                              onChange={e => setIntCreds((c: any) => ({ ...c, obsidian: { ...(c.obsidian || { mode: 'cloud' }), restApiUrl: e.target.value } }))}
                            />
                            <input
                              className="grok-input"
                              type="password"
                              placeholder="REST API key (from Local REST API plugin)"
                              value={intCreds.obsidian?.restApiKey || ''}
                              onChange={e => setIntCreds((c: any) => ({ ...c, obsidian: { ...(c.obsidian || { mode: 'cloud' }), restApiKey: e.target.value } }))}
                            />
                          </>
                        )}
                        <div className="mt-2 text-xs text-dim">
                          {isCloud ? (
                            <>
                              Cloud mode uses the{' '}
                              <a href="https://github.com/coddingtonbear/obsidian-local-rest-api" className="link-accent" target="_blank" rel="noreferrer">Local REST API</a>{' '}
                              plugin exposed via tunnel or remote host — URL and API key required.
                            </>
                          ) : (
                            <>
                              Local mode reads notes directly from your vault folder on this machine. Use Browse to pick the vault directory.
                            </>
                          )}
                        </div>
                      </>
                      );
                    })()}
                    {(integration.docsUrl || integration.setupUrl) && (
                      <div className="integration-docs-row">
                        {integration.docsUrl && (
                          <a
                            href={integration.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="integration-docs-link"
                          >
                            {integration.docsLabel || 'API docs'} ↗
                          </a>
                        )}
                        {integration.setupUrl && (
                          <a
                            href={integration.setupUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="integration-docs-link"
                          >
                            Setup guide ↗
                          </a>
                        )}
                      </div>
                    )}
                    <div className="integration-card-actions">
                      <button
                        type="button"
                        onClick={() => saveIntegration(integration.id)}
                        disabled={!!intSaving[integration.id]}
                        className="grok-btn grok-btn-primary text-xs"
                      >
                        {intSaving[integration.id] ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => testIntegration(integration.id)}
                        className="grok-btn grok-btn-secondary text-xs"
                      >
                        Test Connection
                      </button>
                      {configured && (
                        <button
                          type="button"
                          onClick={() => void deleteIntegration(integration.id)}
                          className="grok-btn grok-btn-ghost text-xs text-error ml-auto"
                          title="Delete stored credentials for this integration"
                        >
                          <Trash2 size={13} /> Remove
                        </button>
                      )}
                    </div>
                    </div>
                    )}
                  </div>
                  );
                })}
              </div>

              <div className="mt-5 text-xs text-dim">Credentials are stored locally on your machine only. Never sent anywhere except to the services you authorize.</div>

              <SkillsBrowser
                installed={[...new Set(agents.flatMap((a) => a.skills || []))]}
                installedCounts={agents.reduce<Record<string, number>>((acc, a) => {
                  for (const s of a.skills || []) acc[s] = (acc[s] || 0) + 1;
                  return acc;
                }, {})}
                agents={agents.map((a) => ({ id: a.id, name: a.name, skills: a.skills }))}
                onToggleAgentSkill={async (agentId, skillId, enabled) => {
                  const agent = agents.find((a) => a.id === agentId);
                  if (!agent) return;
                  const skills = enabled
                    ? [...new Set([...(agent.skills || []), skillId])]
                    : (agent.skills || []).filter((s) => s !== skillId);
                  const res = await fetch('/api/agents', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'update', agent: { ...agent, skills } }),
                  });
                  const data = await res.json();
                  if (data.error) {
                    toast.error(data.error);
                    return;
                  }
                  await refreshAgents();
                }}
                onInstall={(skillId) => toast.info(`Manage "${skillId}" from an agent's editor — open Agents → ✎ → Skills Browser.`)}
              />

              <McpPanel
                githubToken={intCreds.github?.token}
                defaultWorkspace={defaultWorkspaceInput || config?.defaultWorkspace}
                externalAllowedPath={mcpBrowsePath}
                onBrowsePath={() => setFolderBrowseFor('mcp')}
              />

              <ToolsCatalog />
            </div>
          )}

          {tab === 'usage' && (
            <UsageDashboard />
          )}

          {tab === 'logs' && (
            <LogsPanel />
          )}

          {tab === 'settings' && (
            <div className="page-content settings-page">
              <div className="page-title">Settings</div>
              <div className="page-subtitle">
                Model sources, agent behavior, quotas, and workspace — everything lives on this machine.
              </div>

              <div className="settings-grid">
                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <KeyRound size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">xAI Grok API Key</div>
                      <div className="text-[11px] text-dim">Cloud Grok via console.x.ai token — encrypted at rest.</div>
                    </div>
                    <InfoHint className="ml-auto" text="Get a key at console.x.ai. It is encrypted at rest (AES-256-GCM) with a machine key stored outside the project — never in source code." />
                  </div>
                  <input value={apiKeyInput} onChange={e=>setApiKeyInput(e.target.value)} placeholder="xai-..." className="grok-input mb-2 font-mono" />
                  <div className="flex flex-wrap gap-2">
                    <button onClick={saveApiKey} className="grok-btn grok-btn-primary">Save &amp; Validate Key</button>
                    <button onClick={quickValidate} className="grok-btn grok-btn-secondary">Test</button>
                    {(config as any)?.hasKey && (
                      <button onClick={() => void clearApiKey()} className="grok-btn grok-btn-ghost text-error" title="Remove the stored key from this machine">
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="text-xs mt-1 text-dim">Cloud API key for xAI-hosted Grok models. Local models run separately on your machine.</div>
                  <div className="text-[10px] mt-1.5 text-dim">
                    🔒 Credentials are encrypted at rest (AES-256-GCM). The encryption key is stored outside this project
                    {(config as any)?.secretKeyLocation ? <> at <span className="font-mono">{(config as any).secretKeyLocation}</span></> : null} — never in source code.
                  </div>
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <BarChart3 size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">xAI Management Key</div>
                      <div className="text-[11px] text-dim">Backports official team usage &amp; billing into the Usage page.</div>
                    </div>
                  </div>
                  <input
                    value={managementKeyInput}
                    onChange={(e) => setManagementKeyInput(e.target.value)}
                    placeholder="Management key from console.x.ai → Settings → Management Keys"
                    className="grok-input mb-2 font-mono text-xs"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => void saveManagementKey()} className="grok-btn grok-btn-primary text-xs">
                      Save Management Key
                    </button>
                    <button
                      type="button"
                      onClick={() => void testManagementKey()}
                      className="grok-btn grok-btn-secondary text-xs"
                      title="Call management-api.x.ai with this key (or the saved one) to verify billing access"
                    >
                      Test
                    </button>
                    {(config as any)?.hasManagementKey && (
                      <button type="button" onClick={() => void clearManagementKey()} className="grok-btn grok-btn-ghost text-xs text-error">
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="text-xs mt-2 text-dim">
                    Separate from your inference API key. Used only to read{' '}
                    <span className="font-mono">management-api.x.ai</span> billing / usage (models, spend, prepaid balance).
                    Without it, Usage still tries your API key / OAuth, then falls back to studio metering.
                    Test checks billing read access (team invoices / balance).
                  </div>
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <Users size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">OAuth with X</div>
                      <div className="text-[11px] text-dim">OAuth 2.0 · SuperGrok / X Premium+ sign-in — no API key needed.</div>
                    </div>
                  </div>
                  <div className="text-xs text-dim mb-3">
                    One click, zero config — a popup opens the official <span className="font-mono">accounts.x.ai</span> login,
                    then closes itself. Tokens are cached encrypted on this machine and refresh automatically; your
                    SuperGrok / Premium+ quota is used. Nothing to copy or paste.
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    {oauthStatus.connected ? (
                      <span className="status-pill text-success">Connected{oauthStatus.displayName ? ` · ${oauthStatus.displayName}` : ''}{oauthStatus.email ? ` · ${oauthStatus.email}` : ''}</span>
                    ) : oauthStatus.expired ? (
                      <span className="status-pill text-warning">OAuth expired — sign in again</span>
                    ) : (
                      <span className="status-pill text-dim">Not connected</span>
                    )}
                    <button onClick={startOAuthLogin} disabled={oauthStarting} className="grok-btn grok-btn-primary text-xs">
                      {oauthStarting ? 'Opening accounts.x.ai…' : '🔑 Sign in with X'}
                    </button>
                    {oauthStatus.connected && (
                      <button onClick={disconnectOAuth} className="grok-btn grok-btn-ghost text-xs text-error">Disconnect</button>
                    )}
                  </div>
                  <details className="text-xs">
                    <summary className="text-dim cursor-pointer select-none">Popup didn&apos;t come back? Manual fallback</summary>
                    <div className="mt-2">
                      <input
                        value={oauthCallbackInput}
                        onChange={(e) => setOauthCallbackInput(e.target.value)}
                        placeholder="Paste the callback URL or authorization code"
                        className="grok-input mb-2 text-xs font-mono"
                      />
                      <button onClick={exchangeOAuthCallback} disabled={!oauthCallbackInput.trim()} className="grok-btn grok-btn-secondary text-xs">
                        Complete OAuth
                      </button>
                      <div className="text-[10px] text-dim mt-2">Some tiers can return HTTP 403 after login — keep an API key as fallback.</div>
                    </div>
                  </details>
                  {(config as any)?.hasKey && oauthStatus.connected && (
                    <div className="mt-4">
                      <div className="grok-label text-xs">Cloud auth preference (both configured)</div>
                      <div className="flex gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => saveCloudAuthMode('api_key')}
                          className={`grok-btn text-xs ${cloudAuthMode === 'api_key' ? 'grok-btn-primary' : 'grok-btn-secondary'}`}
                        >
                          Prefer API key
                        </button>
                        <button
                          type="button"
                          onClick={() => saveCloudAuthMode('oauth')}
                          className={`grok-btn text-xs ${cloudAuthMode === 'oauth' ? 'grok-btn-primary' : 'grok-btn-secondary'}`}
                        >
                          Prefer OAuth
                        </button>
                      </div>
                    </div>
                  )}
                  {oauthStatus.error && <div className="text-xs text-warning mt-2">{oauthStatus.error}</div>}
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <Server size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Local Models</div>
                      <div className="text-[11px] text-dim">LM Studio, Ollama, llama.cpp — any OpenAI-compatible server.</div>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm mt-2">
                    <input type="checkbox" checked={localGrokEnabled} onChange={e => setLocalGrokEnabled(e.target.checked)} />
                    Enable local models (any OpenAI-compatible server — Grok, Llama, Qwen, Mistral…)
                  </label>
                  <div className="text-xs text-dim mt-1 mb-2">Run Grok locally via LM Studio, Ollama, or any OpenAI-compatible endpoint. Select <strong>Local</strong> models in chat and agents.</div>
                  <input
                    className="grok-input font-mono text-xs mb-2"
                    value={localGrokBaseUrl}
                    onChange={e => setLocalGrokBaseUrl(e.target.value)}
                    placeholder="http://127.0.0.1:1234/v1"
                  />
                  <div className="flex gap-2 flex-wrap">
                    <button onClick={saveLocalGrokSettings} className="grok-btn grok-btn-primary text-sm">Save Local Settings</button>
                    <button onClick={testLocalGrok} className="grok-btn grok-btn-secondary text-sm">Test Connection</button>
                  </div>
                  {localGrokEnabled && (
                    <div className={`text-xs mt-2 ${localGrokReachable ? 'text-success' : 'text-warning'}`}>
                      {localGrokReachable ? 'Local server reachable' : 'Local server not detected — start LM Studio/Ollama and test again'}
                    </div>
                  )}
                  {localGrokEnabled && (
                    <div className="mt-4">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="grok-label mb-0">Model availability — agents &amp; Grok Chat</div>
                        <div className="flex items-center gap-1">
                          {localModelAllowlist.length > 0 && localModelOptions.length > 0 && (
                            <button
                              type="button"
                              onClick={() => void saveLocalModelAllowlist([])}
                              className="grok-btn grok-btn-ghost text-xs py-0.5"
                              title="Make every model the server offers available"
                            >
                              Allow all
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void fetchLocalModelOptions({ silent: true })}
                            disabled={localModelsFetching}
                            className="grok-btn grok-btn-ghost text-xs py-0.5"
                            title="Reload the model list from the local server"
                          >
                            <RefreshCw size={12} className={localModelsFetching ? 'animate-spin' : ''} /> Refresh
                          </button>
                        </div>
                      </div>
                      {localModelsFetching && localModelOptions.length === 0 ? (
                        <div className="data-loading-row mt-2"><span className="data-spinner" /> Loading models from local server…</div>
                      ) : localModelOptions.length === 0 ? (
                        <div className="text-xs text-dim mt-2">
                          No models reported yet — start your local server and click Test Connection.
                        </div>
                      ) : (
                        <>
                          <div className="local-model-list mt-2">
                            {localModelOptions.map((id) => {
                              const allowed = localModelAllowlist.length === 0 || localModelAllowlist.includes(id);
                              return (
                                <label key={id} className={`local-model-item ${allowed ? '' : 'local-model-item-off'}`}>
                                  <input
                                    type="checkbox"
                                    checked={allowed}
                                    onChange={() => toggleLocalModelAllowed(id)}
                                  />
                                  <span className="font-mono text-xs truncate">{id}</span>
                                </label>
                              );
                            })}
                          </div>
                          <div className="text-[10px] text-dim mt-1.5">
                            {localModelAllowlist.length === 0
                              ? `All ${localModelOptions.length} model(s) from the server are selectable in chat and agents.`
                              : `${localModelAllowlist.length} of ${localModelOptions.length} model(s) selectable — unchecked models are hidden from chat and agent pickers.`}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <Cpu size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Default Model</div>
                      <div className="text-[11px] text-dim">Used by Grok Chat and every new agent.</div>
                    </div>
                    <button type="button" onClick={loadModels} disabled={modelsLoading} className="grok-btn grok-btn-ghost text-xs py-0.5 ml-auto">
                      <RefreshCw size={12} className={modelsLoading ? 'animate-spin' : ''} /> Refresh
                    </button>
                  </div>
                  <select
                    className="grok-select w-full mt-1"
                    value={defaultModelInput}
                    onChange={e => setDefaultModelInput(e.target.value)}
                    disabled={modelsLoading && availableModels.length === 0}
                  >
                    {renderModelOptions(defaultModelInput)}
                  </select>
                  <div className="flex gap-2 mt-2">
                    <button onClick={saveDefaultModel} className="grok-btn grok-btn-primary text-sm">Save Default Model</button>
                  </div>
                  <div className="text-xs mt-1 text-dim">
                    Used for Grok Chat and new agents. Pick Cloud (xAI) or Local (this machine) — the badge shows which is active.
                    {availableModels.length > 0 && ` ${availableModels.length} model(s) available.`}
                  </div>
                  {defaultModelInput && (
                    <div className="mt-2 flex items-center gap-2 text-xs">
                      <span className="text-dim">Current default:</span>
                      <ModelLine modelId={defaultModelInput} />
                    </div>
                  )}
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <Volume2 size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Default Grok voice &amp; speed</div>
                      <div className="text-[11px] text-dim">Studio-wide TTS for Grok Chat and voice mode.</div>
                    </div>
                    <InfoHint
                      className="ml-auto"
                      text="Used when speaking assistant replies. Agents can override voice. Chat and the Grok Voice HUD can change speed live for the session."
                    />
                  </div>
                  <div className="grok-label mt-2 mb-1">Voice</div>
                  <select
                    className="grok-select w-full"
                    value={defaultTtsVoiceInput || DEFAULT_TTS_VOICE}
                    onChange={(e) => setDefaultTtsVoiceInput(e.target.value)}
                    aria-label="Default Grok TTS voice"
                  >
                    {defaultTtsVoiceInput
                      && !agentVoiceOptions.some((v) => v.id === defaultTtsVoiceInput)
                      && !GROK_TTS_VOICES.some((v) => v.id === defaultTtsVoiceInput)
                      && (
                        <option value={defaultTtsVoiceInput}>
                          {defaultTtsVoiceInput} (saved)
                        </option>
                      )}
                    {(agentVoiceOptions.length ? agentVoiceOptions : GROK_TTS_VOICES).map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}{v.description ? ` — ${v.description}` : ''}
                      </option>
                    ))}
                  </select>
                  <div className="grok-label mt-3 mb-1">Speech speed</div>
                  <select
                    className="grok-select w-full"
                    value={String(clampTtsSpeed(defaultTtsSpeedInput))}
                    onChange={(e) => setDefaultTtsSpeedInput(clampTtsSpeed(e.target.value))}
                    aria-label="Default speech speed"
                  >
                    {GROK_TTS_SPEEDS.map((s) => (
                      <option key={s.value} value={String(s.value)}>
                        {s.label} · {s.hint}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2 mt-3">
                    <button type="button" onClick={() => void saveDefaultTtsVoice()} className="grok-btn grok-btn-primary text-sm">
                      Save Voice Defaults
                    </button>
                  </div>
                  <div className="text-xs mt-1.5 text-dim">
                    Seeds Grok Chat and the voice HUD. Speed range 0.7–1.5× (xAI TTS).
                    {' '}Currently{' '}
                    <span className="font-medium text-primary">
                      {agentVoiceOptions.find((v) => v.id === defaultTtsVoiceInput)?.name
                        || GROK_TTS_VOICES.find((v) => v.id === defaultTtsVoiceInput)?.name
                        || defaultTtsVoiceInput
                        || DEFAULT_TTS_VOICE}
                    </span>
                    {' · '}
                    <span className="font-medium text-primary">
                      {GROK_TTS_SPEEDS.find((s) => Math.abs(s.value - clampTtsSpeed(defaultTtsSpeedInput)) < 0.01)?.label
                        || `${clampTtsSpeed(defaultTtsSpeedInput)}×`}
                    </span>
                    .
                  </div>
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <Terminal size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Grok Build CLI</div>
                      <div className="text-[11px] text-dim">Detected automatically from PATH on this machine.</div>
                    </div>
                  </div>
                  <div className="text-xs mt-2 flex items-center gap-2 flex-wrap">
                    <Terminal size={14} className="opacity-70" />
                    {grokCliStatus?.installed ? (
                      <span className="text-success">
                        Installed{grokCliStatus.version ? ` · ${grokCliStatus.version}` : ''}
                        {grokCliStatus.path ? ` · ${grokCliStatus.path}` : ''}
                      </span>
                    ) : (
                      <span className="text-dim">Not detected on PATH — install with: curl -fsSL https://x.ai/cli/install.sh | bash</span>
                    )}
                  </div>
                  <div className="text-xs text-dim mt-1">
                    When installed, Grok Chat can route through the CLI (API/CLI toggle) and agents gain a <span className="font-mono">grok_cli</span> tool
                    with effort levels, self-verification (<span className="font-mono">check</span>), best-of-N runs, and structured JSON output.
                  </div>
                  {grokCliStatus?.installed && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => void checkCliUpdate()}
                        disabled={cliUpdate.checking}
                        className="grok-btn grok-btn-secondary text-xs"
                      >
                        <RefreshCw size={12} className={cliUpdate.checking ? 'animate-spin' : ''} />
                        {cliUpdate.checking ? 'Checking…' : 'Check for updates'}
                      </button>
                      {cliUpdate.text && (
                        <span className={`text-xs ${cliUpdate.available ? 'text-warning' : 'text-dim'}`}>{cliUpdate.text}</span>
                      )}
                    </div>
                  )}
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <ShieldCheck size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Agent Behavior</div>
                      <div className="text-[11px] text-dim">Tool approval, global instructions, AGENTS.md injection.</div>
                    </div>
                  </div>
                  <div className="flex gap-2 mb-3">
                    <button
                      type="button"
                      onClick={() => setToolApprovalMode('yolo')}
                      className={`grok-btn text-xs ${toolApprovalMode === 'yolo' ? 'grok-btn-primary' : 'grok-btn-secondary'}`}
                    >
                      YOLO (auto-run tools)
                    </button>
                    <button
                      type="button"
                      onClick={() => setToolApprovalMode('ask')}
                      className={`grok-btn text-xs ${toolApprovalMode === 'ask' ? 'grok-btn-primary' : 'grok-btn-secondary'}`}
                    >
                      Ask before act
                    </button>
                  </div>
                  <label className="flex items-center gap-2 text-sm mb-2">
                    <input type="checkbox" checked={useAgentsMd} onChange={(e) => setUseAgentsMd(e.target.checked)} />
                    Inject AGENTS.md / CLAUDE.md from workspace
                  </label>
                  <textarea
                    className="grok-input text-xs font-mono min-h-[100px] mb-2"
                    placeholder="Global instructions for every agent and chat session…"
                    value={globalInstructionsInput}
                    onChange={(e) => setGlobalInstructionsInput(e.target.value)}
                  />
                  <button type="button" onClick={() => void saveAgentBehaviorSettings()} className="grok-btn grok-btn-primary text-sm">
                    Save Agent Behavior
                  </button>
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <FolderOpen size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Default Workspace</div>
                      <div className="text-[11px] text-dim">Root folder for uploads, new agents, and the explorer.</div>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-1">
                    <input
                      className="grok-input flex-1 min-w-0 font-mono text-xs"
                      value={defaultWorkspaceInput}
                      onChange={(e) => setDefaultWorkspaceInput(e.target.value)}
                      placeholder="C:\Users\you\Projects\my-repo"
                    />
                    <button
                      type="button"
                      onClick={() => setFolderBrowseFor('workspace')}
                      className="grok-btn grok-btn-secondary text-xs shrink-0"
                      title="Browse for workspace folder"
                    >
                      <FolderOpen size={14} /> Browse
                    </button>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button type="button" onClick={saveDefaultWorkspace} className="grok-btn grok-btn-primary text-sm">
                      Save Workspace
                    </button>
                  </div>
                  <div className="text-xs text-dim mt-1">
                    Root folder for global uploads, new agents, and workspace explorer. Use Browse to pick a directory on this machine.
                  </div>
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <BarChart3 size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Monthly Usage Quota</div>
                      <div className="text-[11px] text-dim">Grok Chat reports spend as a share of this budget.</div>
                    </div>
                    <InfoHint className="ml-auto" text="Green under 60%, amber under 90%, red past it. Estimated from xAI per-token rates; local models are $0." />
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-sm text-dim">$</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="grok-input w-28"
                      value={usageBudgetInput}
                      onChange={(e) => setUsageBudgetInput(e.target.value)}
                    />
                    <span className="text-xs text-dim">per month</span>
                    <button
                      type="button"
                      className="grok-btn grok-btn-secondary text-xs ml-auto"
                      onClick={async () => {
                        const budget = Math.max(0, Number(usageBudgetInput) || 0);
                        const res = await fetch('/api/config', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ usageBudgetUsd: budget }),
                        }).then((r) => r.json()).catch(() => null);
                        if (res?.ok) {
                          toast.success(`Monthly quota set to $${budget}`);
                          void loadNavStats();
                        } else {
                          toast.error('Could not save quota');
                        }
                      }}
                    >
                      Save Quota
                    </button>
                  </div>
                </div>

              </div>

              <div className="mt-5 text-[11px] text-dim">
                Use cloud Grok (xAI API) or local models served on your machine — any model your local server offers is selectable.
                Agents, chat, and usage tracking reflect which provider each model uses.
              </div>
            </div>
          )}
        </div>

        {/* Footer bar */}
        <div className="footer-bar h-9 px-4 text-[10px] flex items-center text-dim justify-between gap-3 relative z-[1]">
          <div
            className="truncate"
            title={
              `Running source commit ${runtimeVersion.commitFull || runtimeVersion.commit}`
              + ` (v${runtimeVersion.version || APP_VERSION})`
              + (runtimeVersion.dirty ? ' · dirty working tree' : '')
              + (runtimeVersion.root ? `\n${runtimeVersion.root}` : '')
            }
          >
            Shiba Studio{' '}
            <span className="font-mono">
              {runtimeVersion.commit}{runtimeVersion.dirty ? '*' : ''}
            </span>
            {' '}— the localhost Grok agent studio • nothing leaves your box
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href="https://shiba-studio.io/docs.html"
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary"
              title="Full documentation — getting started, chat, agents, automations, configuration"
            >
              Docs
            </a>
            <a
              href="https://github.com/stevologic/shiba-studio/issues/new"
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary inline-flex items-center gap-1"
              title="Contribute by submitting a feature request — opens a new GitHub issue"
            >
              <Plus size={11} /> Request a feature
            </a>
            <button
              type="button"
              className={`donate-doge-btn ${dogeCopied ? 'donate-doge-copied' : ''}`}
              onClick={() => {
                navigator.clipboard.writeText(DOGE_DONATION_ADDRESS)
                  .then(() => {
                    setDogeCopied(true);
                    setTimeout(() => setDogeCopied(false), 2200);
                  })
                  .catch(() => toast.error(`Could not copy — address: ${DOGE_DONATION_ADDRESS}`));
              }}
              title={`Support the creator with Dogecoin — click to copy the wallet address\n${DOGE_DONATION_ADDRESS}`}
            >
              {dogeCopied ? 'Ð Address copied — much thanks, very wow 🐕' : 'Ð Donate Dogecoin'}
            </button>
            <Link href="/settings" className="cursor-pointer hover:text-primary">Settings</Link>
          </div>
        </div>
      </div>

      {folderBrowseFor !== null && (
      <FolderBrowseModal
        open={folderBrowseFor !== null}
        title={
          folderBrowseFor === 'workspace'
            ? 'Select default workspace folder'
            : folderBrowseFor === 'mcp'
              ? 'Select allowed directory for MCP filesystem'
              : 'Select Obsidian vault folder'
        }
        initialPath={
          folderBrowseFor === 'workspace'
            ? defaultWorkspaceInput || config?.defaultWorkspace || ''
            : folderBrowseFor === 'mcp'
              ? mcpBrowsePath || defaultWorkspaceInput || config?.defaultWorkspace || ''
              : intCreds.obsidian?.vaultPath || ''
        }
        onClose={() => setFolderBrowseFor(null)}
        onSelect={(path) => {
          if (folderBrowseFor === 'workspace') {
            setDefaultWorkspaceInput(path);
          } else if (folderBrowseFor === 'mcp') {
            setMcpBrowsePath(path);
          } else {
            setIntCreds((c: any) => ({
              ...c,
              obsidian: { ...(c.obsidian || { mode: 'local' }), vaultPath: path },
            }));
          }
          setFolderBrowseFor(null);
        }}
      />
      )}

      {/* Run agent — text prompt modal */}
      {showRunModal && runModalAgent && (
          <div
            className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
            onClick={() => { setShowRunModal(false); setRunModalAgent(null); }}
          >
            <div
              className="modal modal-pop w-full max-w-lg p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="text-lg font-semibold">Run {runModalAgent.name}</div>
                  <div className="text-xs text-dim mt-1">Text instructions for this autonomous agent run.</div>
                </div>
                <span className="multimodal-badge multimodal-badge-muted shrink-0">Text only</span>
              </div>
              <textarea
                className="grok-input schedule-instructions-input text-sm w-full"
                value={runModalPrompt}
                onChange={(e) => setRunModalPrompt(e.target.value)}
                placeholder="What should this agent do?"
                autoFocus
              />
              <div className="modal-multimodal-note mt-3">
                <MultimodalBadge compact />
                <span>
                  Images &amp; files → use{' '}
                  <button type="button" className="link-accent" onClick={() => { setShowRunModal(false); navigateToTab('chat'); }}>
                    Grok Chat
                  </button>
                  {' '}(multimodal submissions).
                </span>
              </div>
              <div className="flex gap-3 mt-5">
                <button
                  type="button"
                  onClick={() => { setShowRunModal(false); setRunModalAgent(null); }}
                  className="grok-btn grok-btn-secondary flex-1"
                >
                  Cancel
                </button>
                <button type="button" onClick={submitRunModal} className="grok-btn grok-btn-primary flex-1">
                  <Play size={14} /> Run
                </button>
              </div>
            </div>
          </div>
        )}

      {/* Run log — hidden while details or execution trace is open (stack). */}
      {historyAgent && !(runDetail || runDetailLoading) && !showTraceModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => { setHistoryAgent(null); setHistoryRuns(null); }}
        >
          <div className="modal modal-pop w-full max-w-2xl p-6 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-1">
              <img src={resolveAgentAvatarPath(historyAgent)} alt="" className="agent-avatar-sm" width={28} height={28} />
              <div className="text-lg font-semibold truncate">Run log — {historyAgent.name}</div>
              <button
                type="button"
                className="grok-btn grok-btn-ghost p-1.5 ml-auto shrink-0"
                onClick={() => { setHistoryAgent(null); setHistoryRuns(null); }}
                title="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="text-xs text-dim mb-4">Click a run to open its full details — prompt, tools, outcome, and execution trace.</div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {historyRuns === null ? (
                <div className="data-loading-row py-6"><span className="data-spinner" /> Loading runs…</div>
              ) : historyRuns.length === 0 ? (
                <div className="text-sm text-dim py-6 text-center">No runs yet — press ▶ on a schedule or wait for the next cron tick.</div>
              ) : (
                <div className="space-y-1.5">
                  {historyRuns.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="run-history-row"
                      onClick={() => {
                        // Keep the run log open underneath — closing the details
                        // modal (backdrop / Esc) returns to this list.
                        void openRunDetails(r.id);
                      }}
                      title="Open run details"
                    >
                      <span className={`run-status run-status-${r.status} shrink-0`}>{r.status}</span>
                      <span className="text-dim shrink-0 text-[11px]">
                        {new Date(r.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="truncate flex-1 text-left text-muted" title={r.prompt}>{r.prompt}</span>
                      <span className="text-dim shrink-0 text-[11px] font-mono">{r.traceSteps ?? 0} steps</span>
                      {r.finalOutput && (
                        <span
                          role="button"
                          tabIndex={0}
                          className="link-accent text-[11px] shrink-0 inline-flex items-center gap-1"
                          onClick={(e) => { e.stopPropagation(); setAnswerRun(r); }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setAnswerRun(r); }
                          }}
                          title="View this run's final answer"
                        >
                          <Eye size={11} /> answer
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end mt-4">
              <button type="button" onClick={() => { setHistoryAgent(null); setHistoryRuns(null); }} className="grok-btn grok-btn-secondary">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Final-answer quick look — the run's output without leaving the page */}
      {answerRun && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4"
          onClick={() => setAnswerRun(null)}
        >
          <div className="modal modal-pop w-full max-w-2xl p-6 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-1">
              <div className="text-lg font-semibold truncate">Answer — {answerRun.agentName}</div>
              <span className={`run-status run-status-${answerRun.status} shrink-0`}>{answerRun.status}</span>
            </div>
            <div className="text-xs text-dim mb-3 flex flex-wrap items-center gap-2">
              <ModelLine modelId={answerRun.model} />
              <span>· {new Date(answerRun.startedAt).toLocaleString()}</span>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 grok-card p-4 bg-black/30">
              <ChatMarkdown content={answerRun.finalOutput || ''} />
            </div>
            <div className="flex items-center justify-between gap-3 mt-4">
              <button
                type="button"
                className="grok-btn grok-btn-ghost text-xs"
                onClick={() => {
                  const id = answerRun.id;
                  setAnswerRun(null);
                  void (async () => {
                    try {
                      const res = await fetch(`/api/runs?id=${encodeURIComponent(id)}`);
                      const data = await res.json();
                      if (!data.ok || !data.run) throw new Error(data.error || 'Run not found');
                      setRunDetail(data.run);
                      openExecutionTraceFromDetails(data.run);
                    } catch (e: unknown) {
                      toast.error(e instanceof Error ? e.message : 'Could not load run');
                    }
                  })();
                }}
              >
                <Terminal size={13} /> Open full trace
              </button>
              <button type="button" onClick={() => setAnswerRun(null)} className="grok-btn grok-btn-secondary">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Run details — middle of the stack (under execution trace, over run log). */}
      {(runDetail || runDetailLoading) && !showTraceModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-[65] p-4"
          onClick={closeRunDetail}
        >
          <div className="modal modal-pop w-full max-w-3xl p-6 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {runDetailLoading || !runDetail ? (
              <div className="data-loading-row py-10 justify-center"><span className="data-spinner data-spinner-lg" /> Loading run…</div>
            ) : (() => {
              const detailAgent = agents.find((a) => a.id === runDetail.agentId) || agents.find((a) => a.name === runDetail.agentName);
              const toolCounts = new Map<string, number>();
              for (const s of runDetail.trace || []) {
                if (s.tool?.name) toolCounts.set(s.tool.name, (toolCounts.get(s.tool.name) || 0) + 1);
              }
              return (
                <>
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <img
                        src={detailAgent ? resolveAgentAvatarPath(detailAgent) : MISSING_AGENT_AVATAR_PATH}
                        alt=""
                        className="agent-avatar-sm shrink-0"
                        width={28}
                        height={28}
                        title={detailAgent ? undefined : 'This agent has since been deleted'}
                      />
                      <div className="text-lg font-semibold truncate">{runDetail.agentName}</div>
                      <span className={`run-status run-status-${runDetail.status} shrink-0`}>{runDetail.status}</span>
                    </div>
                    <button type="button" className="grok-btn grok-btn-ghost p-1.5 shrink-0" onClick={closeRunDetail} title={historyAgent ? 'Back to run log' : 'Close'}>
                      <X size={16} />
                    </button>
                  </div>
                  <div className="text-xs text-dim mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <ModelLine modelId={runDetail.model} />
                    <span>started {new Date(runDetail.startedAt).toLocaleString()}</span>
                    {runDetail.completedAt && <span>· finished {new Date(runDetail.completedAt).toLocaleString()}</span>}
                    {runDetail.scheduleId && <span className="badge badge-muted">scheduled</span>}
                  </div>

                  <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1">
                    <div>
                      <div className="run-detail-label">Prompt</div>
                      <div className="grok-card p-3 text-sm text-muted whitespace-pre-wrap">{runDetail.prompt || '—'}</div>
                    </div>

                    <div className="flex flex-wrap gap-4">
                      <div className="flex-1 min-w-[220px]">
                        <div className="run-detail-label">Tools used</div>
                        {toolCounts.size === 0 ? (
                          <div className="text-xs text-dim">No tool calls in this run.</div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {[...toolCounts.entries()].map(([name, n]) => (
                              <span key={name} className="badge badge-accent font-mono text-[11px]">{name}{n > 1 ? ` ×${n}` : ''}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-[220px]">
                        <div className="run-detail-label">Skills</div>
                        {detailAgent && (detailAgent.skills || []).length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {(detailAgent.skills || []).map((s) => <span key={s} className="badge badge-accent text-[11px]">{s}</span>)}
                          </div>
                        ) : (
                          <div className="text-xs text-dim">{detailAgent ? 'No skills assigned.' : 'Agent deleted — skills unknown.'}</div>
                        )}
                      </div>
                    </div>

                    {(runDetail.sideEffects || []).length > 0 && (
                      <div>
                        <div className="run-detail-label">Side effects</div>
                        <ul className="text-xs text-muted space-y-1">
                          {(runDetail.sideEffects || []).map((s, i) => <li key={i} className="flex gap-2"><span className="text-dim shrink-0">•</span><span>{String(s)}</span></li>)}
                        </ul>
                      </div>
                    )}

                    {runDetail.finalOutput && (
                      <div>
                        <div className="run-detail-label">Outcome</div>
                        <div className="grok-card p-3 bg-black/30">
                          <ChatMarkdown content={runDetail.finalOutput} />
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="run-detail-label">Execution trace · {(runDetail.trace || []).length} steps</div>
                      <div className="grok-card p-3 font-mono text-xs bg-black/40 max-h-[300px] overflow-auto">
                        {(runDetail.trace || []).length === 0 ? (
                          <div className="text-dim">No trace recorded.</div>
                        ) : (runDetail.trace || []).map((step, idx) => (
                          <div key={idx} className={`trace-step mb-3 ${step.type}`}>
                            <div className="text-[10px] text-dim">{new Date(step.ts).toLocaleTimeString()} — {String(step.type).toUpperCase()}</div>
                            <div className="mt-0.5">{step.content}</div>
                            {step.tool && <div className="tool-call mt-1">{step.tool.name} {JSON.stringify(step.tool.args)}</div>}
                            {step.screenshot && <div className="mt-2 screenshot"><img src={step.screenshot} alt="capture" /></div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 mt-4">
                    <button
                      type="button"
                      className="grok-btn grok-btn-ghost text-xs"
                      onClick={() => openExecutionTraceFromDetails(runDetail)}
                      title="Open the full execution trace (returns here when closed)"
                    >
                      <Terminal size={13} /> Open in trace view
                    </button>
                    <button
                      type="button"
                      onClick={closeRunDetail}
                      className="grok-btn grok-btn-secondary"
                    >
                      {historyAgent ? 'Back to run log' : 'Close'}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Agent create/edit modal — rich form */}
      {showAgentModal && (
          <div
            className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
            onClick={() => { setShowAgentModal(false); setEditingAgent(null); setHighlightScheduleIdx(null); }}
          >
            <div className="modal modal-pop w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="text-xl font-semibold mb-4">{editingAgent ? 'Edit Agent' : 'Create New Agent'}</div>

              <div className="grid grid-cols-1 gap-y-4">
                <div>
                  <div className="grok-label">Agent Name</div>
                  <input className="grok-input" value={agentForm.name} onChange={e => setAgentForm({ ...agentForm, name: e.target.value })} />
                </div>
                <div>
                  <div className="grok-label">Alien Avatar</div>
                  <div className="flex items-center gap-3 mb-2">
                    <img
                      src={ALIEN_AVATARS.find(a => a.id === agentForm.avatar)?.path || ALIEN_AVATARS[0].path}
                      alt="Selected avatar"
                      className="agent-avatar"
                      width={40}
                      height={40}
                    />
                    <span className="text-xs text-dim">{ALIEN_AVATARS.find(a => a.id === agentForm.avatar)?.label || 'Alien 1'} — pick from 50 aliens below</span>
                  </div>
                  <div className="avatar-picker">
                    {ALIEN_AVATARS.map(av => (
                      <button
                        key={av.id}
                        type="button"
                        className={`avatar-option ${agentForm.avatar === av.id ? 'selected' : ''}`}
                        onClick={() => setAgentForm({ ...agentForm, avatar: av.id })}
                        title={av.label}
                      >
                        <img src={av.path} alt={av.label} width={32} height={32} />
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="grok-label mb-1">Runs on</div>
                  <div className="sync-direction">
                    <button
                      type="button"
                      onClick={() => setAgentForm({ ...agentForm, origin: 'local' })}
                      className={`sync-direction-option ${agentForm.origin !== 'cloud' ? 'sync-direction-active' : ''}`}
                    >
                      <Terminal size={14} /> Local machine
                    </button>
                    <button
                      type="button"
                      onClick={() => setAgentForm({ ...agentForm, origin: 'cloud' })}
                      className={`sync-direction-option ${agentForm.origin === 'cloud' ? 'sync-direction-active' : ''}`}
                    >
                      <Globe size={14} /> Grok cloud
                    </button>
                  </div>
                  <div className="text-[10px] text-dim mt-1">
                    {agentForm.origin === 'cloud'
                      ? 'Cloud agent — works through Grok cloud services and connected integrations only. No local files, shell, or browser access.'
                      : 'Local agent — full system access on this machine: files, shell, Chrome browser, git worktrees, MCP tools, plus all cloud services.'}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="grok-label mb-0">Grok Model</div>
                    {agentForm.model && <ModelProviderBadge modelId={agentForm.model} />}
                    <button type="button" onClick={loadModels} disabled={modelsLoading} className="grok-btn grok-btn-ghost text-xs py-0.5">
                      <RefreshCw size={12} className={modelsLoading ? 'animate-spin' : ''} /> Refresh
                    </button>
                  </div>
                  <select className="grok-select w-full mt-1" value={agentForm.model || ''} onChange={e=>setAgentForm({...agentForm, model: e.target.value})} disabled={modelsLoading && availableModels.length === 0}>
                    {renderModelOptions(agentForm.model)}
                  </select>
                  <div className="text-xs text-dim mt-0.5">
                    {availableModels.length > 0
                      ? `${availableModels.length} models — Cloud (xAI) and/or Local (this machine).`
                      : modelsError || 'Add xAI API key, sign in with X (OAuth), or enable local models in Settings.'}
                  </div>
                  {agentForm.model && (
                    <div className="text-[10px] text-dim mt-1">
                      This agent will use <strong>{providerLabel(parseModelRef(agentForm.model).provider)}</strong> inference: {modelDisplayName(agentForm.model)}
                    </div>
                  )}
                </div>
                <div>
                  <div className="grok-label">Default voice</div>
                  <select
                    className="grok-select w-full mt-1"
                    value={agentForm.voiceId || ''}
                    onChange={(e) => setAgentForm({ ...agentForm, voiceId: e.target.value })}
                    aria-label="Default Grok TTS voice for this agent"
                  >
                    <option value="">
                      Studio default
                      {defaultTtsVoiceInput
                        ? ` (${agentVoiceOptions.find((v) => v.id === defaultTtsVoiceInput)?.name
                          || GROK_TTS_VOICES.find((v) => v.id === defaultTtsVoiceInput)?.name
                          || defaultTtsVoiceInput})`
                        : ''}
                    </option>
                    {/* Ensure a saved custom/unknown id still appears even if not in the live list */}
                    {agentForm.voiceId
                      && !agentVoiceOptions.some((v) => v.id === agentForm.voiceId)
                      && (
                        <option value={agentForm.voiceId}>
                          {agentForm.voiceId} (saved)
                        </option>
                      )}
                    {agentVoiceOptions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}{v.description ? ` — ${v.description}` : ''}
                      </option>
                    ))}
                  </select>
                  <div className="text-[10px] text-dim mt-1">
                    Used when chatting as this agent (Grok Voice / Speak). Leave as app default to use the global chat voice
                    {agentForm.voiceId
                      ? ` · currently ${agentVoiceOptions.find((v) => v.id === agentForm.voiceId)?.name || agentForm.voiceId}`
                      : ` · app fallback is ${DEFAULT_TTS_VOICE}`}.
                  </div>
                </div>
                {agentForm.origin !== 'cloud' ? (
                  <>
                    <div>
                      <div className="grok-label">Workspace Path</div>
                      <input className="grok-input" value={agentForm.workspace?.path || ''} onChange={e => setAgentForm({ ...agentForm, workspace: { ...agentForm.workspace, path: e.target.value } })} />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={agentForm.workspace?.useWorktree} onChange={e => setAgentForm({ ...agentForm, workspace: { ...agentForm.workspace, useWorktree: e.target.checked } })} /> Use isolated git worktree (recommended)
                    </label>
                  </>
                ) : (
                  <div className="text-[11px] text-dim border border-default rounded p-3">
                    Cloud agents have no local workspace — they act through Grok cloud services and the integrations you enable below.
                  </div>
                )}

                <div className="agent-form-section">
                  <div className="agent-form-section-head">
                    <div className="agent-form-section-title">
                      <Plug size={15} className="opacity-70" />
                      Capabilities — integrations
                    </div>
                    <div className="agent-form-section-sub">
                      Toggle which connected services this agent may use during runs and chat.
                    </div>
                  </div>
                  <div className="agent-capability-grid">
                    {INTEGRATION_IDS.map(key => {
                      const meta = getIntegrationMeta(key)!;
                      const on = !!agentForm.integrations?.[key];
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`agent-capability-tile ${on ? 'on' : ''}`}
                          onClick={() => setAgentForm({
                            ...agentForm,
                            integrations: { ...agentForm.integrations, [key]: !on },
                          })}
                        >
                          <IntegrationIcon id={key} size="sm" />
                          <span className="agent-capability-label">{meta.label}</span>
                          <span className={`agent-capability-check ${on ? 'on' : ''}`}>
                            {on ? <Check size={12} /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Google Drive folder isolation — soft-scope this agent to
                    specific folders instead of the whole Drive. */}
                {agentForm.integrations?.googledrive && (
                  <div className="grok-card p-3 bg-black/20">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="grok-label mb-0 flex items-center gap-1.5">
                        Google Drive folder scope
                        <InfoHint text="Restrict this agent's Google Drive tools to specific Drive folders. It will only list files inside them and upload into the first. Leave empty for full Google Drive access. This is workspace isolation enforced in the tool layer, not a hard API boundary." />
                      </div>
                      <button type="button" className="grok-btn grok-btn-ghost text-xs" onClick={() => void loadDriveFolders()} disabled={driveFoldersLoading}>
                        {driveFoldersLoading ? 'Loading…' : (driveFolderOptions ? 'Refresh folders' : 'Load folders')}
                      </button>
                    </div>
                    {(agentForm.driveFolders || []).length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {(agentForm.driveFolders || []).map((f: { id: string; name: string }) => (
                          <span key={f.id} className="tool-chip tool-chip-local flex items-center gap-1">
                            📁 {f.name}
                            <button type="button" className="opacity-70 hover:opacity-100" title="Remove" onClick={() => setAgentForm({ ...agentForm, driveFolders: (agentForm.driveFolders || []).filter((x: { id: string }) => x.id !== f.id) })}>×</button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-warning mb-2">Full Google Drive access — this agent can read and write anywhere in Drive. Pick folders below to isolate it.</div>
                    )}
                    {driveFolderOptions && driveFolderOptions.length > 0 && (
                      <div className="workspace-dir-list max-h-40 overflow-auto">
                        {driveFolderOptions.map((f) => {
                          const selected = (agentForm.driveFolders || []).some((x: { id: string }) => x.id === f.id);
                          return (
                            <label key={f.id} className="workspace-dir-item cursor-pointer">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={(e) => {
                                  const cur = agentForm.driveFolders || [];
                                  setAgentForm({
                                    ...agentForm,
                                    driveFolders: e.target.checked
                                      ? [...cur, { id: f.id, name: f.name }]
                                      : cur.filter((x: { id: string }) => x.id !== f.id),
                                  });
                                }}
                              />
                              <span className="truncate min-w-0">📁 {f.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    {driveFolderOptions && driveFolderOptions.length === 0 && (
                      <div className="text-[11px] text-dim">No folders found (or Google Drive not signed in). Sign in on the Capabilities page, then Load folders.</div>
                    )}
                  </div>
                )}

                {(() => {
                  const enabledAuth = INTEGRATION_IDS.filter((k) => agentForm.integrations?.[k] && AGENT_OVERRIDE_FIELDS[k]);
                  if (!enabledAuth.length) return null;
                  const ov = agentForm.integrationOverrides || {};
                  const setOv = (svc: string, field: string, value: string) => setAgentForm({
                    ...agentForm,
                    integrationOverrides: { ...ov, [svc]: { ...(ov[svc] || {}), [field]: value } },
                  });
                  return (
                    <details className="grok-card p-3 bg-black/20">
                      <summary className="grok-label mb-0 cursor-pointer select-none flex items-center gap-1.5">
                        Scoped credentials (optional)
                        <InfoHint text="Give this agent its OWN account for an enabled integration — e.g. its own GitHub token or X account — instead of the global one. Leave a field blank to fall back to the global credentials. Stored AES-256-GCM encrypted." />
                      </summary>
                      <div className="mt-2 space-y-3">
                        <div className="text-[11px] text-dim">Only fills shown for integrations this agent has enabled above. Empty = use the global account.</div>
                        {enabledAuth.map((svc) => (
                          <div key={svc}>
                            <div className="text-xs font-medium flex items-center gap-1.5 mb-1"><IntegrationIcon id={svc} size="sm" /> {getIntegrationMeta(svc)?.label} — this agent&apos;s account</div>
                            <div className="space-y-1.5">
                              {AGENT_OVERRIDE_FIELDS[svc].map((f) => (
                                f.key === 'serviceAccountJson' ? (
                                  <textarea key={f.key} className="grok-input text-xs font-mono h-16" placeholder={f.label} value={ov[svc]?.[f.key] || ''} onChange={(e) => setOv(svc, f.key, e.target.value)} />
                                ) : (
                                  <input key={f.key} type={f.secret ? 'password' : 'text'} className="grok-input text-xs" placeholder={f.label} value={ov[svc]?.[f.key] || ''} onChange={(e) => setOv(svc, f.key, e.target.value)} />
                                )
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  );
                })()}

                <div>
                  <div className="grok-label">Peer Agents (inter-agent messaging)</div>
                  <select multiple className="grok-select w-full h-20" value={agentForm.peers || []} onChange={e => {
                    const sel = Array.from(e.target.selectedOptions).map(o => o.value);
                    setAgentForm({ ...agentForm, peers: sel });
                  }}>
                    {agents.filter(a => !editingAgent || a.id !== editingAgent.id).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <div className="text-[10px] text-dim">Selected agents can receive messages from this one via the send_to_peer tool.</div>
                </div>

                <div className="agent-form-section">
                  <div className="agent-form-section-head">
                    <div className="agent-form-section-title">
                      <MessageSquare size={15} className="opacity-70" />
                      Chat personality
                    </div>
                    <div className="agent-form-section-sub">
                      How this agent speaks in Grok Chat — tone, style, and priorities.
                    </div>
                  </div>
                  <textarea
                    className="grok-input schedule-instructions-input text-xs"
                    placeholder="You are a sharp, encouraging builder who explains trade-offs clearly and celebrates small wins…"
                    value={agentForm.chatSkill || ''}
                    onChange={(e) => setAgentForm({ ...agentForm, chatSkill: e.target.value })}
                  />
                </div>

                <div className="agent-form-section">
                  <div className="agent-form-section-head">
                    <div className="agent-form-section-title">
                      <Sparkles size={15} className="opacity-70" />
                      Skills &amp; specialties
                    </div>
                    <div className="agent-form-section-sub">
                      Capability packs injected into autonomous runs (coding, research, browser, …). Click a tile to toggle.
                    </div>
                  </div>
                  {(agentForm.skills || []).length > 0 && (
                    <div className="agent-active-skills mb-3">
                      {(agentForm.skills || []).map((skillId: string) => (
                        <button
                          key={skillId}
                          type="button"
                          className="agent-skill-chip"
                          title="Remove skill"
                          onClick={() => setAgentForm({
                            ...agentForm,
                            skills: (agentForm.skills || []).filter((s: string) => s !== skillId),
                          })}
                        >
                          {skillId}
                          <X size={11} />
                        </button>
                      ))}
                    </div>
                  )}
                  <SkillsBrowser
                    compact
                    installed={agentForm.skills || []}
                    onInstall={(skillId) => {
                      const cur = agentForm.skills || [];
                      if (cur.includes(skillId)) return;
                      setAgentForm({ ...agentForm, skills: [...cur, skillId] });
                    }}
                    onUninstall={(skillId) => {
                      setAgentForm({
                        ...agentForm,
                        skills: (agentForm.skills || []).filter((s: string) => s !== skillId),
                      });
                    }}
                  />
                </div>

                <div
                  id="agent-schedules-section"
                  className={`agent-form-section ${highlightScheduleIdx !== null ? 'schedule-section-focus' : ''}`}
                >
                  <div className="agent-form-section-head">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="agent-form-section-title">
                          <CalendarClock size={15} className="opacity-70" />
                          Automations
                        </div>
                        <div className="agent-form-section-sub">
                          When this agent should wake up on its own — and exactly what to do each time.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setAgentForm({
                            ...agentForm,
                            schedules: [...(agentForm.schedules || []), defaultScheduleEntry()],
                          });
                        }}
                        className="grok-btn grok-btn-secondary text-xs shrink-0"
                      >
                        <Plus size={13} /> Add schedule
                      </button>
                    </div>
                  </div>

                  {(agentForm.schedules || []).length === 0 ? (
                    <div className="agent-schedule-empty">
                      <Clock size={20} className="opacity-40 mb-2" />
                      <div className="text-sm font-medium">No automations yet</div>
                      <div className="text-xs text-dim mt-1 max-w-xs mx-auto leading-relaxed">
                        Add a schedule so this agent can run on a timer with its own prompt — no cron knowledge needed.
                      </div>
                      <button
                        type="button"
                        className="grok-btn grok-btn-primary text-xs mt-3"
                        onClick={() => {
                          setAgentForm({
                            ...agentForm,
                            schedules: [defaultScheduleEntry()],
                          });
                        }}
                      >
                        <Plus size={13} /> Create first schedule
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {(agentForm.schedules || []).map((sch: any, idx: number) => {
                        const preset: SchedulePresetId = sch._preset || 'every_30m';
                        const presetMeta = SCHEDULE_PRESETS.find((p) => p.id === preset);
                        return (
                          <div
                            key={sch.id || idx}
                            id={`agent-schedule-${idx}`}
                            className={`agent-schedule-card ${highlightScheduleIdx === idx ? 'schedule-entry-highlight' : ''} ${sch.enabled ? 'is-active' : 'is-paused'}`}
                          >
                            <div className="agent-schedule-card-top">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="agent-schedule-index">{idx + 1}</span>
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold truncate">
                                    {presetMeta?.label || 'Schedule'}
                                    {(preset === 'daily' || preset === 'weekdays') && sch._time
                                      ? ` · ${sch._time}`
                                      : ''}
                                  </div>
                                  <div className="text-[10px] text-dim font-mono truncate">
                                    {sch.cron || presetMeta?.hint}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  className={`automation-status-tag ${sch.enabled ? 'automation-status-active' : 'automation-status-paused'}`}
                                  onClick={() => patchSchedule(idx, { enabled: !sch.enabled })}
                                  title={sch.enabled ? 'Pause this schedule' : 'Activate this schedule'}
                                >
                                  {sch.enabled ? 'Active' : 'Paused'}
                                </button>
                                <button
                                  type="button"
                                  className="grok-btn grok-btn-ghost text-xs p-1 text-error"
                                  title="Remove schedule"
                                  onClick={() => {
                                    const news = (agentForm.schedules || []).filter((_: any, i: number) => i !== idx);
                                    setAgentForm({ ...agentForm, schedules: news });
                                  }}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </div>

                            <div className="agent-schedule-freq">
                              <div className="agent-schedule-freq-label">Frequency</div>
                              <div className="agent-schedule-presets">
                                {SCHEDULE_PRESETS.filter((p) => p.id !== 'custom').map((p) => (
                                  <button
                                    key={p.id}
                                    type="button"
                                    className={`agent-schedule-preset ${preset === p.id ? 'active' : ''}`}
                                    onClick={() => onSchedulePresetChange(idx, p.id)}
                                    title={p.hint}
                                  >
                                    {p.label}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  className={`agent-schedule-preset ${preset === 'custom' ? 'active' : ''}`}
                                  onClick={() => onSchedulePresetChange(idx, 'custom')}
                                  title="Raw cron expression"
                                >
                                  Custom
                                </button>
                              </div>
                              {(preset === 'daily' || preset === 'weekdays') && (
                                <div className="flex items-center gap-2 mt-2">
                                  <span className="text-[10px] text-dim">At</span>
                                  <input
                                    type="time"
                                    className="grok-input w-auto text-xs"
                                    value={sch._time || '09:00'}
                                    onChange={(e) => onScheduleTimeChange(idx, e.target.value)}
                                  />
                                  <span className="text-[10px] text-dim">{presetMeta?.hint}</span>
                                </div>
                              )}
                              {preset === 'custom' ? (
                                <input
                                  className="grok-input text-xs font-mono mt-2"
                                  placeholder="*/15 * * * *"
                                  value={sch._customCron ?? sch.cron ?? ''}
                                  onChange={(e) => patchSchedule(idx, {
                                    _customCron: e.target.value,
                                    cron: e.target.value,
                                    _preset: 'custom',
                                  })}
                                />
                              ) : preset !== 'daily' && preset !== 'weekdays' ? (
                                <div className="text-[10px] text-dim mt-2">{presetMeta?.hint}</div>
                              ) : null}
                            </div>

                            <div>
                              <div className="agent-schedule-freq-label">What to do each run</div>
                              <textarea
                                className="grok-input schedule-instructions-input text-xs"
                                placeholder="Clear instructions for this automation — e.g. “Summarize new issues in #agent-logs and flag blockers.”"
                                value={sch.instructions || ''}
                                onChange={(e) => patchSchedule(idx, { instructions: e.target.value })}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-3 mt-6">
                <button onClick={() => { setShowAgentModal(false); setEditingAgent(null); setHighlightScheduleIdx(null); }} className="grok-btn grok-btn-secondary flex-1">Cancel</button>
                <button onClick={createOrUpdateAgent} disabled={loading} className="grok-btn grok-btn-primary flex-1">Save Agent</button>
              </div>
              <div className="modal-multimodal-note mt-4">
                <MultimodalBadge compact />
                <span>
                  Grok Chat supports multimodal submissions (images &amp; files). Agent runs here are text-only prompts.
                </span>
              </div>
              <div className="text-[10px] text-center mt-3 text-dim">Agents run exclusively via Grok tool calling + your local tools.</div>
            </div>
          </div>
        )}

      {showCommandPalette && (
        <CommandPalette
          open={showCommandPalette}
          onClose={() => setShowCommandPalette(false)}
          commands={paletteCommands}
        />
      )}

      {pendingToolApproval && (
        <ToolApprovalModal
          pending={pendingToolApproval}
          onApprove={(id) => void resolveToolApproval(id, true)}
          onDeny={(id) => void resolveToolApproval(id, false)}
        />
      )}

      {showSyncModal && (
        <SyncModal
          open={showSyncModal}
          onClose={() => setShowSyncModal(false)}
          localModelInUse={!!(config as any)?.localGrokEnabled}
          onSynced={() => { void loadAll(); void loadNavStats(); }}
        />
      )}

      <ConfirmHost />
    </div>
  );
}
