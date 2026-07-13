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

export async function uploadXaiFile(filename: string, content: Buffer, keyOverride?: string): Promise<XaiFileMeta> {
  const form = new FormData();
  form.append('purpose', 'assistants');
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
