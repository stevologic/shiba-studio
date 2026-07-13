import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import { v4 as uuidv4 } from 'uuid';
import { buildServerFromPreset, getMcpPreset, MCP_PRESETS, xurlCredentialProfile } from './mcp-catalog';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secure-store';

const DATA_DIR = dataDir();
const MCP_FILE = path.join(DATA_DIR, 'mcp-servers.json');

export interface McpServerRecord {
  id: string;
  name: string;
  presetId?: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface McpStore {
  servers: McpServerRecord[];
}

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

const mcpLockGlobal = globalThis as typeof globalThis & { __shibaMcpWriteChain?: Promise<unknown> };

function withMcpWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = mcpLockGlobal.__shibaMcpWriteChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  mcpLockGlobal.__shibaMcpWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Keep each X OAuth app/account out of xurl's process-global default store.
 * xurl resolves its store from the OS home directory; both variables are
 * needed because Go uses USERPROFILE on Windows and HOME on Unix. */
function isolateXurlEnvironment(env: Record<string, string>): Record<string, string> {
  const clientId = env.CLIENT_ID;
  if (!clientId) return env;
  const home = path.join(DATA_DIR, 'x-mcp', xurlCredentialProfile(clientId));
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: path.join(DATA_DIR, 'npx-cache'),
  };
}

function openServerSecrets(server: McpServerRecord): { server: McpServerRecord; hadPlaintext: boolean } {
  let hadPlaintext = false;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env || {})) {
    if (!value) {
      env[key] = value;
    } else if (isEncryptedSecret(value)) {
      env[key] = decryptSecret(value);
    } else {
      env[key] = value;
      hadPlaintext = true;
    }
  }
  return { server: { ...server, env }, hadPlaintext };
}

function sealServerSecrets(server: McpServerRecord): McpServerRecord {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env || {})) {
    env[key] = value ? encryptSecret(value) : value;
  }
  return { ...server, env };
}

