// Core types for Shiba Studio - fully Grok/xAI powered agent platform

/** xAI model id — loaded dynamically from GET /v1/language-models */
export type GrokModel = string;

export interface IntegrationScope {
  github: boolean;
  slack: boolean;
  googledrive: boolean;
  discord: boolean;
  x: boolean;
  obsidian: boolean;
  vercel: boolean;
  netlify: boolean;
}

export const EMPTY_INTEGRATION_SCOPE: IntegrationScope = {
  github: false,
  slack: false,
  googledrive: false,
  discord: false,
  x: false,
  obsidian: false,
  vercel: false,
  netlify: false,
};

export interface ScheduleConfig {
  enabled: boolean;
  // Simple cron or interval based (e.g. "*/15 * * * *" or "every:10m")
  cron: string;
  description?: string;
}

// New: per-schedule entry with dedicated instructions (prompt) for that scheduled run
export interface ScheduleEntry {
  id: string;
  enabled: boolean;
  // Cron expression for this specific schedule
  cron: string;
  // The exact instructions/prompt to use when this scheduled entry fires
  instructions: string;
  description?: string;
}

export interface Agent {
  id: string;
  name: string;
  /** Alien avatar id, e.g. alien-01 … alien-50 */
  avatar?: string;
  model: GrokModel;
  description?: string;
  workspace: {
    path: string;            // absolute or relative path to local workspace
    useWorktree: boolean;    // if true, create/use isolated git worktree for this agent
  };
  integrations: IntegrationScope;
  /** Per-agent credential overrides — an agent can use its OWN token/account
   *  for any authenticated integration instead of the global one, scoping it to
   *  that credential. Absent fields fall back to the global config. Sensitive
   *  fields are AES-256-GCM encrypted at rest (see persistence). */
  integrationOverrides?: IntegrationCreds;
  /** Google Drive folder isolation: when non-empty, this agent's Drive tools
   *  are soft-scoped to these folders only (list within them, upload into the
   *  first). Empty/absent = full Drive access. Not a hard API-level boundary —
   *  it's workspace isolation enforced in the tool layer. */
  driveFolders?: Array<{ id: string; name: string }>;
  peers: string[];           // ids of other agents this one can message
  // Skills: array of skill descriptors (e.g. ["research", "coder", "browser-navigator"])
  // Injected into system prompt for specialization (informed by LLM agent best practices like Anthropic Agent Skills)
  skills?: string[];
  /** Chat personality (Skill) — how this agent speaks in Grok Chat conversations. */
  chatSkill?: string;
  /**
   * Default Grok TTS voice for this agent (xAI voice_id, e.g. "eve", "ara").
   * Used in Grok Chat / voice mode when this agent is the active target.
   * Empty/undefined → fall back to the app-wide voice picker.
   */
  voiceId?: string;
  // New multi-schedule support: each entry can have its own instructions
  schedules: ScheduleEntry[];
  // Legacy single schedule for backward compatibility (will be normalized in loads)
  schedule?: ScheduleConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TraceStep {
  id: string;
  ts: string;
  type: 'think' | 'tool' | 'result' | 'error' | 'final' | 'schedule' | 'peer_msg' | 'approval';
  content: string;
  tool?: {
    name: string;
    args: unknown;
    result?: unknown;
    error?: string;
  };
  screenshot?: string; // path or data url
}

export interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;
  prompt: string;
  model: GrokModel;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'error' | 'scheduled';
  trace: TraceStep[];
  finalOutput?: string;
  workspaceSnapshot?: string; // path used
  sideEffects: string[]; // human readable notes e.g. "wrote file X", "posted to #general"
  // For schedule-specific runs
  scheduleId?: string;
  scheduleInstructions?: string;
  /** Set when run originates from Projects tab build */
  projectId?: string;
}

