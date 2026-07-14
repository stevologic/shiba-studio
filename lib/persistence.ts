import path from 'path';
import { Agent, AppConfig, type IntegrationCreds, normalizeAgent } from './types';
import { setIntegrationCreds } from './integrations';
import { dataDir, projectRoot } from './data-paths';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secure-store';
import { randomUUID } from 'crypto';
import { ownershipStoreFencePath, withStoreFileLock } from './store-file-lock';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

/**
 * Credential fields sealed with AES-256-GCM before touching disk. The machine
 * key lives in ~/.shiba-studio/shiba-studio.key — outside source code and the repo.
 * Dot-paths are relative to AppConfig.
 */
const SENSITIVE_CONFIG_PATHS = [
  'xaiApiKey',
  'xaiManagementKey',
  'integrations.github.token',
  'integrations.slack.token',
  'integrations.slack.appToken',
  'integrations.googledrive.accessToken',
  'integrations.googledrive.serviceAccountJson',
  'integrations.googledrive.clientSecret',
  'integrations.googledrive.refreshToken',
  'integrations.discord.token',
  'integrations.x.apiKey',
  'integrations.x.apiSecret',
  'integrations.x.accessToken',
  'integrations.x.accessTokenSecret',
  'integrations.x.clientSecret',
  'integrations.reddit.devvitAppToken',
  'integrations.obsidian.restApiKey',
  'integrations.vercel.token',
  'integrations.netlify.token',
  'integrations.linear.apiKey',
  'integrations.jira.apiToken',
] as const;

function getAtPath(obj: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((cur, seg) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[seg];
    return undefined;
  }, obj);
}

