import { promises as fs } from 'fs';
import path from 'path';
import { Agent, AppConfig, normalizeAgent } from './types';
import { setIntegrationCreds } from './integrations';
import { dataDir, projectRoot } from './data-paths';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secure-store';

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
  'integrations.obsidian.restApiKey',
  'integrations.vercel.token',
  'integrations.netlify.token',
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
  slack: ['token'],
  discord: ['token'],
  x: ['apiKey', 'apiSecret', 'accessToken', 'accessTokenSecret'],
  obsidian: ['restApiKey'],
  googledrive: ['accessToken', 'serviceAccountJson', 'clientSecret', 'refreshToken'],
  vercel: ['token'],
  netlify: ['token'],
};

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

export async function loadAgents(): Promise<Agent[]> {
  await ensureData();
  try {
    const raw = await fs.readFile(agentsFile(), 'utf8');
    const list = JSON.parse(raw) as unknown[];
    return list.map(normalizeAgent).map((a) => transformAgentOverrideSecrets(a, decryptSecret));
  } catch {
    return [];
  }
}

export async function saveAgents(agents: Agent[]) {
  await ensureData();
  const sealed = agents.map((a) => transformAgentOverrideSecrets(a, encryptSecret));
  await fs.writeFile(agentsFile(), JSON.stringify(sealed, null, 2));
}

const DEFAULT_CONFIG: AppConfig = {
  xaiApiKey: '',
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
};

async function syncCloudAuthCache(cfg: AppConfig): Promise<void> {
  const { ensureCloudAuth } = await import('./xai-oauth');
  await ensureCloudAuth(cfg);
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureData();
  try {
    const raw = await fs.readFile(configFile(), 'utf8');
    const stored = { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig;
    const { opened, hadPlaintext } = openConfigSecrets(stored);
    if (hadPlaintext) {
      // One-time migration: re-write any legacy plaintext secrets sealed.
      const { sealed } = sealConfigSecrets(opened);
      await fs.writeFile(configFile(), JSON.stringify(sealed, null, 2));
    }
    setIntegrationCreds(opened.integrations || {});
    await syncCloudAuthCache(opened);
    return opened;
  } catch {
    const fallback = { ...DEFAULT_CONFIG };
    setIntegrationCreds(fallback.integrations || {});
    await syncCloudAuthCache(fallback);
    return fallback;
  }
}

export async function saveConfig(partial: Partial<AppConfig>) {
  await ensureData();
  const cur = await loadConfig();
  const next = { ...cur, ...partial, integrations: { ...cur.integrations, ...(partial.integrations || {}) } };
  const { sealed } = sealConfigSecrets(next);
  await fs.writeFile(configFile(), JSON.stringify(sealed, null, 2));
  setIntegrationCreds(next.integrations);
  await syncCloudAuthCache(next);
  return next;
}

export async function getConfig(): Promise<AppConfig> {
  return loadConfig();
}