export interface IntegrationCreds {
  github?: {
    token: string; // PAT
  };
  slack?: {
    token: string; // xoxb-...
    defaultChannel?: string;
    /**
     * App-level token (xapp-…) for Socket Mode — required to listen for
     * @mentions without a public webhook URL. Create under Slack app →
     * Basic Information → App-Level Tokens (connections:write).
     */
    appToken?: string;
    /** When true (and appToken set), listen for app_mention events and reply. */
    listenEnabled?: boolean;
    /** Agent id that answers Slack @mentions (falls back to first slack-scoped agent). */
    mentionAgentId?: string;
  };
  googledrive?: {
    // For simplicity support access token (oauth) or service account json string
    accessToken?: string;
    serviceAccountJson?: string; // JSON string
    // Popup OAuth: user's Google Cloud OAuth client + captured tokens.
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    tokenExpiry?: string; // ISO — when accessToken expires
    email?: string;
  };
  discord?: {
    token: string; // Bot token
    defaultChannelId?: string;
    /** When true, open a Discord Gateway connection and reply to @mentions. */
    listenEnabled?: boolean;
    /** Agent id that answers Discord @mentions (falls back to first discord-scoped agent). */
    mentionAgentId?: string;
  };
  x?: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  };
  obsidian?: {
    /** Local vault on disk, or remote REST API (cloud). */
    mode: 'local' | 'cloud';
    /** Absolute path to Obsidian vault folder (local mode). */
    vaultPath?: string;
    /** Obsidian Local REST API base URL (e.g. http://127.0.0.1:27123 or remote tunnel). */
    restApiUrl?: string;
    /** API key from Local REST API plugin settings. */
    restApiKey?: string;
  };
  /** Vercel access token — deploy and manage projects via REST API. */
  vercel?: {
    /** Personal or team access token from vercel.com/account/tokens */
    token: string;
    /** Optional team id (team_…) when the token is team-scoped */
    teamId?: string;
    /** Optional team slug (alternative to teamId) */
    teamSlug?: string;
    /** Default project name or id for deploy tools when not specified */
    defaultProject?: string;
  };
  /** Netlify personal access token — deploy sites and manage env vars. */
  netlify?: {
    /** Personal access token from app.netlify.com/user/applications */
    token: string;
    /** Optional account slug (team) for account-scoped env API */
    accountSlug?: string;
    /** Default site id or name for deploy tools when not specified */
    defaultSite?: string;
  };
  /** Linear Board sync. Board-scoped rather than an agent tool scope. */
  linear?: {
    /** Personal API key or OAuth access token. */
    apiKey: string;
    /** Linear team UUID selected as the Board sync target. */
    teamId?: string;
    /** Cached display name for the selected team. */
    teamName?: string;
    syncDirection?: 'pull' | 'push' | 'bidirectional';
    /** `tasks` syncs card fields; `board` also maps workflow statuses/columns. */
    syncMode?: 'tasks' | 'board';
  };
  /** Jira Cloud Board sync. Board-scoped rather than an agent tool scope. */
  jira?: {
    /** Jira Cloud site URL, e.g. https://example.atlassian.net. */
    baseUrl: string;
    /** Required only for Atlassian scoped API tokens (api.atlassian.com route). */
    cloudId?: string;
    email: string;
    apiToken: string;
    /** Jira project key selected as the Board sync target. */
    projectKey?: string;
    /** Cached display name for the selected project. */
    projectName?: string;
    /** Optional Jira Software Kanban board. When set, pulls follow its filter. */
    boardId?: string;
    boardName?: string;
    /** Issue type used when Shiba creates a Jira issue. */
    issueType?: string;
    /** Optional extra JQL appended to the selected project filter. */
    jql?: string;
    syncDirection?: 'pull' | 'push' | 'bidirectional';
    /** `tasks` syncs card fields; `board` also maps workflow statuses/columns. */
    syncMode?: 'tasks' | 'board';
  };
}

export type CloudAuthMode = 'api_key' | 'oauth';

/** YOLO = run tools immediately; ask = require user approval for sensitive tools */
export type ToolApprovalMode = 'yolo' | 'ask';

