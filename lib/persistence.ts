import { promises as fs } from 'fs';
import path from 'path';
import { Agent, AppConfig, normalizeAgent } from './types';
import { setIntegrationCreds } from './integrations';
import { dataDir, projectRoot } from './data-paths';

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

export async function loadAgents(): Promise<Agent[]> {
  await ensureData();
  try {
    const raw = await fs.readFile(agentsFile(), 'utf8');
    const list = JSON.parse(raw) as any[];
    return list.map(normalizeAgent);
  } catch {
    return [];
  }
}

export async function saveAgents(agents: Agent[]) {
  await ensureData();
  await fs.writeFile(agentsFile(), JSON.stringify(agents, null, 2));
}

const DEFAULT_CONFIG: AppConfig = {
  xaiApiKey: '',
  integrations: {},
  defaultWorkspace: projectRoot(),
  defaultGrokModel: '',
  localGrokEnabled: false,
  localGrokBaseUrl: 'http://127.0.0.1:1234/v1',
  cloudAuthMode: 'api_key',
  toolApprovalMode: 'yolo',
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
    const c = { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig;
    setIntegrationCreds(c.integrations || {});
    await syncCloudAuthCache(c);
    return c;
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
  await fs.writeFile(configFile(), JSON.stringify(next, null, 2));
  setIntegrationCreds(next.integrations);
  await syncCloudAuthCache(next);
  return next;
}

export async function getConfig(): Promise<AppConfig> {
  return loadConfig();
}
