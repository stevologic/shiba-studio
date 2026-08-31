/**
 * Pure xAI Imagine HTTP clients: image edit and video generation.
 * Tests inject `fetch` / `sleep`; production uses the global fetch.
 */
import * as fs from 'fs/promises';
import path from 'path';

export const XAI_IMAGINE_EDIT_URL = 'https://api.x.ai/v1/images/edits';
export const XAI_IMAGINE_VIDEO_URL = 'https://api.x.ai/v1/videos/generations';
export const XAI_IMAGINE_VIDEO_GET_URL = 'https://api.x.ai/v1/videos';

export const XAI_IMAGINE_EDIT_MODELS = [
  'grok-imagine-image-2.0',
  'grok-imagine-image',
  'grok-imagine-image-1.5',
] as const;

export const XAI_IMAGINE_VIDEO_MODELS = [
  'grok-imagine-video-1.5',
  'grok-imagine-video',
] as const;

const IMAGE_CAP_BYTES = 20 * 1024 * 1024;
const VIDEO_POLL_INTERVAL_MS = 2_500;
const VIDEO_POLL_MAX_MS = 180_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface XaiImagineHttpOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

function clipApiError(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function requireBearer(bearer: string, action: string): string {
  const token = String(bearer || '').trim();
  if (!token) {
    throw new Error(`${action} needs cloud xAI credentials (API key or OAuth) — configure them in Settings.`);
  }
  return token;
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

export function imageDataUri(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

export async function readWorkspaceImageDataUri(filePath: string): Promise<{ dataUri: string; mimeType: string }> {
  const resolved = path.resolve(String(filePath || ''));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Image file not found: ${filePath}`);
  if (stat.size > IMAGE_CAP_BYTES) throw new Error('Image is larger than 20 MiB');
  const mimeType = mimeFromExt(resolved);
  const bytes = await fs.readFile(resolved);
  return { dataUri: imageDataUri(bytes, mimeType), mimeType };
}

export interface XaiEditedImage {
  b64: string;
  mimeType: string;
  revisedPrompt?: string;
  model: string;
}

export interface EditXaiImageInput {
  prompt: string;
  image: { url: string; type?: string };
  models?: string[];
  n?: number;
}

export async function editXaiImage(
  input: EditXaiImageInput,
  bearer: string,
  options?: XaiImagineHttpOptions,
): Promise<XaiEditedImage> {
  const token = requireBearer(bearer, 'Image edit');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('Image edit prompt is required');
  const imageUrl = String(input.image?.url || '').trim();
  if (!imageUrl) throw new Error('Image edit requires a source image');
  const models = (input.models?.length ? input.models : [...XAI_IMAGINE_EDIT_MODELS])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const doFetch = options?.fetch || fetch;

  let lastError: Error | null = null;
  for (const model of models) {
    const res = await doFetch(XAI_IMAGINE_EDIT_URL, {
      method: 'POST',
      signal: options?.signal || AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model,
        prompt,
        n: input.n ?? 1,
        response_format: 'b64_json',
        image: { url: imageUrl, type: input.image.type || 'image_url' },
      }),
    });
    if (res.ok) {
      const data = await res.json() as {
        data?: Array<{ b64_json?: string; url?: string; mime_type?: string; revised_prompt?: string }>;
      };
      const first = data?.data?.[0];
      const b64 = first?.b64_json;
      if (!b64) {
        lastError = new Error('xAI returned no edited image data');
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
    lastError = new Error(`xAI image edit failed (${res.status}${detail ? `: ${detail}` : ''})`);
    if (res.status === 401 || res.status === 403) throw lastError;
    const unknownModel = res.status === 404
      || res.status === 422
      || /unknown model|model_not_found|does not exist|not found/i.test(detail);
    if (!unknownModel && res.status !== 400) throw lastError;
  }
  throw lastError || new Error('xAI image edit failed');
}

export type XaiVideoStatus = 'pending' | 'done' | 'failed' | 'expired';

export interface XaiGeneratedVideo {
  url: string;
  requestId: string;
  model: string;
  status: 'done';
}

export interface GenerateXaiVideoInput {
  prompt: string;
  imageUrl?: string;
  duration?: number;
  resolution?: string;
  models?: string[];
}

export interface GenerateXaiVideoOptions extends XaiImagineHttpOptions {
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}

function normalizeVideoStatus(raw: unknown): XaiVideoStatus | string {
  const status = String(raw || '').trim().toLowerCase();
  return status;
}

function videoUrlFromPayload(data: Record<string, unknown>): string {
  const video = (data.video && typeof data.video === 'object') ? data.video as Record<string, unknown> : data;
  const url = video.url || video.uri || data.url;
  return typeof url === 'string' ? url.trim() : '';
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function clampVideoDuration(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 6;
  return Math.min(15, Math.max(1, Math.round(n)));
}

export async function generateXaiVideo(
  input: GenerateXaiVideoInput,
  bearer: string,
  options?: GenerateXaiVideoOptions,
): Promise<XaiGeneratedVideo> {
  const token = requireBearer(bearer, 'Video generation');
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('Video prompt is required');
  const models = (input.models?.length ? input.models : [...XAI_IMAGINE_VIDEO_MODELS])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const doFetch = options?.fetch || fetch;
  const sleep = options?.sleep || defaultSleep;
  const intervalMs = Math.max(0, options?.intervalMs ?? VIDEO_POLL_INTERVAL_MS);
  const maxWaitMs = Math.max(1, options?.maxWaitMs ?? VIDEO_POLL_MAX_MS);
  const now = options?.now || Date.now;
  const duration = clampVideoDuration(input.duration);

  let lastError: Error | null = null;
  for (const model of models) {
    const body: Record<string, unknown> = { model, prompt, duration };
    if (input.imageUrl) body.image = { url: input.imageUrl };
    if (input.resolution) body.resolution = input.resolution;
    const started = await doFetch(XAI_IMAGINE_VIDEO_URL, {
      method: 'POST',
      signal: options?.signal || AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (started.status === 401 || started.status === 403) {
      const detail = clipApiError(await started.text().catch(() => ''));
      throw new Error(`xAI video generation failed (${started.status}${detail ? `: ${detail}` : ''})`);
    }
    if (!started.ok) {
      const detail = clipApiError(await started.text().catch(() => ''));
      lastError = new Error(`xAI video generation failed (${started.status}${detail ? `: ${detail}` : ''})`);
      const unknownModel = started.status === 404
        || started.status === 422
        || /unknown model|model_not_found|does not exist|not found/i.test(detail);
      if (!unknownModel && started.status !== 400) throw lastError;
      continue;
    }
    const startedJson = await started.json() as Record<string, unknown>;
    const requestId = String(startedJson.request_id || startedJson.id || '').trim();
    if (!requestId) {
      lastError = new Error('xAI video generation returned no request id');
      continue;
    }

    const deadline = now() + maxWaitMs;
    while (now() <= deadline) {
      const poll = await doFetch(`${XAI_IMAGINE_VIDEO_GET_URL}/${encodeURIComponent(requestId)}`, {
        method: 'GET',
        signal: options?.signal || AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}` },
      });
      if (poll.status === 401 || poll.status === 403) {
        const detail = clipApiError(await poll.text().catch(() => ''));
        throw new Error(`xAI video poll failed (${poll.status}${detail ? `: ${detail}` : ''})`);
      }
      if (!poll.ok && poll.status !== 202) {
        const detail = clipApiError(await poll.text().catch(() => ''));
        throw new Error(`xAI video poll failed (${poll.status}${detail ? `: ${detail}` : ''})`);
      }
      const payload = poll.ok ? await poll.json() as Record<string, unknown> : { status: 'pending' };
      const status = normalizeVideoStatus(payload.status || (poll.status === 202 ? 'pending' : ''));
      if (status === 'done' || status === 'completed' || status === 'succeeded') {
        const url = videoUrlFromPayload(payload);
        if (!url) throw new Error('xAI video generation finished without a video URL');
        return { url, requestId, model, status: 'done' };
      }
      if (status === 'failed' || status === 'expired' || status === 'error') {
        const detail = clipApiError(String(payload.error || payload.message || status));
        throw new Error(`xAI video generation ${status}${detail ? `: ${detail}` : ''}`);
      }
      if (now() + intervalMs > deadline) break;
      await sleep(intervalMs);
    }
    throw new Error('xAI video generation timed out before the video was ready');
  }
  throw lastError || new Error('xAI video generation failed');
}

