// Obsidian integration — local vault filesystem or cloud/remote REST API
// (Obsidian Local REST API plugin: https://github.com/coddingtonbear/obsidian-local-rest-api)

import * as fs from 'fs/promises';
import * as path from 'path';
import type { IntegrationCreds } from './types';

export type ObsidianMode = 'local' | 'cloud';

export interface ObsidianConfig {
  mode: ObsidianMode;
  vaultPath?: string;
  restApiUrl?: string;
  restApiKey?: string;
}

const DEFAULT_LOCAL_REST = 'http://127.0.0.1:27123';

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function getObsidianConfig(creds: IntegrationCreds): ObsidianConfig | null {
  const o = creds.obsidian;
  if (!o) return null;
  const mode: ObsidianMode = o.mode === 'cloud' ? 'cloud' : 'local';
  const vaultPath = o.vaultPath?.trim();
  const restApiUrl = o.restApiUrl?.trim();
  const restApiKey = o.restApiKey?.trim();
  if (mode === 'cloud' && (!restApiUrl || !restApiKey)) return null;
  if (mode === 'local' && !vaultPath && !restApiUrl) return null;
  return { mode, vaultPath, restApiUrl, restApiKey };
}

function resolveVaultPath(vaultPath: string, notePath: string): string {
  const vault = path.resolve(vaultPath);
  const resolved = path.resolve(vault, notePath.replace(/^\/+/, ''));
  if (resolved !== vault && !resolved.startsWith(vault + path.sep)) {
    throw new Error('Note path escapes vault boundary');
  }
  return resolved;
}

