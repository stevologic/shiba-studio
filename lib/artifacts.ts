import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from './data-paths';
import { getDb } from './db';
import { getTask, recordTaskEvidence } from './task-ledger';
import { createTaskCheckpoint, getTaskCheckpoint, sealTaskCheckpoint } from './task-checkpoints';

export type ArtifactKind = 'html' | 'pdf' | 'word' | 'powerpoint' | 'excel' | 'image' | 'text' | 'other';
export type ArtifactAudience = 'private_link' | 'lan';

export interface ArtifactLiveSource {
  type: 'filesystem' | 'integration';
  reference: string;
  readOnly: true;
  approvedAt: string;
}
type ArtifactLiveSourceInput = Pick<ArtifactLiveSource, 'type' | 'reference'> & Partial<Pick<ArtifactLiveSource, 'readOnly' | 'approvedAt'>>;

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  checkpointId: string;
  version: number;
  filePath: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  renderStatus: 'pending' | 'passed' | 'failed';
  renderReport: Record<string, unknown>;
  evidenceId?: string;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  name: string;
  kind: ArtifactKind;
  mimeType: string;
  status: 'draft' | 'verified' | 'published' | 'archived';
  currentVersionId: string;
  sourceLineage: Record<string, unknown>;
  liveSource?: ArtifactLiveSource;
  createdAt: string;
  updatedAt: string;
  versions?: ArtifactVersion[];
}

export interface ArtifactAnnotation {
  id: string;
  artifactId: string;
  versionId: string;
  locator: { type: 'region' | 'page' | 'slide' | 'table' | 'cell'; page?: number; slide?: number; sheet?: string; cell?: string; x?: number; y?: number; width?: number; height?: number };
  comment: string;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt?: string;
}

export interface ArtifactPublication {
  id: string;
  artifactId: string;
  versionId: string;
  audience: ArtifactAudience;
  expiresAt?: string;
  createdAt: string;
  revokedAt?: string;
}

interface ArtifactRow {
  id: string; taskId: string; name: string; kind: ArtifactKind; mimeType: string;
  status: ArtifactRecord['status']; currentVersionId: string; sourceLineage: string;
  liveSource: string | null; createdAt: string; updatedAt: string;
}
interface VersionRow {
  id: string; artifactId: string; checkpointId: string; version: number; filePath: string;
  relativePath: string; sha256: string; bytes: number; renderStatus: ArtifactVersion['renderStatus'];
  renderReport: string; evidenceId: string | null; createdAt: string;
}
interface AnnotationRow {
  id: string; artifactId: string; versionId: string; locator: string; comment: string;
  status: ArtifactAnnotation['status']; createdAt: string; resolvedAt: string | null;
}
interface PublicationRow {
  id: string; artifactId: string; versionId: string; audience: string; expiresAt: string | null;
  createdAt: string; revokedAt: string | null;
}

// Checkpoints intentionally cap one file at 20 MiB. Artifact versions share
// those exact checkpoints, so accepting larger files here would create an
// unversioned side channel.
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 128 * 1024;
const AUTO_REGISTER_EXTENSIONS = new Set(['.html', '.htm', '.svg']);

function ensureSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      status TEXT NOT NULL,
      currentVersionId TEXT NOT NULL,
      sourceLineage TEXT NOT NULL DEFAULT '{}',
      liveSource TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(taskId, updatedAt DESC);
    CREATE TABLE IF NOT EXISTS artifact_versions (
      id TEXT PRIMARY KEY,
      artifactId TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      checkpointId TEXT NOT NULL,
      version INTEGER NOT NULL,
      filePath TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      renderStatus TEXT NOT NULL DEFAULT 'pending',
      renderReport TEXT NOT NULL DEFAULT '{}',
      evidenceId TEXT,
      createdAt TEXT NOT NULL,
      UNIQUE(artifactId, version),
      UNIQUE(artifactId, checkpointId)
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifactId, version DESC);
    CREATE TABLE IF NOT EXISTS artifact_annotations (
      id TEXT PRIMARY KEY,
      artifactId TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      versionId TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
      locator TEXT NOT NULL,
      comment TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      createdAt TEXT NOT NULL,
      resolvedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS artifact_publications (
      id TEXT PRIMARY KEY,
      artifactId TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      versionId TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
      tokenHash TEXT NOT NULL UNIQUE,
      audience TEXT NOT NULL,
      expiresAt TEXT,
      createdAt TEXT NOT NULL,
      revokedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_publications_artifact
      ON artifact_publications(artifactId, createdAt DESC);
  `);
}

function settleExpiredPublicationStatuses(): void {
  getDb().prepare(`
    UPDATE artifacts SET status = CASE
      WHEN EXISTS (
        SELECT 1 FROM artifact_versions
        WHERE artifact_versions.id = artifacts.currentVersionId
          AND artifact_versions.renderStatus = 'passed'
      ) THEN 'verified' ELSE 'draft' END
    WHERE status = 'published' AND NOT EXISTS (
      SELECT 1 FROM artifact_publications
      WHERE artifact_publications.artifactId = artifacts.id
        AND artifact_publications.revokedAt IS NULL
        AND (artifact_publications.expiresAt IS NULL OR artifact_publications.expiresAt > ?)
    )
  `).run(new Date().toISOString());
}

function parseObject<T>(raw: string | null, fallback: T): T {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

function checkedObject(value: unknown, label: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  let json: string;
  try { json = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON serializable`); }
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) throw new Error(`${label} exceeds ${MAX_JSON_BYTES} bytes`);
  return parseObject<Record<string, unknown>>(json, {});
}

