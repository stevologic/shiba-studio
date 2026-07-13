import { randomUUID } from 'crypto';
import path from 'path';
import { dataDir } from './data-paths';
import { setApiKey } from './grok-client';
import { loadConfig } from './persistence';
import { resolveCloudBearer } from './xai-oauth';
import {
  cloudFileViewUrl,
  deleteXaiFile,
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
  deleteGlobalUploadFile,
} from './workspace';
import { recordManagedStorageIssue } from './managed-storage-quarantine';

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
  /** Durable ownership tombstone until the remote object is confirmed gone. */
  deletionRequestedAt?: string;
  deletionAttempts?: number;
  deletionError?: string;
  /** Explicitly remote-only until the local upload is restored or deleted. */
  localMissingAt?: string;
  /** First authoritative inventory that could not find this remote id. */
  remoteMissingAt?: string;
}

interface CloudSyncUploadIntent {
  id: string;
  localName: string;
  bytes: number;
  localModifiedAt: string;
  /** Cryptographic identity of the exact bytes submitted to xAI. */
  sha256?: string;
  startedAt: string;
  previousFileIds: string[];
  attempts: number;
  lastError?: string;
  retrySafe?: boolean;
}

interface CloudSyncDeletionIntent {
  localName: string;
  requestedAt: string;
  lastError?: string;
}

interface CloudSyncDownloadIntent {
  id: string;
  xaiFileId: string;
  localName: string;
  startedAt: string;
}

interface CloudSyncState {
  files: CloudSyncEntry[];
  uploadIntents?: CloudSyncUploadIntent[];
  deletionIntents?: CloudSyncDeletionIntent[];
  downloadIntents?: CloudSyncDownloadIntent[];
  lastSyncAt?: string;
}

function isCloudSyncEntry(value: unknown): value is CloudSyncEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<CloudSyncEntry>;
  return typeof entry.xaiFileId === 'string' && /^[A-Za-z0-9._:-]{1,300}$/.test(entry.xaiFileId)
    && typeof entry.localName === 'string' && sanitizeUploadName(entry.localName) === entry.localName;
}

function isCloudUploadIntent(value: unknown): value is CloudSyncUploadIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Partial<CloudSyncUploadIntent>;
  return typeof intent.id === 'string' && intent.id.length > 0
    && /^[A-Za-z0-9._:-]{1,300}$/.test(intent.id)
    && typeof intent.localName === 'string' && sanitizeUploadName(intent.localName) === intent.localName
    && typeof intent.bytes === 'number' && Number.isFinite(intent.bytes) && intent.bytes >= 0
    && typeof intent.localModifiedAt === 'string' && Number.isFinite(Date.parse(intent.localModifiedAt))
    && typeof intent.startedAt === 'string' && Number.isFinite(Date.parse(intent.startedAt))
    && Array.isArray(intent.previousFileIds) && intent.previousFileIds.every((id) =>
      typeof id === 'string' && /^[A-Za-z0-9._:-]{1,300}$/.test(id))
    && typeof intent.attempts === 'number' && Number.isFinite(intent.attempts);
}

function isCloudDeletionIntent(value: unknown): value is CloudSyncDeletionIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Partial<CloudSyncDeletionIntent>;
  return typeof intent.localName === 'string' && sanitizeUploadName(intent.localName) === intent.localName
    && typeof intent.requestedAt === 'string' && Number.isFinite(Date.parse(intent.requestedAt));
}

function isCloudDownloadIntent(value: unknown): value is CloudSyncDownloadIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Partial<CloudSyncDownloadIntent>;
  return typeof intent.id === 'string' && intent.id.length > 0
    && typeof intent.xaiFileId === 'string' && /^[A-Za-z0-9._:-]{1,300}$/.test(intent.xaiFileId)
    && typeof intent.localName === 'string' && sanitizeUploadName(intent.localName) === intent.localName
    && typeof intent.startedAt === 'string' && Number.isFinite(Date.parse(intent.startedAt));
}

