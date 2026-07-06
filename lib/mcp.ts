import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { buildServerFromPreset, getMcpPreset, MCP_PRESETS } from './mcp-catalog';

const DATA_DIR = path.join(process.cwd(), 'data');
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

async function loadStore(): Promise<McpStore> {
  await ensureData();
  try {
    const raw = await fs.readFile(MCP_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
  } catch {
    return { servers: [] };
  }
}

async function saveStore(servers: McpServerRecord[]) {
  await ensureData();
  await fs.writeFile(MCP_FILE, JSON.stringify({ servers }, null, 2));
}

export function listMcpPresets() {
  return MCP_PRESETS;
}

export async function listMcpServers(): Promise<McpServerRecord[]> {
  const store = await loadStore();
  return store.servers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getMcpServer(id: string): Promise<McpServerRecord | null> {
  const store = await loadStore();
  return store.servers.find((s) => s.id === id) || null;
}

export async function addMcpServerFromPreset(
  presetId: string,
  fieldValues: Record<string, string>,
  defaults?: { workspacePath?: string; githubToken?: string },
): Promise<McpServerRecord> {
  const built = buildServerFromPreset(presetId, fieldValues, defaults);
  if (!built) throw new Error('Unknown MCP preset');

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
}

export async function addCustomMcpServer(input: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  notes?: string;
}): Promise<McpServerRecord> {
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
}

export async function updateMcpServer(
  id: string,
  patch: Partial<Pick<McpServerRecord, 'name' | 'enabled' | 'command' | 'args' | 'env' | 'notes'>>,
): Promise<McpServerRecord> {
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
}

export async function deleteMcpServer(id: string): Promise<void> {
  const store = await loadStore();
  await saveStore(store.servers.filter((s) => s.id !== id));
}

export async function listEnabledMcpServers(): Promise<McpServerRecord[]> {
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

export async function testMcpServer(server: McpServerRecord): Promise<McpTestResult> {
  try {
    const { connectMcpServer, disconnectMcpClient } = await import('./mcp-client');
    const client = await connectMcpServer(server, 25_000);
    try {
      const listed = await client.listTools();
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