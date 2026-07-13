import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';
import { loadConfig } from './persistence';
import { loadOAuthSession, resolveCloudBearer } from './xai-oauth';
import {
  deleteXaiFile,
  downloadXaiFileContent,
  listXaiFiles,
  uploadXaiFile,
  type XaiFileMeta,
} from './xai-files';

const OWNERSHIP_SCHEMA = 'shiba-external-resource-v1';
const DEFAULT_CHAT_UNREFERENCED_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_TOMBSTONE_GRACE_MS = 60_000;
const DEFAULT_INTENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_DELETE_BATCH_SIZE = 100;

export type OwnedXaiResourceKind = 'chat_file' | 'entity_snapshot';
export type OwnedXaiAuthSource = 'api_key' | 'oauth' | null;

interface OwnedXaiUploadIntent {
  id: string;
  kind: OwnedXaiResourceKind;
  ownerKey: string;
  filename: string;
  bytes: number;
  authSource: OwnedXaiAuthSource;
  authFingerprint: string;
  startedAt: string;
  lastError: string | null;
}

interface OwnedXaiResourceRow {
  resourceId: string;
  ownershipToken: string;
  kind: OwnedXaiResourceKind;
  ownerKey: string;
  filename: string;
  bytes: number;
  authSource: OwnedXaiAuthSource;
  authFingerprint: string;
  createdAt: string;
  unreferencedAt: string | null;
  deletionRequestedAt: string | null;
  deletionAttempts: number;
  lastError: string | null;
}

export interface OwnedXaiCleanupReport {
  uploadIntentsRecovered: number;
  uploadIntentsAbandoned: number;
  uploadIntentsPending: number;
  chatFilesTombstoned: number;
  entitySnapshotsTombstoned: number;
  remoteFilesDeleted: number;
  deletionsPending: number;
  errors: string[];
}

export interface ReconcileOwnedXaiResourcesOptions {
  liveChatFileIds?: ReadonlySet<string>;
  nowMs?: number;
  chatUnreferencedAgeMs?: number;
  tombstoneGraceMs?: number;
  intentRetentionMs?: number;
  deleteBatchSize?: number;
}

function ensureSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS external_xai_upload_intents (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      ownerKey TEXT NOT NULL,
      filename TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      authSource TEXT,
      authFingerprint TEXT NOT NULL DEFAULT '',
      startedAt TEXT NOT NULL,
      lastError TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_external_xai_upload_intents_started
      ON external_xai_upload_intents(startedAt, id);
    CREATE TABLE IF NOT EXISTS external_xai_resources (
      resourceId TEXT PRIMARY KEY,
      ownershipToken TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      ownerKey TEXT NOT NULL,
      filename TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      authSource TEXT,
      authFingerprint TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      unreferencedAt TEXT,
      deletionRequestedAt TEXT,
      deletionAttempts INTEGER NOT NULL DEFAULT 0,
      lastError TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_external_xai_resources_cleanup
      ON external_xai_resources(deletionRequestedAt, createdAt, resourceId);
    CREATE INDEX IF NOT EXISTS idx_external_xai_resources_owner
      ON external_xai_resources(kind, ownerKey, createdAt);
  `);
  for (const table of ['external_xai_upload_intents', 'external_xai_resources']) {
    const columns = new Set((getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (!columns.has('authFingerprint')) {
      try {
        getDb().exec(`ALTER TABLE ${table} ADD COLUMN authFingerprint TEXT NOT NULL DEFAULT ''`);
      } catch (error) {
        if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

function validRemoteId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,300}$/.test(value);
}

function normalizeOwnerKey(value: string): string {
  const key = String(value || '').trim();
  if (!key || key.length > 300) throw new Error('Owned xAI resource owner key is invalid');
  return key;
}

function chatRemoteFilename(ownershipToken: string, originalFilename: string): string {
  const extension = /(\.[A-Za-z0-9]{1,12})$/.exec(originalFilename.trim())?.[1]
    ?.toLowerCase() || '';
  return `shiba-chat-${ownershipToken}${extension}`;
}

function insertUploadIntent(input: {
  id: string;
  kind: OwnedXaiResourceKind;
  ownerKey: string;
  filename: string;
  bytes: number;
  authSource?: OwnedXaiAuthSource;
  authFingerprint: string;
  startedAt?: string;
}): OwnedXaiUploadIntent {
  ensureSchema();
  const intent: OwnedXaiUploadIntent = {
    id: input.id,
    kind: input.kind,
    ownerKey: normalizeOwnerKey(input.ownerKey),
    filename: input.filename.trim(),
    bytes: Math.max(0, Math.floor(Number(input.bytes) || 0)),
    authSource: input.authSource || null,
    authFingerprint: input.authFingerprint,
    startedAt: input.startedAt || new Date().toISOString(),
    lastError: null,
  };
  if (!validRemoteId(intent.id)
    || !intent.filename
    || intent.filename.length > 500
    || !/^[0-9a-f]{64}$/.test(intent.authFingerprint)) {
    throw new Error('Owned xAI upload identity is invalid');
  }
  getDb().prepare(`
    INSERT INTO external_xai_upload_intents (
      id, kind, ownerKey, filename, bytes, authSource, authFingerprint, startedAt, lastError
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    intent.id,
    intent.kind,
    intent.ownerKey,
    intent.filename,
    intent.bytes,
    intent.authSource,
    intent.authFingerprint,
    intent.startedAt,
  );
  return intent;
}

function completeUploadIntent(intentId: string, meta: XaiFileMeta): void {
  ensureSchema();
  if (!validRemoteId(meta.id)) throw new Error('xAI returned an invalid file id');
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const intent = db.prepare(`
      SELECT id, kind, ownerKey, filename, bytes, authSource, authFingerprint, startedAt, lastError
      FROM external_xai_upload_intents WHERE id = ?
    `).get(intentId) as OwnedXaiUploadIntent | undefined;
    if (!intent) {
      const replay = db.prepare(`
        SELECT resourceId FROM external_xai_resources WHERE ownershipToken = ?
      `).get(intentId) as { resourceId: string } | undefined;
      if (replay?.resourceId === meta.id) {
        db.exec('COMMIT');
        return;
      }
      throw new Error('Owned xAI upload intent disappeared before completion');
    }
    if (meta.filename && meta.filename !== intent.filename) {
      throw new Error('xAI returned a filename that does not match the owned upload intent');
    }
    const conflicting = db.prepare(`
      SELECT ownershipToken FROM external_xai_resources WHERE resourceId = ?
    `).get(meta.id) as { ownershipToken: string } | undefined;
    if (conflicting && conflicting.ownershipToken !== intent.id) {
      throw new Error('xAI file id is already owned by another upload intent');
    }
    if (conflicting?.ownershipToken === intent.id) {
      db.prepare('DELETE FROM external_xai_upload_intents WHERE id = ?').run(intent.id);
      db.exec('COMMIT');
      return;
    }
    const now = new Date().toISOString();
    if (intent.kind === 'entity_snapshot') {
      db.prepare(`
        UPDATE external_xai_resources
        SET deletionRequestedAt = COALESCE(deletionRequestedAt, ?), lastError = NULL
        WHERE kind = 'entity_snapshot' AND ownerKey = ? AND resourceId != ?
      `).run(now, intent.ownerKey, meta.id);
    }
    db.prepare(`
      INSERT INTO external_xai_resources (
        resourceId, ownershipToken, kind, ownerKey, filename, bytes,
        authSource, authFingerprint, createdAt, unreferencedAt, deletionRequestedAt,
        deletionAttempts, lastError
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
      ON CONFLICT(ownershipToken) DO UPDATE SET
        resourceId = excluded.resourceId,
        filename = excluded.filename,
        bytes = excluded.bytes,
        authSource = excluded.authSource,
        authFingerprint = excluded.authFingerprint
    `).run(
      meta.id,
      intent.id,
      intent.kind,
      intent.ownerKey,
      intent.filename,
      Number(meta.bytes) || intent.bytes,
      intent.authSource,
      intent.authFingerprint,
      now,
      intent.kind === 'chat_file' ? now : null,
    );
    db.prepare('DELETE FROM external_xai_upload_intents WHERE id = ?').run(intent.id);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

function recordUploadFailure(intentId: string, error: unknown): void {
  ensureSchema();
  const message = String(error instanceof Error ? error.message : error).slice(0, 2_000);
  const status = /xAI upload (\d{3})/i.exec(message)?.[1];
  const definitiveClientFailure = Boolean(status
    && Number(status) >= 400
    && Number(status) < 500
    && ![408, 409, 425, 429].includes(Number(status)));
  if (definitiveClientFailure) {
    getDb().prepare('DELETE FROM external_xai_upload_intents WHERE id = ?').run(intentId);
  } else {
    getDb().prepare(`
      UPDATE external_xai_upload_intents SET lastError = ? WHERE id = ?
    `).run(message, intentId);
  }
}

async function authFingerprint(token: string, source: OwnedXaiAuthSource): Promise<string> {
  let stableIdentity = token;
  if (source === 'oauth') {
    const session = await loadOAuthSession();
    stableIdentity = session?.userId?.trim()
      || session?.email?.trim().toLowerCase()
      || session?.refreshToken?.trim()
      || token;
  }
  return createHash('sha256')
    .update(`${source || 'default'}\0${stableIdentity}`)
    .digest('hex');
}

export async function uploadOwnedXaiChatFile(input: {
  originalFilename: string;
  content: Buffer;
  authToken?: string;
  authSource?: OwnedXaiAuthSource;
}): Promise<XaiFileMeta> {
  const token = input.authToken?.trim();
  if (!token) throw new Error('Owned xAI chat uploads require a pinned credential');
  const ownershipToken = randomUUID();
  const intent = insertUploadIntent({
    id: ownershipToken,
    kind: 'chat_file',
    ownerKey: 'chat-attachment',
    filename: chatRemoteFilename(ownershipToken, input.originalFilename),
    bytes: input.content.length,
    authSource: input.authSource,
    authFingerprint: await authFingerprint(token, input.authSource || null),
  });
  try {
    const meta = await uploadXaiFile(intent.filename, input.content, token);
    completeUploadIntent(intent.id, meta);
    return meta;
  } catch (error) {
    recordUploadFailure(intent.id, error);
    throw error;
  }
}

export async function uploadOwnedXaiEntitySnapshot(input: {
  ownerKey: string;
  filename: string;
  kind: string;
  payload: unknown;
  authToken?: string;
  authSource?: OwnedXaiAuthSource;
}): Promise<XaiFileMeta> {
  const token = input.authToken?.trim();
  if (!token) throw new Error('Owned xAI entity uploads require a pinned credential');
  const ownershipToken = randomUUID();
  const body = Buffer.from(JSON.stringify({
    _shibaOwnership: {
      schema: OWNERSHIP_SCHEMA,
      id: ownershipToken,
      kind: 'entity_snapshot',
      ownerKey: normalizeOwnerKey(input.ownerKey),
    },
    kind: input.kind,
    exportedAt: new Date().toISOString(),
    payload: input.payload,
  }, null, 2));
  const intent = insertUploadIntent({
    id: ownershipToken,
    kind: 'entity_snapshot',
    ownerKey: input.ownerKey,
    filename: input.filename,
    bytes: body.length,
    authSource: input.authSource,
    authFingerprint: await authFingerprint(token, input.authSource || null),
  });
  try {
    const meta = await uploadXaiFile(intent.filename, body, token);
    completeUploadIntent(intent.id, meta);
    return meta;
  } catch (error) {
    recordUploadFailure(intent.id, error);
    throw error;
  }
}

function remoteCreatedAtMs(value: number): number {
  const numeric = Number(value) || 0;
  return numeric > 0 && numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
}

function withinIntentWindow(intent: OwnedXaiUploadIntent, file: XaiFileMeta): boolean {
  const createdAt = remoteCreatedAtMs(file.created_at);
  if (!createdAt) return true;
  const startedAt = Date.parse(intent.startedAt);
  return Number.isFinite(startedAt)
    && createdAt >= startedAt - 5 * 60_000
    && createdAt <= startedAt + 24 * 60 * 60_000;
}

async function exactAuthToken(
  source: OwnedXaiAuthSource,
  expectedFingerprint: string,
): Promise<string | null> {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(
    cfg,
    source === 'oauth' ? 'oauth' : source === 'api_key' ? 'token' : undefined,
  );
  if (!auth.token || (source && auth.source !== source)) return null;
  if (!expectedFingerprint
    || await authFingerprint(auth.token, auth.source) !== expectedFingerprint) return null;
  return auth.token;
}

async function entitySnapshotMatches(
  intent: OwnedXaiUploadIntent,
  candidate: XaiFileMeta,
  authToken: string,
): Promise<'match' | 'mismatch' | 'error'> {
  let raw: Buffer;
  try {
    raw = await downloadXaiFileContent(candidate.id, authToken);
  } catch {
    return 'error';
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as {
      _shibaOwnership?: { schema?: string; id?: string; kind?: string; ownerKey?: string };
    };
    return parsed?._shibaOwnership?.schema === OWNERSHIP_SCHEMA
      && parsed._shibaOwnership.id === intent.id
      && parsed._shibaOwnership.kind === 'entity_snapshot'
      && parsed._shibaOwnership.ownerKey === intent.ownerKey
      ? 'match'
      : 'mismatch';
  } catch {
    return 'mismatch';
  }
}

async function recoverUploadIntents(nowMs: number, retentionMs: number): Promise<{
  recovered: number;
  abandoned: number;
  pending: number;
  errors: string[];
}> {
  ensureSchema();
  const intents = getDb().prepare(`
    SELECT id, kind, ownerKey, filename, bytes, authSource, authFingerprint, startedAt, lastError
    FROM external_xai_upload_intents ORDER BY startedAt ASC, id ASC
  `).all() as OwnedXaiUploadIntent[];
  let recovered = 0;
  let abandoned = 0;
  const errors: string[] = [];
  const inventories = new Map<string, { token: string; files: XaiFileMeta[] } | null>();

  for (const intent of intents) {
    const sourceKey = `${intent.authSource || 'default'}:${intent.authFingerprint}`;
    if (!inventories.has(sourceKey)) {
      try {
        const token = await exactAuthToken(intent.authSource, intent.authFingerprint);
        inventories.set(sourceKey, token ? { token, files: await listXaiFiles(token) } : null);
      } catch (error) {
        errors.push(`xAI upload recovery (${sourceKey}): ${error instanceof Error ? error.message : String(error)}`);
        inventories.set(sourceKey, null);
      }
    }
    const inventory = inventories.get(sourceKey);
    if (!inventory) continue;
    const candidates = inventory.files.filter((file) =>
      file.filename === intent.filename && withinIntentWindow(intent, file));
    let match: XaiFileMeta | undefined;
    let inspectionFailed = false;
    if (intent.kind === 'chat_file') {
      const exact = candidates.filter((file) => Number(file.bytes) === intent.bytes);
      if (exact.length === 1) match = exact[0];
    } else {
      const exact: XaiFileMeta[] = [];
      for (const candidate of candidates) {
        const inspected = await entitySnapshotMatches(intent, candidate, inventory.token);
        if (inspected === 'match') exact.push(candidate);
        else if (inspected === 'error') inspectionFailed = true;
      }
      if (exact.length === 1) match = exact[0];
    }
    if (match) {
      completeUploadIntent(intent.id, match);
      recovered += 1;
      continue;
    }
    if (!inspectionFailed && Date.parse(intent.startedAt) <= nowMs - retentionMs) {
      getDb().prepare('DELETE FROM external_xai_upload_intents WHERE id = ?').run(intent.id);
      abandoned += 1;
    }
  }
  const pending = Number((getDb().prepare(`
    SELECT COUNT(*) AS count FROM external_xai_upload_intents
  `).get() as { count: number }).count) || 0;
  return { recovered, abandoned, pending, errors };
}

function tombstoneUnownedResources(
  liveChatFileIds: ReadonlySet<string>,
  nowMs: number,
  chatUnreferencedAgeMs: number,
): { chat: number; snapshots: number } {
  ensureSchema();
  const db = getDb();
  const rows = db.prepare(`
    SELECT resourceId, ownershipToken, kind, ownerKey, filename, bytes,
      authSource, authFingerprint, createdAt, unreferencedAt, deletionRequestedAt,
      deletionAttempts, lastError
    FROM external_xai_resources
  `).all() as OwnedXaiResourceRow[];
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - chatUnreferencedAgeMs).toISOString();
  let chat = 0;
  let snapshots = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (row.kind !== 'chat_file') continue;
      if (liveChatFileIds.has(row.resourceId)) {
        db.prepare(`
          UPDATE external_xai_resources
          SET unreferencedAt = NULL, deletionRequestedAt = NULL, lastError = NULL
          WHERE resourceId = ?
        `).run(row.resourceId);
        continue;
      }
      const unreferencedAt = row.unreferencedAt || now;
      if (!row.unreferencedAt) {
        db.prepare(`
          UPDATE external_xai_resources SET unreferencedAt = ? WHERE resourceId = ?
        `).run(unreferencedAt, row.resourceId);
      }
      if (!row.deletionRequestedAt && unreferencedAt <= cutoff) {
        chat += Number(db.prepare(`
          UPDATE external_xai_resources
          SET deletionRequestedAt = ?, lastError = NULL
          WHERE resourceId = ? AND deletionRequestedAt IS NULL
        `).run(now, row.resourceId).changes) || 0;
      }
    }

    const activeSnapshots = db.prepare(`
      SELECT resourceId, ownerKey, createdAt FROM external_xai_resources
      WHERE kind = 'entity_snapshot' AND deletionRequestedAt IS NULL
      ORDER BY ownerKey ASC, createdAt DESC, resourceId DESC
    `).all() as Array<{ resourceId: string; ownerKey: string; createdAt: string }>;
    const seenOwners = new Set<string>();
    for (const row of activeSnapshots) {
      if (!seenOwners.has(row.ownerKey)) {
        seenOwners.add(row.ownerKey);
        continue;
      }
      snapshots += Number(db.prepare(`
        UPDATE external_xai_resources
        SET deletionRequestedAt = ?, lastError = NULL
        WHERE resourceId = ? AND deletionRequestedAt IS NULL
      `).run(now, row.resourceId).changes) || 0;
    }
    db.exec('COMMIT');
    return { chat, snapshots };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

export async function processPendingOwnedXaiDeletions(options: {
  nowMs?: number;
  tombstoneGraceMs?: number;
  deleteBatchSize?: number;
  kind?: OwnedXaiResourceKind;
} = {}): Promise<{ removed: number; pending: number; errors: string[] }> {
  ensureSchema();
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const tombstoneGraceMs = options.tombstoneGraceMs === 0
    ? 0
    : Math.max(60_000, Number(options.tombstoneGraceMs) || DEFAULT_TOMBSTONE_GRACE_MS);
  const deleteBatchSize = Math.max(
    1,
    Math.min(1_000, Math.floor(Number(options.deleteBatchSize) || DEFAULT_DELETE_BATCH_SIZE)),
  );
  const eligibleBefore = new Date(nowMs - tombstoneGraceMs).toISOString();
  const rows = getDb().prepare(`
    SELECT resourceId, ownershipToken, kind, ownerKey, filename, bytes,
      authSource, authFingerprint, createdAt, unreferencedAt, deletionRequestedAt,
      deletionAttempts, lastError
    FROM external_xai_resources
    WHERE deletionRequestedAt IS NOT NULL AND deletionRequestedAt <= ?
      AND (? IS NULL OR kind = ?)
    ORDER BY deletionRequestedAt ASC, resourceId ASC
    LIMIT ?
  `).all(eligibleBefore, options.kind || null, options.kind || null, deleteBatchSize) as OwnedXaiResourceRow[];
  let removed = 0;
  const errors: string[] = [];
  const tokens = new Map<string, string | null>();
  for (const row of rows) {
    const sourceKey = `${row.authSource || 'default'}:${row.authFingerprint}`;
    if (!tokens.has(sourceKey)) {
      try {
        tokens.set(sourceKey, await exactAuthToken(row.authSource, row.authFingerprint));
      } catch (error) {
        errors.push(`xAI deletion auth (${sourceKey}): ${error instanceof Error ? error.message : String(error)}`);
        tokens.set(sourceKey, null);
      }
    }
    const token = tokens.get(sourceKey);
    if (!token) continue;
    try {
      await deleteXaiFile(row.resourceId, token);
      getDb().prepare(`
        DELETE FROM external_xai_resources
        WHERE resourceId = ? AND deletionRequestedAt = ?
      `).run(row.resourceId, row.deletionRequestedAt);
      removed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/xAI delete 404/i.test(message)) {
        getDb().prepare('DELETE FROM external_xai_resources WHERE resourceId = ?').run(row.resourceId);
        removed += 1;
        continue;
      }
      getDb().prepare(`
        UPDATE external_xai_resources
        SET deletionAttempts = deletionAttempts + 1, lastError = ?
        WHERE resourceId = ? AND deletionRequestedAt IS NOT NULL
      `).run(message.slice(0, 2_000), row.resourceId);
      errors.push(`xAI deletion ${row.resourceId}: ${message}`);
    }
  }
  const pending = Number((getDb().prepare(`
    SELECT COUNT(*) AS count FROM external_xai_resources
    WHERE deletionRequestedAt IS NOT NULL AND (? IS NULL OR kind = ?)
  `).get(options.kind || null, options.kind || null) as { count: number }).count) || 0;
  return { removed, pending, errors };
}

