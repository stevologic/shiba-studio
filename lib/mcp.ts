import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import { v4 as uuidv4 } from 'uuid';
import { buildServerFromPreset, getMcpPreset, MCP_PRESETS, xurlCredentialProfile } from './mcp-catalog';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secure-store';

const DATA_DIR = dataDir();
// These are runtime data roots, not bundle inputs. Without the installed
// Next/Turbopack trace hint, a configurable data directory can make NFT trace
// the entire repository into every route that imports the MCP store.
const MCP_FILE = path.join(/* turbopackIgnore: true */ DATA_DIR, 'mcp-servers.json');
const X_MCP_ROOT = path.join(/* turbopackIgnore: true */ DATA_DIR, 'x-mcp');
const X_MCP_PROFILE_MARKER = '.shiba-x-mcp-profile.json';
const X_MCP_PROFILE_PATTERN = /^shiba-studio-[0-9a-f]{8}$/;
const X_MCP_QUARANTINE_PATTERN = /^\.shiba-x-mcp-delete-(shiba-studio-[0-9a-f]{8})-[0-9a-f-]{36}$/;

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
  const home = path.join(/* turbopackIgnore: true */ X_MCP_ROOT, xurlCredentialProfile(clientId));
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: path.join(/* turbopackIgnore: true */ DATA_DIR, 'npx-cache'),
  };
}

interface XurlCredentialMarker {
  schema: 'shiba-x-mcp-profile-v1';
  profile: string;
  nonce: string;
}

function exactXurlCredentialHome(server: McpServerRecord): string | null {
  if (server.presetId !== 'x') return null;
  const clientId = server.env?.CLIENT_ID?.trim();
  if (!clientId) return null;
  const expected = path.resolve(/* turbopackIgnore: true */ X_MCP_ROOT, xurlCredentialProfile(clientId));
  if (path.dirname(expected) !== path.resolve(/* turbopackIgnore: true */ X_MCP_ROOT)) return null;
  if (path.resolve(/* turbopackIgnore: true */ server.env.HOME || '') !== expected) return null;
  if (path.resolve(/* turbopackIgnore: true */ server.env.USERPROFILE || '') !== expected) return null;
  return expected;
}

