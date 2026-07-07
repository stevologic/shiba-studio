import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import { setApiKey } from './grok-client';
import { loadConfig } from './persistence';
import { resolveCloudBearer } from './xai-oauth';
import {
  cloudFileViewUrl,
  downloadXaiFileContent,
  listXaiFiles,
  resolveXaiFileLink,
  uploadXaiFile,
  XaiFileMeta,
} from './xai-files';
import {
  ensureDir,
  getGlobalUploadsDir,
  listGlobalUploadFiles,
  recordUploadMeta,
  sanitizeUploadName,
  sha256Checksum,
  writeBinaryFile,
} from './workspace';

const SYNC_FILE = dataDir('cloud-sync.json');

export interface CloudSyncEntry {
  localName: string;
  xaiFileId: string;
  bytes: number;
  syncedAt: string;
  localModifiedAt: string;
  /** CDN public URL when eligible; otherwise use cloudUrl from enrichment. */
  publicUrl?: string;
  cloudUrl?: string;
}

interface CloudSyncState {
  files: CloudSyncEntry[];
  lastSyncAt?: string;
}

async function loadState(): Promise<CloudSyncState> {
  try {
    const raw = await fs.readFile(SYNC_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { files: Array.isArray(parsed.files) ? parsed.files : [], lastSyncAt: parsed.lastSyncAt };
  } catch {
    return { files: [] };
  }
}

async function saveState(state: CloudSyncState) {
  await ensureDir(path.dirname(SYNC_FILE));
  await fs.writeFile(SYNC_FILE, JSON.stringify(state, null, 2));
}

export async function getCloudSyncEntries(): Promise<CloudSyncEntry[]> {
  return (await loadState()).files;
}

export async function removeCloudSyncByLocalName(localName: string): Promise<void> {
  const state = await loadState();
  const next = state.files.filter((f) => f.localName !== localName);
  if (next.length === state.files.length) return;
  state.files = next;
  await saveState(state);
}

export async function syncUploadToCloud(): Promise<{
  uploaded: string[];
  skipped: string[];
  errors: string[];
}> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) throw new Error('Cloud credentials required for cloud sync (API key or OAuth with X)');
  setApiKey(auth.token);

  const uploadsDir = await getGlobalUploadsDir();
  const localFiles = await listGlobalUploadFiles();
  const state = await loadState();
  const byName = new Map(state.files.map((f) => [f.localName, f]));

  const uploaded: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const file of localFiles) {
    const existing = byName.get(file.name);
    const mtime = new Date(file.modifiedAt).toISOString();
    if (existing && existing.localModifiedAt === mtime && existing.bytes === (file.size || 0)) {
      skipped.push(file.name);
      continue;
    }
    try {
      const buf = await fs.readFile(path.join(uploadsDir, file.name));
      const meta = await uploadXaiFile(file.name, buf);
      let publicUrl: string | undefined = meta.public_url || undefined;
      let cloudUrl: string | undefined;
      try {
        cloudUrl = await resolveXaiFileLink(meta.id, file.name);
        if (cloudUrl.startsWith('http')) publicUrl = cloudUrl;
      } catch {
        cloudUrl = cloudFileViewUrl(meta.id);
      }
      const entry: CloudSyncEntry = {
        localName: file.name,
        xaiFileId: meta.id,
        bytes: meta.bytes ?? buf.length,
        syncedAt: new Date().toISOString(),
        localModifiedAt: mtime,
        publicUrl,
        cloudUrl,
      };
      const idx = state.files.findIndex((f) => f.localName === file.name);
      if (idx >= 0) state.files[idx] = entry;
      else state.files.push(entry);
      uploaded.push(file.name);
    } catch (e: any) {
      errors.push(`${file.name}: ${e.message}`);
    }
  }

  state.lastSyncAt = new Date().toISOString();
  await saveState(state);
  return { uploaded, skipped, errors };
}

export async function syncDownloadFromCloud(): Promise<{
  downloaded: string[];
  skipped: string[];
  errors: string[];
}> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) throw new Error('Cloud credentials required for cloud sync (API key or OAuth with X)');
  setApiKey(auth.token);

  const uploadsDir = await getGlobalUploadsDir();
  const cloudFiles = await listXaiFiles();
  const state = await loadState();
  const byId = new Map(state.files.map((f) => [f.xaiFileId, f]));

  const downloaded: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const cloud of cloudFiles) {
    const name = sanitizeUploadName(cloud.filename || `file-${cloud.id}`);
    const localPath = path.join(uploadsDir, name);
    let localMtime = '';
    try {
      const st = await fs.stat(localPath);
      localMtime = st.mtime.toISOString();
    } catch {
      /* new file */
    }

    const mapped = byId.get(cloud.id);
    if (mapped && mapped.localModifiedAt === localMtime && mapped.bytes === cloud.bytes) {
      skipped.push(name);
      continue;
    }

    try {
      const buf = await downloadXaiFileContent(cloud.id);
      await writeBinaryFile(localPath, buf);
      const downloadedAt = new Date().toISOString();
      await recordUploadMeta(name, sha256Checksum(buf), downloadedAt);
      const st = await fs.stat(localPath);
      let cloudUrl = cloud.public_url || cloudFileViewUrl(cloud.id);
      if (!cloud.public_url) {
        try {
          cloudUrl = await resolveXaiFileLink(cloud.id, name);
        } catch {
          cloudUrl = cloudFileViewUrl(cloud.id);
        }
      }
      const entry: CloudSyncEntry = {
        localName: name,
        xaiFileId: cloud.id,
        bytes: cloud.bytes ?? buf.length,
        syncedAt: new Date().toISOString(),
        localModifiedAt: st.mtime.toISOString(),
        publicUrl: cloud.public_url || (cloudUrl.startsWith('http') ? cloudUrl : undefined),
        cloudUrl,
      };
      const idx = state.files.findIndex((f) => f.xaiFileId === cloud.id || f.localName === name);
      if (idx >= 0) state.files[idx] = entry;
      else state.files.push(entry);
      downloaded.push(name);
    } catch (e: any) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  state.lastSyncAt = new Date().toISOString();
  await saveState(state);
  return { downloaded, skipped, errors };
}

export function enrichCloudSyncEntry(entry: CloudSyncEntry): CloudSyncEntry & { url: string } {
  return {
    ...entry,
    cloudUrl: entry.cloudUrl || entry.publicUrl || cloudFileViewUrl(entry.xaiFileId),
    url: entry.publicUrl || entry.cloudUrl || cloudFileViewUrl(entry.xaiFileId),
  };
}

export async function listCloudFilesPreview(): Promise<XaiFileMeta[]> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) return [];
  setApiKey(auth.token);
  return listXaiFiles();
}