import { randomUUID } from 'crypto';
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

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

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

const cloudSyncLockGlobal = globalThis as typeof globalThis & {
  __shibaCloudSyncChain?: Promise<unknown>;
};

function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = cloudSyncLockGlobal.__shibaCloudSyncChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  cloudSyncLockGlobal.__shibaCloudSyncChain = run.then(() => undefined, () => undefined);
  return run;
}

async function loadStateUnlocked(): Promise<CloudSyncState> {
  try {
    const raw = await fs.readFile(SYNC_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as CloudSyncState).files)) {
      throw new Error('Invalid cloud sync store: expected an object with a files array');
    }
    const state = parsed as CloudSyncState;
    return { files: state.files, lastSyncAt: state.lastSyncAt };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return { files: [] };
  }
}

async function saveStateUnlocked(state: CloudSyncState): Promise<void> {
  await ensureDir(path.dirname(SYNC_FILE));
  const tmp = `${SYNC_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, SYNC_FILE);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function mutateState(mutate: (state: CloudSyncState) => void | Promise<void>): Promise<void> {
  return withStateLock(async () => {
    const state = await loadStateUnlocked();
    await mutate(state);
    await saveStateUnlocked(state);
  });
}

export async function getCloudSyncEntries(): Promise<CloudSyncEntry[]> {
  return withStateLock(async () => (await loadStateUnlocked()).files);
}

export async function removeCloudSyncByLocalName(localName: string): Promise<void> {
  await mutateState((state) => {
    state.files = state.files.filter((f) => f.localName !== localName);
  });
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
  const state = await withStateLock(loadStateUnlocked);
  const byName = new Map(state.files.map((f) => [f.localName, f]));

  const uploaded: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const syncedEntries: CloudSyncEntry[] = [];

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
      syncedEntries.push(entry);
      uploaded.push(file.name);
    } catch (e) {
      errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await mutateState((current) => {
    for (const entry of syncedEntries) {
      const idx = current.files.findIndex((f) => f.localName === entry.localName);
      if (idx >= 0) current.files[idx] = entry;
      else current.files.push(entry);
    }
    current.lastSyncAt = new Date().toISOString();
  });
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
  const state = await withStateLock(loadStateUnlocked);
  const byId = new Map(state.files.map((f) => [f.xaiFileId, f]));

  const downloaded: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const syncedEntries: CloudSyncEntry[] = [];

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
      syncedEntries.push(entry);
      downloaded.push(name);
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await mutateState((current) => {
    for (const entry of syncedEntries) {
      const idx = current.files.findIndex(
        (f) => f.xaiFileId === entry.xaiFileId || f.localName === entry.localName,
      );
      if (idx >= 0) current.files[idx] = entry;
      else current.files.push(entry);
    }
    current.lastSyncAt = new Date().toISOString();
  });
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