const cloudSyncLockGlobal = globalThis as typeof globalThis & {
  __shibaCloudSyncChain?: Promise<unknown>;
  __shibaCloudTransferChain?: Promise<unknown>;
};

function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = cloudSyncLockGlobal.__shibaCloudSyncChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  cloudSyncLockGlobal.__shibaCloudSyncChain = run.then(() => undefined, () => undefined);
  return run;
}

function withTransferLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = cloudSyncLockGlobal.__shibaCloudTransferChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  cloudSyncLockGlobal.__shibaCloudTransferChain = run.then(() => undefined, () => undefined);
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
    return {
      files: state.files,
      uploadIntents: Array.isArray(state.uploadIntents) ? state.uploadIntents : [],
      deletionIntents: Array.isArray(state.deletionIntents) ? state.deletionIntents : [],
      downloadIntents: Array.isArray(state.downloadIntents) ? state.downloadIntents : [],
      lastSyncAt: state.lastSyncAt,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return { files: [], uploadIntents: [], deletionIntents: [], downloadIntents: [] };
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

function remoteCreatedAtMs(value: number): number {
  const numeric = Number(value) || 0;
  return numeric > 0 && numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
}

async function beginUploadIntent(input: {
  localName: string;
  bytes: number;
  localModifiedAt: string;
  sha256: string;
}): Promise<CloudSyncUploadIntent> {
  let selected: CloudSyncUploadIntent | undefined;
  await mutateState((state) => {
    state.uploadIntents ||= [];
    if ((state.deletionIntents || []).some((intent) => isCloudDeletionIntent(intent) &&
      intent.localName === input.localName && input.localModifiedAt <= intent.requestedAt)) {
      throw new Error('Cloud upload is blocked by a pending deletion for this file');
    }
    selected = state.uploadIntents.find((intent) => isCloudUploadIntent(intent) &&
      intent.localName === input.localName
      && intent.bytes === input.bytes
      && intent.localModifiedAt === input.localModifiedAt);
    if (selected) {
      if (!selected.retrySafe) {
        throw new Error('A prior cloud upload is still awaiting unambiguous recovery');
      }
      selected.sha256 = input.sha256;
      selected.startedAt = new Date().toISOString();
      selected.retrySafe = false;
      selected.lastError = undefined;
      return;
    }
    selected = {
      id: randomUUID(),
      ...input,
      startedAt: new Date().toISOString(),
      previousFileIds: state.files
        .filter(isCloudSyncEntry)
        .filter((entry) => entry.localName === input.localName)
        .map((entry) => entry.xaiFileId),
      attempts: 0,
    };
    state.uploadIntents.push(selected);
  });
  if (!selected) throw new Error('Cloud upload intent was not persisted');
  return selected;
}

async function failUploadIntent(id: string, error: unknown): Promise<void> {
  await mutateState((state) => {
    const intent = (state.uploadIntents || []).find((entry) => isCloudUploadIntent(entry) && entry.id === id);
    if (!intent) return;
    intent.attempts += 1;
    intent.lastError = String(error instanceof Error ? error.message : error).slice(0, 2_000);
    const status = /xAI upload (\d{3})/i.exec(intent.lastError)?.[1];
    intent.retrySafe = Boolean(status && Number(status) >= 400 && Number(status) < 500
      && ![408, 409, 425, 429].includes(Number(status)));
  });
}

async function completeUploadIntent(id: string, entry: CloudSyncEntry): Promise<void> {
  await mutateState((state) => {
    const intent = (state.uploadIntents || []).find((candidate) => isCloudUploadIntent(candidate) && candidate.id === id);
    if (!intent) {
      // Completion may be replayed after a response was durably adopted.
      if (state.files.some((candidate) => isCloudSyncEntry(candidate) && candidate.xaiFileId === entry.xaiFileId)) return;
      throw new Error('Cloud upload intent disappeared before completion');
    }
    const now = new Date().toISOString();
    const deletionWins = (state.deletionIntents || []).some((item) => isCloudDeletionIntent(item) &&
      item.localName === intent.localName && intent.startedAt <= item.requestedAt);
    for (const previous of state.files) {
      if (!isCloudSyncEntry(previous)) continue;
      if (
        previous.localName === intent.localName
        && previous.xaiFileId !== entry.xaiFileId
        && !previous.deletionRequestedAt
      ) {
        previous.deletionRequestedAt = now;
        previous.deletionError = undefined;
      }
    }
    if (deletionWins) {
      entry.deletionRequestedAt = now;
      entry.deletionError = undefined;
    }
    const sameRemote = state.files.findIndex((candidate) =>
      isCloudSyncEntry(candidate) && candidate.xaiFileId === entry.xaiFileId);
    if (sameRemote >= 0) state.files[sameRemote] = entry;
    else state.files.push(entry);
    state.uploadIntents = (state.uploadIntents || []).filter((candidate) =>
      !isCloudUploadIntent(candidate) || candidate.id !== id);
  });
}

async function beginDownloadIntent(xaiFileId: string, localName: string): Promise<CloudSyncDownloadIntent> {
  let selected: CloudSyncDownloadIntent | undefined;
  await mutateState((state) => {
    state.downloadIntents ||= [];
    selected = state.downloadIntents.find((intent) => isCloudDownloadIntent(intent) && intent.xaiFileId === xaiFileId);
    if (selected) return;
    selected = { id: randomUUID(), xaiFileId, localName, startedAt: new Date().toISOString() };
    state.downloadIntents.push(selected);
  });
  if (!selected) throw new Error('Cloud download intent was not persisted');
  return selected;
}

async function completeDownloadIntent(id: string, entry: CloudSyncEntry): Promise<void> {
  await mutateState((state) => {
    const intent = (state.downloadIntents || []).find((candidate) => isCloudDownloadIntent(candidate) && candidate.id === id);
    if (!intent) {
      if (state.files.some((candidate) => isCloudSyncEntry(candidate) && candidate.xaiFileId === entry.xaiFileId)) return;
      throw new Error('Cloud download intent disappeared before completion');
    }
    const idx = state.files.findIndex((candidate) =>
      isCloudSyncEntry(candidate) && candidate.xaiFileId === entry.xaiFileId);
    if (idx >= 0) state.files[idx] = entry;
    else state.files.push(entry);
    state.downloadIntents = (state.downloadIntents || []).filter((candidate) =>
      !isCloudDownloadIntent(candidate) || candidate.id !== id);
  });
}

/** Recover the response/persistence crash window of a successful xAI upload. */
export async function recoverPendingCloudUploadIntents(): Promise<{
  recovered: number;
  pending: number;
}> {
  const snapshot = await withStateLock(loadStateUnlocked);
  const rawIntents = (snapshot.uploadIntents || []) as unknown[];
  const intents = rawIntents.filter(isCloudUploadIntent);
  if (!rawIntents.length) return { recovered: 0, pending: 0 };
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) return { recovered: 0, pending: rawIntents.length };
  setApiKey(auth.token);
  const remote = await listXaiFiles();
  let recovered = 0;
  for (const intent of intents) {
    const alreadyCommitted = (snapshot.files as unknown[]).find((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const entry = value as Partial<CloudSyncEntry>;
      return (
      !entry.deletionRequestedAt
      && entry.localName === intent.localName
      && entry.bytes === intent.bytes
      && entry.localModifiedAt === intent.localModifiedAt
      );
    });
    if (alreadyCommitted) {
      await mutateState((state) => {
        state.uploadIntents = (state.uploadIntents || []).filter((entry) =>
          !isCloudUploadIntent(entry) || entry.id !== intent.id);
      });
      recovered += 1;
      continue;
    }
    const earliest = Date.parse(intent.startedAt) - 2 * 60_000;
    const latest = Date.parse(intent.startedAt) + 15 * 60_000;
    const candidates = remote.filter((entry) =>
      entry.filename === intent.localName
      && Number(entry.bytes) === intent.bytes
      && !intent.previousFileIds.includes(entry.id)
      && remoteCreatedAtMs(entry.created_at) >= earliest
      && remoteCreatedAtMs(entry.created_at) <= latest)
      .sort((a, b) => remoteCreatedAtMs(b.created_at) - remoteCreatedAtMs(a.created_at));
    // Name/size/time are not ownership proof. Historical intents without a
    // checksum stay pending; current intents adopt only one exact byte match.
    const matching: XaiFileMeta[] = [];
    if (intent.sha256) {
      for (const candidate of candidates) {
        try {
          if (sha256Checksum(await downloadXaiFileContent(candidate.id)) === intent.sha256) {
            matching.push(candidate);
          }
        } catch {
          // A transient content read leaves the intent pending for retry.
        }
      }
    }
    const candidate = matching.length === 1 ? matching[0] : undefined;
    if (!candidate) continue;
    await completeUploadIntent(intent.id, {
      localName: intent.localName,
      xaiFileId: candidate.id,
      bytes: candidate.bytes ?? intent.bytes,
      syncedAt: new Date().toISOString(),
      localModifiedAt: intent.localModifiedAt,
      publicUrl: candidate.public_url || undefined,
      cloudUrl: candidate.public_url || cloudFileViewUrl(candidate.id),
    });
    recovered += 1;
  }
  // Unknown/legacy shapes are intentionally retained as pending. An upload
  // response can represent remote bytes, so lack of recovery metadata is not
  // permission to discard its ownership claim.
  return { recovered, pending: Math.max(0, rawIntents.length - recovered) };
}

