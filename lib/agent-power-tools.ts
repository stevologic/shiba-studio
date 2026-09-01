// Industry-standard agent abilities beyond the original toolbelt:
// web research (fetch + search), workspace-wide code search, persistent
// per-agent memory (SQLite), and xAI image generation.

import * as fs from 'fs/promises';
import { clipForModel } from './prompt-hygiene';
import path from 'path';
import { recallMemories, saveMemory, type AgentMemoryEntry } from './agent-memory';

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
    return { url: res.url, status: res.status, text: clipForModel(body, TEXT_CAP) };
  }
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  return { url: res.url, status: res.status, title, text: clipForModel(htmlToText(body), TEXT_CAP) };
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

export type { AgentMemoryEntry } from './agent-memory';

export function memorySave(agentId: string, key: string, content: string): AgentMemoryEntry {
  return saveMemory(agentId, key, content, { source: 'tool' }).entry;
}

export function memoryRecall(agentId: string, query?: string): AgentMemoryEntry[] {
  return recallMemories(agentId, query);
}

/* ── xAI image generation (Grok Imagine) ──────────────────────────────── */

/** Preferred Imagine image models, then the legacy grok-2-image fallback. */
export const XAI_IMAGINE_IMAGE_MODELS = [
  'grok-imagine-image-1.5',
  'grok-imagine-image',
  'grok-imagine-image-2.0',
  'grok-2-image',
] as const;

export const XAI_IMAGINE_IMAGE_MODEL = XAI_IMAGINE_IMAGE_MODELS[0];

export interface XaiImageGenerateOptions {
  aspectRatio?: string;
  n?: number;
  models?: string[];
  signal?: AbortSignal;
}

export interface XaiGeneratedImage {
  b64: string;
  mimeType: string;
  revisedPrompt?: string;
  model: string;
}

function clipApiError(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Call xAI `/v1/images/generations`. Tries Imagine 1.5 first, then other
 * Imagine image ids, then grok-2-image if the account has not rolled forward.
 */
export async function generateXaiImage(
  prompt: string,
  bearer: string,
  options?: XaiImageGenerateOptions,
): Promise<XaiGeneratedImage> {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Image prompt is required');
  const models = (options?.models?.length ? options.models : [...XAI_IMAGINE_IMAGE_MODELS])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (!models.length) throw new Error('No image models to try');

  let lastError: Error | null = null;
  for (const model of models) {
    const body: Record<string, unknown> = {
      model,
      prompt: text,
      n: options?.n ?? 1,
      response_format: 'b64_json',
    };
    if (options?.aspectRatio && !model.startsWith('grok-2-image')) {
      body.aspect_ratio = options.aspectRatio;
    }
    const res = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      signal: options?.signal || AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json() as {
        data?: Array<{ b64_json?: string; url?: string; mime_type?: string; revised_prompt?: string }>;
      };
      const first = data?.data?.[0];
      const b64 = first?.b64_json;
      if (!b64) {
        lastError = new Error('xAI returned no image data');
        continue;
      }
      return {
        b64,
        mimeType: first?.mime_type || 'image/jpeg',
        revisedPrompt: first?.revised_prompt,
        model,
      };
    }
    const detail = clipApiError(await res.text().catch(() => ''));
    lastError = new Error(`xAI image generation failed (${res.status}${detail ? `: ${detail}` : ''})`);
    if (res.status === 401 || res.status === 403) throw lastError;
    const unknownModel = res.status === 404
      || res.status === 422
      || /unknown model|model_not_found|does not exist|not found/i.test(detail);
    if (!unknownModel && res.status !== 400) throw lastError;
  }
  throw lastError || new Error('xAI image generation failed');
}

export async function generateImage(
  prompt: string,
  bearer: string,
  workDir: string,
  options?: XaiImageGenerateOptions,
): Promise<{ path: string; revisedPrompt?: string; dataUrl: string; model: string }> {
  const generated = await generateXaiImage(prompt, bearer, options);
  const dir = path.join(workDir, 'generated-images');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `img-${Date.now()}.jpg`);
  await fs.writeFile(file, Buffer.from(generated.b64, 'base64'));
  return {
    path: file,
    revisedPrompt: generated.revisedPrompt,
    dataUrl: `data:${generated.mimeType};base64,${generated.b64}`,
    model: generated.model,
  };
}

/** Portrait framing for agent avatars. The caller's description stays intact. */
export function buildAvatarImaginePrompt(input: {
  prompt?: string;
  name?: string;
  description?: string;
}): string {
  const user = String(input.prompt || '').trim();
  if (user) {
    return [
      'Square head-and-shoulders portrait for a software-agent avatar.',
      user,
      'Facing the camera, centered, no text, no watermark, no UI chrome.',
    ].join(' ');
  }
  const who = String(input.name || '').trim() || 'a studio agent';
  const focus = String(input.description || '').trim();
  return [
    `Square head-and-shoulders portrait of ${who}, a Grok-powered studio agent.`,
    focus ? `Personality: ${focus}.` : 'Helpful, focused, and slightly futuristic.',
    'Facing the camera, centered, cinematic lighting, no text, no watermark.',
  ].join(' ');
}
