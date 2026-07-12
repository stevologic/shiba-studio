"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Home, MessageSquare, Users, FolderOpen, FolderKanban, KanbanSquare, Clock, Plug, Settings, Play, Plus, Trash2, Edit2,
  CalendarClock, Check, ChevronDown, ChevronUp, X, RefreshCw, Terminal, Globe, Camera, BarChart3, Upload,
  CloudUpload, Command, Menu, Pencil, ScrollText, History, Eye, ChevronsLeft, ChevronsRight,
  KeyRound, Server, Cpu, ShieldCheck, Sparkles, Volume2, Gauge, Archive, Bug, CopyPlus
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
const KanbanBoard = dynamic(() => import('@/components/kanban-board'), { loading: panelLoading });
const PreviewRail = dynamic(() => import('@/components/preview-rail'), { loading: panelLoading });
const ToolsCatalog = dynamic(() => import('@/components/tools-catalog'), { loading: panelLoading });
const ChatMarkdown = dynamic(() => import('@/components/chat-markdown-lazy'));
const SyncModal = dynamic(() => import('@/components/sync-modal'));
const CommandPalette = dynamic(() => import('@/components/command-palette'));
const FolderBrowseModal = dynamic(() => import('@/components/folder-browse-modal'));
const ToolApprovalModal = dynamic(() => import('@/components/tool-approval-modal'));
import { toast } from '@/lib/toast';
import { getTerminalOpen, setTerminalOpen, toggleTerminalOpen, subscribeTerminalOpen } from '@/lib/terminal-ui-store';
import {
  endVoiceIfSessionChanges,
  getVoiceAgentUiState,
  subscribeVoiceAgentUi,
} from '@/lib/voice-agent-ui-store';
import {
  hasLiveChatRuns,
  primaryLiveChatSessionId,
  subscribeLiveChatRuns,
} from '@/lib/chat-live-runs';
import { Agent, AgentRun, AppConfig, GrokModel, EMPTY_INTEGRATION_SCOPE } from '@/lib/types';
import { isMaskedSecret, maskSecret } from '@/lib/secret-mask';
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
import { estimateCronRunsPerDay, SCHEDULE_RUNS_PER_DAY_WARN } from '@/lib/cron-estimate';
import { AGENT_INTEGRATION_IDS, INTEGRATION_CATALOG, INTEGRATION_IDS, getIntegrationMeta } from '@/lib/integration-catalog';
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
  getCachedNavStats,
  isNavStatsLoaded,
  writeCachedNavStats,
} from '@/lib/nav-stats-store';
import {
  getCachedAgents,
  hasCachedAgents,
  setCachedAgents,
} from '@/lib/agents-ui-store';
import { getCachedRuns, setCachedRuns } from '@/lib/runs-ui-store';
import { subscribeLiveEvents } from '@/lib/live-events';
import {
  getCachedIntegrationCreds,
  setCachedIntegrationCreds,
} from '@/lib/integrations-ui-store';
import {
  getProvidersUiSnapshot,
  hasProvidersUiSnapshot,
  patchProvidersUiSnapshot,
  setProvidersUiSnapshot,
  type CachedOauthStatus,
} from '@/lib/providers-ui-store';
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
  dashboard: 'Dashboard', chat: 'Grok Chat', projects: 'Projects', board: 'Board', agents: 'Agents',
  workspace: 'Workspace', automations: 'Automations', integrations: 'Capabilities',
  usage: 'Usage', logs: 'Logs', settings: 'Settings',
};

/** Survives React remounts so chat session URL changes never re-bootstrap the shell. */
let studioBootstrapped = false;

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

/** Providers rail probes (local reachability, CLI) — cache 10 min across reloads. */
const PROVIDER_STATUS_LS = 'shiba-provider-status-v1';
const PROVIDER_STATUS_TTL_MS = 10 * 60_000;

type ProviderStatusCache = {
  at: number;
  localGrokReachable?: boolean;
  grokCli?: { installed: boolean; version?: string; path?: string };
};