export interface AppConfig {
  xaiApiKey: string;
  /**
   * Optional xAI Management API key (Console → Settings → Management Keys).
   * Used to backport authoritative team usage / billing into the Usage page.
   * Separate from the inference API key.
   */
  xaiManagementKey?: string;
  integrations: IntegrationCreds;
  defaultWorkspace: string;
  /** Default model ref (cloud:id or local:id) for new agents and Grok Chat */
  defaultGrokModel?: string;
  /**
   * App-wide default Grok TTS voice id (e.g. "eve", "ara").
   * Used by Grok Chat voice mode when the user has not picked a session override,
   * and as the "App default" option for agent default voices.
   */
  defaultTtsVoice?: string;
  /**
   * App-wide default speech rate for Grok TTS (xAI range 0.7–1.5, default 1.0).
   * Seeds Grok Chat / voice HUD when the user has not set a session override.
   */
  defaultTtsSpeed?: number;
  /** Enable OpenAI-compatible local Grok runtime (LM Studio, Ollama, etc.) */
  localGrokEnabled?: boolean;
  /** Base URL for local Grok server, e.g. http://127.0.0.1:1234/v1 */
  localGrokBaseUrl?: string;
  /**
   * Local model ids exposed to agents and Grok Chat (plain server ids, no
   * provider prefix). Empty or missing = every model the server offers.
   */
  localModelAllowlist?: string[];
  /** When both API key and OAuth are configured, which credential to use for cloud Grok */
  cloudAuthMode?: CloudAuthMode;
  /** Tool execution policy for agent runs */
  toolApprovalMode?: ToolApprovalMode;
  /**
   * Tool function names the user has turned off globally (Capabilities → Tools).
   * Disabled tools are omitted from model tool lists and blocked if still called.
   */
  disabledTools?: string[];
  /** User-defined instructions prepended to all agents and chat */
  globalInstructions?: string;
  /** Inject AGENTS.md / CLAUDE.md from workspace into prompts */
  useAgentsMd?: boolean;
  /** Monthly spend quota (USD) — usage is reported as a percentage of this */
  usageBudgetUsd?: number;
  /** Where the usage/cost figure comes from: auto (xAI billing when available,
   *  else studio metering), xai (billing only), or local (studio metering). */
  usageCostSource?: 'auto' | 'xai' | 'local';
  /** Daily spend quota (USD, 0/unset = none) */
  dailyBudgetUsd?: number;
  /** When a budget is set, block new cloud runs at the limit (default true) */
  budgetHardStop?: boolean;
  /** Max agent runs in flight at once (default 3) */
  maxConcurrentRuns?: number;
  /** Per-run cumulative token budget (0/unset = unlimited) */
  perRunTokenCap?: number;
  /** Agent sandbox container memory limit in MB (default 512) */
  sandboxMemoryMb?: number;
  /** Agent sandbox container CPU limit (default 1; fractions allowed) */
  sandboxCpus?: number;
  /** Auto-prune agent runs older than this many days (0/unset = keep forever) */
  runRetentionDays?: number;
  /** Auto-prune audit-log entries older than this many days (0/unset = keep forever) */
  auditRetentionDays?: number;
}

export interface InterAgentMessage {
  fromAgentId: string;
  toAgentId: string;
  message: string;
  ts: string;
}

export interface ScheduledTask {
  id: string;
  agentId: string;
  cron: string;
  lastRun?: string;
  nextRun?: string;
  enabled: boolean;
}

// For workspace
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

/** Loose shape of schedule entries as they appear in legacy on-disk JSON. */
type LegacyScheduleEntry = {
  id?: string;
  enabled?: unknown;
  cron?: string;
  instructions?: string;
  description?: string;
};

/**
 * Normalize legacy agent (single schedule) to new shape with schedules[] + skills.
 * Used for backward compat during load/seed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- input is untyped legacy JSON from disk; every field is normalized below
export function normalizeAgent(agent: any): Agent {
  const base = { ...agent };
  // Agents stored before the local/cloud split was removed may carry an
  // `origin` field — drop it; every agent runs on this machine.
  delete base.origin;
  if (!base.skills) base.skills = [];
  if (base.chatSkill === undefined || base.chatSkill === null) base.chatSkill = '';
  // Optional Grok TTS voice — keep only non-empty string ids ('' clears on save).
  if (typeof base.voiceId === 'string') {
    base.voiceId = base.voiceId.trim().toLowerCase();
    if (!base.voiceId) delete base.voiceId;
  } else {
    delete base.voiceId;
  }
  if (!base.schedules || !Array.isArray(base.schedules)) {
    if (base.schedule) {
      base.schedules = [{
        id: 'legacy-' + Date.now(),
        enabled: !!base.schedule.enabled,
        cron: base.schedule.cron || '*/30 * * * *',
        instructions: base.schedule.description || base.description || 'Perform scheduled task.',
        description: base.schedule.description
      }];
    } else {
      base.schedules = [];
    }
  }
  // Ensure every schedule entry has id and instructions; filter 'manual' pollution
  base.schedules = (base.schedules || []).filter((s: LegacyScheduleEntry) => s.cron && !String(s.cron).includes('manual')).map((s: LegacyScheduleEntry, i: number) => ({
    id: s.id || `sch-${i}-${Date.now()}`,
    enabled: !!s.enabled,
    cron: s.cron || '*/30 * * * *',
    instructions: s.instructions || s.description || 'Perform scheduled task.',
    description: s.description
  }));
  base.integrations = {
    ...EMPTY_INTEGRATION_SCOPE,
    ...(base.integrations || {}),
  };
  return base as Agent;
}