export interface CloudSyncOwnershipReport {
  uploadIntentsRecovered: number;
  uploadIntentsPending: number;
  duplicateMappingsRemoved: number;
  invalidOwnershipMappingsQuarantined: number;
  obsoleteVersionsQueued: number;
  invalidMappingsQueued: number;
  remoteOnly: number;
  remoteMissingMarked: number;
  remoteMissingMappingsRemoved: number;
  redundantDownloadIntentsRemoved: number;
  staleDownloadIntentsQuarantined: number;
  invalidDownloadIntentsQuarantined: number;
  invalidUploadIntentsQuarantined: number;
  invalidDeletionIntentsQuarantined: number;
}

/** Normalize durable cloud ownership without deleting remote-only user data. */
export async function reconcileCloudSyncOwnership(): Promise<CloudSyncOwnershipReport> {
  const recovered = await recoverPendingCloudUploadIntents();
  const localFiles = await listGlobalUploadFiles();
  const localNames = new Set(localFiles.map((entry) => entry.name));
  let remoteIds: Set<string> | undefined;
  try {
    const cfg = await loadConfig();
    const auth = await resolveCloudBearer(cfg);
    if (auth.token) {
      setApiKey(auth.token);
      remoteIds = new Set((await listXaiFiles()).map((entry) => entry.id));
    }
  } catch {
    // Remote inventory is advisory and retried. Local ownership repair must
    // remain available while the provider or network is unavailable.
  }
  const report: CloudSyncOwnershipReport = {
    uploadIntentsRecovered: recovered.recovered,
    uploadIntentsPending: recovered.pending,
    duplicateMappingsRemoved: 0,
    invalidOwnershipMappingsQuarantined: 0,
    obsoleteVersionsQueued: 0,
    invalidMappingsQueued: 0,
    remoteOnly: 0,
    remoteMissingMarked: 0,
    remoteMissingMappingsRemoved: 0,
    redundantDownloadIntentsRemoved: 0,
    staleDownloadIntentsQuarantined: 0,
    invalidDownloadIntentsQuarantined: 0,
    invalidUploadIntentsQuarantined: 0,
    invalidDeletionIntentsQuarantined: 0,
  };
  await mutateState(async (state) => {
    const now = new Date().toISOString();
    const canonicalByRemote = new Map<string, CloudSyncEntry>();
    for (const raw of state.files as unknown as CloudSyncEntry[]) {
      if (!raw || typeof raw !== 'object') {
        await recordManagedStorageIssue('invalid_cloud_sync_mapping', { record: raw });
        report.duplicateMappingsRemoved += 1;
        report.invalidOwnershipMappingsQuarantined += 1;
        continue;
      }
      const entry = raw;
      if (typeof entry.xaiFileId !== 'string' || !/^[A-Za-z0-9._:-]{1,300}$/.test(entry.xaiFileId)) {
        await recordManagedStorageIssue('invalid_cloud_sync_mapping', { record: raw });
        report.duplicateMappingsRemoved += 1;
        report.invalidOwnershipMappingsQuarantined += 1;
        continue;
      }
      if (typeof entry.localName !== 'string' || sanitizeUploadName(entry.localName) !== entry.localName) {
        entry.deletionRequestedAt ||= now;
        entry.deletionError = undefined;
        report.invalidMappingsQueued += 1;
      }
      const existing = canonicalByRemote.get(entry.xaiFileId);
      if (!existing) {
        canonicalByRemote.set(entry.xaiFileId, entry);
        continue;
      }
      const keepEntry = Boolean(entry.deletionRequestedAt) && !existing.deletionRequestedAt
        || (!entry.deletionRequestedAt && !existing.deletionRequestedAt
          && Date.parse(entry.syncedAt || '') > Date.parse(existing.syncedAt || ''));
      if (keepEntry) canonicalByRemote.set(entry.xaiFileId, entry);
      report.duplicateMappingsRemoved += 1;
    }
    state.files = [...canonicalByRemote.values()];

    const retainedUploadIntents: CloudSyncUploadIntent[] = [];
    const seenUploadIds = new Set<string>();
    for (const value of (state.uploadIntents || []) as unknown[]) {
      if (!isCloudUploadIntent(value) || seenUploadIds.has(value.id)) {
        await recordManagedStorageIssue('invalid_cloud_upload_intent', { record: value });
        report.invalidUploadIntentsQuarantined += 1;
        continue;
      }
      seenUploadIds.add(value.id);
      retainedUploadIntents.push(value);
    }
    state.uploadIntents = retainedUploadIntents;
    report.uploadIntentsPending = retainedUploadIntents.length;

    const retainedDeletionIntents: CloudSyncDeletionIntent[] = [];
    const seenDeletionNames = new Set<string>();
    for (const value of (state.deletionIntents || []) as unknown[]) {
      if (!isCloudDeletionIntent(value) || seenDeletionNames.has(value.localName)) {
        await recordManagedStorageIssue('invalid_cloud_deletion_intent', { record: value });
        report.invalidDeletionIntentsQuarantined += 1;
        continue;
      }
      seenDeletionNames.add(value.localName);
      retainedDeletionIntents.push(value);
    }
    state.deletionIntents = retainedDeletionIntents;

    const mappedRemoteIds = new Set(state.files.map((entry) => entry.xaiFileId));
    const retainedDownloadIntents: CloudSyncDownloadIntent[] = [];
    const seenDownloadIds = new Set<string>();
    const seenDownloadRemotes = new Set<string>();
    for (const value of (state.downloadIntents || []) as unknown[]) {
      if (!isCloudDownloadIntent(value)) {
        await recordManagedStorageIssue('invalid_cloud_download_intent', { record: value });
        report.invalidDownloadIntentsQuarantined += 1;
        continue;
      }
      if (seenDownloadIds.has(value.id) || seenDownloadRemotes.has(value.xaiFileId)) {
        await recordManagedStorageIssue('duplicate_cloud_download_intent', { record: value });
        report.invalidDownloadIntentsQuarantined += 1;
        continue;
      }
      seenDownloadIds.add(value.id);
      seenDownloadRemotes.add(value.xaiFileId);
      if (mappedRemoteIds.has(value.xaiFileId)) {
        report.redundantDownloadIntentsRemoved += 1;
        continue;
      }
      if (
        remoteIds
        && !remoteIds.has(value.xaiFileId)
        && Date.parse(value.startedAt) <= Date.now() - 60 * 60_000
      ) {
        await recordManagedStorageIssue('stale_cloud_download_intent', { record: value });
        report.staleDownloadIntentsQuarantined += 1;
        continue;
      }
      retainedDownloadIntents.push(value);
    }
    state.downloadIntents = retainedDownloadIntents;

    if (remoteIds) {
      state.files = state.files.filter((entry) => {
        if (entry.deletionRequestedAt || remoteIds!.has(entry.xaiFileId)) {
          entry.remoteMissingAt = undefined;
          return true;
        }
        if (!entry.remoteMissingAt) {
          entry.remoteMissingAt = now;
          report.remoteMissingMarked += 1;
          return true;
        }
        if (Date.parse(entry.remoteMissingAt) > Date.now() - 60 * 60_000) return true;
        report.remoteMissingMappingsRemoved += 1;
        return false;
      });
    }

    const activeByName = new Map<string, CloudSyncEntry[]>();
    for (const entry of state.files) {
      if (!isCloudSyncEntry(entry)) continue;
      if (entry.deletionRequestedAt) continue;
      const group = activeByName.get(entry.localName) || [];
      group.push(entry);
      activeByName.set(entry.localName, group);
    }
    for (const entries of activeByName.values()) {
      entries.sort((a, b) => Date.parse(b.syncedAt || '') - Date.parse(a.syncedAt || ''));
      for (const obsolete of entries.slice(1)) {
        obsolete.deletionRequestedAt = now;
        obsolete.deletionError = undefined;
        report.obsoleteVersionsQueued += 1;
      }
    }
    for (const entry of state.files) {
      if (!isCloudSyncEntry(entry)) continue;
      if (entry.deletionRequestedAt) continue;
      if (localNames.has(entry.localName)) entry.localMissingAt = undefined;
      else {
        entry.localMissingAt ||= now;
        report.remoteOnly += 1;
      }
    }
  });
  return report;
}