async function obsidianFetch(url: string, init: RequestInit & { skipTlsVerify?: boolean } = {}): Promise<Response> {
  const { skipTlsVerify, ...rest } = init;
  const opts: RequestInit = { ...rest, signal: AbortSignal.timeout(20_000) };
  if (skipTlsVerify && url.startsWith('https://')) {
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      return await fetch(url, opts);
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
  return fetch(url, opts);
}

function restHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function restListDir(base: string, apiKey: string, sub = ''): Promise<string[]> {
  const segment = sub ? `/${encodeURI(sub.replace(/^\/+/, ''))}` : '/';
  const res = await obsidianFetch(`${base}/vault${segment}`, {
    headers: restHeaders(apiKey),
    skipTlsVerify: true,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Obsidian REST ${res.status}: ${txt}`);
  }
  const data = await res.json();
  if (Array.isArray(data)) return data.map(String);
  if (Array.isArray(data.files)) return data.files.map(String);
  if (Array.isArray(data.entries)) return data.entries.map((e: { path?: string; name?: string }) => e.path || e.name || '');
  return [];
}

async function restReadNote(base: string, apiKey: string, notePath: string): Promise<string> {
  const res = await obsidianFetch(`${base}/vault/${encodeURI(notePath.replace(/^\/+/, ''))}`, {
    headers: restHeaders(apiKey),
    skipTlsVerify: true,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Obsidian REST read ${res.status}: ${txt}`);
  }
  return res.text();
}

async function restWriteNote(base: string, apiKey: string, notePath: string, content: string): Promise<void> {
  const res = await obsidianFetch(`${base}/vault/${encodeURI(notePath.replace(/^\/+/, ''))}`, {
    method: 'PUT',
    headers: { ...restHeaders(apiKey), 'Content-Type': 'text/markdown' },
    body: content,
    skipTlsVerify: true,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Obsidian REST write ${res.status}: ${txt}`);
  }
}

async function restSearch(base: string, apiKey: string, query: string): Promise<{ path: string; snippet?: string }[]> {
  const params = new URLSearchParams({ query });
  const res = await obsidianFetch(`${base}/search/simple/?${params}`, {
    method: 'POST',
    headers: restHeaders(apiKey),
    skipTlsVerify: true,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Obsidian REST search ${res.status}: ${txt}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((item: { filename?: string; path?: string; snippet?: string; content?: string }) => ({
    path: item.filename || item.path || '',
    snippet: item.snippet || item.content,
  })).filter((r) => r.path);
}

async function walkVaultMd(vaultPath: string, subdir = '', max = 80): Promise<{ path: string; name: string }[]> {
  const results: { path: string; name: string }[] = [];
  const dir = subdir ? path.join(vaultPath, subdir) : vaultPath;

  async function walk(rel: string) {
    if (results.length >= max) return;
    const abs = path.join(vaultPath, rel);
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (results.length >= max) break;
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(relPath);
      else if (ent.name.endsWith('.md')) {
        results.push({ path: relPath.replace(/\\/g, '/'), name: ent.name });
      }
    }
  }

  await walk(subdir);
  return results;
}

function useRest(cfg: ObsidianConfig): { base: string; apiKey: string } | null {
  const apiKey = cfg.restApiKey?.trim();
  if (!apiKey) return null;
  const base = normalizeBase(cfg.restApiUrl || (cfg.mode === 'local' ? DEFAULT_LOCAL_REST : ''));
  if (!base) return null;
  return { base, apiKey };
}

export async function testObsidian(creds: IntegrationCreds): Promise<{
  ok: boolean;
  mode?: ObsidianMode;
  vaultPath?: string;
  noteCount?: number;
  restApi?: string;
  error?: string;
}> {
  const cfg = getObsidianConfig(creds);
  if (!cfg) {
    return {
      ok: false,
      error: creds.obsidian?.mode === 'cloud'
        ? 'Cloud mode requires REST API URL and API key'
        : 'Configure a local vault path and/or Local REST API URL + key',
    };
  }

  const errors: string[] = [];
  let noteCount = 0;
  let vaultOk = false;
  let restOk = false;
  let restBase: string | undefined;

  if (cfg.mode === 'local' && cfg.vaultPath) {
    try {
      const vault = path.resolve(cfg.vaultPath);
      await fs.access(vault);
      const notes = await walkVaultMd(vault, '', 500);
      noteCount = notes.length;
      vaultOk = true;
    } catch (e: unknown) {
      errors.push(e instanceof Error ? e.message : 'Vault path not accessible');
    }
  }

  const rest = useRest(cfg);
  if (rest) {
    try {
      const ping = await obsidianFetch(`${rest.base}/`, { skipTlsVerify: true });
      if (!ping.ok && ping.status !== 401) {
        throw new Error(`REST ping ${ping.status}`);
      }
      const listed = await restListDir(rest.base, rest.apiKey, '');
      restOk = true;
      restBase = rest.base;
      if (!vaultOk) noteCount = listed.filter((f) => f.endsWith('.md')).length;
    } catch (e: unknown) {
      errors.push(`REST API: ${e instanceof Error ? e.message : 'unreachable'}`);
    }
  }

  if (cfg.mode === 'cloud' && !restOk) {
    return { ok: false, mode: 'cloud', error: errors.join('; ') || 'Cloud REST API unreachable' };
  }

  if (cfg.mode === 'local' && !vaultOk && !restOk) {
    return { ok: false, mode: 'local', error: errors.join('; ') || 'Local vault and REST API both failed' };
  }

  return {
    ok: true,
    mode: cfg.mode,
    vaultPath: vaultOk ? path.resolve(cfg.vaultPath!) : undefined,
    noteCount,
    restApi: restBase,
  };
}

export async function obsidianListNotes(
  creds: IntegrationCreds,
  dir = '',
  max = 40,
): Promise<{ path: string; name: string }[]> {
  const cfg = getObsidianConfig(creds);
  if (!cfg) throw new Error('Obsidian not configured');

  const rest = useRest(cfg);
  if (rest) {
    const files = await restListDir(rest.base, rest.apiKey, dir);
    return files
      .filter((f) => f.endsWith('.md') || !f.includes('.'))
      .slice(0, max)
      .map((f) => ({ path: f.replace(/\\/g, '/'), name: path.basename(f) }));
  }

  if (cfg.mode === 'local' && cfg.vaultPath) {
    return walkVaultMd(path.resolve(cfg.vaultPath), dir, max);
  }

  throw new Error('Obsidian not configured for listing');
}

export async function obsidianReadNote(creds: IntegrationCreds, notePath: string): Promise<string> {
  const cfg = getObsidianConfig(creds);
  if (!cfg) throw new Error('Obsidian not configured');

  const rest = useRest(cfg);
  if (rest) return restReadNote(rest.base, rest.apiKey, notePath);

  if (cfg.mode === 'local' && cfg.vaultPath) {
    const abs = resolveVaultPath(cfg.vaultPath, notePath);
    return fs.readFile(abs, 'utf8');
  }

  throw new Error('Obsidian not configured for read');
}

export async function obsidianWriteNote(creds: IntegrationCreds, notePath: string, content: string): Promise<void> {
  const cfg = getObsidianConfig(creds);
  if (!cfg) throw new Error('Obsidian not configured');

  const rest = useRest(cfg);
  if (rest) {
    await restWriteNote(rest.base, rest.apiKey, notePath, content);
    return;
  }

  if (cfg.mode === 'local' && cfg.vaultPath) {
    const abs = resolveVaultPath(cfg.vaultPath, notePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return;
  }

  throw new Error('Obsidian not configured for write');
}

export async function obsidianSearch(
  creds: IntegrationCreds,
  query: string,
): Promise<{ path: string; snippet?: string }[]> {
  const cfg = getObsidianConfig(creds);
  if (!cfg) throw new Error('Obsidian not configured');

  const rest = useRest(cfg);
  if (rest) return restSearch(rest.base, rest.apiKey, query);

  if (cfg.mode === 'local' && cfg.vaultPath) {
    const notes = await walkVaultMd(path.resolve(cfg.vaultPath), '', 200);
    const q = query.toLowerCase();
    const hits: { path: string; snippet?: string }[] = [];
    for (const note of notes) {
      if (hits.length >= 30) break;
      try {
        const abs = resolveVaultPath(cfg.vaultPath, note.path);
        const text = await fs.readFile(abs, 'utf8');
        const idx = text.toLowerCase().indexOf(q);
        if (idx >= 0 || note.path.toLowerCase().includes(q) || note.name.toLowerCase().includes(q)) {
          const start = Math.max(0, idx - 40);
          hits.push({
            path: note.path,
            snippet: idx >= 0 ? text.slice(start, start + 120).replace(/\s+/g, ' ') : note.name,
          });
        }
      } catch {
        /* skip */
      }
    }
    return hits;
  }

  throw new Error('Obsidian not configured for search');
}