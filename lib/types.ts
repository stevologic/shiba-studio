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
}

export const EMPTY_INTEGRATION_SCOPE: IntegrationScope = {
  github: false,
  slack: false,
  googledrive: false,
  discord: false,
  x: false,
  obsidian: false,
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

/**
 * Where an agent executes:
 * - 'local'  — this machine: full system access (files, shell, browser, worktrees, MCP) plus cloud services.
 * - 'cloud'  — Grok cloud: only xAI-hosted capabilities and connected cloud integrations; no local system access.
 */
export type AgentOrigin = 'local' | 'cloud';

export interface Agent {
  id: string;
  name: string;
  /** Alien avatar id, e.g. alien-01 … alien-50 */
  avatar?: string;
  /** Execution home — 'local' (this machine) or 'cloud' (Grok cloud). Defaults to 'local'. */
  origin?: AgentOrigin;
  model: GrokModel;
  description?: string;
  workspace: {
    path: string;            // absolute or relative path to local workspace
    useWorktree: boolean;    // if true, create/use isolated git worktree for this agent
  };
  integrations: IntegrationScope;
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
  arguments: Record<string, any>;
}

export interface TraceStep {
  id: string;
  ts: string;
  type: 'think' | 'tool' | 'result' | 'error' | 'final' | 'schedule' | 'peer_msg' | 'approval';
  content: string;
  tool?: {
    name: string;
    args: any;
    result?: any;
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
}

export type CloudAuthMode = 'api_key' | 'oauth';

/** YOLO = run tools immediately; ask = require user approval for sensitive tools */
export type ToolApprovalMode = 'yolo' | 'ask';

export interface AppConfig {
  xaiApiKey: string;
  integrations: IntegrationCreds;
  defaultWorkspace: string;
  /** Default model ref (cloud:id or local:id) for new agents and Grok Chat */
  defaultGrokModel?: string;
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
  /** User-defined instructions prepended to all agents and chat */
  globalInstructions?: string;
  /** Inject AGENTS.md / CLAUDE.md from workspace into prompts */
  useAgentsMd?: boolean;
  /** Monthly spend quota (USD) — usage is reported as a percentage of this */
  usageBudgetUsd?: number;
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

/**
 * Normalize legacy agent (single schedule) to new shape with schedules[] + skills.
 * Used for backward compat during load/seed.
 */
export function normalizeAgent(agent: any): Agent {
  const base = { ...agent };
  base.origin = base.origin === 'cloud' ? 'cloud' : 'local';
  if (!base.skills) base.skills = [];
  if (base.chatSkill === undefined || base.chatSkill === null) base.chatSkill = '';
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
  base.schedules = (base.schedules || []).filter((s: any) => s.cron && !String(s.cron).includes('manual')).map((s: any, i: number) => ({
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