export async function getCloudSyncEntries(): Promise<CloudSyncEntry[]> {
  return (await getCloudSyncOverview()).files;
}

/** Read the persisted sync rows and timestamp from the same locked snapshot. */
export async function getCloudSyncOverview(): Promise<{
  files: CloudSyncEntry[];
  lastSyncAt: string | null;
}> {
  return withStateLock(async () => {
    const state = await loadStateUnlocked();
    return {
      files: [...state.files],
      lastSyncAt: state.lastSyncAt || null,
    };
  });
}

export async function removeCloudSyncByLocalName(localName: string): Promise<void> {
  await requestCloudSyncDeletion(localName);
  await processPendingCloudSyncDeletions().catch(() => undefined);
}

export async function requestCloudSyncDeletion(localName: string): Promise<void> {
  const safe = sanitizeUploadName(localName);
  await mutateState((state) => {
    const now = new Date().toISOString();
    state.deletionIntents ||= [];
    if (!state.deletionIntents.some((intent) => isCloudDeletionIntent(intent) && intent.localName === safe)) {
      state.deletionIntents.push({ localName: safe, requestedAt: now });
    }
    for (const entry of state.files) {
      if (!isCloudSyncEntry(entry)) continue;
      if (entry.localName !== safe) continue;
      entry.deletionRequestedAt ||= now;
      entry.deletionError = undefined;
    }
  });
}