function readProviderStatusCache(): ProviderStatusCache | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PROVIDER_STATUS_LS);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProviderStatusCache;
    if (!parsed || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function providerStatusCacheFresh(cache: ProviderStatusCache | null): boolean {
  return !!cache && Date.now() - cache.at < PROVIDER_STATUS_TTL_MS;
}

function writeProviderStatusCache(patch: Partial<Omit<ProviderStatusCache, 'at'>>): void {
  if (typeof window === 'undefined') return;
  try {
    const prev = readProviderStatusCache() || { at: 0 };
    const next: ProviderStatusCache = {
      ...prev,
      ...patch,
      at: Date.now(),
    };
    window.localStorage.setItem(PROVIDER_STATUS_LS, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

function invalidateProviderStatusCache(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PROVIDER_STATUS_LS);
  } catch {
    /* private mode */
  }
}

/** Per-agent credential override fields, by integration. Only shown for the
 *  integrations an agent has enabled — lets an agent use its own account. */
const AGENT_OVERRIDE_FIELDS: Record<string, Array<{ key: string; label: string; secret?: boolean }>> = {
  github: [{ key: 'token', label: 'GitHub token (ghp_…)', secret: true }],
  slack: [
    { key: 'token', label: 'Slack bot token (xoxb-…)', secret: true },
    { key: 'appToken', label: 'App-level token (xapp-… Socket Mode)', secret: true },
    { key: 'defaultChannel', label: 'Default channel (#…)' },
    { key: 'mentionAgentId', label: 'Mention agent id (optional)' },
  ],
  discord: [
    { key: 'token', label: 'Discord bot token', secret: true },
    { key: 'defaultChannelId', label: 'Default channel id' },
    { key: 'mentionAgentId', label: 'Mention agent id (optional)' },
  ],
  x: [
    { key: 'apiKey', label: 'API Key' }, { key: 'apiSecret', label: 'API Secret', secret: true },
    { key: 'accessToken', label: 'Access Token' }, { key: 'accessTokenSecret', label: 'Access Token Secret', secret: true },
  ],
  obsidian: [{ key: 'restApiUrl', label: 'REST API URL' }, { key: 'restApiKey', label: 'REST API key', secret: true }, { key: 'vaultPath', label: 'Vault path (local mode)' }],
  googledrive: [{ key: 'accessToken', label: 'OAuth access token', secret: true }, { key: 'serviceAccountJson', label: 'Service account JSON', secret: true }],
  vercel: [
    { key: 'token', label: 'Vercel access token', secret: true },
    { key: 'teamId', label: 'Team id (team_…, optional)' },
    { key: 'teamSlug', label: 'Team slug (optional)' },
    { key: 'defaultProject', label: 'Default project name or id' },
  ],
  netlify: [
    { key: 'token', label: 'Netlify personal access token', secret: true },
    { key: 'accountSlug', label: 'Account slug (optional)' },
    { key: 'defaultSite', label: 'Default site id or name' },
  ],
};

/** Enter-to-submit for single-line settings inputs: typing a value and pressing
 *  Enter runs that field's Save action instead of doing nothing. */
function submitOnEnter(run: () => void) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  };
}

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
    // Prefer replace for session switches so the App Router doesn't treat each
    // click as a heavy navigation. Layout holds ShibaStudio so badges stay put.
    if (
      pathname === '/chat'
      || pathname === '/chat/'
      || pathname.startsWith('/chat/')
    ) {
      router.replace(path);
    } else {
      router.push(path);
    }
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

  // Seed from module cache so remounts/tab hops never show a false empty list.
  const [agents, setAgents] = useState<Agent[]>(() => getCachedAgents() ?? []);
  const [agentsReady, setAgentsReady] = useState(() => hasCachedAgents());
  // Runs ride the same remount cache: without it, every tab navigation showed
  // an empty "Recent Agent Runs" until the next poll or a page refresh.
  const [runs, setRuns] = useState<AgentRun[]>(() => getCachedRuns() ?? []);
  // Providers / auth — same remount cache so the rail doesn't flash "off".
  const [config, setConfig] = useState<AppConfig | null>(
    () => (getProvidersUiSnapshot()?.config as AppConfig | null) ?? null,
  );
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
  // Same keep-alive for background chat turns: leave Chat and the session keeps working.
  const [chatRunActive, setChatRunActive] = useState(false);
  useEffect(() => {
    setChatRunActive(hasLiveChatRuns());
    return subscribeLiveChatRuns(() => setChatRunActive(hasLiveChatRuns()));
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
  const [toolApprovalMode, setToolApprovalMode] = useState<ToolApprovalMode>('ask');
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
    name: 'Builder Agent', avatar: 'alien-01', model: 'grok-4', workspace: { path: '', useWorktree: true },
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
  // Seed from the module cache so a shell remount (tab nav) never flashes
  // configured integrations as "Not set up" while /api/integrations re-fetches.
  const [intCreds, setIntCreds] = useState<any>(() => getCachedIntegrationCreds());
  const [intTest, setIntTest] = useState<any>({});
  const [intSaving, setIntSaving] = useState<Record<string, boolean>>({});
  const [expandedIntegration, setExpandedIntegration] = useState<string | null>(null);

  function integrationConfigured(id: string): boolean {
    const creds = (intCreds as Record<string, Record<string, string>>)[id] || {};
    if (id === 'obsidian') return !!(creds.vaultPath?.trim() || creds.restApiUrl?.trim());
    if (id === 'linear') return !!creds.apiKey?.trim();
    if (id === 'jira') return !!(creds.baseUrl?.trim() && creds.email?.trim() && creds.apiToken?.trim());
    return Object.entries(creds).some(([k, v]) => k !== 'mode' && typeof v === 'string' && v.trim().length > 0);
  }
  const [folderBrowseFor, setFolderBrowseFor] = useState<'obsidian' | 'workspace' | 'mcp' | null>(null);
  const [mcpBrowsePath, setMcpBrowsePath] = useState<string | null>(null);
  const [grokCliStatus, setGrokCliStatus] = useState<{ installed: boolean; version?: string; path?: string } | null>(
    () => getProvidersUiSnapshot()?.grokCli ?? null,
  );

  const [apiKeyInput, setApiKeyInput] = useState(() => {
    const snap = getProvidersUiSnapshot();
    return snap?.apiKeyMasked || (snap?.hasApiKeyMasked ? '••••••••' : '');
  });
  const [managementKeyInput, setManagementKeyInput] = useState(() => {
    const snap = getProvidersUiSnapshot();
    return snap?.managementKeyMasked || (snap?.hasManagementKeyMasked ? '••••••••' : '');
  });
  /** Persistent "Tested" badges for Settings probe buttons (localStorage). */
  type SettingsTestId = 'apiKey' | 'managementKey' | 'localGrok';
  const SETTINGS_TESTED_LS = 'shiba-settings-tested';
  const [settingsTested, setSettingsTested] = useState<Partial<Record<SettingsTestId, boolean>>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_TESTED_LS);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Record<SettingsTestId, boolean>>;
      if (parsed && typeof parsed === 'object') setSettingsTested(parsed);
    } catch { /* private mode / bad JSON */ }
  }, []);
  function markSettingsTested(id: SettingsTestId, ok: boolean) {
    setSettingsTested((prev) => {
      const next = { ...prev, [id]: ok };
      try { window.localStorage.setItem(SETTINGS_TESTED_LS, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }
  const [oauthStatus, setOauthStatus] = useState<CachedOauthStatus>(() =>
    getProvidersUiSnapshot()?.oauthStatus ?? { connected: false, expired: false },
  );
  const [cloudAuthMode, setCloudAuthMode] = useState<'api_key' | 'oauth'>(() =>
    getProvidersUiSnapshot()?.cloudAuthMode ?? 'api_key',
  );
  const [oauthCallbackInput, setOauthCallbackInput] = useState('');
  const [oauthStarting, setOauthStarting] = useState(false);
  const [defaultModelInput, setDefaultModelInput] = useState('');
  const [defaultTtsVoiceInput, setDefaultTtsVoiceInput] = useState(DEFAULT_TTS_VOICE);
  const [defaultTtsSpeedInput, setDefaultTtsSpeedInput] = useState(DEFAULT_TTS_SPEED);
  /** Voice-test playback: idle → loading (fetching TTS) → playing. */
  const [voiceTestState, setVoiceTestState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const voiceTestRef = useRef<HTMLAudioElement | null>(null);
  const [defaultWorkspaceInput, setDefaultWorkspaceInput] = useState('');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>(() =>
    (getProvidersUiSnapshot()?.availableModels as ModelOption[] | undefined) ?? [],
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(() =>
    getProvidersUiSnapshot()?.modelsError ?? null,
  );
  const [localGrokEnabled, setLocalGrokEnabled] = useState(() =>
    getProvidersUiSnapshot()?.localGrokEnabled ?? false,
  );
  const [localGrokBaseUrl, setLocalGrokBaseUrl] = useState(() =>
    getProvidersUiSnapshot()?.localGrokBaseUrl ?? 'http://127.0.0.1:1234/v1',
  );
  const [localGrokReachable, setLocalGrokReachable] = useState(() => {
    const snap = getProvidersUiSnapshot();
    if (snap) return snap.localGrokReachable;
    const cache = typeof window !== 'undefined' ? readProviderStatusCache() : null;
    return cache?.localGrokReachable ?? false;
  });
  const [localModelOptions, setLocalModelOptions] = useState<string[]>(() =>
    getProvidersUiSnapshot()?.localModelOptions ?? [],
  );
  const [localModelAllowlist, setLocalModelAllowlist] = useState<string[]>(() =>
    getProvidersUiSnapshot()?.localModelAllowlist ?? [],
  );
  const [localModelsFetching, setLocalModelsFetching] = useState(false);

  // Providers probes (CLI + local) — hydrate from module + 10‑min LS cache; only re-probe when stale.
  useEffect(() => {
    const snap = getProvidersUiSnapshot();
    if (snap?.grokCli) setGrokCliStatus(snap.grokCli);
    if (snap?.localGrokReachable != null) setLocalGrokReachable(!!snap.localGrokReachable);

    const cache = readProviderStatusCache();
    if (cache?.localGrokReachable != null && !snap) setLocalGrokReachable(!!cache.localGrokReachable);
    if (cache?.grokCli && !snap?.grokCli) setGrokCliStatus(cache.grokCli);

    // Fresh probe cache + we already have CLI status → skip network.
    if (providerStatusCacheFresh(cache) && (cache?.grokCli || snap?.grokCli)) return;
    // Module snapshot already has CLI from this tab session → skip re-probe on remount.
    if (snap?.grokCli) return;

    fetch('/api/grok-cli/status')
      .then((r) => r.json())
      .then((data) => {
        const next = {
          installed: !!data.installed,
          version: data.version as string | undefined,
          path: data.path as string | undefined,
        };
        setGrokCliStatus(next);
        writeProviderStatusCache({ grokCli: next });
        patchProvidersUiSnapshot({ grokCli: next });
      })
      .catch(() => {
        const next = { installed: false as const };
        setGrokCliStatus(next);
        writeProviderStatusCache({ grokCli: next });
        patchProvidersUiSnapshot({ grokCli: next });
      });
  }, []);
  // Seed from module cache so tab switches / remounts never flash zeros or spinners.
  const [navStats, setNavStats] = useState<NavStats>(() => getCachedNavStats());
  const [navStatsLoaded, setNavStatsLoaded] = useState(() => isNavStatsLoaded());
  const [cliUpdate, setCliUpdate] = useState<{ checking: boolean; text?: string; available?: boolean }>({ checking: false });
  /** Live commit of the tree this server process is serving (refreshed via /api/version). */
  const [runtimeVersion, setRuntimeVersion] = useState<{
    version: string;
    commit: string;
    commitFull: string | null;
    dirty: boolean;
    root?: string;
  }>({ version: APP_VERSION, commit: GIT_COMMIT_FALLBACK, commitFull: null, dirty: false });
  const [updateNotice, setUpdateNotice] = useState<{ latest: string; url: string | null } | null>(null);
  // One release-update probe per app load (server caches the GitHub call 6h).
  useEffect(() => {
    fetch('/api/version?checkUpdate=1', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d?.update?.updateAvailable && d.update.latest) {
          setUpdateNotice({ latest: d.update.latest, url: d.update.url || null });
        }
      })
      .catch(() => { /* offline — no notice */ });
  }, []);
  // Cost & safety + retention (Settings card) — text state so fields can be cleared.
  const [costSettings, setCostSettings] = useState({
    usageBudgetUsd: '',
    usageCostSource: 'auto' as 'auto' | 'xai' | 'local',
    dailyBudgetUsd: '',
    budgetHardStop: true,
    maxConcurrentRuns: '3',
    perRunTokenCap: '',
    sandboxMemoryMb: '',
    sandboxCpus: '',
    runRetentionDays: '',
    auditRetentionDays: '',
  });
  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | null>(null);
  const [clearingBoard, setClearingBoard] = useState(false);
  const backupFileRef = useRef<HTMLInputElement | null>(null);

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

  /**
   * Full badge refresh — only call after a mutation that can change counts
   * (create/delete chat, project, automation, integration, sync, etc.).
   * Never call on plain tab / session navigation.
   */
  async function loadNavStats() {
    try {
      const res = await fetch('/api/nav-stats');
      const data = await res.json();
      if (data.ok) {
        const next: NavStats = {
          chatSessions: data.chatSessions ?? 0,
          projects: data.projects ?? 0,
          boardOpen: data.boardOpen ?? 0,
          workspaceFiles: data.workspaceFiles ?? 0,
          automationsScheduled: data.automationsScheduled ?? 0,
          integrationsConfigured: data.integrationsConfigured ?? 0,
          usageCostUsd: data.usageCostUsd ?? 0,
          usageCostSource: data.usageCostSource === 'xai' ? 'xai' : 'local',
          usageBudgetUsd: data.usageBudgetUsd ?? 0,
          cloudReachable: data.cloudReachable !== false,
        };
        // Skip setState when nothing changed — avoids badge flicker / re-paint.
        if (!writeCachedNavStats(next) && isNavStatsLoaded()) return;
        setNavStats(next);
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

  async function loadModels(opts?: { forceProviderProbe?: boolean }) {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
        const mapped: ModelOption[] = data.models.map((m: ModelOption) => ({
          id: m.id,
          label: m.label || modelDisplayName(m.id),
          provider: m.provider || (m.id.startsWith('local:') ? 'local' : 'cloud'),
          reasoning: m.reasoning,
        }));
        setAvailableModels(mapped);
        patchProvidersUiSnapshot({ availableModels: mapped, modelsError: null });
        // Only refresh Local badge from this probe when cache is stale or forced —
        // still always apply when the server reports a definitive localReachable.
        if (typeof data.localReachable === 'boolean') {
          const cache = readProviderStatusCache();
          if (opts?.forceProviderProbe || !providerStatusCacheFresh(cache) || data.localReachable === false) {
            setLocalGrokReachable(!!data.localReachable);
            writeProviderStatusCache({ localGrokReachable: !!data.localReachable });
            patchProvidersUiSnapshot({ localGrokReachable: !!data.localReachable });
          }
        }
        setChatModel((current) => pickDefaultModel(current));
        const resolvedDefault = pickDefaultModel(config?.defaultGrokModel || defaultModelInput || undefined);
        if (config?.defaultGrokModel) setDefaultModelInput(config.defaultGrokModel);
        else if (!defaultModelInput) setDefaultModelInput(resolvedDefault);
        setAgentForm((f: any) => ({ ...f, model: pickDefaultModel(f.model) }));
      } else {
        setAvailableModels([]);
        const errMsg = data.error || (data.hasCloudAuth || data.localEnabled ? 'No models returned' : 'Add xAI API key, sign in with X (OAuth), or enable local models in Settings');
        setModelsError(errMsg);
        patchProvidersUiSnapshot({ availableModels: [], modelsError: errMsg });
        // Failed / empty model list with local enabled → mark Local offline
        if (data.localEnabled || localGrokEnabled || (config as any)?.localGrokEnabled) {
          if (data.localReachable === false || data.error) {
            setLocalGrokReachable(false);
            writeProviderStatusCache({ localGrokReachable: false });
            patchProvidersUiSnapshot({ localGrokReachable: false });
          }
        }
      }
    } catch (e: any) {
      setAvailableModels([]);
      setModelsError(e.message);
      patchProvidersUiSnapshot({ availableModels: [], modelsError: e.message });
      // Network/API failure — don't claim Local is healthy
      if (localGrokEnabled || (config as any)?.localGrokEnabled) {
        setLocalGrokReachable(false);
        writeProviderStatusCache({ localGrokReachable: false });
        patchProvidersUiSnapshot({ localGrokReachable: false });
      }
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

  /** Runs update both state and the remount cache — always together. */
  function applyRuns(next: AgentRun[]) {
    setCachedRuns(next);
    setRuns(next);
  }

  /** Refresh the run list alone (dashboard/automations data — changes often). */
  async function refreshRuns() {
    try {
      const rRes = await fetch('/api/runs').then((r) => r.json());
      if (Array.isArray(rRes.runs)) applyRuns(rRes.runs);
    } catch {
      /* keep last runs */
    }
  }

  /**
   * Push a loaded config into every form/display state derived from it.
   * Called from loadAll AND from the remount-restore path — the Settings
   * forms used to reset to defaults on every tab navigation because only
   * loadAll populated them. Returns the derived values the providers
   * snapshot needs.
   */
  function applyConfigToForms(cfg: any) {
    setConfig(cfg as any);
    // Server sends partial fingerprints ("xai-ab…7f3a"), never full keys —
    // recognizable in the input without exposing the secret.
    if (cfg.hasKey) setApiKeyInput(String(cfg.xaiApiKey || '') || '••••••••');
    if (cfg.hasManagementKey) setManagementKeyInput(String(cfg.xaiManagementKey || '') || '••••••••');
    const nextOauth: CachedOauthStatus = cfg.oauthStatus
      ? cfg.oauthStatus
      : { connected: false, expired: false };
    if (cfg.oauthStatus) setOauthStatus(nextOauth);
    const nextAuthMode = (cfg.cloudAuthMode === 'oauth' ? 'oauth' : 'api_key') as 'api_key' | 'oauth';
    if (cfg.cloudAuthMode) setCloudAuthMode(nextAuthMode);
    const nextLocalEnabled = cfg.localGrokEnabled !== undefined ? !!cfg.localGrokEnabled : localGrokEnabled;
    if (cfg.localGrokEnabled !== undefined) setLocalGrokEnabled(nextLocalEnabled);
    const nextLocalBase = cfg.localGrokBaseUrl || localGrokBaseUrl;
    if (cfg.localGrokBaseUrl) setLocalGrokBaseUrl(cfg.localGrokBaseUrl);
    const nextAllowlist = Array.isArray(cfg.localModelAllowlist) ? cfg.localModelAllowlist : localModelAllowlist;
    if (Array.isArray(cfg.localModelAllowlist)) setLocalModelAllowlist(nextAllowlist);
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
    setCostSettings({
      usageBudgetUsd: cfg.usageBudgetUsd ? String(cfg.usageBudgetUsd) : '',
      usageCostSource: (cfg.usageCostSource === 'xai' || cfg.usageCostSource === 'local' ? cfg.usageCostSource : 'auto') as 'auto' | 'xai' | 'local',
      dailyBudgetUsd: cfg.dailyBudgetUsd ? String(cfg.dailyBudgetUsd) : '',
      budgetHardStop: cfg.budgetHardStop !== false,
      maxConcurrentRuns: String(cfg.maxConcurrentRuns || 3),
      perRunTokenCap: cfg.perRunTokenCap ? String(cfg.perRunTokenCap) : '',
      sandboxMemoryMb: cfg.sandboxMemoryMb ? String(cfg.sandboxMemoryMb) : '',
      sandboxCpus: cfg.sandboxCpus ? String(cfg.sandboxCpus) : '',
      runRetentionDays: cfg.runRetentionDays ? String(cfg.runRetentionDays) : '',
      auditRetentionDays: cfg.auditRetentionDays ? String(cfg.auditRetentionDays) : '',
    });
    return { nextOauth, nextAuthMode, nextLocalEnabled, nextLocalBase, nextAllowlist };
  }

  // Load everything. Each part applies independently (allSettled) — one
  // failing endpoint must not blank the other three until the next refresh.
  async function loadAll() {
    try {
      const settle = <T,>(r: PromiseSettledResult<T>): T | null =>
        r.status === 'fulfilled' ? r.value : null;
      const [aResS, rResS, cResS, intResS] = await Promise.allSettled([
        fetch('/api/agents').then(r => r.json()),
        fetch('/api/runs').then(r => r.json()),
        fetch('/api/config').then(r => r.json()),
        fetch('/api/integrations').then(r => r.json()),
      ]);
      const aRes = settle(aResS);
      const rRes = settle(rResS);
      const cRes = settle(cResS);
      const intRes = settle(intResS);
      if (aRes) {
        const nextAgents = (aRes.agents || []) as Agent[];
        setCachedAgents(nextAgents);
        setAgents(nextAgents);
        setAgentsReady(true);
      }
      if (rRes) applyRuns(rRes.runs || []);
      if (intRes?.integrations) {
        const merged = { github: {}, slack: {}, googledrive: {}, discord: {}, x: {}, obsidian: { mode: 'local' }, linear: {}, jira: {}, ...intRes.integrations };
        setCachedIntegrationCreds(merged);
        setIntCreds(merged);
      }
      if (!cRes) return;
      const cfg = cRes;
      const { nextOauth, nextAuthMode, nextLocalEnabled, nextLocalBase, nextAllowlist } = applyConfigToForms(cfg);
      // Persist Providers rail picture for remounts / tab hops (skip full loadAll).
      const probe = readProviderStatusCache();
      setProvidersUiSnapshot({
        config: cfg as Record<string, unknown>,
        oauthStatus: nextOauth,
        cloudAuthMode: nextAuthMode,
        localGrokEnabled: nextLocalEnabled,
        localGrokBaseUrl: nextLocalBase,
        localGrokReachable: probe?.localGrokReachable
          ?? getProvidersUiSnapshot()?.localGrokReachable
          ?? false,
        localModelOptions: getProvidersUiSnapshot()?.localModelOptions ?? [],
        localModelAllowlist: nextAllowlist,
        grokCli: getProvidersUiSnapshot()?.grokCli ?? probe?.grokCli ?? null,
        availableModels: getProvidersUiSnapshot()?.availableModels ?? [],
        modelsError: getProvidersUiSnapshot()?.modelsError ?? null,
        hasApiKeyMasked: !!(cfg as any).hasKey,
        hasManagementKeyMasked: !!(cfg as any).hasManagementKey,
        apiKeyMasked: (cfg as any).hasKey ? String((cfg as any).xaiApiKey || '') : '',
        managementKeyMasked: (cfg as any).hasManagementKey ? String((cfg as any).xaiManagementKey || '') : '',
      });
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

  // Catalog + badges + providers load ONCE per browser tab. On remount, restore
  // from module caches — never leave agents empty or Providers all-off.
  useEffect(() => {
    if (studioBootstrapped) {
      if (isNavStatsLoaded()) {
        setNavStats(getCachedNavStats());
        setNavStatsLoaded(true);
      }
      if (hasCachedAgents()) {
        setAgents(getCachedAgents() ?? []);
        setAgentsReady(true);
      }
      const snap = getProvidersUiSnapshot();
      if (snap) {
        // Config-derived form states first (Settings inputs, guardrails,
        // default model/voice/workspace) — these used to silently reset to
        // factory defaults on every tab navigation.
        if (snap.config) applyConfigToForms(snap.config);
        // Snapshot fields override where the snapshot is fresher (probes).
        setOauthStatus(snap.oauthStatus);
        setCloudAuthMode(snap.cloudAuthMode);
        setLocalGrokEnabled(snap.localGrokEnabled);
        setLocalGrokBaseUrl(snap.localGrokBaseUrl);
        setLocalGrokReachable(snap.localGrokReachable);
        setLocalModelOptions(snap.localModelOptions);
        setLocalModelAllowlist(snap.localModelAllowlist);
        if (snap.grokCli) setGrokCliStatus(snap.grokCli);
        if (snap.availableModels?.length) setAvailableModels(snap.availableModels as ModelOption[]);
        if (snap.modelsError != null) setModelsError(snap.modelsError);
        if (snap.hasApiKeyMasked) setApiKeyInput(snap.apiKeyMasked || '••••••••');
        if (snap.hasManagementKeyMasked) setManagementKeyInput(snap.managementKeyMasked || '••••••••');
      }
      // Runs change constantly — the cache painted the first frame; refresh now
      // instead of waiting out the 30s poll.
      void refreshRuns();
      // Cold caches (HMR / partial remount) — full hydrate once.
      if (!hasCachedAgents() && !hasProvidersUiSnapshot()) {
        void loadAll();
      }
      return;
    }
    studioBootstrapped = true;
    loadAll();
    void loadNavStats();
  }, []);

  // Usage badge alone: refresh the cost figure every 15 minutes (not entity counts).
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch('/api/nav-stats');
        const data = await res.json();
        if (data.ok) {
          setNavStats((prev) => {
            const next: NavStats = {
              ...prev,
              usageCostUsd: data.usageCostUsd ?? prev.usageCostUsd,
              usageCostSource: data.usageCostSource === 'xai'
                ? 'xai'
                : (data.usageCostSource === 'local' ? 'local' : prev.usageCostSource),
            };
            writeCachedNavStats(next);
            return next;
          });
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

  // Model catalog: load once when cloud/local becomes available (not every poll tick).
  // If remount restored models from providers cache, skip a redundant fetch.
  const modelsBootstrappedRef = useRef(!!(getProvidersUiSnapshot()?.availableModels?.length));
  useEffect(() => {
    const cloud = !!(config as any)?.hasCloudAuth;
    const local = !!(localGrokEnabled || (config as any)?.localGrokEnabled);
    if (!cloud && !local) return;
    if (modelsBootstrappedRef.current && availableModels.length > 0) return;
    modelsBootstrappedRef.current = true;
    void loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(config as any)?.hasCloudAuth, (config as any)?.localGrokEnabled, localGrokEnabled]);

  // Local reachability for Providers rail — use 10‑min cache; only probe when stale.
  useEffect(() => {
    if (!localGrokEnabled && !(config as any)?.localGrokEnabled) return;
    const cache = readProviderStatusCache();
    if (providerStatusCacheFresh(cache) && cache?.localGrokReachable != null) {
      setLocalGrokReachable(!!cache.localGrokReachable);
      return;
    }
    void fetchLocalModelOptions({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localGrokEnabled, (config as any)?.localGrokEnabled]);

  // Settings → Local models list: only refresh options when cache is stale.
  useEffect(() => {
    if (tab !== 'settings' || !localGrokEnabled) return;
    const cache = readProviderStatusCache();
    if (providerStatusCacheFresh(cache) && cache?.localGrokReachable != null && localModelOptions.length > 0) return;
    void fetchLocalModelOptions({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, localGrokEnabled]);

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
  /** Schedules whose Run was just clicked — instant "running" UI on THAT row
   *  until the SSE runs feed reports the real run (expires after 12s). Keyed by
   *  schedule id so only the specific automation shows running, not the agent's
   *  other schedules. */
  const [justStartedRunScheds, setJustStartedRunScheds] = useState<Set<string>>(new Set());
  function markScheduleRunJustStarted(scheduleId: string) {
    if (!scheduleId) return;
    setJustStartedRunScheds((current) => new Set(current).add(scheduleId));
    window.setTimeout(() => {
      setJustStartedRunScheds((current) => {
        if (!current.has(scheduleId)) return current;
        const next = new Set(current);
        next.delete(scheduleId);
        return next;
      });
    }, 12_000);
  }

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

  /** Refresh the open run-details modal without the loading flicker — used to
   *  poll a run that's still executing so status/trace update live. */
  async function refreshRunDetailQuiet(runId: string) {
    try {
      const res = await fetch(`/api/runs?id=${encodeURIComponent(runId)}`);
      const data = await res.json();
      if (data.ok && data.run) setRunDetail(data.run);
    } catch { /* keep the last snapshot on a transient error */ }
  }

  /** Open the live status/trace for a running automation (its running run). */
  function openRunningRun(scheduleId: string) {
    const running = runs.find((r) => r.scheduleId === scheduleId && r.status === 'running')
      || runs.find((r) => r.status === 'running' && !r.scheduleId);
    if (running) { void openRunDetails(running.id); return; }
    toast('This automation is starting — its trace will appear in a moment.');
  }

  // While the run-details modal shows a still-executing run, poll it so the
  // status and trace update live (the runtime persists the trace each step).
  const runDetailId = runDetail?.id;
  const runDetailStatus = runDetail?.status;
  useEffect(() => {
    if (!runDetailId || runDetailStatus !== 'running') return;
    const t = window.setInterval(() => { void refreshRunDetailQuiet(runDetailId); }, 2500);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshRunDetailQuiet is stable enough; keyed to the running run
  }, [runDetailId, runDetailStatus]);

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

  /** Create-automation form on the Automations page (no full agent editor). */
  type NewAutomationForm = {
    agentId: string;
    instructions: string;
    enabled: boolean;
    _preset: SchedulePresetId;
    _time: string;
    _customCron: string;
  };
  const emptyNewAutomation = (): NewAutomationForm => ({
    agentId: '',
    instructions: '',
    enabled: true,
    _preset: 'every_30m',
    _time: '09:00',
    _customCron: '*/30 * * * *',
  });
  const [showNewAutomation, setShowNewAutomation] = useState(false);
  const [newAutomation, setNewAutomation] = useState<NewAutomationForm>(emptyNewAutomation);
  const [savingAutomation, setSavingAutomation] = useState(false);

  function openNewAutomationModal(preselectAgentId?: string) {
    const preferred = preselectAgentId || agents[0]?.id || '';
    setNewAutomation({
      ...emptyNewAutomation(),
      agentId: preferred,
      instructions: preferred
        ? `Scheduled work for ${agents.find((a) => a.id === preferred)?.name || 'agent'}.`
        : '',
    });
    setShowNewAutomation(true);
  }

  async function createAutomationFromPage() {
    const agent = agents.find((a) => a.id === newAutomation.agentId);
    if (!agent) {
      toast.error(agents.length === 0 ? 'Create an agent first (Agents page)' : 'Pick an agent for this automation');
      return;
    }
    const instructions = newAutomation.instructions.trim();
    if (!instructions) {
      toast.error('Add instructions — what should the agent do when it runs?');
      return;
    }
    const cron = presetToCron(
      newAutomation._preset,
      newAutomation._time,
      newAutomation._customCron,
    ).trim();
    if (!cron) {
      toast.error('Choose a valid schedule');
      return;
    }
    setSavingAutomation(true);
    try {
      const entry = {
        id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        enabled: !!newAutomation.enabled,
        cron,
        instructions,
        description: instructions.slice(0, 80),
      };
      const existing = agentSchedules(agent);
      const schedules = [...existing, entry];
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          agent: { ...agent, schedules, schedule: undefined },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.error) throw new Error(data.error);
      await refreshAgents();
      await loadNavStats();
      setShowNewAutomation(false);
      setNewAutomation(emptyNewAutomation());
      toast.success(`Automation added to ${agent.name}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not create automation');
    }
    setSavingAutomation(false);
  }

  // Agents CRUD
  async function refreshAgents() {
    const res = await fetch('/api/agents').then(r => r.json());
    const nextAgents = (res.agents || []) as Agent[];
    setCachedAgents(nextAgents);
    setAgents(nextAgents);
    setAgentsReady(true);
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

  /**
   * Clone: open the create modal pre-filled from an existing agent so only the
   * one thing that differs (model, a scope, a skill) needs changing. Goes
   * through the CREATE path (editingAgent=null) so the server mints a fresh id
   * — any stray id/timestamps in the form are ignored on create. Schedules are
   * carried but disabled so the copy can't silently double an automation.
   */
  function openCloneAgent(a: Agent) {
    setEditingAgent(null);
    const norm = { ...a };
    const srcSchedules = (norm.schedules && norm.schedules.length)
      ? norm.schedules
      : (norm.schedule
        ? [{ id: 'legacy', enabled: norm.schedule.enabled, cron: norm.schedule.cron, instructions: norm.schedule.description || norm.description || 'Scheduled task' }]
        : []);
    setAgentForm({
      ...norm,
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      name: `${norm.name} (copy)`,
      avatar: resolveAgentAvatar(norm),
      voiceId: typeof norm.voiceId === 'string' ? norm.voiceId : '',
      workspace: { ...norm.workspace },
      integrations: { ...norm.integrations },
      integrationOverrides: norm.integrationOverrides ? JSON.parse(JSON.stringify(norm.integrationOverrides)) : {},
      driveFolders: [...(norm.driveFolders || [])],
      peers: [...(norm.peers || [])],
      skills: [...(norm.skills || [])],
      schedules: srcSchedules.map((s, i) =>
        enrichScheduleForForm({ ...s, id: `sch-clone-${i}-${Date.now()}`, enabled: false })),
    });
    setDriveFolderOptions(null);
    setShowAgentModal(true);
    toast.success('Cloned — tweak what differs and Create. Schedules start paused.');
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
        const merged = { github: {}, slack: {}, googledrive: {}, discord: {}, x: {}, obsidian: { mode: 'local' }, linear: {}, jira: {}, ...data.integrations };
        setCachedIntegrationCreds(merged);
        setIntCreds(merged);
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
      message: which === 'linear' || which === 'jira'
        ? 'Stored credentials are deleted from this machine. Existing issue links remain on Board, but sync is unavailable until you reconnect.'
        : 'Stored credentials for this integration are deleted from this machine. Agents lose access until you reconfigure it.',
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
        const merged = { github: {}, slack: {}, googledrive: {}, discord: {}, x: {}, obsidian: { mode: 'local' }, linear: {}, jira: {}, ...data.integrations };
        setCachedIntegrationCreds(merged);
        setIntCreds(merged);
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
    if (!apiKeyInput || isMaskedSecret(apiKeyInput)) return;
    const res = await fetch('/api/grok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'validate', key: apiKeyInput }) });
    const data = await res.json();
    if (data.ok) {
      markSettingsTested('apiKey', true);
      toast.success('Grok API key validated & saved');
      await loadAll();
      await loadModels();
    } else {
      markSettingsTested('apiKey', false);
      toast.error('Key validation failed: ' + (data.error || 'bad key'));
    }
  }

  async function quickValidate() {
    const res = await fetch('/api/grok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'validate', key: apiKeyInput }) });
    const data = await res.json();
    markSettingsTested('apiKey', !!data.ok);
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
    markSettingsTested('apiKey', false);
    toast.success('API key cleared');
    await loadAll();
    await loadModels();
  }

  async function saveManagementKey() {
    if (!managementKeyInput || isMaskedSecret(managementKeyInput)) return;
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xaiManagementKey: managementKeyInput }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      toast.success('Management key saved — Usage will pull xAI billing data');
      setManagementKeyInput(maskSecret(managementKeyInput));
      await loadAll();
      await loadNavStats();
    } else {
      toast.error(data.error || 'Failed to save management key');
    }
  }

  async function testManagementKey() {
    const key = managementKeyInput?.trim() || '';
    const usingSaved = !key || isMaskedSecret(key);
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
        markSettingsTested('managementKey', true);
        toast.success(data.note || 'Management key is valid');
      } else {
        markSettingsTested('managementKey', false);
        toast.error(
          [data.error, data.note].filter(Boolean).join(' — ') || 'Management key test failed',
        );
      }
    } catch (e: unknown) {
      markSettingsTested('managementKey', false);
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
    markSettingsTested('managementKey', false);
    toast.success('Management key cleared');
    await loadAll();
  }

  async function refreshOAuthStatus() {
    try {
      const res = await fetch('/api/xai-oauth/status');
      const data = await res.json();
      if (data.ok) {
        const next: CachedOauthStatus = {
          connected: !!data.connected,
          expired: !!data.expired,
          email: data.email,
          displayName: data.displayName,
          error: data.error,
        };
        setOauthStatus(next);
        patchProvidersUiSnapshot({ oauthStatus: next });
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
    patchProvidersUiSnapshot({ oauthStatus: { connected: false, expired: false } });
    toast.success('OAuth disconnected');
    await loadAll();
    await loadModels();
  }

  async function saveCloudAuthMode(mode: 'api_key' | 'oauth') {
    setCloudAuthMode(mode);
    patchProvidersUiSnapshot({ cloudAuthMode: mode });
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudAuthMode: mode }),
    });
    const data = await res.json();
    if (data.ok) {
      setConfig((c: any) => {
        const next = { ...c, cloudAuthMode: mode, activeCloudSource: data.activeCloudSource };
        patchProvidersUiSnapshot({ config: next as Record<string, unknown> });
        return next;
      });
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
    setConfig((c: any) => {
      const next = { ...c, localGrokEnabled, localGrokBaseUrl };
      patchProvidersUiSnapshot({
        config: next as Record<string, unknown>,
        localGrokEnabled,
        localGrokBaseUrl,
      });
      return next;
    });
    toast.success(localGrokEnabled ? 'Local models enabled' : 'Local models disabled');
    invalidateProviderStatusCache();
    modelsBootstrappedRef.current = false;
    if (localGrokEnabled) {
      await fetchLocalModelOptions({ silent: true });
    } else {
      setLocalGrokReachable(false);
      writeProviderStatusCache({ localGrokReachable: false });
      patchProvidersUiSnapshot({ localGrokReachable: false });
    }
    await loadModels({ forceProviderProbe: true });
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
        writeProviderStatusCache({ localGrokReachable: true });
        const optsList = ((data.models || []) as Array<{ id?: string; label?: string }>).map(localIdOf).filter(Boolean);
        setLocalModelOptions(optsList);
        patchProvidersUiSnapshot({ localGrokReachable: true, localModelOptions: optsList });
        if (!opts?.silent) {
          markSettingsTested('localGrok', true);
          toast.success(`Local server reachable — ${data.models?.length || 0} model(s) found`);
        }
      } else {
        setLocalGrokReachable(false);
        writeProviderStatusCache({ localGrokReachable: false });
        setLocalModelOptions([]);
        patchProvidersUiSnapshot({ localGrokReachable: false, localModelOptions: [] });
        if (!opts?.silent) {
          markSettingsTested('localGrok', false);
          toast.error(data.error || 'Local server not reachable');
        }
      }
      return !!data.ok;
    } catch {
      setLocalGrokReachable(false);
      writeProviderStatusCache({ localGrokReachable: false });
      setLocalModelOptions([]);
      patchProvidersUiSnapshot({ localGrokReachable: false, localModelOptions: [] });
      if (!opts?.silent) markSettingsTested('localGrok', false);
      return false;
    } finally {
      setLocalModelsFetching(false);
    }
  }

  async function testLocalGrok() {
    invalidateProviderStatusCache();
    const ok = await fetchLocalModelOptions();
    if (ok) await loadModels({ forceProviderProbe: true });
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

  async function saveCostSettings() {
    const payload = {
      usageBudgetUsd: Number(costSettings.usageBudgetUsd) || 0,
      usageCostSource: costSettings.usageCostSource,
      dailyBudgetUsd: Number(costSettings.dailyBudgetUsd) || 0,
      budgetHardStop: costSettings.budgetHardStop,
      maxConcurrentRuns: Number(costSettings.maxConcurrentRuns) || 3,
      perRunTokenCap: Number(costSettings.perRunTokenCap) || 0,
      sandboxMemoryMb: Number(costSettings.sandboxMemoryMb) || 0,
      sandboxCpus: Number(costSettings.sandboxCpus) || 0,
      runRetentionDays: Number(costSettings.runRetentionDays) || 0,
      auditRetentionDays: Number(costSettings.auditRetentionDays) || 0,
    };
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      toast.error('Failed to save cost & safety settings');
      return;
    }
    setConfig((c: any) => ({ ...c, ...payload }));
    toast.success('Cost & safety settings saved');
    void loadNavStats();
  }

  async function exportBackup() {
    setBackupBusy('export');
    try {
      // Anchor download — the route sets Content-Disposition with a dated name.
      const a = document.createElement('a');
      a.href = '/api/backup';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => setBackupBusy(null), 800);
    }
  }

  async function clearBoardData() {
    if (!window.confirm('Delete ALL board cards and start from scratch? This cannot be undone.')) return;
    setClearingBoard(true);
    try {
      const res = await fetch('/api/board', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clearBoard' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Could not clear the board');
      toast.success(data.removed ? `Board cleared — removed ${data.removed} card${data.removed === 1 ? '' : 's'}` : 'Board is already empty');
      loadNavStats();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not clear the board');
    }
    setClearingBoard(false);
  }

  async function importBackup(file: File) {
    setBackupBusy('import');
    try {
      const text = await file.text();
      let bundle: unknown;
      try {
        bundle = JSON.parse(text);
      } catch {
        toast.error('That file is not valid JSON');
        return;
      }
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
      });
      const data = await res.json();
      if (!data.ok) {
        toast.error(data.error || 'Restore failed');
        return;
      }
      for (const w of data.warnings || []) toast.warning(w);
      toast(`Restored: ${(data.restored || []).join(', ')}. Reloading…`);
      setTimeout(() => window.location.reload(), 1500);
    } finally {
      setBackupBusy(null);
    }
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

  /** Speak a short sample with the CURRENTLY SELECTED (possibly unsaved)
   *  voice + speed so the user can audition before saving. */
  async function testDefaultVoice() {
    // Second click while playing = stop.
    if (voiceTestRef.current) {
      voiceTestRef.current.pause();
      URL.revokeObjectURL(voiceTestRef.current.src);
      voiceTestRef.current = null;
      setVoiceTestState('idle');
      return;
    }
    const voice = (defaultTtsVoiceInput || DEFAULT_TTS_VOICE).trim().toLowerCase() || DEFAULT_TTS_VOICE;
    const speed = clampTtsSpeed(defaultTtsSpeedInput);
    const name = agentVoiceOptions.find((v) => v.id === voice)?.name
      || GROK_TTS_VOICES.find((v) => v.id === voice)?.name
      || voice;
    setVoiceTestState('loading');
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Hi, I'm ${name} — this is how Grok will sound in Shiba Studio.`,
          voice_id: voice,
          speed,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `TTS failed (${res.status})`);
      }
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      voiceTestRef.current = audio;
      const cleanup = () => {
        URL.revokeObjectURL(audio.src);
        if (voiceTestRef.current === audio) voiceTestRef.current = null;
        setVoiceTestState('idle');
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      setVoiceTestState('playing');
      await audio.play();
    } catch (e) {
      if (voiceTestRef.current) {
        URL.revokeObjectURL(voiceTestRef.current.src);
        voiceTestRef.current = null;
      }
      setVoiceTestState('idle');
      toast.error(e instanceof Error ? e.message : 'Voice test failed');
    }
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

  // Seed a sample agent only after the first successful agents fetch returned [].
  // Never seed while agents are still loading (that looked like "no agents" and
  // could race a real list still on disk).
  // Deps are always exactly 3 primitives so HMR / remount never trips
  // "useEffect dependency array changed size".
  const hasConfig = !!config;
  const agentCount = agents.length;
  const seededEmptyAgentsRef = useRef(false);
  useEffect(() => {
    if (!agentsReady || !hasConfig) return;
    if (agentCount > 0) {
      // The install has agents — remember that, so a later intentional
      // full-delete is treated as the user's choice, not a fresh first run.
      try { window.localStorage.setItem('shiba-seeded-agents', '1'); } catch { /* private mode */ }
      return;
    }
    if (seededEmptyAgentsRef.current) return;
    // Seed the sample agent only on a genuine first run. Once this install has
    // ever had agents (persisted flag), an empty roster means the user deleted
    // them — never resurrect Explorer Agent against their wishes.
    try {
      if (window.localStorage.getItem('shiba-seeded-agents')) {
        seededEmptyAgentsRef.current = true;
        return;
      }
    } catch { /* private mode — fall through and seed */ }
    seededEmptyAgentsRef.current = true;
    try { window.localStorage.setItem('shiba-seeded-agents', '1'); } catch { /* private mode */ }
    let cancelled = false;
    const cfg = config;
    (async () => {
      await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Explorer Agent',
          model: cfg?.defaultGrokModel || pickDefaultModel(),
          description: 'Default exploration + automation agent',
          workspace: { path: cfg?.defaultWorkspace || '.', useWorktree: true },
          integrations: { ...EMPTY_INTEGRATION_SCOPE },
          peers: [],
          schedule: { enabled: true, cron: '0 */2 * * *' },
        }),
      });
      if (!cancelled) await refreshAgents();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config read once when hasConfig flips true
  }, [agentsReady, agentCount, hasConfig]);

  // Light poll: runs list only (not full loadAll agents/config/integrations).
  // Full loadAll was a major nav jank source every 22s; runs need fresher data.
  useEffect(() => {
    const t = setInterval(() => { void refreshRuns(); }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable helper, interval armed once
  }, []);

  // Live change feed (SSE): refresh the affected slice the moment the server
  // says data changed — running tasks, board moves, chat sessions, agents all
  // update without a page refresh. Polls above stay as a fallback. Debounced
  // per slice so bursty writers (an agent posting notes) coalesce.
  useEffect(() => {
    const timers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
    const debounced = (key: string, fn: () => void, ms = 400) => {
      if (timers[key]) clearTimeout(timers[key]);
      timers[key] = setTimeout(() => { timers[key] = undefined; fn(); }, ms);
    };
    const unsubscribe = subscribeLiveEvents(['runs', 'board', 'chats', 'agents'], (type) => {
      if (type === 'runs') {
        debounced('runs', () => { void refreshRuns(); });
      } else if (type === 'agents') {
        debounced('agents', () => { void refreshAgents(); void loadNavStats(); });
      } else {
        // board / chats → nav badges (open cards, session count).
        debounced('nav', () => { void loadNavStats(); }, 600);
      }
    });
    return () => {
      unsubscribe();
      for (const t of Object.values(timers)) if (t) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable helpers, subscribe once per mount
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
      { id: 'board', label: 'Board' },
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
      {
        id: `clone-${a.id}`,
        label: `Clone ${a.name}`,
        group: 'Agents',
        keywords: ['clone', 'copy', 'duplicate', a.name],
        run: () => openCloneAgent(a),
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
            // Open = backlog + todo + in progress: the work still ahead of review.
            { id: 'board', label: 'Board', icon: KanbanSquare, stat: navStats.boardOpen > 0 ? String(navStats.boardOpen) : null },
            { id: 'agents', label: 'Agents', icon: Users, stat: agents.length > 0 ? String(agents.length) : null },
            { id: 'workspace', label: 'Workspace', icon: FolderOpen, stat: navStats.workspaceFiles > 0 ? String(navStats.workspaceFiles) : null },
            { id: 'automations', label: 'Automations', icon: Clock, stat: navStats.automationsScheduled > 0 ? String(navStats.automationsScheduled) : null },
            { id: 'integrations', label: 'Capabilities', icon: Plug, stat: navStats.integrationsConfigured > 0 ? String(navStats.integrationsConfigured) : null },
            {
              id: 'usage',
              label: 'Usage',
              icon: BarChart3,
              // Always show a cost badge when xAI account usage is configured (even $0.00);
              // otherwise only show local studio metering when spend is non-zero.
              stat: (navStats.usageCostSource === 'xai' || navStats.usageCostUsd > 0)
                ? formatUsageCostUsd(navStats.usageCostUsd)
                : null,
            },
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
                prefetch={false}
                onClick={(e) => {
                  // Client navigate without re-bootstrapping badges/catalog.
                  e.preventDefault();
                  navigateToTab(item.id as AppTab);
                }}
                className={`nav-item ${active ? 'active' : ''} ${navCollapsed ? 'nav-item-collapsed' : ''}`}
                title={item.label}
                aria-label={item.label}
              >
                <Icon size={16} strokeWidth={1.75} className="nav-item-icon" aria-hidden />
                <span className="nav-item-label">{item.label}</span>
                {!navCollapsed && !navStatsLoaded && item.id !== 'dashboard' && item.id !== 'settings' && item.id !== 'agents' && item.id !== 'logs' && (
                  <span className="data-spinner nav-item-meta ml-auto" aria-label={`Loading ${item.label} count`} />
                )}
                {!navCollapsed && item.stat != null && (
                  <span className={`nav-stat-badge nav-item-meta ${item.id === 'usage' ? 'nav-stat-badge-cost' : ''}`} title={
                    item.id === 'chat' ? `${item.stat} open session(s)`
                    : item.id === 'projects' ? `${item.stat} project(s)`
                    : item.id === 'workspace' ? `${item.stat} file(s) in workspace`
                    : item.id === 'automations' ? `${item.stat} scheduled automation(s)`
                    : item.id === 'integrations' ? `${item.stat} configured integration(s)`
                    : item.id === 'usage'
                      ? (navStats.usageCostSource === 'xai'
                        ? `${formatUsageCostUsd(navStats.usageCostUsd)} month-to-date (xAI account)`
                        : `${formatUsageCostUsd(navStats.usageCostUsd)} studio metering`)
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

        {/* Model-source status — bottom of left nav, above footer separator */}
        {(() => {
          // Prefer live form/state mirrors of config so badges stay correct after save/load.
          const hasKey = !!(config as any)?.hasKey || isMaskedSecret(apiKeyInput);
          const oauthOn = !!oauthStatus.connected;
          const oauthExpired = !!oauthStatus.expired && !oauthOn;
          const cliOn = !!grokCliStatus?.installed;
          const localOn = !!(localGrokEnabled || (config as any)?.localGrokEnabled);
          const localOk = localOn && localGrokReachable;
          const activeCloud = ((config as any)?.activeCloudSource as 'api_key' | 'oauth' | null | undefined) || null;
          const keyIsActive = hasKey && activeCloud !== 'oauth';
          const oauthIsActive = oauthOn && activeCloud === 'oauth';
          const ready = !!(config as any)?.hasCloudAuth || hasKey || oauthOn || localOk;
          type SourceTone = 'active' | 'on' | 'warn' | 'off';
          const sources: Array<{
            id: string;
            label: string;
            short: string;
            tone: SourceTone;
            detail: string;
          }> = [
            {
              id: 'xai',
              label: 'xAI',
              short: 'X',
              tone: keyIsActive ? 'active' : hasKey ? 'on' : 'off',
              detail: keyIsActive ? 'Active' : hasKey ? 'Token' : 'Off',
            },
            {
              id: 'oauth',
              label: 'OAuth',
              short: 'O',
              tone: oauthIsActive ? 'active' : oauthOn ? 'on' : oauthExpired ? 'warn' : 'off',
              detail: oauthIsActive ? 'Active' : oauthOn ? 'Signed in' : oauthExpired ? 'Expired' : 'Off',
            },
            {
              id: 'cli',
              label: 'CLI',
              short: 'C',
              tone: cliOn ? 'on' : 'off',
              detail: cliOn
                ? (grokCliStatus?.version
                  ? grokCliStatus.version.replace(/^grok\s*/i, '').split(/\s+/)[0]
                  : 'On')
                : 'Off',
            },
            {
              id: 'local',
              label: 'Local',
              short: 'L',
              tone: localOk ? 'on' : localOn ? 'warn' : 'off',
              detail: localOk ? 'Online' : localOn ? 'Offline' : 'Off',
            },
          ];
          return (
            <div className={`nav-providers ${navCollapsed ? 'nav-providers-collapsed' : ''}`}>
              {!navCollapsed ? (
                <button
                  type="button"
                  className="nav-providers-head"
                  onClick={() => navigateToTab('settings')}
                  aria-label={ready ? 'Model providers ready — open Settings' : 'No model provider ready — open Settings'}
                >
                  <span className="nav-providers-title">Providers</span>
                  <span className={`nav-status-ready ${ready ? 'nav-status-ready-ok' : 'nav-status-ready-warn'}`}>
                    {ready ? 'Ready' : 'Needs setup'}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  className="nav-providers-head nav-providers-head-collapsed"
                  onClick={() => navigateToTab('settings')}
                  title={ready ? 'Providers ready' : 'Providers need setup'}
                  aria-label={ready ? 'Model providers ready — open Settings' : 'No model provider ready — open Settings'}
                >
                  <span className={`nav-status-dot ${ready ? 'nav-status-dot-on' : 'nav-status-dot-warn'}`} aria-hidden />
                </button>
              )}
              <div className={`nav-providers-list ${navCollapsed ? 'nav-providers-list-collapsed' : ''}`}>
                {sources.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`nav-provider-row nav-status-${s.tone}`}
                    onClick={() => navigateToTab('settings')}
                    title={`${s.label}: ${s.detail}`}
                  >
                    <span className="nav-status-dot" aria-hidden />
                    {navCollapsed ? (
                      <span className="nav-status-short">{s.short}</span>
                    ) : (
                      <>
                        <span className="nav-status-name">{s.label}</span>
                        <span className="nav-status-detail">{s.detail}</span>
                      </>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        {!navCollapsed && (
          <div className={`sidebar-foot p-4 border-t border-default text-xs text-dim ${process.env.NODE_ENV === 'development' ? 'sidebar-foot-dev' : ''}`}>
            <div className="whitespace-nowrap">localhost • Cloud + local models</div>
            <div className="mt-1 text-[9px] whitespace-nowrap">Chat that acts • agents that run while you sleep</div>
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
          </div>
          <div className="flex items-center gap-2 text-sm">
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

        {/* Offline degradation — cloud creds configured but api.x.ai unreachable */}
        {navStatsLoaded && !navStats.cloudReachable && !!(config as any)?.hasCloudAuth && (
          <div className="offline-banner relative z-[2] px-4 py-2 text-xs flex items-center gap-3" role="alert">
            <span aria-hidden>📡</span>
            <span className="flex-1 min-w-0">
              <strong>api.x.ai is unreachable</strong> — cloud chats and runs will fail, and scheduled cloud runs
              skip their ticks (recorded in Logs) until the connection returns. Local models keep working.
            </span>
            <button
              type="button"
              className="grok-btn grok-btn-ghost text-xs shrink-0"
              onClick={() => void loadNavStats()}
            >
              Retry
            </button>
          </div>
        )}

        {/* Content surfaces — workspace locks outer scroll; lists scroll inside */}
        <div
          className={
            tab === 'workspace' || tab === 'board'
              ? 'flex-1 min-h-0 overflow-hidden p-3 sm:p-5 relative z-[1] flex flex-col'
              : 'flex-1 overflow-auto p-3 sm:p-5 space-y-5 relative z-[1]'
          }
        >
          {/* DASHBOARD */}
          {tab === 'dashboard' && (
            <div className="relative dashboard-page page-content">
            <div className="space-y-5 relative z-[1]">
              {/* First-run onboarding: connect → create an agent → run it.
                  Shows until every step is done (or dismissed); state derives
                  from live data, so it survives reloads without bookkeeping. */}
              {config && !welcomeDismissed && (() => {
                const connected = !!(config as any).hasCloudAuth || oauthStatus.connected || localGrokEnabled;
                const hasAgent = agents.length > 0;
                const hasRun = runs.length > 0;
                if (connected && hasAgent && hasRun) return null;
                const StepMark = ({ done, n }: { done: boolean; n: number }) => (
                  <span aria-hidden className={`onboarding-step-mark ${done ? 'done' : ''}`}>{done ? '✓' : n}</span>
                );
                return (
                <div className="grok-card p-6 relative">
                  <button
                    type="button"
                    className="grok-btn grok-btn-ghost p-1 absolute top-3 right-3"
                    onClick={() => { setWelcomeDismissed(true); try { window.localStorage.setItem('shiba-welcome', 'dismissed'); } catch { /* private mode */ } }}
                    title="Dismiss — you can always connect from Settings"
                    aria-label="Dismiss getting-started guide"
                  >
                    <X size={14} />
                  </button>
                  <div className="text-xl font-semibold tracking-tight">
                    {connected ? 'Almost there — meet your first agent' : 'Welcome! Three steps to your first agent run'}
                  </div>
                  <ol className="mt-4 space-y-3 max-w-2xl list-none">
                    <li className="flex items-start gap-3">
                      <StepMark done={connected} n={1} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium">Connect a model source</div>
                        {!connected ? (
                          <>
                            <div className="text-xs text-muted mt-0.5">
                              Easiest: sign in with your X account — the popup opens the official{' '}
                              <span className="font-mono">accounts.x.ai</span> login and closes itself. Tokens stay
                              encrypted on this machine; your SuperGrok / Premium+ quota is used.
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <button onClick={startOAuthLogin} disabled={oauthStarting} className="grok-btn grok-btn-primary text-sm">
                                {oauthStarting ? 'Opening accounts.x.ai…' : '🔑 Sign in with X'}
                              </button>
                              <button
                                type="button"
                                onClick={() => navigateToTab('settings')}
                                className="text-xs text-dim underline underline-offset-2 hover:text-primary"
                              >
                                or use an xAI API key / local model in Settings
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="text-xs text-success mt-0.5">Connected — Grok is ready.</div>
                        )}
                      </div>
                    </li>
                    <li className="flex items-start gap-3">
                      <StepMark done={hasAgent} n={2} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium">Create your first agent</div>
                        {!hasAgent ? (
                          <>
                            <div className="text-xs text-muted mt-0.5">
                              An agent gets a model, a workspace folder, and the tools you allow — files, shell, browser, integrations.
                            </div>
                            <button onClick={openCreateAgent} disabled={!connected} className="grok-btn grok-btn-secondary text-sm mt-2">
                              <Plus size={14} /> New Agent
                            </button>
                          </>
                        ) : (
                          <div className="text-xs text-success mt-0.5">Agent ready: {agents[0]?.name}.</div>
                        )}
                      </div>
                    </li>
                    <li className="flex items-start gap-3">
                      <StepMark done={hasRun} n={3} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium">Run it</div>
                        {!hasRun ? (
                          <>
                            <div className="text-xs text-muted mt-0.5">
                              Watch the live execution trace as it works — every step lands in the run history below.
                            </div>
                            {hasAgent && (
                              <button onClick={() => openRunModal(agents[0])} className="grok-btn grok-btn-secondary text-sm mt-2">
                                <Play size={14} /> Run {agents[0]?.name}
                              </button>
                            )}
                          </>
                        ) : (
                          <div className="text-xs text-success mt-0.5">First run done — you&apos;re flying. 🚀</div>
                        )}
                      </div>
                    </li>
                  </ol>
                </div>
                );
              })()}
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
                    {/* Counts enabled schedules (not agents) — matches the sidebar Automations badge. */}
                    <div>Active schedules</div><div className="font-mono text-right">{agents.reduce((n, a: any) => n + ((a.schedules?.length ? a.schedules : (a.schedule ? [a.schedule] : [])).filter((s: any) => s.enabled).length), 0)}</div>
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

          {/* GROK CHAT — keep mounted while voice is active or a session turn is still
              streaming so work continues after navigating to Agents / Settings / etc.
              Freeze the bound session id off-chat so pathname changes don't remount. */}
          {(tab === 'chat' || voiceAgentActive || chatRunActive) && (
            <div
              className={tab === 'chat' ? undefined : 'voice-agent-chat-keepalive'}
              aria-hidden={tab !== 'chat'}
              style={tab === 'chat' ? undefined : { display: 'none' }}
            >
              <ChatSessionsPanel
                sessionId={(() => {
                  const fromUrl = pathToChatSessionId(pathname);
                  // On the Chat tab the URL (or last-opened id) always wins so the
                  // rail can switch sessions freely — never pin to a live run here.
                  if (tab === 'chat') return fromUrl || readLastChatSessionId();
                  // Off chat with live voice: pin the bound session so the panel never remounts.
                  if (voiceAgentActive) {
                    return getVoiceAgentUiState().boundSessionId || readLastChatSessionId();
                  }
                  // Off chat with a background turn: pin that session's panel.
                  if (chatRunActive) {
                    return primaryLiveChatSessionId() || readLastChatSessionId();
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
                defaultWorkspace={config?.defaultWorkspace || defaultWorkspaceInput || ''}
              />
            </div>
          )}

          {tab === 'projects' && (
            <ProjectsPanel
              agents={agents}
              defaultWorkspace={config?.defaultWorkspace || defaultWorkspaceInput || ''}
              defaultChatModel={chatModel}
              projectActiveRun={activeRun?.projectId ? activeRun : null}
              projectLiveTrace={activeRun?.projectId ? liveTrace : []}
              onOpenProjectChat={(sessionId) => {
                // Opening a chat does not change badge counts.
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
            <div className="page-content">
              <div className="page-head-row">
                <div className="min-w-0">
                  <div className="page-title">
                    Agents
                    <InfoHint text="Agents run on this machine with full access: files, shell, browser, MCP, and their own sandbox container. Each agent has its own model, workspace, integrations, schedules, and peers." />
                  </div>
                  <div className="page-subtitle">
                    Your Grok agents — models, workspaces, schedules, integrations, and peers.
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
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
                        </div>
                        <div className="text-xs text-dim flex items-center gap-1.5 min-w-0 mt-0.5">
                          <span className="min-w-0 truncate" title={modelDisplayName(agent.model)}>
                            <ModelLine modelId={agent.model} />
                          </span>
                          <span className="shrink-0">• {agent.workspace.useWorktree ? 'worktree' : 'workspace'}</span>
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
                          {agent.workspace.path}
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
                          onClick={() => openCloneAgent(agent)}
                          className="grok-btn grok-btn-ghost text-xs py-1 shrink-0"
                          title="Clone this agent — copies every setting into a new agent so you only change what differs"
                          aria-label={`Clone ${agent.name}`}
                        >
                          <CopyPlus size={14}/>
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
              <div className="page-head-row mb-0">
                <div className="min-w-0">
                  <div className="page-title">
                    Automations
                    <InfoHint text="Automations run agents on schedules with their own instructions. Create them here or from an agent’s editor. Open a run log to inspect past executions." />
                  </div>
                  <div className="page-subtitle">
                    Scheduled &amp; orchestrated agents — cron jobs with their own instructions, run logs, and one-click replay.
                  </div>
                </div>
                <button
                  type="button"
                  className="grok-btn grok-btn-primary text-xs shrink-0"
                  onClick={() => openNewAutomationModal()}
                  title="Create a new scheduled automation"
                >
                  <Plus size={14} /> New automation
                </button>
              </div>
              <div className="space-y-3">
                {/* Only agents with actual schedules — no placeholder cards */}
                {agents.filter((a) => agentSchedules(a).length > 0).map(a => {
                  const scheds = agentSchedules(a);
                  const runCount = scheduledRuns
                    ? scheduledRuns.filter((r) => r.agentId === a.id || r.agentName === a.name).length
                    : null;
                  // Live "running now" is per-SCHEDULE: a run carries the
                  // scheduleId that fired it, so only that automation's row
                  // shows running — not the agent's other schedules. The SSE
                  // runs feed keeps `runs` fresh; justStartedRunScheds bridges
                  // the click→feed gap.
                  const runningSchedIds = new Set(
                    runs
                      .filter((r) => r.agentId === a.id && r.status === 'running' && r.scheduleId)
                      .map((r) => r.scheduleId as string),
                  );
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
                          onClick={() => openNewAutomationModal(a.id)}
                          className="grok-btn grok-btn-ghost text-xs py-1 px-2"
                          title="Add another automation for this agent"
                        >
                          <CalendarClock size={14}/> Add
                        </button>
                      </div>
                    </div>
                    {/* One row per automation — its own status pill + run/edit/delete */}
                    <div className="mt-2 text-xs space-y-1">
                      {scheds.map((s: any, i: number) => {
                        // This specific automation is running (matched by the
                        // firing run's scheduleId), not the agent as a whole.
                        const scheduleRunning = runningSchedIds.has(s.id) || justStartedRunScheds.has(s.id);
                        return (
                        <div key={s.id || i} className="text-muted flex items-center gap-x-2 gap-y-1 min-w-0">
                          <button
                            type="button"
                            onClick={() => void toggleScheduleEntry(a, i)}
                            className={`automation-status-tag shrink-0 ${s.enabled ? 'automation-status-active' : 'automation-status-paused'}`}
                            title={s.enabled ? 'Pause this automation' : 'Activate this automation'}
                          >
                            {s.enabled ? 'Active' : 'Paused'}
                          </button>
                          {scheduleRunning && (
                            <button
                              type="button"
                              className="automation-running-chip automation-running-chip-btn shrink-0"
                              title="Show live status & trace of this run"
                              onClick={() => openRunningRun(s.id)}
                            >
                              <RefreshCw size={10} className="animate-spin" /> running
                            </button>
                          )}
                          <span className="font-mono text-[11px] shrink-0">{describeCron(s.cron)}</span>
                          {(() => {
                            const perDay = estimateCronRunsPerDay(String(s.cron || ''));
                            return perDay !== null && perDay > SCHEDULE_RUNS_PER_DAY_WARN ? (
                              <span
                                className="text-warning text-[11px] shrink-0"
                                title={`This automation fires ~${perDay}× per day — each fire is a full agent run and (on cloud models) costs tokens. Overlapping ticks are skipped, but consider a slower cadence or a daily budget in Settings → Cost & safety.`}
                              >
                                ⚠ ~{perDay}×/day
                              </span>
                            ) : null;
                          })()}
                          {s.instructions && <span className="text-dim truncate min-w-0">· {s.instructions.slice(0, 60)}{s.instructions.length > 60 ? '…' : ''}</span>}
                          <span className="ml-auto flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                if (scheduleRunning) { openRunningRun(s.id); return; }
                                markScheduleRunJustStarted(s.id);
                                void runAgent(a, { useScheduleInstructions: true, scheduleIndex: i });
                              }}
                              className="grok-btn grok-btn-ghost text-xs p-1"
                              title={scheduleRunning ? 'Running now — show live status & trace' : 'Run this automation now with its instructions'}
                              aria-label={scheduleRunning ? 'Show running automation status' : 'Run automation now'}
                            >
                              {scheduleRunning ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12}/>}
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
                        );
                      })}
                    </div>
                  </div>
                )})}
                {agents.filter((a) => agentSchedules(a).length > 0).length === 0 && (
                  <div className="grok-card p-8 text-center text-dim text-sm">
                    <Clock size={28} className="mx-auto mb-3 opacity-40" />
                    <div className="font-medium text-sm text-primary mb-1">No automations yet</div>
                    <div className="max-w-sm mx-auto leading-relaxed mb-4">
                      {agents.length === 0
                        ? 'Create an agent first, then come back here to put it on a schedule.'
                        : 'Schedule an agent to wake up on a timer with its own instructions — no agent-editor detour required.'}
                    </div>
                    {agents.length === 0 ? (
                      <button type="button" className="grok-btn grok-btn-primary text-xs" onClick={() => { openCreateAgent(); navigateToTab('agents'); }}>
                        <Plus size={13} /> Create an agent
                      </button>
                    ) : (
                      <button type="button" className="grok-btn grok-btn-primary text-xs" onClick={() => openNewAutomationModal()}>
                        <Plus size={13} /> New automation
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-6 text-xs text-dim">
                Agents can also schedule themselves via the <span className="font-mono">schedule_task</span> tool and message peers with <span className="font-mono">send_to_peer</span>.
              </div>

              {showNewAutomation && (
                <div
                  className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4"
                  onClick={() => !savingAutomation && setShowNewAutomation(false)}
                >
                  <div
                    className="modal modal-pop w-full max-w-md p-5 max-h-[90vh] overflow-y-auto"
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                    aria-label="New automation"
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="text-lg font-semibold flex items-center gap-2">
                        <CalendarClock size={18} className="opacity-70" />
                        New automation
                      </div>
                      <button
                        type="button"
                        className="grok-btn grok-btn-ghost p-1.5"
                        onClick={() => setShowNewAutomation(false)}
                        disabled={savingAutomation}
                        aria-label="Close"
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <div className="text-xs text-dim mb-4">
                      Pick an agent, when it should run, and what it should do. Pause or edit anytime from this page.
                    </div>

                    {agents.length === 0 ? (
                      <div className="text-sm text-dim mb-4">
                        No agents yet.{' '}
                        <button type="button" className="link-accent" onClick={() => { setShowNewAutomation(false); openCreateAgent(); navigateToTab('agents'); }}>
                          Create one first
                        </button>
                        .
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <div className="grok-label">Agent</div>
                          <select
                            className="grok-select w-full text-sm"
                            value={newAutomation.agentId}
                            onChange={(e) => {
                              const id = e.target.value;
                              const name = agents.find((a) => a.id === id)?.name;
                              setNewAutomation((f) => ({
                                ...f,
                                agentId: id,
                                instructions: f.instructions.trim()
                                  ? f.instructions
                                  : (name ? `Scheduled work for ${name}.` : f.instructions),
                              }));
                            }}
                          >
                            {agents.map((a) => (
                              <option key={a.id} value={a.id}>{a.name}</option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <div className="grok-label">When to run</div>
                          <select
                            className="grok-select w-full text-sm"
                            value={newAutomation._preset}
                            onChange={(e) => setNewAutomation((f) => ({
                              ...f,
                              _preset: e.target.value as SchedulePresetId,
                            }))}
                          >
                            {SCHEDULE_PRESETS.map((p) => (
                              <option key={p.id} value={p.id}>{p.label}</option>
                            ))}
                          </select>
                          <div className="text-[11px] text-dim mt-1">
                            {SCHEDULE_PRESETS.find((p) => p.id === newAutomation._preset)?.hint}
                          </div>
                          {(newAutomation._preset === 'daily' || newAutomation._preset === 'weekdays') && (
                            <div className="mt-2">
                              <div className="grok-label">Time</div>
                              <input
                                type="time"
                                className="grok-input text-sm w-40"
                                value={newAutomation._time}
                                onChange={(e) => setNewAutomation((f) => ({ ...f, _time: e.target.value || '09:00' }))}
                              />
                            </div>
                          )}
                          {newAutomation._preset === 'custom' && (
                            <div className="mt-2">
                              <div className="grok-label">Cron expression</div>
                              <input
                                className="grok-input font-mono text-xs"
                                value={newAutomation._customCron}
                                onChange={(e) => setNewAutomation((f) => ({ ...f, _customCron: e.target.value }))}
                                placeholder="*/30 * * * *"
                              />
                            </div>
                          )}
                          <div className="text-[11px] text-dim mt-1.5 font-mono">
                            {describeCron(presetToCron(newAutomation._preset, newAutomation._time, newAutomation._customCron))}
                          </div>
                        </div>

                        <div>
                          <div className="grok-label">Instructions</div>
                          <textarea
                            className="grok-input min-h-[6.5rem] resize-y text-sm"
                            value={newAutomation.instructions}
                            onChange={(e) => setNewAutomation((f) => ({ ...f, instructions: e.target.value }))}
                            placeholder="What should this agent do when the schedule fires?"
                          />
                        </div>

                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={newAutomation.enabled}
                            onChange={(e) => setNewAutomation((f) => ({ ...f, enabled: e.target.checked }))}
                          />
                          Activate immediately
                        </label>
                      </div>
                    )}

                    <div className="flex gap-2 mt-5">
                      <button
                        type="button"
                        className="grok-btn grok-btn-secondary flex-1"
                        disabled={savingAutomation}
                        onClick={() => setShowNewAutomation(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="grok-btn grok-btn-primary flex-1"
                        disabled={savingAutomation || agents.length === 0}
                        onClick={() => void createAutomationFromPage()}
                      >
                        {savingAutomation ? 'Saving…' : 'Create automation'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </div>
          )}

          {/* CAPABILITIES — core integrations, skills, MCP servers, tools */}
          {tab === 'integrations' && (
            <div className="integrations-page page-content">
              <div className="page-title">
                Capabilities
                <InfoHint text="Agent-scoped integrations become run/chat tools. Linear and Jira connect directly to the shared Board so every agent can work synced cards through the Board tools." />
              </div>
              <div className="page-subtitle">Everything your agents and shared Board can reach — core integrations, skills, MCP servers, and built-in tools.</div>

              <div className="page-section-title">
                <Plug size={18} className="opacity-70" />
                Core Integrations
                <InfoHint text="Credentials are AES-256-GCM encrypted at rest on this machine and never leave it except toward the service itself." />
              </div>
              <div className="page-section-sub">Provide credentials once. Agent-scoped services become run tools; Linear and Jira become sync targets directly inside Board.</div>

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
                        <div className="cap-card-title flex items-center gap-2 flex-wrap">
                          {integration.label}
                          <span className={`integration-status-chip ${connected ? 'integration-chip-connected' : configured ? 'integration-chip-configured' : 'integration-chip-unset'}`}>
                            {connected ? 'Connected' : configured ? 'Configured' : 'Not set up'}
                          </span>
                        </div>
                        <div className="cap-card-desc mt-0.5">{integration.description}</div>
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
                        {integration.id === 'vercel' && intTest.vercel?.ok && (
                          <span className="integration-card-status text-success">
                            connected as {intTest.vercel.user}
                            {intTest.vercel.team ? ` · ${intTest.vercel.team}` : ''}
                          </span>
                        )}
                        {integration.id === 'netlify' && intTest.netlify?.ok && (
                          <span className="integration-card-status text-success">
                            connected as {intTest.netlify.user}
                            {intTest.netlify.account ? ` · ${intTest.netlify.account}` : ''}
                          </span>
                        )}
                        {integration.id === 'linear' && intTest.linear?.ok && (
                          <span className="integration-card-status text-success">
                            connected as {intTest.linear.user || 'Linear user'}
                            {intTest.linear.organization ? ` · ${intTest.linear.organization}` : ''}
                          </span>
                        )}
                        {integration.id === 'jira' && intTest.jira?.ok && (
                          <span className="integration-card-status text-success">
                            connected as {intTest.jira.user || 'Jira user'}
                            {intTest.jira.site ? ` · ${intTest.jira.site}` : ''}
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
                        <input className="grok-input mb-2 font-mono text-xs" type="password" placeholder="Slack Bot Token (xoxb-...)" value={intCreds.slack?.token || ''} onChange={e => setIntCreds((c:any)=>({...c, slack: {...(c.slack||{}), token: e.target.value}}))} autoComplete="off" />
                        <input className="grok-input mb-2" placeholder="Default channel (#general)" value={intCreds.slack?.defaultChannel || ''} onChange={e => setIntCreds((c:any)=>({...c, slack: {...(c.slack||{}), defaultChannel: e.target.value}}))} />
                        <div className="text-xs text-dim mt-3 mb-1.5 font-medium">Listen for @mentions</div>
                        <div className="text-[11px] text-dim mb-2">
                          Enable Socket Mode on your Slack app, subscribe to the <span className="font-mono">app_mention</span> bot event,
                          then create an App-Level Token with <span className="font-mono">connections:write</span>.
                          When someone @mentions the bot, a studio agent answers in the thread.
                        </div>
                        <input
                          className="grok-input mb-2 font-mono text-xs"
                          type="password"
                          placeholder="App-Level Token (xapp-… for Socket Mode)"
                          value={intCreds.slack?.appToken || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, slack: { ...(c.slack || {}), appToken: e.target.value } }))}
                          autoComplete="off"
                        />
                        <label className="flex items-center gap-2 text-xs mb-2">
                          <input
                            type="checkbox"
                            checked={!!intCreds.slack?.listenEnabled}
                            onChange={(e) => setIntCreds((c: any) => ({ ...c, slack: { ...(c.slack || {}), listenEnabled: e.target.checked } }))}
                          />
                          Listen for @mentions and reply with an agent
                        </label>
                        <select
                          className="grok-select text-xs w-full"
                          value={intCreds.slack?.mentionAgentId || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, slack: { ...(c.slack || {}), mentionAgentId: e.target.value || undefined } }))}
                        >
                          <option value="">Responding agent — auto (first with Slack scope)</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </select>
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
                        <input className="grok-input mb-2 font-mono text-xs" type="password" placeholder="Discord Bot Token" value={intCreds.discord?.token || ''} onChange={e => setIntCreds((c:any)=>({...c, discord: {...(c.discord||{}), token: e.target.value}}))} autoComplete="off" />
                        <input className="grok-input mb-2" placeholder="Default channel ID (snowflake, optional)" value={intCreds.discord?.defaultChannelId || ''} onChange={e => setIntCreds((c:any)=>({...c, discord: {...(c.discord||{}), defaultChannelId: e.target.value}}))} />
                        <div className="text-xs text-dim mt-3 mb-1.5 font-medium">Listen for @mentions</div>
                        <div className="text-[11px] text-dim mb-2">
                          Enable the <span className="font-mono">Message Content</span> privileged intent and
                          <span className="font-mono"> Server Members</span> as needed in the Discord Developer Portal.
                          Invite the bot with permission to Read Messages / Send Messages. When @mentioned, a studio agent replies in-thread.
                        </div>
                        <label className="flex items-center gap-2 text-xs mb-2">
                          <input
                            type="checkbox"
                            checked={!!intCreds.discord?.listenEnabled}
                            onChange={(e) => setIntCreds((c: any) => ({ ...c, discord: { ...(c.discord || {}), listenEnabled: e.target.checked } }))}
                          />
                          Listen for @mentions and reply with an agent
                        </label>
                        <select
                          className="grok-select text-xs w-full"
                          value={intCreds.discord?.mentionAgentId || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, discord: { ...(c.discord || {}), mentionAgentId: e.target.value || undefined } }))}
                        >
                          <option value="">Responding agent — auto (first with Discord scope)</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </select>
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
                    {integration.id === 'vercel' && (
                      <>
                        <div className="text-xs text-dim mb-2">
                          Create a token at{' '}
                          <a href="https://vercel.com/account/tokens" className="link-accent" target="_blank" rel="noreferrer">vercel.com/account/tokens</a>
                          {' '}with access to the team/account that owns your apps. Agents can list projects, deploy, and set env vars when Vercel scope is enabled.
                        </div>
                        <input
                          className="grok-input mb-2 font-mono text-xs"
                          type="password"
                          placeholder="Vercel access token"
                          value={intCreds.vercel?.token || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, vercel: { ...(c.vercel || {}), token: e.target.value } }))}
                          autoComplete="off"
                        />
                        <input
                          className="grok-input mb-2 font-mono text-xs"
                          placeholder="Team id (team_…, optional — for team-scoped tokens)"
                          value={intCreds.vercel?.teamId || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, vercel: { ...(c.vercel || {}), teamId: e.target.value } }))}
                        />
                        <input
                          className="grok-input mb-2 font-mono text-xs"
                          placeholder="Team slug (optional alternative to team id)"
                          value={intCreds.vercel?.teamSlug || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, vercel: { ...(c.vercel || {}), teamSlug: e.target.value } }))}
                        />
                        <input
                          className="grok-input font-mono text-xs"
                          placeholder="Default project name or id (optional)"
                          value={intCreds.vercel?.defaultProject || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, vercel: { ...(c.vercel || {}), defaultProject: e.target.value } }))}
                        />
                        <div className="mt-2 text-xs text-dim">
                          Default project is used when agents call deploy/list tools without a project argument. Git-linked projects redeploy the latest commit; production target promotes aliases.
                        </div>
                      </>
                    )}
                    {integration.id === 'netlify' && (
                      <>
                        <div className="text-xs text-dim mb-2">
                          Create a personal access token at{' '}
                          <a href="https://app.netlify.com/user/applications#personal-access-tokens" className="link-accent" target="_blank" rel="noreferrer">app.netlify.com/user/applications</a>
                          . Agents can list sites, trigger deploys for git-linked sites, and set env vars when Netlify scope is enabled — a deploy path for vibe-coded projects alongside Vercel.
                        </div>
                        <input
                          className="grok-input mb-2 font-mono text-xs"
                          type="password"
                          placeholder="Netlify personal access token"
                          value={intCreds.netlify?.token || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, netlify: { ...(c.netlify || {}), token: e.target.value } }))}
                          autoComplete="off"
                        />
                        <input
                          className="grok-input mb-2 font-mono text-xs"
                          placeholder="Account slug (optional — for team env API)"
                          value={intCreds.netlify?.accountSlug || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, netlify: { ...(c.netlify || {}), accountSlug: e.target.value } }))}
                        />
                        <input
                          className="grok-input font-mono text-xs"
                          placeholder="Default site id or name (optional)"
                          value={intCreds.netlify?.defaultSite || ''}
                          onChange={(e) => setIntCreds((c: any) => ({ ...c, netlify: { ...(c.netlify || {}), defaultSite: e.target.value } }))}
                        />
                        <div className="mt-2 text-xs text-dim">
                          Default site is used when agents call deploy/list tools without a site argument. Prefer git-linked sites so netlify_deploy can trigger a build after code is pushed.
                        </div>
                      </>
                    )}
                    {integration.id === 'linear' && (() => {
                      const linear = intCreds.linear || {};
                      const teams = (Array.isArray(intTest.linear?.teams) ? intTest.linear.teams : []) as Array<{ id: string; key: string; name: string }>;
                      return (
                        <>
                          <div className="text-xs text-dim mb-2">
                            Create a personal API key in Linear&apos;s Security &amp; access settings. Board can pull issues,
                            push Shiba cards, or sync both ways; agents keep using the normal Board tools.
                          </div>
                          <input
                            className="grok-input mb-2 font-mono text-xs"
                            type="password"
                            placeholder="Linear personal API key"
                            value={linear.apiKey || ''}
                            onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, linear: { ...(c.linear || {}), apiKey: e.target.value } }))}
                            autoComplete="off"
                          />
                          {teams.length > 0 ? (
                            <select
                              className="grok-select text-xs w-full mb-2"
                              value={linear.teamId || ''}
                              onChange={(e) => {
                                const team = teams.find((item) => item.id === e.target.value);
                                setIntCreds((c: typeof intCreds) => ({
                                  ...c,
                                  linear: { ...(c.linear || {}), teamId: e.target.value, teamName: team?.name || '' },
                                }));
                              }}
                            >
                              <option value="">Select the Linear team to sync</option>
                              {teams.map((team) => <option key={team.id} value={team.id}>{team.name} ({team.key})</option>)}
                            </select>
                          ) : (
                            <input
                              className="grok-input mb-2 font-mono text-xs"
                              placeholder="Team UUID (or Test Connection to choose)"
                              value={linear.teamId || ''}
                              onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, linear: { ...(c.linear || {}), teamId: e.target.value } }))}
                            />
                          )}
                          <div className="grid grid-cols-2 gap-2">
                            <select
                              className="grok-select text-xs w-full"
                              value={linear.syncDirection || 'pull'}
                              onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, linear: { ...(c.linear || {}), syncDirection: e.target.value } }))}
                            >
                              <option value="pull">Pull into Shiba</option>
                              <option value="push">Push from Shiba</option>
                              <option value="bidirectional">Two-way sync</option>
                            </select>
                            <select
                              className="grok-select text-xs w-full"
                              value={linear.syncMode || 'board'}
                              onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, linear: { ...(c.linear || {}), syncMode: e.target.value } }))}
                            >
                              <option value="board">Tasks + columns</option>
                              <option value="tasks">Task fields only</option>
                            </select>
                          </div>
                          <div className="mt-2 text-[11px] text-dim">Test Connection loads your teams. You can also choose the target and run the sync from Board → Sync.</div>
                        </>
                      );
                    })()}
                    {integration.id === 'jira' && (() => {
                      const jira = intCreds.jira || {};
                      const projects = (Array.isArray(intTest.jira?.projects) ? intTest.jira.projects : []) as Array<{ id: string; key: string; name: string }>;
                      const boards = (Array.isArray(intTest.jira?.boards) ? intTest.jira.boards : []) as Array<{
                        id: number;
                        name: string;
                        location?: { projectKey?: string; projectName?: string };
                      }>;
                      const targetValue = jira.boardId ? `board:${jira.boardId}` : jira.projectKey ? `project:${jira.projectKey}` : '';
                      return (
                        <>
                          <div className="text-xs text-dim mb-2">
                            Jira Cloud uses your Atlassian email plus an API token. Kanban boards and projects can be
                            mirrored to Board; status changes use the transitions your Jira workflow allows.
                          </div>
                          <input
                            className="grok-input mb-2 font-mono text-xs"
                            placeholder="Jira Cloud site (https://example.atlassian.net)"
                            value={jira.baseUrl || ''}
                            onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, jira: { ...(c.jira || {}), baseUrl: e.target.value } }))}
                          />
                          <input
                            className="grok-input mb-2 text-xs"
                            type="email"
                            placeholder="Atlassian account email"
                            value={jira.email || ''}
                            onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, jira: { ...(c.jira || {}), email: e.target.value } }))}
                          />
                          <input
                            className="grok-input mb-2 font-mono text-xs"
                            type="password"
                            placeholder="Atlassian API token"
                            value={jira.apiToken || ''}
                            onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, jira: { ...(c.jira || {}), apiToken: e.target.value } }))}
                            autoComplete="off"
                          />
                          <input
                            className="grok-input mb-2 font-mono text-xs"
                            placeholder="Cloud ID (optional; required for scoped API tokens)"
                            value={jira.cloudId || ''}
                            onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, jira: { ...(c.jira || {}), cloudId: e.target.value } }))}
                          />
                          {(projects.length > 0 || boards.length > 0) ? (
                            <select
                              className="grok-select text-xs w-full mb-2"
                              value={targetValue}
                              onChange={(e) => {
                                const value = e.target.value;
                                const board = boards.find((item) => `board:${item.id}` === value);
                                const project = projects.find((item) => `project:${item.key}` === value);
                                setIntCreds((c: typeof intCreds) => ({
                                  ...c,
                                  jira: {
                                    ...(c.jira || {}),
                                    boardId: board ? String(board.id) : '',
                                    boardName: board?.name || '',
                                    projectKey: board?.location?.projectKey || project?.key || '',
                                    projectName: board?.location?.projectName || project?.name || '',
                                  },
                                }));
                              }}
                            >
                              <option value="">Select a Jira project or Kanban board</option>
                              {boards.map((board) => <option key={`board-${board.id}`} value={`board:${board.id}`}>Kanban · {board.name}</option>)}
                              {projects.map((project) => <option key={`project-${project.key}`} value={`project:${project.key}`}>Project · {project.name} ({project.key})</option>)}
                            </select>
                          ) : (
                            <input
                              className="grok-input mb-2 font-mono text-xs"
                              placeholder="Project key (or Test Connection to choose)"
                              value={jira.projectKey || ''}
                              onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, jira: { ...(c.jira || {}), projectKey: e.target.value.toUpperCase(), boardId: '', boardName: '' } }))}
                            />
                          )}
                          <div className="grid grid-cols-2 gap-2 mb-2">
                            <input
                              className="grok-input text-xs"
                              placeholder="Issue type (Task)"
                              value={jira.issueType || ''}
                              onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, jira: { ...(c.jira || {}), issueType: e.target.value } }))}
                            />
                            <select
                              className="grok-select text-xs w-full"
                              value={jira.syncDirection || 'pull'}
                              onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, jira: { ...(c.jira || {}), syncDirection: e.target.value } }))}
                            >
                              <option value="pull">Pull into Shiba</option>
                              <option value="push">Push from Shiba</option>
                              <option value="bidirectional">Two-way sync</option>
                            </select>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <select
                              className="grok-select text-xs w-full"
                              value={jira.syncMode || 'board'}
                              onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, jira: { ...(c.jira || {}), syncMode: e.target.value } }))}
                            >
                              <option value="board">Tasks + columns</option>
                              <option value="tasks">Task fields only</option>
                            </select>
                            <input
                              className="grok-input text-xs"
                              placeholder="Extra JQL (optional)"
                              value={jira.jql || ''}
                              onChange={(e) => setIntCreds((c: typeof intCreds) => ({ ...c, jira: { ...(c.jira || {}), jql: e.target.value } }))}
                            />
                          </div>
                          <div className="mt-2 text-[11px] text-dim">Test Connection loads visible projects and Jira Software Kanban boards. Scoped API tokens also need the site Cloud ID.</div>
                        </>
                      );
                    })()}
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

              <div className="cap-card-meta">Credentials are stored locally on your machine only. Never sent anywhere except to the services you authorize.</div>

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

          {tab === 'board' && (
            <KanbanBoard agents={agents} onOpenRun={openRunTrace} onOpenCountChanged={() => { void loadNavStats(); }} />
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
                Model sources, agent behavior, and workspace — everything lives on this machine.
              </div>

              <div className="settings-sections">
              <section className="settings-section">
                <h3 className="settings-section-title">Grok credentials &amp; sign-in</h3>
                <div className="settings-section-sub text-[11px] text-dim">Keys and accounts that connect Shiba to xAI &mdash; all encrypted on this machine.</div>
              <div className="settings-grid">
                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <KeyRound size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
                        xAI Grok API Key
                        {settingsTested.apiKey && <span className="settings-tested-badge">Tested</span>}
                      </div>
                      <div className="text-[11px] text-dim">Cloud Grok via console.x.ai token — encrypted at rest.</div>
                    </div>
                    <InfoHint className="ml-auto" text="Get a key at console.x.ai. It is encrypted at rest (AES-256-GCM) with a machine key stored outside the project — never in source code." />
                  </div>
                  <input value={apiKeyInput} onChange={e=>setApiKeyInput(e.target.value)} onKeyDown={submitOnEnter(saveApiKey)} placeholder="xai-..." className="grok-input mb-2 font-mono" />
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
                      <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
                        xAI Management Key
                        {settingsTested.managementKey && <span className="settings-tested-badge">Tested</span>}
                      </div>
                      <div className="text-[11px] text-dim">Backports official team usage &amp; billing into the Usage page.</div>
                    </div>
                  </div>
                  <input
                    value={managementKeyInput}
                    onChange={(e) => setManagementKeyInput(e.target.value)}
                    onKeyDown={submitOnEnter(() => void saveManagementKey())}
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

              </div>
              </section>
              <section className="settings-section">
                <h3 className="settings-section-title">Models, voice &amp; CLI</h3>
                <div className="settings-section-sub text-[11px] text-dim">Where inference runs and how Grok sounds &mdash; cloud, local models, and the Build CLI.</div>
              <div className="settings-grid">
                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <Server size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
                        Local Models
                        {settingsTested.localGrok && <span className="settings-tested-badge">Tested</span>}
                      </div>
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
                    onKeyDown={submitOnEnter(saveLocalGrokSettings)}
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
                    <button type="button" onClick={() => void loadModels({ forceProviderProbe: true })} disabled={modelsLoading} className="grok-btn grok-btn-ghost text-xs py-0.5 ml-auto">
                      <RefreshCw size={12} className={modelsLoading ? 'animate-spin' : ''} /> Refresh
                    </button>
                  </div>
                  <select
                    className="grok-select w-full mt-1"
                    value={defaultModelInput}
                    onChange={e => setDefaultModelInput(e.target.value)}
                    disabled={modelsLoading && availableModels.length === 0}
                    aria-label="Default model for Grok Chat and new agents"
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
                    <button
                      type="button"
                      onClick={() => void testDefaultVoice()}
                      disabled={voiceTestState === 'loading'}
                      className="grok-btn grok-btn-secondary text-sm inline-flex items-center gap-1.5"
                      title="Hear a short sample with the selected voice and speed (uses cloud TTS)"
                    >
                      <Volume2 size={14} />
                      {voiceTestState === 'loading' ? 'Generating…' : voiceTestState === 'playing' ? 'Stop' : 'Test voice'}
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

              </div>
              </section>
              <section className="settings-section">
                <h3 className="settings-section-title">Agent behavior &amp; workspace</h3>
                <div className="settings-section-sub text-[11px] text-dim">Default approval mode, global instructions, and where agents read and write files.</div>
              <div className="settings-grid">
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
                      onKeyDown={submitOnEnter(saveDefaultWorkspace)}
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

              </div>
              </section>
              <section className="settings-section">
                <h3 className="settings-section-title">Cost &amp; safety</h3>
                <div className="settings-section-sub text-[11px] text-dim">Spend caps, run limits, and how long runs and logs are kept.</div>
              <div className="settings-grid">
                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <Gauge size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Cost &amp; safety</div>
                      <div className="text-[11px] text-dim">Spend limits, run concurrency, token caps, and data retention.</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <label className="text-xs text-dim">
                      Monthly budget (USD)
                      <input
                        className="grok-input mt-1" type="number" min="0" step="1" placeholder="0 = none"
                        value={costSettings.usageBudgetUsd} onKeyDown={submitOnEnter(() => void saveCostSettings())}
                        onChange={(e) => setCostSettings((s) => ({ ...s, usageBudgetUsd: e.target.value }))}
                      />
                    </label>
                    <label className="text-xs text-dim">
                      Daily budget (USD)
                      <input
                        className="grok-input mt-1" type="number" min="0" step="1" placeholder="0 = none"
                        value={costSettings.dailyBudgetUsd} onKeyDown={submitOnEnter(() => void saveCostSettings())}
                        onChange={(e) => setCostSettings((s) => ({ ...s, dailyBudgetUsd: e.target.value }))}
                      />
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-sm mb-2">
                    <input
                      type="checkbox"
                      checked={costSettings.budgetHardStop}
                      onChange={(e) => setCostSettings((s) => ({ ...s, budgetHardStop: e.target.checked }))}
                    />
                    Hard stop — block new cloud runs & chats at the limit (local models never blocked)
                  </label>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <label className="text-xs text-dim">
                      Max concurrent runs
                      <input
                        className="grok-input mt-1" type="number" min="1" max="20" step="1"
                        value={costSettings.maxConcurrentRuns} onKeyDown={submitOnEnter(() => void saveCostSettings())}
                        onChange={(e) => setCostSettings((s) => ({ ...s, maxConcurrentRuns: e.target.value }))}
                      />
                    </label>
                    <label className="text-xs text-dim">
                      Per-run token cap
                      <input
                        className="grok-input mt-1" type="number" min="0" step="1000" placeholder="0 = unlimited"
                        value={costSettings.perRunTokenCap} onKeyDown={submitOnEnter(() => void saveCostSettings())}
                        onChange={(e) => setCostSettings((s) => ({ ...s, perRunTokenCap: e.target.value }))}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <label className="text-xs text-dim">
                      Sandbox memory (MB)
                      <input
                        className="grok-input mt-1" type="number" min="128" max="16384" step="128" placeholder="512 = default"
                        value={costSettings.sandboxMemoryMb} onKeyDown={submitOnEnter(() => void saveCostSettings())}
                        onChange={(e) => setCostSettings((s) => ({ ...s, sandboxMemoryMb: e.target.value }))}
                      />
                    </label>
                    <label className="text-xs text-dim">
                      Sandbox CPUs
                      <input
                        className="grok-input mt-1" type="number" min="0.25" max="16" step="0.25" placeholder="1 = default"
                        value={costSettings.sandboxCpus} onKeyDown={submitOnEnter(() => void saveCostSettings())}
                        onChange={(e) => setCostSettings((s) => ({ ...s, sandboxCpus: e.target.value }))}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <label className="text-xs text-dim">
                      Keep runs (days)
                      <input
                        className="grok-input mt-1" type="number" min="0" step="1" placeholder="0 = forever"
                        value={costSettings.runRetentionDays} onKeyDown={submitOnEnter(() => void saveCostSettings())}
                        onChange={(e) => setCostSettings((s) => ({ ...s, runRetentionDays: e.target.value }))}
                      />
                    </label>
                    <label className="text-xs text-dim">
                      Keep audit log (days)
                      <input
                        className="grok-input mt-1" type="number" min="0" step="1" placeholder="0 = forever"
                        value={costSettings.auditRetentionDays} onKeyDown={submitOnEnter(() => void saveCostSettings())}
                        onChange={(e) => setCostSettings((s) => ({ ...s, auditRetentionDays: e.target.value }))}
                      />
                    </label>
                  </div>
                  <label className="text-xs text-dim block mb-3">
                    Usage figure source
                    <select
                      className="grok-select w-full mt-1"
                      value={costSettings.usageCostSource}
                      onChange={(e) => setCostSettings((s) => ({ ...s, usageCostSource: e.target.value as 'auto' | 'xai' | 'local' }))}
                      title="Where the QUOTA badge and monthly figure come from"
                    >
                      <option value="auto">Auto — xAI account billing when available, else studio metering</option>
                      <option value="xai">xAI account billing only</option>
                      <option value="local">Studio metering (this app's own token accounting)</option>
                    </select>
                  </label>
                  <button type="button" onClick={() => void saveCostSettings()} className="grok-btn grok-btn-primary text-sm">
                    Save Cost &amp; Safety
                  </button>
                  <div className="text-[11px] text-dim mt-2">
                    Budgets use studio metering (estimates from xAI token rates). When a scheduled run would overlap the previous
                    one, the tick is skipped and recorded in Logs. Retention pruning runs daily.
                  </div>
                </div>

              </div>
              </section>
              <section className="settings-section">
                <h3 className="settings-section-title">Backup &amp; maintenance</h3>
                <div className="settings-section-sub text-[11px] text-dim">Export or restore this machine&rsquo;s setup, and reset board data.</div>
              <div className="settings-grid">
                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <Archive size={16} className="opacity-70 shrink-0" />
                    <div>
                      <div className="font-medium text-sm">Backup &amp; restore</div>
                      <div className="text-[11px] text-dim">One file: settings, agents, chats, projects, runs, audit log.</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 mb-2">
                    <button
                      type="button"
                      onClick={() => void exportBackup()}
                      disabled={backupBusy !== null}
                      className="grok-btn grok-btn-primary text-sm"
                    >
                      {backupBusy === 'export' ? 'Preparing…' : '⬇ Export backup'}
                    </button>
                    <button
                      type="button"
                      onClick={() => backupFileRef.current?.click()}
                      disabled={backupBusy !== null}
                      className="grok-btn grok-btn-secondary text-sm"
                    >
                      {backupBusy === 'import' ? 'Restoring…' : '⬆ Restore from file'}
                    </button>
                    <input
                      ref={backupFileRef}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      aria-label="Choose a Shiba Studio backup file to restore"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) void importBackup(f);
                      }}
                    />
                  </div>
                  <div className="text-[11px] text-dim">
                    ⚠️ The export includes your <strong>encryption key</strong> so credentials restore on a new machine —
                    treat the file like a password. Screenshots and uploaded files are not included.
                  </div>
                </div>

                <div className="grok-card p-5 settings-card">
                  <div className="settings-card-head">
                    <Trash2 size={16} className="opacity-70 shrink-0 text-error" />
                    <div>
                      <div className="font-medium text-sm">Clear the board</div>
                      <div className="text-[11px] text-dim">Remove every Kanban card and start fresh (keys reset to SHIB-1).</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void clearBoardData()}
                    disabled={clearingBoard}
                    className="grok-btn grok-btn-ghost text-sm text-error"
                  >
                    {clearingBoard ? 'Clearing…' : 'Clear all board cards'}
                  </button>
                  <div className="text-[11px] text-dim mt-2">
                    ⚠️ Irreversible — deletes all cards in every column and their activity/run links. Agents, chats, and
                    projects are not affected. A confirmation is required first.
                  </div>
                </div>

              </div>
              </section>
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
            {updateNotice && (
              <a
                href={updateNotice.url || 'https://github.com/stevologic/shiba-studio/releases'}
                target="_blank"
                rel="noreferrer"
                className="ml-2 text-warning underline underline-offset-2"
                title={`You run v${runtimeVersion.version}; ${updateNotice.latest} is available on GitHub`}
              >
                ⬆ {updateNotice.latest} available
              </a>
            )}
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
            <Link
              href="/api-docs"
              className="hover:text-primary"
              title="Interactive API explorer — send real requests against your instance"
            >
              API
            </Link>
            <a
              href="https://github.com/stevologic/shiba-studio/issues/new?template=feature_request.md"
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary inline-flex items-center gap-1"
              title="Suggest a feature — opens a new GitHub issue from the feature template"
            >
              <Plus size={11} /> Request a feature
            </a>
            <a
              href="https://github.com/stevologic/shiba-studio/issues/new?template=bug_report.md"
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary inline-flex items-center gap-1"
              title="Report a bug — opens a new GitHub issue from the bug template"
            >
              <Bug size={11} /> Report a bug
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
      {/* Execution Trace — top-level so it opens from ANY tab (dashboard
          answer modal, automations, board work modal). Closing returns to
          run details (if any) or the page. */}
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
                      // Land on the full run summary (agent, prompt, tools,
                      // outcome, trace, rail); its footer opens the dedicated
                      // trace view for deep inspection.
                      setRunDetail(data.run);
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

                    {/* Preview rail — screenshots/artifacts along the trace,
                        same as the dedicated trace view. */}
                    {!runDetail.projectId && (
                      <PreviewRail
                        trace={runDetail.trace || []}
                        selectedIdx={previewSelectedIdx}
                        onSelect={setPreviewSelectedIdx}
                      />
                    )}
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
            /* No close-on-backdrop: agent setup is a long form and a stray
               click outside must not throw the work away. Close via ✕/Cancel. */
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
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="grok-label mb-0">Grok Model</div>
                    {agentForm.model && <ModelProviderBadge modelId={agentForm.model} />}
                    <button type="button" onClick={() => void loadModels({ forceProviderProbe: true })} disabled={modelsLoading} className="grok-btn grok-btn-ghost text-xs py-0.5">
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
                <div>
                  <div className="grok-label">Workspace Path</div>
                  <input className="grok-input" value={agentForm.workspace?.path || ''} onChange={e => setAgentForm({ ...agentForm, workspace: { ...agentForm.workspace, path: e.target.value } })} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={agentForm.workspace?.useWorktree} onChange={e => setAgentForm({ ...agentForm, workspace: { ...agentForm.workspace, useWorktree: e.target.checked } })} /> Use isolated git worktree (recommended)
                </label>

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
                    {AGENT_INTEGRATION_IDS.map(key => {
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
          onOpenHref={(href) => router.push(href)}
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