function inTransaction<T>(operation: () => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

function rowToVersion(row: VersionRow): ArtifactVersion {
  const { renderReport, evidenceId, ...base } = row;
  return { ...base, renderReport: parseObject(renderReport, {}), ...(evidenceId ? { evidenceId } : {}) };
}

function rowToArtifact(row: ArtifactRow, versions?: ArtifactVersion[]): ArtifactRecord {
  const { sourceLineage, liveSource, ...base } = row;
  return {
    ...base,
    sourceLineage: parseObject(sourceLineage, {}),
    ...(liveSource ? { liveSource: parseObject<ArtifactLiveSource | undefined>(liveSource, undefined) } : {}),
    ...(versions ? { versions } : {}),
  };
}

function rowToPublication(row: PublicationRow): ArtifactPublication {
  return {
    id: row.id,
    artifactId: row.artifactId,
    versionId: row.versionId,
    audience: row.audience === 'lan' ? 'lan' : 'private_link',
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    createdAt: row.createdAt,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

function kindForPath(filePath: string): { kind: ArtifactKind; mimeType: string } {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return { kind: 'html', mimeType: 'text/html' };
  if (ext === '.pdf') return { kind: 'pdf', mimeType: 'application/pdf' };
  if (ext === '.docx') return { kind: 'word', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  if (ext === '.pptx') return { kind: 'powerpoint', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  if (ext === '.xlsx') return { kind: 'excel', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return { kind: 'image', mimeType: ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1).replace('jpg', 'jpeg')}` };
  if (['.txt', '.md', '.csv', '.json', '.log'].includes(ext)) return { kind: 'text', mimeType: 'text/plain; charset=utf-8' };
  return { kind: 'other', mimeType: 'application/octet-stream' };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveOwnedFile(taskId: string, requestedPath: string): Promise<{ absolute: string; relative: string; rootId: string }> {
  const task = getTask(taskId);
  if (!task) throw new Error('Task not found');
  const requested = path.resolve(String(requestedPath || ''));
  const absolute = await fs.realpath(requested).catch(() => null);
  const stat = await fs.lstat(requested).catch(() => null);
  if (!absolute || !stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error('Artifact must be a regular file inside a task-owned writable workspace root');
  }
  for (const root of task.workspaceRoots.filter((candidate) => candidate.permission === 'write')) {
    const rootReal = await fs.realpath(path.resolve(root.path)).catch(() => null);
    if (!rootReal || !inside(rootReal, absolute)) continue;
    if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    return { absolute, relative: path.relative(rootReal, absolute).replace(/\\/g, '/'), rootId: root.id };
  }
  throw new Error('Artifact must be a regular file inside a task-owned writable workspace root');
}

async function checkpointForFile(taskId: string, rootId: string, relative: string, digest: { sha256: string; bytes: number }): Promise<string> {
  const task = getTask(taskId)!;
  if (task.checkpointId) {
    const checkpoint = getTaskCheckpoint(task.checkpointId, task.id);
    const file = checkpoint?.files.find((candidate) => candidate.workspaceRootId === rootId && candidate.relativePath === relative);
    if (checkpoint?.state === 'ready' && file?.afterExists && file.afterHash === digest.sha256 && file.afterBytes === digest.bytes) return checkpoint.id;
  }
  const open = await createTaskCheckpoint({ taskId, reason: `Artifact version ${relative}`, files: [{ workspaceRootId: rootId, path: relative }], context: { artifactVersion: true } });
  const sealed = await sealTaskCheckpoint(taskId, open.id);
  const file = sealed.files.find((candidate) => candidate.workspaceRootId === rootId && candidate.relativePath === relative);
  if (!file?.afterExists || file.afterHash !== digest.sha256 || file.afterBytes !== digest.bytes) {
    throw new Error('Artifact source changed while its checkpoint was being captured; retry the registration');
  }
  return sealed.id;
}

async function fileDigest(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const content = await fs.readFile(filePath);
  return { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength };
}

async function snapshotArtifactFile(artifactId: string, versionId: string, sourcePath: string, content: Buffer): Promise<string> {
  const ext = path.extname(sourcePath).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 16);
  const directory = dataDir('artifacts', artifactId);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${versionId}${ext}`);
  await fs.writeFile(target, content, { flag: 'wx', mode: 0o444 });
  await fs.chmod(target, 0o444).catch(() => {});
  return target;
}

async function captureOwnedSource(taskId: string, filePath: string): Promise<{
  owned: Awaited<ReturnType<typeof resolveOwnedFile>>;
  content: Buffer;
  digest: { sha256: string; bytes: number };
  checkpointId: string;
}> {
  const owned = await resolveOwnedFile(taskId, filePath);
  const content = await fs.readFile(owned.absolute);
  if (content.byteLength > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  const digest = { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength };
  const checkpointId = await checkpointForFile(taskId, owned.rootId, owned.relative, digest);
  return { owned, content, digest, checkpointId };
}

async function normalizeLiveSource(taskId: string, source: ArtifactLiveSourceInput | undefined, approved: boolean): Promise<ArtifactLiveSource | undefined> {
  if (!source) return undefined;
  if (!approved) throw new Error('A live source requires explicit read-only approval');
  const reference = String(source.reference || '').trim();
  if (!reference || reference.length > 2_000) throw new Error('Live source reference is invalid');
  if (source.type === 'filesystem') {
    const owned = await resolveOwnedFile(taskId, reference);
    return { type: 'filesystem', reference: owned.absolute, readOnly: true, approvedAt: new Date().toISOString() };
  }
  if (source.type !== 'integration') throw new Error('Unsupported live source type');
  return { type: 'integration', reference, readOnly: true, approvedAt: new Date().toISOString() };
}

export async function createArtifact(input: {
  taskId: string;
  filePath: string;
  name?: string;
  sourceLineage?: Record<string, unknown>;
  liveSource?: ArtifactLiveSourceInput;
  approveLiveSource?: boolean;
}): Promise<ArtifactRecord> {
  ensureSchema();
  const captured = await captureOwnedSource(input.taskId, input.filePath);
  const format = kindForPath(captured.owned.absolute);
  const lineage = checkedObject(input.sourceLineage, 'Source lineage');
  const liveSource = await normalizeLiveSource(input.taskId, input.liveSource, input.approveLiveSource === true);
  const id = randomUUID();
  const versionId = randomUUID();
  const snapshotPath = await snapshotArtifactFile(id, versionId, captured.owned.absolute, captured.content);
  const now = new Date().toISOString();
  try {
    inTransaction(() => {
      getDb().prepare(`
        INSERT INTO artifacts (id, taskId, name, kind, mimeType, status, currentVersionId, sourceLineage, liveSource, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
      `).run(
        id, input.taskId, (input.name || path.basename(captured.owned.absolute)).trim().slice(0, 300) || path.basename(captured.owned.absolute),
        format.kind, format.mimeType, versionId,
        JSON.stringify({ ...lineage, sourcePath: captured.owned.absolute, workspaceRootId: captured.owned.rootId }),
        liveSource ? JSON.stringify(liveSource) : null, now, now,
      );
      getDb().prepare(`
        INSERT INTO artifact_versions (id, artifactId, checkpointId, version, filePath, relativePath, sha256, bytes, renderStatus, renderReport, createdAt)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'pending', '{}', ?)
      `).run(versionId, id, captured.checkpointId, snapshotPath, captured.owned.relative, captured.digest.sha256, captured.digest.bytes, now);
    });
  } catch (error) {
    await fs.unlink(snapshotPath).catch(() => {});
    throw error;
  }
  recordTaskEvidence({ taskId: input.taskId, kind: 'artifact', status: 'informational', label: input.name || path.basename(captured.owned.absolute), summary: 'Artifact registered; visual verification is still pending.', uri: captured.owned.absolute, scope: captured.owned.rootId, metadata: { artifactId: id, versionId, checkpointId: captured.checkpointId, path: captured.owned.relative } });
  return getArtifact(id)!;
}

export async function createArtifactVersion(artifactId: string, filePath?: string): Promise<ArtifactRecord> {
  ensureSchema();
  const artifact = getArtifact(artifactId);
  if (!artifact) throw new Error('Artifact not found');
  const sourcePath = filePath || (typeof artifact.sourceLineage.sourcePath === 'string' ? artifact.sourceLineage.sourcePath : '');
  const captured = await captureOwnedSource(artifact.taskId, sourcePath);
  const format = kindForPath(captured.owned.absolute);
  if (format.kind !== artifact.kind || format.mimeType !== artifact.mimeType) throw new Error('A new version must use the artifact original file format');
  const current = artifact.versions!.find((version) => version.id === artifact.currentVersionId)!;
  if (current.sha256 === captured.digest.sha256 && current.bytes === captured.digest.bytes) throw new Error('Artifact source is unchanged');
  const latest = Math.max(...artifact.versions!.map((version) => version.version));
  const id = randomUUID();
  const snapshotPath = await snapshotArtifactFile(artifact.id, id, captured.owned.absolute, captured.content);
  const now = new Date().toISOString();
  try {
    inTransaction(() => {
      getDb().prepare(`
        INSERT INTO artifact_versions (id, artifactId, checkpointId, version, filePath, relativePath, sha256, bytes, renderStatus, renderReport, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?)
      `).run(id, artifact.id, captured.checkpointId, latest + 1, snapshotPath, captured.owned.relative, captured.digest.sha256, captured.digest.bytes, now);
      getDb().prepare('UPDATE artifacts SET currentVersionId = ?, updatedAt = ? WHERE id = ?').run(id, now, artifact.id);
    });
  } catch (error) {
    await fs.unlink(snapshotPath).catch(() => {});
    throw error;
  }
  recomputeArtifactStatus(artifact.id);
  return getArtifact(artifact.id)!;
}

export function getArtifact(id: string): ArtifactRecord | null {
  ensureSchema();
  settleExpiredPublicationStatuses();
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
  if (!row) return null;
  const versions = (getDb().prepare(`
    SELECT artifact_versions.* FROM artifact_versions
    JOIN task_checkpoints ON task_checkpoints.id = artifact_versions.checkpointId
    WHERE artifact_versions.artifactId = ? AND task_checkpoints.taskId = ? AND task_checkpoints.state = 'ready'
    ORDER BY artifact_versions.version DESC
  `).all(id, row.taskId) as VersionRow[]).map(rowToVersion);
  return rowToArtifact(row, versions);
}

export function listArtifacts(taskId?: string): ArtifactRecord[] {
  ensureSchema();
  settleExpiredPublicationStatuses();
  const rows = (taskId
    ? getDb().prepare('SELECT * FROM artifacts WHERE taskId = ? ORDER BY updatedAt DESC').all(taskId)
    : getDb().prepare('SELECT * FROM artifacts ORDER BY updatedAt DESC LIMIT 500').all()) as ArtifactRow[];
  return rows.map((row) => rowToArtifact(row));
}

export function getArtifactVersion(artifactId: string, versionId: string): ArtifactVersion | null {
  ensureSchema();
  const row = getDb().prepare(`
    SELECT artifact_versions.* FROM artifact_versions
    JOIN artifacts ON artifacts.id = artifact_versions.artifactId
    JOIN task_checkpoints ON task_checkpoints.id = artifact_versions.checkpointId
    WHERE artifact_versions.id = ? AND artifact_versions.artifactId = ?
      AND task_checkpoints.taskId = artifacts.taskId AND task_checkpoints.state = 'ready'
  `).get(versionId, artifactId) as VersionRow | undefined;
  return row ? rowToVersion(row) : null;
}

function recomputeArtifactStatus(artifactId: string): void {
  const artifact = getArtifact(artifactId);
  if (!artifact || artifact.status === 'archived') return;
  const hasActivePublication = !!getDb().prepare(`
    SELECT 1 FROM artifact_publications
    WHERE artifactId = ? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?)
    LIMIT 1
  `).get(artifact.id, new Date().toISOString());
  const current = artifact.versions?.find((version) => version.id === artifact.currentVersionId);
  const status: ArtifactRecord['status'] = hasActivePublication ? 'published' : current?.renderStatus === 'passed' ? 'verified' : 'draft';
  getDb().prepare('UPDATE artifacts SET status = ?, updatedAt = ? WHERE id = ?').run(status, new Date().toISOString(), artifact.id);
}

export async function verifyArtifactVersion(input: { artifactId: string; versionId: string; passed: boolean; renderer: string; notes: string; metadata?: Record<string, unknown> }): Promise<ArtifactRecord> {
  const artifact = getArtifact(input.artifactId);
  const version = getArtifactVersion(input.artifactId, input.versionId);
  if (!artifact || !version) throw new Error('Artifact version not found');
  const currentDigest = await fileDigest(version.filePath);
  if (version.sha256 !== currentDigest.sha256 || version.bytes !== currentDigest.bytes) throw new Error('Artifact version bytes changed after registration');
  const renderer = String(input.renderer || '').trim().slice(0, 200);
  if (!renderer) throw new Error('Renderer is required');
  const notes = String(input.notes || '').trim().slice(0, 20_000);
  const metadata = checkedObject(input.metadata, 'Render metadata');
  const evidence = recordTaskEvidence({
    taskId: artifact.taskId,
    kind: 'artifact',
    status: input.passed ? 'passed' : 'failed',
    label: artifact.name,
    summary: notes || (input.passed ? 'Rendered artifact passed visual review.' : 'Rendered artifact failed visual review.'),
    uri: version.filePath,
    metadata: { artifactId: artifact.id, versionId: version.id, checkpointId: version.checkpointId, path: version.relativePath, ...metadata, renderer },
  });
  const now = new Date().toISOString();
  inTransaction(() => {
    getDb().prepare('UPDATE artifact_versions SET renderStatus = ?, renderReport = ?, evidenceId = ? WHERE id = ?')
      .run(input.passed ? 'passed' : 'failed', JSON.stringify({ ...metadata, renderer, notes, verifiedAt: now }), evidence.id, version.id);
    getDb().prepare('UPDATE artifacts SET updatedAt = ? WHERE id = ?').run(now, artifact.id);
  });
  recomputeArtifactStatus(artifact.id);
  return getArtifact(artifact.id)!;
}

function normalizeLocator(value: unknown): ArtifactAnnotation['locator'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Annotation locator must be an object');
  const raw = value as Record<string, unknown>;
  const type = String(raw.type || '');
  if (type === 'page' || type === 'slide') {
    const field = type === 'page' ? 'page' : 'slide';
    const position = Number(raw[field]);
    if (!Number.isInteger(position) || position < 1 || position > 100_000) throw new Error(`${field} must be a positive integer`);
    return type === 'page' ? { type, page: position } : { type, slide: position };
  }
  if (type === 'cell') {
    const cell = String(raw.cell || '').trim().toUpperCase();
    const sheet = raw.sheet == null ? undefined : String(raw.sheet).trim().slice(0, 200);
    if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cell)) throw new Error('Cell must use A1 notation');
    return { type, cell, ...(sheet ? { sheet } : {}) };
  }
  if (type === 'table') {
    const sheet = String(raw.sheet || '').trim().slice(0, 200);
    return { type, ...(sheet ? { sheet } : {}) };
  }
  if (type === 'region') {
    const numbers = ['x', 'y', 'width', 'height'].map((field) => Number(raw[field]));
    if (numbers.some((number) => !Number.isFinite(number) || number < 0 || number > 1)) {
      throw new Error('Region x, y, width, and height must be normalized values from 0 to 1');
    }
    if (numbers[2] === 0 || numbers[3] === 0 || numbers[0] + numbers[2] > 1 || numbers[1] + numbers[3] > 1) {
      throw new Error('Region dimensions must fit within the artifact');
    }
    return { type, x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
  }
  throw new Error('Unsupported annotation locator type');
}

export function addArtifactAnnotation(input: { artifactId: string; versionId: string; locator: ArtifactAnnotation['locator']; comment: string }): ArtifactAnnotation {
  const artifact = getArtifact(input.artifactId);
  const version = getArtifactVersion(input.artifactId, input.versionId);
  if (!artifact || !version) throw new Error('Artifact version not found');
  const comment = String(input.comment || '').trim();
  if (!comment) throw new Error('Annotation comment is required');
  const locator = normalizeLocator(input.locator);
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO artifact_annotations (id, artifactId, versionId, locator, comment, status, createdAt)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
  `).run(id, input.artifactId, input.versionId, JSON.stringify(locator), comment.slice(0, 10_000), now);
  recordTaskEvidence({
    taskId: artifact.taskId,
    kind: 'artifact',
    status: 'informational',
    label: `Revision feedback: ${artifact.name}`,
    summary: comment.slice(0, 10_000),
    uri: version.filePath,
    metadata: { artifactId: artifact.id, versionId: version.id, checkpointId: version.checkpointId, locator, annotationId: id, revisionContext: true },
  });
  return listArtifactAnnotations(input.artifactId).find((annotation) => annotation.id === id)!;
}

export function listArtifactAnnotations(artifactId: string): ArtifactAnnotation[] {
  ensureSchema();
  return (getDb().prepare('SELECT * FROM artifact_annotations WHERE artifactId = ? ORDER BY createdAt DESC').all(artifactId) as AnnotationRow[])
    .map((row) => {
      const { locator, resolvedAt, ...base } = row;
      return { ...base, locator: parseObject(locator, { type: 'region' as const, x: 0, y: 0, width: 1, height: 1 }), ...(resolvedAt ? { resolvedAt } : {}) };
    });
}

export function resolveArtifactAnnotation(artifactId: string, annotationId: string, resolved: boolean): ArtifactAnnotation {
  ensureSchema();
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE artifact_annotations SET status = ?, resolvedAt = ?
    WHERE id = ? AND artifactId = ?
  `).run(resolved ? 'resolved' : 'open', resolved ? now : null, annotationId, artifactId);
  if (!result.changes) throw new Error('Artifact annotation not found');
  return listArtifactAnnotations(artifactId).find((annotation) => annotation.id === annotationId)!;
}

export function publishArtifact(input: { artifactId: string; versionId: string; audience: ArtifactAudience; ttlHours?: number }): ArtifactPublication & { token: string } {
  const artifact = getArtifact(input.artifactId);
  const version = getArtifactVersion(input.artifactId, input.versionId);
  if (!artifact || !version) throw new Error('Artifact version not found');
  if (artifact.status === 'archived') throw new Error('Archived artifacts cannot be published');
  if (version.renderStatus !== 'passed') throw new Error('Only a visually verified artifact version can be published');
  if (input.audience !== 'private_link' && input.audience !== 'lan') throw new Error('Unsupported publication audience');
  const token = `sha_${randomBytes(32).toString('base64url')}`;
  const ttlHours = Math.max(1, Math.min(720, Number(input.ttlHours) || 168));
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  inTransaction(() => {
    getDb().prepare(`
      INSERT INTO artifact_publications (id, artifactId, versionId, tokenHash, audience, expiresAt, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, artifact.id, version.id, createHash('sha256').update(token).digest('hex'), input.audience, expiresAt, createdAt);
    getDb().prepare("UPDATE artifacts SET status = 'published', updatedAt = ? WHERE id = ?").run(createdAt, artifact.id);
  });
  return { id, artifactId: artifact.id, versionId: version.id, audience: input.audience, expiresAt, createdAt, token };
}

export function listArtifactPublications(artifactId: string): ArtifactPublication[] {
  ensureSchema();
  if (!getArtifact(artifactId)) throw new Error('Artifact not found');
  return (getDb().prepare(`
    SELECT id, artifactId, versionId, audience, expiresAt, createdAt, revokedAt
    FROM artifact_publications WHERE artifactId = ? ORDER BY createdAt DESC
  `).all(artifactId) as PublicationRow[]).map(rowToPublication);
}

export function resolvePublishedArtifact(token: string): { artifact: ArtifactRecord; version: ArtifactVersion; publication: ArtifactPublication } | null {
  ensureSchema();
  const normalized = String(token || '').trim();
  if (!/^sha_[A-Za-z0-9_-]{43}$/.test(normalized)) return null;
  const hash = createHash('sha256').update(normalized).digest('hex');
  const row = getDb().prepare(`
    SELECT id, artifactId, versionId, audience, expiresAt, createdAt, revokedAt FROM artifact_publications
    WHERE tokenHash = ? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?)
  `).get(hash, new Date().toISOString()) as PublicationRow | undefined;
  if (!row) return null;
  const artifact = getArtifact(row.artifactId);
  const version = getArtifactVersion(row.artifactId, row.versionId);
  return artifact && artifact.status !== 'archived' && version ? { artifact, version, publication: rowToPublication(row) } : null;
}

export function revokeArtifactPublications(artifactId: string, publicationId?: string): number {
  ensureSchema();
  if (!getArtifact(artifactId)) throw new Error('Artifact not found');
  const changes = (publicationId
    ? getDb().prepare('UPDATE artifact_publications SET revokedAt = ? WHERE artifactId = ? AND id = ? AND revokedAt IS NULL').run(new Date().toISOString(), artifactId, publicationId)
    : getDb().prepare('UPDATE artifact_publications SET revokedAt = ? WHERE artifactId = ? AND revokedAt IS NULL').run(new Date().toISOString(), artifactId)).changes;
  recomputeArtifactStatus(artifactId);
  return Number(changes);
}

export function takeDownArtifact(artifactId: string): ArtifactRecord {
  const artifact = getArtifact(artifactId);
  if (!artifact) throw new Error('Artifact not found');
  const now = new Date().toISOString();
  inTransaction(() => {
    getDb().prepare('UPDATE artifact_publications SET revokedAt = ? WHERE artifactId = ? AND revokedAt IS NULL').run(now, artifact.id);
    getDb().prepare("UPDATE artifacts SET status = 'archived', updatedAt = ? WHERE id = ?").run(now, artifact.id);
  });
  return getArtifact(artifact.id)!;
}

export function rollbackArtifact(artifactId: string, versionId: string): ArtifactRecord {
  const artifact = getArtifact(artifactId);
  const version = getArtifactVersion(artifactId, versionId);
  if (!artifact || !version) throw new Error('Artifact version not found');
  if (artifact.status === 'archived') throw new Error('Archived artifacts must be restored before rollback');
  getDb().prepare('UPDATE artifacts SET currentVersionId = ?, updatedAt = ? WHERE id = ?').run(version.id, new Date().toISOString(), artifact.id);
  recomputeArtifactStatus(artifact.id);
  return getArtifact(artifact.id)!;
}

export async function refreshLiveArtifact(artifactId: string): Promise<ArtifactRecord> {
  const artifact = getArtifact(artifactId);
  if (!artifact) throw new Error('Artifact not found');
  if (!artifact.liveSource?.readOnly || !artifact.liveSource.approvedAt) throw new Error('Artifact has no explicitly approved read-only live source');
  if (artifact.liveSource.type !== 'filesystem') {
    throw new Error('This integration has no registered read-only artifact reader');
  }
  return createArtifactVersion(artifact.id, artifact.liveSource.reference);
}

export function publicationAudienceAllowsRequest(publication: ArtifactPublication, request: Request): boolean {
  if (publication.audience === 'private_link') return true;
  const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname === '::1') return true;
  if (hostname.includes(':')) return /^(fc|fd|fe8|fe9|fea|feb)/i.test(hostname.replace(/:/g, ''));
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 169 && parts[1] === 254);
}

export async function autoRegisterArtifactWrite(input: { taskId: string; filePath: string; runId?: string }): Promise<ArtifactRecord | null> {
  if (!AUTO_REGISTER_EXTENSIONS.has(path.extname(input.filePath).toLowerCase())) return null;
  const absolute = path.resolve(input.filePath);
  const existing = listArtifacts(input.taskId).find((artifact) => artifact.sourceLineage.sourcePath === absolute);
  if (existing) {
    const full = getArtifact(existing.id)!;
    const source = await fs.readFile(absolute).catch(() => null);
    if (!source) return null;
    const digest = createHash('sha256').update(source).digest('hex');
    const current = full.versions?.find((version) => version.id === full.currentVersionId);
    if (current?.sha256 === digest && current.bytes === source.byteLength) return full;
    return createArtifactVersion(full.id, absolute);
  }
  return createArtifact({
    taskId: input.taskId,
    filePath: absolute,
    sourceLineage: { origin: 'agent_fs_write', ...(input.runId ? { runId: input.runId } : {}) },
  });
}

export async function artifactVersionResponse(artifact: ArtifactRecord, version: ArtifactVersion): Promise<Response> {
  if (version.artifactId !== artifact.id) return Response.json({ ok: false, error: 'Artifact version ownership mismatch' }, { status: 409 });
  const bytes = await fs.readFile(version.filePath).catch(() => null);
  if (!bytes) return Response.json({ ok: false, error: 'Artifact version bytes are unavailable' }, { status: 410 });
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== version.sha256 || bytes.byteLength !== version.bytes) return Response.json({ ok: false, error: 'Artifact version integrity check failed' }, { status: 409 });
  const safeName = artifact.name.replace(/[\r\n"\\]/g, '').slice(0, 180) || 'artifact';
  const headers = new Headers({
    'Content-Type': artifact.mimeType,
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${safeName}"`,
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  });
  if (artifact.kind === 'html') {
    // The iframe may execute the artifact's own scripts, but CSP forces a
    // unique opaque origin with no network, storage, forms, popups, or access
    // to the Studio origin.
    headers.set('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; frame-src 'none'; object-src 'none'; worker-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline' blob:; font-src data:");
  } else if (artifact.mimeType === 'image/svg+xml') {
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  }
  return new Response(new Uint8Array(bytes), { headers });
}