/** Persist deletion intent before touching local bytes and serialize it with uploads. */
export async function deleteUploadEverywhere(localName: string): Promise<void> {
  const safe = sanitizeUploadName(localName);
  return withTransferLock(async () => {
    await requestCloudSyncDeletion(safe);
    await deleteGlobalUploadFile(safe);
    await processPendingCloudSyncDeletions().catch(() => undefined);
  });
}

export async function processPendingCloudSyncDeletions(): Promise<{
  removed: number;
  pending: number;
}> {
  const pending = (await withStateLock(loadStateUnlocked)).files
    .filter(isCloudSyncEntry)
    .filter((entry) => entry.deletionRequestedAt);
  const localFiles = await listGlobalUploadFiles();
  const localModifiedByName = new Map(localFiles.map((entry) => [entry.name, entry.modifiedAt]));
  if (!pending.length) {
    await mutateState((state) => {
      state.deletionIntents = (state.deletionIntents || []).filter((intent) => isCloudDeletionIntent(intent) && (
        (localModifiedByName.has(intent.localName)
          && localModifiedByName.get(intent.localName)! <= intent.requestedAt)
        || (state.uploadIntents || []).some((entry) =>
          isCloudUploadIntent(entry) && entry.localName === intent.localName)
      ));
    });
    return { removed: 0, pending: 0 };
  }
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) return { removed: 0, pending: pending.length };
  setApiKey(auth.token);
  const removedIds = new Set<string>();
  const failures = new Map<string, string>();
  for (const entry of pending) {
    try {
      await deleteXaiFile(entry.xaiFileId);
      removedIds.add(entry.xaiFileId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/xAI delete 404/i.test(message)) removedIds.add(entry.xaiFileId);
      else failures.set(entry.xaiFileId, message.slice(0, 2_000));
    }
  }
  await mutateState((state) => {
    state.files = state.files.filter((entry) => {
      if (!isCloudSyncEntry(entry)) return true;
      if (!entry.deletionRequestedAt) return true;
      if (removedIds.has(entry.xaiFileId)) return false;
      entry.deletionAttempts = (entry.deletionAttempts || 0) + 1;
      entry.deletionError = failures.get(entry.xaiFileId) || 'Remote deletion is still pending';
      return true;
    });
    state.deletionIntents = (state.deletionIntents || []).filter((intent) => {
      if (!isCloudDeletionIntent(intent)) return false;
      const stillMapped = state.files.some((entry) =>
        isCloudSyncEntry(entry) && entry.localName === intent.localName);
      const uploadMayStillComplete = (state.uploadIntents || []).some((entry) =>
        isCloudUploadIntent(entry) && entry.localName === intent.localName);
      const localPredatesDelete = localModifiedByName.has(intent.localName)
        && localModifiedByName.get(intent.localName)! <= intent.requestedAt;
      return localPredatesDelete || stillMapped || uploadMayStillComplete;
    });
  });
  return { removed: removedIds.size, pending: pending.length - removedIds.size };
}