async function readXurlCredentialMarker(
  home: string,
  expectedProfile = path.basename(home),
): Promise<XurlCredentialMarker | null> {
  const markerFile = path.join(/* turbopackIgnore: true */ home, X_MCP_PROFILE_MARKER);
  try {
    const stat = await fs.lstat(markerFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = JSON.parse(await fs.readFile(markerFile, 'utf8')) as Partial<XurlCredentialMarker>;
    return parsed.schema === 'shiba-x-mcp-profile-v1'
      && parsed.profile === expectedProfile
      && typeof parsed.nonce === 'string'
      && /^[0-9a-f-]{36}$/.test(parsed.nonce)
      ? { schema: 'shiba-x-mcp-profile-v1', profile: expectedProfile, nonce: parsed.nonce }
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureXurlCredentialHomeOwned(server: McpServerRecord): Promise<string | null> {
  const home = exactXurlCredentialHome(server);
  if (!home) return null;
  await fs.mkdir(X_MCP_ROOT, { recursive: true });
  const rootStat = await fs.lstat(X_MCP_ROOT);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('X MCP credential root must be a real directory');
  }
  let created = false;
  try {
    await fs.mkdir(home);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
  }
  if (!created) {
    const homeStat = await fs.lstat(home);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
      throw new Error('X MCP credential profile must be a real directory');
    }
    const existing = await readXurlCredentialMarker(home);
    if (existing) return home;
    // Recover only a crash-left empty directory. rmdir is deliberately
    // non-recursive: if any provider/user byte exists or appears concurrently,
    // it fails closed instead of claiming that data as Shiba-owned.
    try {
      await fs.rmdir(home);
    } catch (error) {
      if (['ENOTEMPTY', 'EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code || '')) {
        throw new Error('Existing X MCP profile is unmarked and was preserved');
      }
      throw error;
    }
    try {
      await fs.mkdir(home);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const concurrent = await readXurlCredentialMarker(home);
      if (concurrent) return home;
      throw new Error('Concurrent X MCP profile creation could not be proven safe');
    }
  }
  const markerFile = path.join(/* turbopackIgnore: true */ home, X_MCP_PROFILE_MARKER);
  const marker: XurlCredentialMarker = {
    schema: 'shiba-x-mcp-profile-v1',
    profile: path.basename(home),
    nonce: uuidv4(),
  };
  try {
    await fs.writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      if (created) await fs.rmdir(home).catch(() => undefined);
      throw error;
    }
  }
  if (!(await readXurlCredentialMarker(home))) {
    throw new Error('X MCP credential profile marker is invalid');
  }
  return home;
}

async function removeOwnedXurlCredentialHome(home: string): Promise<boolean> {
  const root = path.resolve(/* turbopackIgnore: true */ X_MCP_ROOT);
  const candidate = path.resolve(/* turbopackIgnore: true */ home);
  const name = path.basename(candidate);
  const profile = X_MCP_PROFILE_PATTERN.test(name)
    ? name
    : X_MCP_QUARANTINE_PATTERN.exec(name)?.[1];
  if (path.dirname(candidate) !== root || !profile) return false;
  const quarantine = path.join(/* turbopackIgnore: true */ root, `.shiba-x-mcp-delete-${profile}-${uuidv4()}`);
  try {
    const [rootStat, homeStat] = await Promise.all([fs.lstat(root), fs.lstat(candidate)]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) return false;
    const marker = await readXurlCredentialMarker(candidate, profile);
    if (!marker) return false;
    // Rename is the ownership handoff: recursive removal never targets the
    // observed live profile path. Verify inode + unguessable marker again after
    // the atomic move so a replacement cannot ride through the check/remove gap.
    await fs.rename(candidate, quarantine);
    const movedStat = await fs.lstat(quarantine);
    const movedMarker = await readXurlCredentialMarker(quarantine, profile);
    const sameObject = homeStat.dev === movedStat.dev && homeStat.ino === movedStat.ino;
    if (!sameObject || !movedMarker || movedMarker.nonce !== marker.nonce) {
      try { await fs.rename(quarantine, candidate); } catch { /* preserve quarantine for review */ }
      return false;
    }
    await fs.rm(quarantine, { recursive: true, force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
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
      const previousXurlHome = exactXurlCredentialHome(existing);
      if (previousXurlHome) await ensureXurlCredentialHomeOwned(existing).catch(() => null);
      existing.name = built.name;
      existing.command = built.command;
      existing.args = built.args;
      existing.env = built.env;
      existing.enabled = true;
      existing.updatedAt = new Date().toISOString();
      if (presetId === 'x') {
        const nextHome = exactXurlCredentialHome(existing);
        try {
          await ensureXurlCredentialHomeOwned(existing);
        } catch (error) {
          const legacyUnmarked = previousXurlHome === nextHome
            && /unmarked.*preserved/i.test(error instanceof Error ? error.message : String(error));
          if (!legacyUnmarked) throw error;
        }
      }
      await saveStore(store.servers);
      const nextXurlHome = exactXurlCredentialHome(existing);
      if (
        previousXurlHome
        && previousXurlHome !== nextXurlHome
        && !store.servers.some((server) => exactXurlCredentialHome(server) === previousXurlHome)
      ) {
        await removeOwnedXurlCredentialHome(previousXurlHome).catch(() => false);
      }
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
    if (presetId === 'x') await ensureXurlCredentialHomeOwned(server);
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
  const { withIntegrityMutation } = await import('./integrity-coordinator');
  await withIntegrityMutation(`MCP server deletion:${id}`, () => withMcpWriteLock(async () => {
    const store = await loadStore();
    const removed = store.servers.find((server) => server.id === id);
    const home = removed ? exactXurlCredentialHome(removed) : null;
    if (removed && home) await ensureXurlCredentialHomeOwned(removed).catch(() => null);
    const remaining = store.servers.filter((server) => server.id !== id);
    if (remaining.length === store.servers.length) return;
    await saveStore(remaining);
    if (home && !remaining.some((server) => exactXurlCredentialHome(server) === home)) {
      await removeOwnedXurlCredentialHome(home).catch(() => false);
    }
  }));
}

/** Remove only X preset servers using the exact deleted OAuth client. A
 * separately configured X MCP client remains untouched. */
export async function deleteXClientProfile(clientId: string): Promise<{
  serversRemoved: number;
  credentialHomeRemoved: boolean;
}> {
  const normalized = clientId.trim();
  if (!normalized) return { serversRemoved: 0, credentialHomeRemoved: false };
  const expectedHome = path.resolve(/* turbopackIgnore: true */ X_MCP_ROOT, xurlCredentialProfile(normalized));
  const { withIntegrityMutation } = await import('./integrity-coordinator');
  const mutation = await withIntegrityMutation(
    `X MCP client deletion:${xurlCredentialProfile(normalized)}`,
    () => withMcpWriteLock(async () => {
      const store = await loadStore();
      const removed = store.servers.filter((server) =>
        server.presetId === 'x'
        && server.env?.CLIENT_ID?.trim() === normalized
        && exactXurlCredentialHome(server) === expectedHome);
      for (const server of removed) await ensureXurlCredentialHomeOwned(server).catch(() => null);
      const removedIds = new Set(removed.map((server) => server.id));
      const remaining = store.servers.filter((server) => !removedIds.has(server.id));
      if (removed.length) await saveStore(remaining);
      const active = remaining.some((server) => exactXurlCredentialHome(server) === expectedHome);
      const credentialHomeRemoved = active
        ? false
        : await removeOwnedXurlCredentialHome(expectedHome).catch(() => false);
      return { serversRemoved: removed.length, credentialHomeRemoved };
    }),
  );
  return mutation.result;
}

export interface XurlCredentialIntegrityReport {
  activeProfiles: number;
  orphanedProfilesRemoved: number;
  unprovenProfilesPreserved: number;
  errors: string[];
}

/** Direct-child, marker-gated sweep for credential homes left by an
 * interrupted profile/server deletion. Unmarked or malformed directories are
 * preserved because Shiba cannot prove ownership. */
export function reconcileXurlCredentialHomes(): Promise<XurlCredentialIntegrityReport> {
  return withMcpWriteLock(async () => {
    const report: XurlCredentialIntegrityReport = {
      activeProfiles: 0,
      orphanedProfilesRemoved: 0,
      unprovenProfilesPreserved: 0,
      errors: [],
    };
    const store = await loadStore();
    const activeHomes = new Set<string>();
    for (const server of store.servers) {
      const home = exactXurlCredentialHome(server);
      if (!home) continue;
      activeHomes.add(home);
      try {
        await ensureXurlCredentialHomeOwned(server);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/unmarked.*preserved/i.test(message)) report.unprovenProfilesPreserved += 1;
        else report.errors.push(`active profile ${path.basename(home)}: ${message}`);
      }
    }
    report.activeProfiles = activeHomes.size;
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(X_MCP_ROOT, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return report;
      report.errors.push(`credential root: ${error instanceof Error ? error.message : String(error)}`);
      return report;
    }
    for (const entry of entries) {
      const isProfile = X_MCP_PROFILE_PATTERN.test(entry.name);
      const isQuarantine = X_MCP_QUARANTINE_PATTERN.test(entry.name);
      if (!entry.isDirectory() || (!isProfile && !isQuarantine)) continue;
      const home = path.resolve(/* turbopackIgnore: true */ X_MCP_ROOT, entry.name);
      if (path.dirname(home) !== path.resolve(/* turbopackIgnore: true */ X_MCP_ROOT)
        || (isProfile && activeHomes.has(home))) continue;
      try {
        if (await removeOwnedXurlCredentialHome(home)) report.orphanedProfilesRemoved += 1;
        else report.unprovenProfilesPreserved += 1;
      } catch (error) {
        report.errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
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