async function loadStore(options: { persistMaintenance?: boolean } = {}): Promise<McpStore> {
  if (options.persistMaintenance !== false) await ensureData();
  try {
    const raw = await fs.readFile(MCP_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    let changed = false;
    const servers: McpServerRecord[] = (Array.isArray(parsed.servers) ? parsed.servers : [])
      .map((record: McpServerRecord) => {
        const opened = openServerSecrets(record);
        if (opened.hadPlaintext) changed = true;
        return opened.server;
      });
    // Self-heal zero-config preset servers whose command/args drifted from the
    // current catalog (e.g. the Web Fetch package was corrected). Presets with
    // no env fields append nothing user-specific to args, so re-syncing is
    // lossless — records with env fields (filesystem path, GitHub token) are
    // left untouched.
    for (const s of servers) {
      const preset = s.presetId ? getMcpPreset(s.presetId) : undefined;
      if (!preset) continue;
      if (preset.id === 'x') {
        const built = buildServerFromPreset('x', s.env);
        if (!built) continue;
        built.env = isolateXurlEnvironment(built.env);
        const commandChanged = s.command !== built.command;
        const argsChanged = s.args.join('\u0000') !== built.args.join('\u0000');
        const envChanged = Object.entries(built.env).some(([key, value]) => s.env[key] !== value)
          || Object.keys(s.env).some((key) => !(key in built.env));
        if (commandChanged || argsChanged || envChanged) {
          s.command = built.command;
          s.args = built.args;
          s.env = built.env;
          changed = true;
        }
      } else if (preset.envFields.length === 0) {
        const args = [...preset.args];
        if (s.command !== preset.command || s.args.join('\u0000') !== args.join('\u0000')) {
          s.command = preset.command;
          s.args = args;
          changed = true;
        }
      }
    }
    if (changed && options.persistMaintenance !== false) await saveStore(servers);
    return { servers };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { servers: [] };
    throw error;
  }
}

async function saveStore(servers: McpServerRecord[]) {
  await ensureData();
  const tmp = `${MCP_FILE}.${process.pid}.${uuidv4()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ servers: servers.map(sealServerSecrets) }, null, 2));
    await fs.rename(tmp, MCP_FILE);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export function listMcpPresets() {
  return MCP_PRESETS;
}

export async function listMcpServers(): Promise<McpServerRecord[]> {
  return withMcpWriteLock(async () => {
    const store = await loadStore();
    return store.servers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
}

/** Read configured servers without persisting secret migration or preset drift
 * maintenance. Diagnostics use this path so generating a report is read-only. */
export async function listMcpServersReadOnly(): Promise<McpServerRecord[]> {
  return withMcpWriteLock(async () => {
    const store = await loadStore({ persistMaintenance: false });
    return store.servers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
}

export async function getMcpServer(id: string): Promise<McpServerRecord | null> {
  return withMcpWriteLock(async () => {
    const store = await loadStore();
    return store.servers.find((s) => s.id === id) || null;
  });
}

export async function addMcpServerFromPreset(
  presetId: string,
  fieldValues: Record<string, string>,
  defaults?: {
    workspacePath?: string;
    githubToken?: string;
    xClientId?: string;
    xClientSecret?: string;
  },
): Promise<McpServerRecord> {
  return withMcpWriteLock(async () => {
    const built = buildServerFromPreset(presetId, fieldValues, defaults);
    if (!built) throw new Error('Unknown MCP preset');
    if (presetId === 'x') built.env = isolateXurlEnvironment(built.env);

    const store = await loadStore();
    const existing = store.servers.find((s) => s.presetId === presetId);
    if (existing) {
      existing.name = built.name;
      existing.command = built.command;
      existing.args = built.args;
      existing.env = built.env;
      existing.enabled = true;
      existing.updatedAt = new Date().toISOString();
      await saveStore(store.servers);
      return existing;
    }

    const now = new Date().toISOString();
    const server: McpServerRecord = {
      id: uuidv4(),
      name: built.name,
      presetId,
      enabled: true,
      command: built.command,
      args: built.args,
      env: built.env,
      createdAt: now,
      updatedAt: now,
    };
    store.servers.push(server);
    await saveStore(store.servers);
    return server;
  });
}

export async function addCustomMcpServer(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  notes?: string;
}): Promise<McpServerRecord> {
  return withMcpWriteLock(async () => {
    const name = input.name?.trim();
    const command = input.command?.trim();
    if (!name) throw new Error('Server name required');
    if (!command) throw new Error('Command required');

    const now = new Date().toISOString();
    const server: McpServerRecord = {
      id: uuidv4(),
      name,
      enabled: true,
      command,
      args: Array.isArray(input.args) ? input.args.filter(Boolean) : [],
      env: input.env || {},
      notes: input.notes?.trim(),
      createdAt: now,
      updatedAt: now,
    };

    const store = await loadStore();
    store.servers.push(server);
    await saveStore(store.servers);
    return server;
  });
}

export async function updateMcpServer(
  id: string,
  patch: Partial<Pick<McpServerRecord, 'name' | 'enabled' | 'command' | 'args' | 'env' | 'notes'>>,
): Promise<McpServerRecord> {
  return withMcpWriteLock(async () => {
    const store = await loadStore();
    const idx = store.servers.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error('MCP server not found');

    store.servers[idx] = {
      ...store.servers[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await saveStore(store.servers);
    return store.servers[idx];
  });
}

export async function deleteMcpServer(id: string): Promise<void> {
  await withMcpWriteLock(async () => {
    const store = await loadStore();
    await saveStore(store.servers.filter((s) => s.id !== id));
  });
}

export async function listEnabledMcpServers(): Promise<McpServerRecord[]> {
  const { loadConfig } = await import('./persistence');
  if ((await loadConfig()).safeMode) return [];
  const servers = await listMcpServers();
  return servers.filter((s) => s.enabled);
}

export type McpTestResult = {
  ok: boolean;
  toolCount?: number;
  tools?: string[];
  error?: string;
  serverVersion?: string;
};

const inFlightTests = new Map<string, Promise<McpTestResult>>();

export function testMcpServer(server: McpServerRecord): Promise<McpTestResult> {
  const existing = inFlightTests.get(server.id);
  if (existing) return existing;
  const pending = runMcpTest(server).finally(() => {
    if (inFlightTests.get(server.id) === pending) inFlightTests.delete(server.id);
  });
  inFlightTests.set(server.id, pending);
  return pending;
}

async function runMcpTest(server: McpServerRecord): Promise<McpTestResult> {
  try {
    const { connectMcpServer, disconnectMcpClient } = await import('./mcp-client');
    // npx-launched servers download their package on first use (a cold install
    // of a deps-heavy server can take 30s+), so allow generous headroom — later
    // launches hit the npm cache and connect in a few seconds.
    const client = await connectMcpServer(server, 90_000);
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const listed = await Promise.race([
        client.listTools(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('MCP tool discovery timed out after 60s')), 60_000);
          timeout.unref?.();
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      const tools = (listed.tools || []).map((t) => t.name);
      return {
        ok: true,
        toolCount: tools.length,
        tools: tools.slice(0, 20),
        serverVersion: client.getServerVersion?.() || undefined,
      };
    } finally {
      await disconnectMcpClient(client);
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'MCP test failed' };
  }
}

export function describeMcpServer(server: McpServerRecord): string {
  const preset = server.presetId ? getMcpPreset(server.presetId) : undefined;
  const label = preset?.shortLabel || server.name;
  return `${label} (${server.command} ${server.args.join(' ')})`;
}
