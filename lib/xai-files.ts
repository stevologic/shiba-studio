import { XAI_BASE } from './grok-client';

export interface XaiFileMeta {
  id: string;
  filename: string;
  bytes: number;
  created_at: number;
  expires_at?: number | null;
  purpose?: string;
  object?: string;
  public_url?: string | null;
  public_url_expires_at?: number | null;
}

export const XAI_CONSOLE_FILES_URL = 'https://console.x.ai/team/default/files';

/** xAI Files `expires_after` is 1 hour–30 days, measured from upload. */
export const XAI_FILE_EXPIRES_AFTER_MIN_SECONDS = 3_600;
export const XAI_FILE_EXPIRES_AFTER_MAX_SECONDS = 2_592_000;
/**
 * Safety-net TTL for ephemeral chat attachments. Shiba still tombstones
 * unreferenced chat files after a day; this only bounds abandoned xAI objects
 * if the coordinator never runs. Durable cloud-sync and entity snapshots stay
 * permanent.
 */
export const CHAT_FILE_EXPIRES_AFTER_SECONDS = XAI_FILE_EXPIRES_AFTER_MAX_SECONDS;

export interface XaiFileUploadOptions {
  expiresAfterSeconds?: number | null;
}

/** Clamp a Files API TTL, or omit it when the caller wants a permanent object. */
export function normalizeXaiFileExpiresAfter(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  const seconds = Math.round(n);
  if (seconds <= 0) return undefined;
  return Math.min(
    XAI_FILE_EXPIRES_AFTER_MAX_SECONDS,
    Math.max(XAI_FILE_EXPIRES_AFTER_MIN_SECONDS, seconds),
  );
}

export function isPublicUrlEligible(filename: string): boolean {
  return /\.(png|jpe?g|pdf|mp4)$/i.test(filename);
}

export function cloudFileViewUrl(fileId: string): string {
  return `/api/workspace/cloud-file?fileId=${encodeURIComponent(fileId)}`;
}

async function cloudFetch(url: string, init: RequestInit = {}, keyOverride?: string): Promise<Response> {
  const { fetchCloudWithAuth } = await import('./xai-oauth');
  return fetchCloudWithAuth(url, init, { keyOverride });
}

export async function listXaiFiles(keyOverride?: string): Promise<XaiFileMeta[]> {
  const all: XaiFileMeta[] = [];
  let token: string | undefined;
  const pageSize = 100;

  while (true) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      order: 'desc',
      sort_by: 'created_at',
    });
    if (token) params.set('pagination_token', token);

    const res = await cloudFetch(`${XAI_BASE}/files?${params}`, {}, keyOverride);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`xAI Files API ${res.status}: ${txt}`);
    }
    const data = await res.json();
    const page = (data.data || []) as XaiFileMeta[];
    all.push(...page);
    if (page.length < pageSize) break;
    token = data.pagination_token;
    if (!token) break;
  }

  return all;
}

export async function uploadXaiFile(
  filename: string,
  content: Buffer,
  keyOverride?: string,
  options?: XaiFileUploadOptions,
): Promise<XaiFileMeta> {
  const form = new FormData();
  // Purpose and TTL must precede the file part so xAI sees them on the same
  // multipart request (the SDK deepObject form is also order-sensitive).
  form.append('purpose', 'assistants');
  const expiresAfter = normalizeXaiFileExpiresAfter(options?.expiresAfterSeconds);
  if (expiresAfter != null) form.append('expires_after', String(expiresAfter));
  form.append('file', new Blob([new Uint8Array(content)]), filename);

  const res = await cloudFetch(`${XAI_BASE}/files`, {
    method: 'POST',
    body: form,
  }, keyOverride);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`xAI upload ${res.status}: ${txt}`);
  }
  return res.json();
}

export async function downloadXaiFileContent(fileId: string, keyOverride?: string): Promise<Buffer> {
  const res = await cloudFetch(`${XAI_BASE}/files/${fileId}/content`, {}, keyOverride);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`xAI download ${res.status}: ${txt}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function getXaiFileMeta(fileId: string): Promise<XaiFileMeta> {
  const res = await cloudFetch(`${XAI_BASE}/files/${fileId}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`xAI file meta ${res.status}: ${txt}`);
  }
  return res.json();
}

export async function createXaiPublicUrl(fileId: string): Promise<{ public_url?: string; expires_at?: number | null }> {
  const res = await cloudFetch(`${XAI_BASE}/files/${fileId}/public-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`xAI public URL ${res.status}: ${txt}`);
  }
  return res.json();
}

export async function resolveXaiFileLink(fileId: string, filename: string): Promise<string> {
  try {
    const meta = await getXaiFileMeta(fileId);
    if (meta.public_url) return meta.public_url;
  } catch {
    /* fall through */
  }
  if (isPublicUrlEligible(filename)) {
    try {
      const pub = await createXaiPublicUrl(fileId);
      if (pub.public_url) return pub.public_url;
    } catch {
      /* fall through */
    }
  }
  return cloudFileViewUrl(fileId);
}

export async function deleteXaiFile(fileId: string, keyOverride?: string): Promise<void> {
  const res = await cloudFetch(`${XAI_BASE}/files/${fileId}`, {
    method: 'DELETE',
  }, keyOverride);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`xAI delete ${res.status}: ${txt}`);
  }
}