export async function saveEditedImage(
  workDir: string,
  generated: XaiEditedImage,
): Promise<{ path: string; dataUrl: string; model: string; revisedPrompt?: string }> {
  const dir = path.join(workDir, 'generated-images');
  await fs.mkdir(dir, { recursive: true });
  const ext = generated.mimeType.includes('png') ? 'png' : 'jpg';
  const file = path.join(dir, `edit-${Date.now()}.${ext}`);
  await fs.writeFile(file, Buffer.from(generated.b64, 'base64'));
  return {
    path: file,
    dataUrl: `data:${generated.mimeType};base64,${generated.b64}`,
    model: generated.model,
    revisedPrompt: generated.revisedPrompt,
  };
}

export async function saveGeneratedVideo(
  workDir: string,
  generated: XaiGeneratedVideo,
  options?: { fetch?: FetchLike; signal?: AbortSignal },
): Promise<{ path: string; url: string; model: string }> {
  const dir = path.join(workDir, 'generated-videos');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `vid-${Date.now()}.mp4`);
  const doFetch = options?.fetch || fetch;
  const res = await doFetch(generated.url, { signal: options?.signal || AbortSignal.timeout(120_000) });
  if (!res.ok) {
    throw new Error(`Could not download generated video (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Downloaded video was empty');
  await fs.writeFile(file, buf);
  return { path: file, url: generated.url, model: generated.model };
}