async function syncUploadToCloudUnlocked(): Promise<{
  uploaded: string[];
  skipped: string[];
  errors: string[];
}> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) throw new Error('Cloud credentials required for cloud sync (API key or OAuth with X)');
  setApiKey(auth.token);
  // Adopt any prior upload whose remote response was received just before the
  // process stopped, then decide whether the local file still needs a push.
  await recoverPendingCloudUploadIntents();

  const uploadsDir = await getGlobalUploadsDir();
  const localFiles = await listGlobalUploadFiles();
  const state = await withStateLock(loadStateUnlocked);
  const byName = new Map(state.files.filter(isCloudSyncEntry)
    .filter((entry) => !entry.deletionRequestedAt)
    .map((f) => [f.localName, f]));
  const deletionByName = new Map((state.deletionIntents || [])
    .filter(isCloudDeletionIntent)
    .map((intent) => [intent.localName, intent]));

  const uploaded: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const file of localFiles) {
    const deletion = deletionByName.get(file.name);
    if (deletion && new Date(file.modifiedAt).toISOString() <= deletion.requestedAt) {
      skipped.push(file.name);
      continue;
    }
    const existing = byName.get(file.name);
    const mtime = new Date(file.modifiedAt).toISOString();
    if (existing && existing.localModifiedAt === mtime && existing.bytes === (file.size || 0)) {
      skipped.push(file.name);
      continue;
    }
    let intent: CloudSyncUploadIntent | undefined;
    try {
      const buf = await fs.readFile(path.join(uploadsDir, file.name));
      intent = await beginUploadIntent({
        localName: file.name,
        bytes: buf.length,
        localModifiedAt: mtime,
        sha256: sha256Checksum(buf),
      });
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
      // Commit the remote identity immediately per file. Replacing a prior
      // version queues its exact id for deletion instead of losing ownership
      // when the local-name mapping is updated.
      await completeUploadIntent(intent.id, entry);
      uploaded.push(file.name);
    } catch (e) {
      if (intent) await failUploadIntent(intent.id, e).catch(() => undefined);
      errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await mutateState((current) => {
    current.lastSyncAt = new Date().toISOString();
  });
  await processPendingCloudSyncDeletions().catch(() => undefined);
  return { uploaded, skipped, errors };
}

export function syncUploadToCloud(): Promise<{
  uploaded: string[];
  skipped: string[];
  errors: string[];
}> {
  return withTransferLock(syncUploadToCloudUnlocked);
}

async function syncDownloadFromCloudUnlocked(): Promise<{
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
  const active = state.files.filter(isCloudSyncEntry).filter((entry) => !entry.deletionRequestedAt);
  const byId = new Map(active.map((f) => [f.xaiFileId, f]));
  const downloadIntentByRemote = new Map((state.downloadIntents || [])
    .filter(isCloudDownloadIntent)
    .map((intent) => [intent.xaiFileId, intent]));
  const deletionPendingIds = new Set(
    state.files.filter(isCloudSyncEntry)
      .filter((entry) => entry.deletionRequestedAt)
      .map((entry) => entry.xaiFileId),
  );
  const reservedNames = new Set((await listGlobalUploadFiles()).map((entry) => entry.name));
  const nameOwners = new Map(active.map((entry) => [entry.localName, entry.xaiFileId]));

  const downloaded: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const cloud of cloudFiles) {
    if (deletionPendingIds.has(cloud.id)) continue;
    const mapped = byId.get(cloud.id);
    const baseName = sanitizeUploadName(cloud.filename || `file-${cloud.id}`);
    const existingIntent = downloadIntentByRemote.get(cloud.id);
    let name = mapped?.localName || existingIntent?.localName || baseName;
    if (!mapped && (reservedNames.has(name) || (nameOwners.has(name) && nameOwners.get(name) !== cloud.id))) {
      const parsed = path.parse(baseName);
      const token = cloud.id.replace(/[^A-Za-z0-9_-]/g, '').slice(-12) || randomUUID().slice(0, 8);
      let counter = 0;
      do {
        const suffix = counter === 0 ? token : `${token}-${counter}`;
        name = sanitizeUploadName(`${parsed.name}-${suffix}${parsed.ext}`);
        counter += 1;
      } while (reservedNames.has(name) || nameOwners.has(name));
    }
    reservedNames.add(name);
    nameOwners.set(name, cloud.id);
    const localPath = path.join(uploadsDir, name);
    let localMtime = '';
    try {
      const st = await fs.stat(localPath);
      localMtime = st.mtime.toISOString();
    } catch {
      /* new file */
    }

    if (!existingIntent && mapped && mapped.localModifiedAt === localMtime && mapped.bytes === cloud.bytes) {
      skipped.push(name);
      continue;
    }

    try {
      const intent = existingIntent || await beginDownloadIntent(cloud.id, name);
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
      // Complete each remote/local mapping immediately. A crash after the
      // bytes land is recovered from the durable per-file intent above.
      await completeDownloadIntent(intent.id, entry);
      downloaded.push(name);
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await mutateState((current) => { current.lastSyncAt = new Date().toISOString(); });
  return { downloaded, skipped, errors };
}

export function syncDownloadFromCloud(): Promise<{
  downloaded: string[];
  skipped: string[];
  errors: string[];
}> {
  return withTransferLock(syncDownloadFromCloudUnlocked);
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
