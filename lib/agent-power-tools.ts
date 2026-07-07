// Industry-standard agent abilities beyond the original toolbelt:
// web research (fetch + search), workspace-wide code search, persistent
// per-agent memory (SQLite), and xAI image generation.

import * as fs from 'fs/promises';
import path from 'path';
import { getDb } from './db';

const FETCH_TIMEOUT_MS = 15_000;
const TEXT_CAP = 20_000;
const USER_AGENT = 'ShibaStudio/0.1 (localhost agent; +https://github.com)';

/* ── Web research ─────────────────────────────────────────────────────── */

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export async function webFetch(rawUrl: string): Promise<{ url: string; status: number; title?: string; text: string }> {
  const url = new URL(String(rawUrl || ''));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported');
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json,text/plain,*/*' },
  });
  const contentType = res.headers.get('content-type') || '';
  const body = await res.text();
  if (!contentType.includes('html')) {
    return { url: res.url, status: res.status, text: body.slice(0, TEXT_CAP) };
  }
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  return { url: res.url, status: res.status, title, text: htmlToText(body).slice(0, TEXT_CAP) };
}

export interface WebSearchResult { title: string; url: string; snippet: string }

/** Keyless web search via DuckDuckGo's HTML endpoint. */
export async function webSearch(query: string, maxResults = 6): Promise<WebSearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`Search request failed (${res.status})`);
  const html = await res.text();

  const results: WebSearchResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(htmlToText(m[1]));
  }
  let i = 0;
  for (let m = linkRe.exec(html); m && results.length < maxResults; m = linkRe.exec(html), i++) {
    let target = m[1];
    // DDG wraps targets: //duckduckgo.com/l/?uddg=<encoded>&rut=…
    const uddg = target.match(/[?&]uddg=([^&]+)/)?.[1];
    if (uddg) {
      try { target = decodeURIComponent(uddg); } catch { /* keep wrapped */ }
    }
    if (target.startsWith('//')) target = `https:${target}`;
    results.push({ title: htmlToText(m[2]), url: target, snippet: snippets[i] || '' });
  }
  return results;
}

/* ── Workspace search ─────────────────────────────────────────────────── */

const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo', 'coverage']);
const SEARCH_MAX_FILE_BYTES = 512 * 1024;
const SEARCH_MAX_MATCHES = 40;

export interface FsSearchMatch { file: string; line: number; text: string }

export async function fsSearch(workDir: string, pattern: string, subDir?: string): Promise<FsSearchMatch[]> {
  const needle = String(pattern || '').toLowerCase();
  if (!needle) throw new Error('pattern is required');
  const root = subDir ? path.resolve(workDir, subDir) : workDir;
  const matches: FsSearchMatch[] = [];

  async function walk(dir: string): Promise<void> {
    if (matches.length >= SEARCH_MAX_MATCHES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= SEARCH_MAX_MATCHES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(full);
        if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
        const content = await fs.readFile(full, 'utf8');
        if (content.includes('\u0000')) continue; // binary
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && matches.length < SEARCH_MAX_MATCHES; i++) {
          if (lines[i].toLowerCase().includes(needle)) {
            matches.push({
              file: path.relative(workDir, full) || entry.name,
              line: i + 1,
              text: lines[i].trim().slice(0, 240),
            });
          }
        }
      } catch {
        /* unreadable file — skip */
      }
    }
  }

  await walk(root);
  return matches;
}

/* ── Persistent per-agent memory ──────────────────────────────────────── */

function memoryDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(agentId, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agentId, updatedAt DESC);
  `);
  return db;
}

export interface AgentMemoryEntry { key: string; content: string; updatedAt: string }

export function memorySave(agentId: string, key: string, content: string): AgentMemoryEntry {
  const k = String(key || '').trim().slice(0, 120);
  if (!k) throw new Error('memory key is required');
  const entry = { key: k, content: String(content || '').slice(0, 8000), updatedAt: new Date().toISOString() };
  memoryDb()
    .prepare(`
      INSERT INTO agent_memory (agentId, key, content, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(agentId, key) DO UPDATE SET content = excluded.content, updatedAt = excluded.updatedAt
    `)
    .run(agentId, entry.key, entry.content, entry.updatedAt);
  return entry;
}

export function memoryRecall(agentId: string, query?: string): AgentMemoryEntry[] {
  const rows = memoryDb()
    .prepare('SELECT key, content, updatedAt FROM agent_memory WHERE agentId = ? ORDER BY updatedAt DESC LIMIT 50')
    .all(agentId) as unknown as AgentMemoryEntry[];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.key.toLowerCase().includes(q) || r.content.toLowerCase().includes(q));
}

/* ── xAI image generation ─────────────────────────────────────────────── */

const XAI_IMAGE_MODEL = 'grok-2-image';

export async function generateImage(
  prompt: string,
  bearer: string,
  workDir: string,
): Promise<{ path: string; revisedPrompt?: string; dataUrl: string }> {
  const res = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ model: XAI_IMAGE_MODEL, prompt: String(prompt || ''), n: 1, response_format: 'b64_json' }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`xAI image generation failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const first = data?.data?.[0];
  const b64: string | undefined = first?.b64_json;
  if (!b64) throw new Error('xAI returned no image data');

  const dir = path.join(workDir, 'generated-images');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `img-${Date.now()}.jpg`);
  await fs.writeFile(file, Buffer.from(b64, 'base64'));
  return {
    path: file,
    revisedPrompt: first?.revised_prompt,
    dataUrl: `data:image/jpeg;base64,${b64}`,
  };
}