function setAtPath(obj: Record<string, unknown>, dotPath: string, value: string): void {
  const segs = dotPath.split('.');
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    const next = cur[seg];
    if (!next || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

/** Deep-copy cfg with every sensitive field sealed. */
function sealConfigSecrets(cfg: AppConfig): { sealed: AppConfig; changed: boolean } {
  const sealed = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  let changed = false;
  for (const p of SENSITIVE_CONFIG_PATHS) {
    const v = getAtPath(sealed, p);
    if (typeof v === 'string' && v.trim() && !isEncryptedSecret(v)) {
      setAtPath(sealed, p, encryptSecret(v));
      changed = true;
    }
  }
  return { sealed: sealed as unknown as AppConfig, changed };
}

/** Deep-copy raw config with every sensitive field opened for in-memory use. */
function openConfigSecrets(raw: AppConfig): { opened: AppConfig; hadPlaintext: boolean } {
  const opened = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  let hadPlaintext = false;
  for (const p of SENSITIVE_CONFIG_PATHS) {
    const v = getAtPath(opened, p);
    if (typeof v === 'string' && v.trim()) {
      if (isEncryptedSecret(v)) setAtPath(opened, p, decryptSecret(v));
      else hadPlaintext = true;
    }
  }
  return { opened: opened as unknown as AppConfig, hadPlaintext };
}

let dataDirOverride: string | null = null;

export function setPersistenceDataDir(dir: string | null): void {
  dataDirOverride = dir;
}

function resolveDataDir(): string {
  return dataDirOverride || dataDir();
}

const agentsFile = () => path.join(resolveDataDir(), 'agents.json');
const configFile = () => path.join(resolveDataDir(), 'config.json');

async function ensureData() {
  await fs.mkdir(resolveDataDir(), { recursive: true });
}

// Sensitive fields inside an agent's per-integration credential overrides —
// sealed with AES-256-GCM at rest, opened in memory (mirrors the global
// SENSITIVE_CONFIG_PATHS but scoped per agent).
const AGENT_OVERRIDE_SECRET_FIELDS: Record<string, string[]> = {
  github: ['token'],
  slack: ['token', 'appToken'],
  discord: ['token'],
  x: ['apiKey', 'apiSecret', 'accessToken', 'accessTokenSecret'],
  reddit: ['devvitAppToken'],
  obsidian: ['restApiKey'],
  googledrive: ['accessToken', 'serviceAccountJson', 'clientSecret', 'refreshToken'],
  vercel: ['token'],
  netlify: ['token'],
};

const REDDIT_DEVVIT_FIELDS = new Set(['devvitEndpoint', 'devvitAppToken']);

/**
 * Reddit's former user OAuth session is not compatible with the Devvit bridge.
 * Rebuild the provider record from the two Devvit fields so tokens, identity
 * metadata, and any unknown legacy fields cannot survive the migration.
 */
function migrateRedditCreds(integrations: Record<string, unknown> | undefined): boolean {
  if (!integrations || !Object.prototype.hasOwnProperty.call(integrations, 'reddit')) return false;
  const raw = integrations.reddit;
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const devvitEndpoint = typeof record.devvitEndpoint === 'string'
    ? record.devvitEndpoint.trim()
    : '';
  const devvitAppToken = typeof record.devvitAppToken === 'string'
    ? record.devvitAppToken.trim()
    : '';
  const reddit: NonNullable<IntegrationCreds['reddit']> = {};
  if (devvitEndpoint) reddit.devvitEndpoint = devvitEndpoint;
  if (devvitAppToken) reddit.devvitAppToken = devvitAppToken;

  const keys = Object.keys(record);
  const changed = raw !== record
    || keys.some((key) => !REDDIT_DEVVIT_FIELDS.has(key))
    || (typeof record.devvitEndpoint === 'string' && record.devvitEndpoint !== devvitEndpoint)
    || (typeof record.devvitAppToken === 'string' && record.devvitAppToken !== devvitAppToken)
    || keys.some((key) => REDDIT_DEVVIT_FIELDS.has(key) && typeof record[key] !== 'string')
    || (Object.keys(reddit).length === 0 && keys.length === 0);

  if (Object.keys(reddit).length) integrations.reddit = reddit;
  else delete integrations.reddit;
  return changed || Object.keys(reddit).length !== keys.length;
}

function migrateAgentRedditCreds(agent: Agent): boolean {
  const overrides = agent.integrationOverrides as Record<string, unknown> | undefined;
  if (!overrides) return false;
  const changed = migrateRedditCreds(overrides);
  if (Object.keys(overrides).length === 0) delete agent.integrationOverrides;
  return changed;
}

function transformAgentOverrideSecrets(agent: Agent, fn: (v: string) => string): Agent {
  const ov = (agent as Agent & { integrationOverrides?: Record<string, Record<string, unknown>> }).integrationOverrides;
  if (!ov) return agent;
  const nextOv: Record<string, Record<string, unknown>> = {};
  for (const [svc, svcObj] of Object.entries(ov)) {
    if (!svcObj || typeof svcObj !== 'object') { nextOv[svc] = svcObj; continue; }
    const copy: Record<string, unknown> = { ...svcObj };
    for (const f of AGENT_OVERRIDE_SECRET_FIELDS[svc] || []) {
      const v = copy[f];
      if (typeof v === 'string' && v) copy[f] = fn(v);
    }
    nextOv[svc] = copy;
  }
  return { ...agent, integrationOverrides: nextOv } as Agent;
}

/**
 * Mention routing belongs to the one global Slack/Discord listener. Agent
 * overrides are outbound credential scopes, so a mentionAgentId stored there
 * is unused and can become a dangling internal reference. Strip legacy/API
 * values at both read and write boundaries.
 */
function stripUnusedAgentOverrideReferences(agent: Agent): boolean {
  const overrides = agent.integrationOverrides as Record<string, Record<string, unknown>> | undefined;
  if (!overrides) return false;
  let changed = false;
  const nextOverrides: Record<string, Record<string, unknown>> = { ...overrides };
  for (const service of ['slack', 'discord']) {
    const current = nextOverrides[service];
    if (!current || !Object.prototype.hasOwnProperty.call(current, 'mentionAgentId')) continue;
    const next = { ...current };
    delete next.mentionAgentId;
    if (Object.keys(next).length) nextOverrides[service] = next;
    else delete nextOverrides[service];
    changed = true;
  }
  if (!changed) return false;
  if (Object.keys(nextOverrides).length) agent.integrationOverrides = nextOverrides as IntegrationCreds;
  else delete agent.integrationOverrides;
  return true;
}

const persistenceLockGlobal = globalThis as typeof globalThis & {
  __shibaConfigChain?: Promise<unknown>;
};

function withAgentsLock<T>(fn: () => Promise<T>): Promise<T> {
  const target = agentsFile();
  return withStoreFileLock(
    ownershipStoreFencePath(path.dirname(target)),
    () => withStoreFileLock(target, fn),
  );
}

async function loadAgentsUnlocked(): Promise<Agent[]> {
  await ensureData();
  try {
    const raw = await fs.readFile(agentsFile(), 'utf8');
    const list = JSON.parse(raw) as unknown[];
    const normalized = list.map(normalizeAgent);
    let migrated = false;
    for (const agent of normalized) migrated = migrateAgentRedditCreds(agent) || migrated;
    const agents = normalized.map((a) => transformAgentOverrideSecrets(a, decryptSecret));
    for (const agent of agents) migrated = stripUnusedAgentOverrideReferences(agent) || migrated;
    if (migrated) await saveAgentsUnlocked(agents);
    return agents;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return [];
  }
}

async function saveAgentsUnlocked(agents: Agent[]): Promise<void> {
  await ensureData();
  for (const agent of agents) {
    stripUnusedAgentOverrideReferences(agent);
    migrateAgentRedditCreds(agent);
  }
  const sealed = agents.map((a) => transformAgentOverrideSecrets(a, encryptSecret));
  const target = agentsFile();
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(sealed, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  // Live UI: agent lists/pickers refresh without a page reload.
  const { emitAppEvent } = await import('./app-events');
  emitAppEvent('agents');
}

export async function loadAgents(): Promise<Agent[]> {
  return withAgentsLock(loadAgentsUnlocked);
}

/**
 * Hold the agent store stable while repairing references in another store.
 * Cross-store reconcilers use this instead of acting on a stale list that
 * could classify a concurrently-created agent as missing.
 */
export function withAgentOwnershipSnapshot<T>(
  inspect: (agentIds: ReadonlySet<string>) => Promise<T>,
): Promise<T> {
  return withAgentsLock(async () => {
    const agents = await loadAgentsUnlocked();
    return inspect(new Set(agents.map((agent) => agent.id)));
  });
}

export async function saveAgents(agents: Agent[]): Promise<void> {
  return withAgentsLock(() => saveAgentsUnlocked(agents));
}

/**
 * Serialize an agent read-modify-write as one operation. The callback may
 * mutate the supplied array in place and returns the caller's result.
 */
export async function mutateAgents<T>(mutate: (agents: Agent[]) => T | Promise<T>): Promise<T> {
  return withAgentsLock(async () => {
    const agents = await loadAgentsUnlocked();
    const result = await mutate(agents);
    await saveAgentsUnlocked(agents);
    return result;
  });
}

const DEFAULT_CONFIG: AppConfig = {
  xaiApiKey: '',
  safeMode: false,
  integrations: {},
  defaultWorkspace: projectRoot(),
  defaultGrokModel: '',
  defaultTtsVoice: '',
  defaultTtsSpeed: 1,
  localGrokEnabled: false,
  localGrokBaseUrl: 'http://127.0.0.1:1234/v1',
  localModelAllowlist: [],
  cloudAuthMode: 'api_key',
  // Approval-required is the safe default for a public release; YOLO is an
  // explicit opt-in from Settings (existing configs keep their saved choice).
  toolApprovalMode: 'ask',
  budgetHardStop: true,
  maxConcurrentRuns: 3,
  disabledTools: [],
  globalInstructions: '',
  useAgentsMd: true,
  remoteAccess: {
    enabled: false,
    pairingTtlMinutes: 5,
    deviceTtlDays: 30,
  },
};

async function syncCloudAuthCache(cfg: AppConfig): Promise<void> {
  const { ensureCloudAuth } = await import('./xai-oauth');
  await ensureCloudAuth(cfg);
}

async function writeConfigFileAtomic(content: string): Promise<void> {
  const target = configFile();
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = persistenceLockGlobal.__shibaConfigChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  persistenceLockGlobal.__shibaConfigChain = run.then(() => undefined, () => undefined);
  return run;
}

async function loadConfigUnlocked(): Promise<AppConfig> {
  await ensureData();
  try {
    const raw = await fs.readFile(configFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const stored = {
      ...DEFAULT_CONFIG,
      ...parsed,
      remoteAccess: {
        ...DEFAULT_CONFIG.remoteAccess,
        ...(parsed.remoteAccess || {}),
        // Missing/legacy config must remain explicitly off.
        enabled: parsed.remoteAccess?.enabled === true,
      },
    } as AppConfig;
    const { opened, hadPlaintext } = openConfigSecrets(stored);
    const redditMigrated = migrateRedditCreds(opened.integrations as Record<string, unknown>);
    if (hadPlaintext || redditMigrated) {
      // One-time migration: seal plaintext and remove obsolete Reddit OAuth data.
      const { sealed } = sealConfigSecrets(opened);
      await writeConfigFileAtomic(JSON.stringify(sealed, null, 2));
    }
    setIntegrationCreds(opened.integrations || {});
    await syncCloudAuthCache(opened);
    return opened;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    const fallback = { ...DEFAULT_CONFIG };
    setIntegrationCreds(fallback.integrations || {});
    await syncCloudAuthCache(fallback);
    return fallback;
  }
}

async function writeConfigUnlocked(next: AppConfig): Promise<AppConfig> {
  migrateRedditCreds(next.integrations as Record<string, unknown>);
  const { sealed } = sealConfigSecrets(next);
  await writeConfigFileAtomic(JSON.stringify(sealed, null, 2));
  setIntegrationCreds(next.integrations);
  await syncCloudAuthCache(next);
  return next;
}

export async function loadConfig(): Promise<AppConfig> {
  return withConfigLock(loadConfigUnlocked);
}

export async function saveConfig(partial: Partial<AppConfig>) {
  return withConfigLock(async () => {
    await ensureData();
    const cur = await loadConfigUnlocked();
    const next = {
      ...cur,
      ...partial,
      integrations: { ...cur.integrations, ...(partial.integrations || {}) },
      remoteAccess: {
        ...(cur.remoteAccess || DEFAULT_CONFIG.remoteAccess),
        ...(partial.remoteAccess || {}),
        enabled: partial.remoteAccess?.enabled ?? cur.remoteAccess?.enabled ?? false,
      },
    };
    return writeConfigUnlocked(next);
  });
}

/** Atomic provider-only config mutation used after network-bound sync work. */
export async function updateIntegrationConfig<K extends keyof IntegrationCreds>(
  key: K,
  update: (current: IntegrationCreds[K], config: AppConfig) => IntegrationCreds[K],
): Promise<AppConfig> {
  return withConfigLock(async () => {
    await ensureData();
    const cur = await loadConfigUnlocked();
    const integrations = { ...cur.integrations, [key]: update(cur.integrations[key], cur) };
    return writeConfigUnlocked({ ...cur, integrations });
  });
}

export async function getConfig(): Promise<AppConfig> {
  return loadConfig();
}