/**
 * Reconcile only resources whose ownership was recorded before upload. Remote
 * files that merely share a Shiba-looking name are never adopted or deleted.
 */
export async function reconcileOwnedXaiResources(
  options: ReconcileOwnedXaiResourcesOptions = {},
): Promise<OwnedXaiCleanupReport> {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const chatUnreferencedAgeMs = Math.max(
    60_000,
    Number(options.chatUnreferencedAgeMs) || DEFAULT_CHAT_UNREFERENCED_AGE_MS,
  );
  const intentRetentionMs = Math.max(
    60_000,
    Number(options.intentRetentionMs) || DEFAULT_INTENT_RETENTION_MS,
  );
  const recovered = await recoverUploadIntents(nowMs, intentRetentionMs);
  const tombstoned = tombstoneUnownedResources(
    options.liveChatFileIds || new Set<string>(),
    nowMs,
    chatUnreferencedAgeMs,
  );
  const deleted = await processPendingOwnedXaiDeletions({
    nowMs,
    tombstoneGraceMs: options.tombstoneGraceMs,
    deleteBatchSize: options.deleteBatchSize,
  });
  return {
    uploadIntentsRecovered: recovered.recovered,
    uploadIntentsAbandoned: recovered.abandoned,
    uploadIntentsPending: recovered.pending,
    chatFilesTombstoned: tombstoned.chat,
    entitySnapshotsTombstoned: tombstoned.snapshots,
    remoteFilesDeleted: deleted.removed,
    deletionsPending: deleted.pending,
    errors: [...recovered.errors, ...deleted.errors],
  };
}

/** Test/diagnostic snapshot; contains identifiers and state, never credentials. */
export function inspectOwnedXaiResources(): {
  intents: OwnedXaiUploadIntent[];
  resources: OwnedXaiResourceRow[];
} {
  ensureSchema();
  return {
    intents: getDb().prepare(`
      SELECT id, kind, ownerKey, filename, bytes, authSource, authFingerprint, startedAt, lastError
      FROM external_xai_upload_intents ORDER BY startedAt, id
    `).all() as OwnedXaiUploadIntent[],
    resources: getDb().prepare(`
      SELECT resourceId, ownershipToken, kind, ownerKey, filename, bytes,
        authSource, authFingerprint, createdAt, unreferencedAt, deletionRequestedAt,
        deletionAttempts, lastError
      FROM external_xai_resources ORDER BY createdAt, resourceId
    `).all() as OwnedXaiResourceRow[],
  };
}

export function getActiveOwnedXaiResourceId(
  kind: OwnedXaiResourceKind,
  ownerKey: string,
): string | null {
  ensureSchema();
  const row = getDb().prepare(`
    SELECT resourceId FROM external_xai_resources
    WHERE kind = ? AND ownerKey = ? AND deletionRequestedAt IS NULL
    ORDER BY createdAt DESC, resourceId DESC LIMIT 1
  `).get(kind, normalizeOwnerKey(ownerKey)) as { resourceId: string } | undefined;
  return row?.resourceId || null;
}
