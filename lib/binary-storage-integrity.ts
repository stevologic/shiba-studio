import path from 'node:path';
import { dataDir } from './data-paths';
import { getDb } from './db';
import {
  quarantineManagedPath,
  recordManagedStorageIssue,
  recoverPreparedManagedQuarantines,
  type PreparedQuarantineRecovery,
} from './managed-storage-quarantine';
import { publishTaskChanges, transitionTaskInOpenTransaction } from './task-ledger';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs = builtinFs.promises;

const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60_000;

type ReferenceProblem = 'missing' | 'outside_managed_root' | 'not_a_regular_file';

interface ReferenceClassification {
  problem?: ReferenceProblem;
  managedPath?: string;
}

interface StoredPathRow {
  id: string;
  filePath: string;
}

interface ArtifactVersionPathRow extends StoredPathRow {
  artifactId: string;
  evidenceId: string | null;
}

interface MeetingAudioPathRow {
  id: string;
  taskId: string;
  status: string;
  audioPath: string;
  audioDeletedAt: string | null;
  deletedAt: string | null;
}

interface NativeJobResultRow {
  id: string;
  result: string;
}

interface RunTraceRow {
  id: string;
  trace: string;
}

interface BrowserTraceIssue {
  runId: string;
  storedPath: string;
  problem: ReferenceProblem;
}

interface BrowserTraceRepair {
  row: RunTraceRow;
  trace: unknown[];
  issues: BrowserTraceIssue[];
}

interface BrokenReference<T> {
  row: T;
  problem: ReferenceProblem | 'retired';
}

export interface BinaryOrphanSweepReport {
  filesQuarantined: number;
  bytesQuarantined: number;
  youngFilesRetained: number;
  emptyDirectoriesRemoved: number;
  errors: string[];
}

export interface ArtifactBinaryIntegrityReport extends BinaryOrphanSweepReport {
  referencesRepaired: number;
  artifactsRemoved: number;
  currentVersionsReassigned: number;
  ownershipScanComplete: boolean;
}

export interface MeetingAudioIntegrityReport extends BinaryOrphanSweepReport {
  referencesRepaired: number;
  activeMeetingsFailed: number;
  activeTasksFailed: number;
  ownershipScanComplete: boolean;
}

export interface NativeCaptureIntegrityReport extends BinaryOrphanSweepReport {
  referencesRepaired: number;
  ownershipScanComplete: boolean;
}

export type BrowserScreenshotIntegrityReport = NativeCaptureIntegrityReport;

export interface BinaryStorageIntegrityReport {
  startedAt: string;
  completedAt: string;
  quarantineRecovery: PreparedQuarantineRecovery;
  artifacts: ArtifactBinaryIntegrityReport;
  meetingAudio: MeetingAudioIntegrityReport;
  nativeCaptures: NativeCaptureIntegrityReport;
  browserScreenshots: BrowserScreenshotIntegrityReport;
  legacyRuns: BinaryOrphanSweepReport;
  errors: string[];
}

export interface BinaryStorageIntegrityOptions {
  nowMs?: number;
  /** Grace for files that have no authoritative SQLite owner. */
  minOrphanAgeMs?: number;
}

interface BinaryStorageGlobals {
  __shibaBinaryStorageIntegrityPass?: Promise<BinaryStorageIntegrityReport>;
}

const globals = globalThis as typeof globalThis & BinaryStorageGlobals;

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function duration(value: number | undefined, fallback: number): number {
  return Math.max(0, finiteNumber(value, fallback));
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function tableExists(name: string): boolean {
  return Boolean(getDb().prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function emptySweepReport(): BinaryOrphanSweepReport {
  return {
    filesQuarantined: 0,
    bytesQuarantined: 0,
    youngFilesRetained: 0,
    emptyDirectoriesRemoved: 0,
    errors: [],
  };
}

function artifactReport(): ArtifactBinaryIntegrityReport {
  return {
    ...emptySweepReport(),
    referencesRepaired: 0,
    artifactsRemoved: 0,
    currentVersionsReassigned: 0,
    ownershipScanComplete: false,
  };
}

function meetingReport(): MeetingAudioIntegrityReport {
  return {
    ...emptySweepReport(),
    referencesRepaired: 0,
    activeMeetingsFailed: 0,
    activeTasksFailed: 0,
    ownershipScanComplete: false,
  };
}

function nativeReport(): NativeCaptureIntegrityReport {
  return {
    ...emptySweepReport(),
    referencesRepaired: 0,
    ownershipScanComplete: false,
  };
}

function browserReport(): BrowserScreenshotIntegrityReport {
  return nativeReport();
}

async function classifyReference(storedPath: string, managedRoot: string): Promise<ReferenceClassification> {
  if (!path.isAbsolute(storedPath)) return { problem: 'outside_managed_root' };
  const candidate = path.resolve(storedPath);
  if (!isInside(managedRoot, candidate) || pathKey(candidate) === pathKey(managedRoot)) {
    return { problem: 'outside_managed_root' };
  }
  const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return { problem: 'missing', managedPath: candidate };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { problem: 'not_a_regular_file', managedPath: candidate };
  }
  // A lexical child can still escape through an intermediate junction/symlink.
  // Resolve both sides before accepting the database ownership pointer.
  const [realRoot, realCandidate] = await Promise.all([
    fs.realpath(managedRoot),
    fs.realpath(candidate),
  ]);
  if (!isInside(realRoot, realCandidate)) return { problem: 'outside_managed_root' };
  return { managedPath: candidate };
}

async function recordReferenceIssue(
  reason: string,
  details: Record<string, unknown>,
  nowMs: number,
  errors: string[],
): Promise<void> {
  try {
    await recordManagedStorageIssue(reason, details, nowMs);
  } catch (error) {
    errors.push(`lost+found issue record: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function quarantineUnreferencedFiles(
  managedRoot: string,
  referencedPaths: ReadonlySet<string>,
  reason: string,
  nowMs: number,
  minAgeMs: number,
): Promise<BinaryOrphanSweepReport> {
  const report = emptySweepReport();
  const dataRoot = dataDir();

  const walk = async (directory: string, isRoot = false): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(candidate);
        continue;
      }
      if (referencedPaths.has(pathKey(candidate))) continue;
      const stat = await fs.lstat(candidate).catch(() => null);
      if (!stat) continue;
      const ageMs = nowMs - stat.mtimeMs;
      if (!Number.isFinite(ageMs) || ageMs < minAgeMs) {
        report.youngFilesRetained += 1;
        continue;
      }
      try {
        await quarantineManagedPath(candidate, reason, {
          originalRelativePath: path.relative(dataRoot, candidate),
        }, nowMs);
        report.filesQuarantined += 1;
        report.bytesQuarantined += stat.isFile() ? stat.size : 0;
      } catch (error) {
        report.errors.push(`${path.relative(dataRoot, candidate)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (isRoot) return;
    // Directories carry no user bytes. Remove them only if the leaf sweep made
    // them empty; ENOTEMPTY also closes a concurrent-create race safely.
    try {
      await fs.rmdir(directory);
      report.emptyDirectoriesRemoved += 1;
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String((error as NodeJS.ErrnoException).code))) {
        report.errors.push(`${path.relative(dataRoot, directory)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  try {
    await walk(managedRoot, true);
  } catch (error) {
    report.errors.push(`${path.relative(dataRoot, managedRoot)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report;
}

function mergeSweep(target: BinaryOrphanSweepReport, source: BinaryOrphanSweepReport): void {
  target.filesQuarantined += source.filesQuarantined;
  target.bytesQuarantined += source.bytesQuarantined;
  target.youngFilesRetained += source.youngFilesRetained;
  target.emptyDirectoriesRemoved += source.emptyDirectoriesRemoved;
  target.errors.push(...source.errors);
}

function repairArtifactReferences(
  broken: ReadonlyArray<BrokenReference<ArtifactVersionPathRow>>,
  now: string,
  report: ArtifactBinaryIntegrityReport,
): void {
  if (!broken.length) return;
  const db = getDb();
  const hasAnnotations = tableExists('artifact_annotations');
  const hasPublications = tableExists('artifact_publications');
  const hasEvidence = tableExists('task_evidence');
  const affectedArtifacts = new Set<string>();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { row } of broken) {
      const removed = db.prepare('DELETE FROM artifact_versions WHERE id = ? AND filePath = ?')
        .run(row.id, row.filePath);
      if (Number(removed.changes) !== 1) continue;
      if (hasAnnotations) db.prepare('DELETE FROM artifact_annotations WHERE versionId = ?').run(row.id);
      if (hasPublications) db.prepare('DELETE FROM artifact_publications WHERE versionId = ?').run(row.id);
      if (hasEvidence) {
        db.prepare(`
          UPDATE task_evidence
          SET uri = NULL,
              status = 'failed',
              summary = CASE
                WHEN instr(summary, 'Artifact snapshot unavailable') > 0 THEN summary
                ELSE summary || ' Artifact snapshot unavailable after storage reconciliation.'
              END,
              metadata = json_set(
                CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                '$.storageUnavailable', 1,
                '$.storageUnavailableAt', ?
              )
          WHERE id = ? OR (
            CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.versionId') END
          ) = ?
        `).run(now, row.evidenceId || '', row.id);
      }
      report.referencesRepaired += 1;
      affectedArtifacts.add(row.artifactId);
    }

    for (const artifactId of affectedArtifacts) {
      const artifact = db.prepare('SELECT status, currentVersionId FROM artifacts WHERE id = ?')
        .get(artifactId) as { status: string; currentVersionId: string } | undefined;
      if (!artifact) continue;
      const latest = db.prepare(`
        SELECT id, renderStatus FROM artifact_versions
        WHERE artifactId = ? ORDER BY version DESC, createdAt DESC LIMIT 1
      `).get(artifactId) as { id: string; renderStatus: string } | undefined;
      if (!latest) {
        if (hasAnnotations) db.prepare('DELETE FROM artifact_annotations WHERE artifactId = ?').run(artifactId);
        if (hasPublications) db.prepare('DELETE FROM artifact_publications WHERE artifactId = ?').run(artifactId);
        const removed = db.prepare('DELETE FROM artifacts WHERE id = ?').run(artifactId);
        report.artifactsRemoved += Number(removed.changes) || 0;
        continue;
      }
      const currentExists = Boolean(db.prepare(`
        SELECT 1 FROM artifact_versions WHERE id = ? AND artifactId = ?
      `).get(artifact.currentVersionId, artifactId));
      if (!currentExists) report.currentVersionsReassigned += 1;
      const selected = currentExists
        ? db.prepare('SELECT id, renderStatus FROM artifact_versions WHERE id = ?')
          .get(artifact.currentVersionId) as { id: string; renderStatus: string }
        : latest;
      const activelyPublished = hasPublications && Boolean(db.prepare(`
        SELECT 1 FROM artifact_publications
        WHERE artifactId = ? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?)
        LIMIT 1
      `).get(artifactId, now));
      const status = artifact.status === 'archived'
        ? 'archived'
        : activelyPublished
          ? 'published'
          : selected.renderStatus === 'passed' ? 'verified' : 'draft';
      db.prepare('UPDATE artifacts SET currentVersionId = ?, status = ?, updatedAt = ? WHERE id = ?')
        .run(selected.id, status, now, artifactId);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

async function reconcileArtifacts(
  nowMs: number,
  minAgeMs: number,
): Promise<ArtifactBinaryIntegrityReport> {
  const report = artifactReport();
  const managedRoot = dataDir('artifacts');
  const referenced = new Set<string>();
  const broken: Array<BrokenReference<ArtifactVersionPathRow>> = [];
  try {
    const rows = tableExists('artifact_versions')
      ? getDb().prepare('SELECT id, artifactId, filePath, evidenceId FROM artifact_versions').all() as unknown as ArtifactVersionPathRow[]
      : [];
    for (const row of rows) {
      const classification = await classifyReference(row.filePath, managedRoot);
      if (classification.problem) broken.push({ row, problem: classification.problem });
      else if (classification.managedPath) referenced.add(pathKey(classification.managedPath));
    }
    repairArtifactReferences(broken, new Date(nowMs).toISOString(), report);
    report.ownershipScanComplete = true;
    for (const issue of broken) {
      await recordReferenceIssue('artifact_version_file_reference_repaired', {
        artifactId: issue.row.artifactId,
        versionId: issue.row.id,
        storedPath: issue.row.filePath,
        problem: issue.problem,
      }, nowMs, report.errors);
    }
  } catch (error) {
    report.errors.push(`ownership: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (report.ownershipScanComplete) {
    mergeSweep(report, await quarantineUnreferencedFiles(
      managedRoot, referenced, 'unowned_artifact_snapshot', nowMs, minAgeMs,
    ));
  }
  return report;
}

function repairMeetingReferences(
  broken: ReadonlyArray<BrokenReference<MeetingAudioPathRow>>,
  now: string,
  report: MeetingAudioIntegrityReport,
): void {
  if (!broken.length) return;
  const db = getDb();
  const hasEvidence = tableExists('task_evidence');
  const hasTasks = tableExists('tasks');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { row } of broken) {
      const activeWithoutAudio = row.status === 'uploaded' || row.status === 'transcribing';
      const repaired = db.prepare(`
        UPDATE meetings
        SET audioPath = NULL,
            audioDeletedAt = COALESCE(audioDeletedAt, ?),
            deleteAudioAt = NULL,
            status = CASE WHEN status IN ('uploaded', 'transcribing') THEN 'failed' ELSE status END,
            error = CASE
              WHEN status IN ('uploaded', 'transcribing')
                THEN 'Meeting audio was unavailable during storage reconciliation.'
              ELSE error
            END,
            version = version + 1,
            updatedAt = ?
        WHERE id = ? AND audioPath = ?
      `).run(now, now, row.id, row.audioPath);
      if (Number(repaired.changes) !== 1) continue;
      report.referencesRepaired += 1;
      if (activeWithoutAudio) report.activeMeetingsFailed += 1;
      if (activeWithoutAudio && hasTasks) {
        const task = db.prepare('SELECT status FROM tasks WHERE id = ?')
          .get(row.taskId) as { status: string } | undefined;
        if (task && ['queued', 'running', 'paused', 'waiting_for_input', 'waiting_for_approval', 'blocked'].includes(task.status)) {
          transitionTaskInOpenTransaction({
            taskId: row.taskId,
            status: 'failed',
            error: 'Meeting audio was unavailable during storage reconciliation.',
            metadata: {
              meetingId: row.id,
              meetingStorageUnavailable: true,
              meetingStorageUnavailableAt: now,
            },
          });
          report.activeTasksFailed += 1;
        }
      }
      if (hasEvidence) {
        db.prepare(`
          UPDATE task_evidence
          SET uri = NULL,
              status = 'failed',
              summary = CASE
                WHEN instr(summary, 'Recording unavailable') > 0 THEN summary
                ELSE summary || ' Recording unavailable after storage reconciliation.'
              END,
              metadata = json_set(
                CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                '$.storageUnavailable', 1,
                '$.storageUnavailableAt', ?
              )
          WHERE taskId = ? AND uri = ?
        `).run(now, row.taskId, `/api/meetings/${row.id}/audio`);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
  if (report.activeTasksFailed) publishTaskChanges(true);
}

async function reconcileMeetingAudio(
  nowMs: number,
  minAgeMs: number,
): Promise<MeetingAudioIntegrityReport> {
  const report = meetingReport();
  const managedRoot = dataDir('meetings', 'audio');
  const referenced = new Set<string>();
  const broken: Array<BrokenReference<MeetingAudioPathRow>> = [];
  try {
    const rows = tableExists('meetings')
      ? getDb().prepare(`
          SELECT id, taskId, status, audioPath, audioDeletedAt, deletedAt
          FROM meetings WHERE audioPath IS NOT NULL
        `).all() as unknown as MeetingAudioPathRow[]
      : [];
    for (const row of rows) {
      if (row.audioDeletedAt || row.deletedAt) {
        broken.push({ row, problem: 'retired' });
        continue;
      }
      const classification = await classifyReference(row.audioPath, managedRoot);
      if (classification.problem) broken.push({ row, problem: classification.problem });
      else if (classification.managedPath) referenced.add(pathKey(classification.managedPath));
    }
    repairMeetingReferences(broken, new Date(nowMs).toISOString(), report);
    report.ownershipScanComplete = true;
    for (const issue of broken) {
      await recordReferenceIssue('meeting_audio_file_reference_repaired', {
        meetingId: issue.row.id,
        storedPath: issue.row.audioPath,
        problem: issue.problem,
      }, nowMs, report.errors);
    }
  } catch (error) {
    report.errors.push(`ownership: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (report.ownershipScanComplete) {
    mergeSweep(report, await quarantineUnreferencedFiles(
      managedRoot, referenced, 'unowned_meeting_audio', nowMs, minAgeMs,
    ));
  }
  return report;
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function repairNativeReferences(
  broken: ReadonlyArray<BrokenReference<NativeJobResultRow>>,
  parsedResults: ReadonlyMap<string, Record<string, unknown>>,
  now: string,
  report: NativeCaptureIntegrityReport,
  protectedPaths: Set<string>,
): void {
  if (!broken.length) return;
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { row, problem } of broken) {
      const parsed = parsedResults.get(row.id);
      const screenshotPath = parsed?.screenshotPath;
      if (!parsed || typeof screenshotPath !== 'string') continue;
      const next = { ...parsed };
      delete next.screenshotPath;
      next.screenshotUnavailable = {
        reason: problem === 'retired' ? 'retired' : problem,
        detectedAt: now,
      };
      const repaired = db.prepare('UPDATE native_node_jobs SET result = ?, updatedAt = ? WHERE id = ? AND result = ?')
        .run(JSON.stringify(next), now, row.id, row.result);
      if (Number(repaired.changes) === 1) report.referencesRepaired += 1;
      else if (path.isAbsolute(screenshotPath) && isInside(dataDir('native-node-captures'), screenshotPath)) {
        // A concurrent completion changed the job. Protect the old candidate
        // in this pass and let the next authoritative snapshot decide.
        protectedPaths.add(pathKey(screenshotPath));
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
}

async function reconcileNativeCaptures(
  nowMs: number,
  minAgeMs: number,
): Promise<NativeCaptureIntegrityReport> {
  const report = nativeReport();
  const managedRoot = dataDir('native-node-captures');
  const referenced = new Set<string>();
  const parsedResults = new Map<string, Record<string, unknown>>();
  const broken: Array<BrokenReference<NativeJobResultRow>> = [];
  try {
    const rows = tableExists('native_node_jobs')
      ? getDb().prepare("SELECT id, result FROM native_node_jobs WHERE result IS NOT NULL AND result LIKE '%screenshotPath%'")
        .all() as unknown as NativeJobResultRow[]
      : [];
    for (const row of rows) {
      const parsed = parseObject(row.result);
      if (!parsed || typeof parsed.screenshotPath !== 'string') continue;
      parsedResults.set(row.id, parsed);
      const classification = await classifyReference(parsed.screenshotPath, managedRoot);
      if (classification.problem) broken.push({ row, problem: classification.problem });
      else if (classification.managedPath) referenced.add(pathKey(classification.managedPath));
    }
    repairNativeReferences(
      broken, parsedResults, new Date(nowMs).toISOString(), report, referenced,
    );
    report.ownershipScanComplete = true;
    for (const issue of broken) {
      const storedPath = parsedResults.get(issue.row.id)?.screenshotPath;
      await recordReferenceIssue('native_capture_file_reference_repaired', {
        jobId: issue.row.id,
        storedPath,
        problem: issue.problem,
      }, nowMs, report.errors);
    }
  } catch (error) {
    report.errors.push(`ownership: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (report.ownershipScanComplete) {
    mergeSweep(report, await quarantineUnreferencedFiles(
      managedRoot, referenced, 'unowned_native_capture', nowMs, minAgeMs,
    ));
  }
  return report;
}

function parseArray(raw: string): unknown[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function repairBrowserScreenshotReferences(
  repairs: ReadonlyArray<BrowserTraceRepair>,
  report: BrowserScreenshotIntegrityReport,
  protectedPaths: Set<string>,
): BrowserTraceIssue[] {
  if (!repairs.length) return [];
  const committedIssues: BrowserTraceIssue[] = [];
  const screenshotRoot = dataDir('screenshots');
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const repair of repairs) {
      const updated = db.prepare('UPDATE runs SET trace = ? WHERE id = ? AND trace = ?')
        .run(JSON.stringify(repair.trace), repair.row.id, repair.row.trace);
      if (Number(updated.changes) === 1) {
        report.referencesRepaired += repair.issues.length;
        committedIssues.push(...repair.issues);
        continue;
      }
      for (const issue of repair.issues) {
        if (path.isAbsolute(issue.storedPath) && isInside(screenshotRoot, issue.storedPath)) {
          protectedPaths.add(pathKey(issue.storedPath));
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  }
  return committedIssues;
}

async function reconcileBrowserScreenshots(
  nowMs: number,
  minAgeMs: number,
): Promise<BrowserScreenshotIntegrityReport> {
  const report = browserReport();
  const managedRoot = dataDir('screenshots');
  const referenced = new Set<string>();
  const repairs: BrowserTraceRepair[] = [];
  try {
    const rows = tableExists('runs')
      ? getDb().prepare(`
          SELECT id, trace FROM runs
          WHERE trace LIKE '%browser_screenshot%' AND trace LIKE '%"path"%'
        `).all() as unknown as RunTraceRow[]
      : [];
    for (const row of rows) {
      const trace = parseArray(row.trace);
      if (!trace) continue;
      const nextTrace = [...trace];
      const issues: BrowserTraceIssue[] = [];
      for (let index = 0; index < trace.length; index += 1) {
        const step = objectValue(trace[index]);
        const tool = objectValue(step?.tool);
        const result = objectValue(tool?.result);
        if (tool?.name !== 'browser_screenshot' || typeof result?.path !== 'string') continue;
        const storedPath = result.path;
        const classification = await classifyReference(storedPath, managedRoot);
        if (!classification.problem) {
          if (classification.managedPath) referenced.add(pathKey(classification.managedPath));
          continue;
        }
        const nextResult = { ...result };
        delete nextResult.path;
        nextResult.screenshotUnavailable = {
          reason: classification.problem,
          detectedAt: new Date(nowMs).toISOString(),
        };
        nextTrace[index] = {
          ...step,
          tool: { ...tool, result: nextResult },
        };
        issues.push({ runId: row.id, storedPath, problem: classification.problem });
      }
      if (issues.length) repairs.push({ row, trace: nextTrace, issues });
    }
    const committedIssues = repairBrowserScreenshotReferences(
      repairs, report, referenced,
    );
    report.ownershipScanComplete = true;
    for (const issue of committedIssues) {
      await recordReferenceIssue('browser_screenshot_file_reference_repaired', {
        runId: issue.runId,
        storedPath: issue.storedPath,
        problem: issue.problem,
      }, nowMs, report.errors);
    }
  } catch (error) {
    report.errors.push(`ownership: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (report.ownershipScanComplete) {
    mergeSweep(report, await quarantineUnreferencedFiles(
      managedRoot, referenced, 'unowned_browser_screenshot', nowMs, minAgeMs,
    ));
  }
  return report;
}

async function runReconciliation(
  options: BinaryStorageIntegrityOptions,
): Promise<BinaryStorageIntegrityReport> {
  const nowMs = finiteNumber(options.nowMs, Date.now());
  const minAgeMs = duration(options.minOrphanAgeMs, DEFAULT_ORPHAN_GRACE_MS);
  const startedAt = new Date(nowMs).toISOString();
  // Opening the database first completes the one-time legacy-run migration.
  getDb();
  const quarantineRecovery = await recoverPreparedManagedQuarantines();
  const [artifacts, meetingAudio, nativeCaptures, browserScreenshots] = await Promise.all([
    reconcileArtifacts(nowMs, minAgeMs),
    reconcileMeetingAudio(nowMs, minAgeMs),
    reconcileNativeCaptures(nowMs, minAgeMs),
    reconcileBrowserScreenshots(nowMs, minAgeMs),
  ]);
  const legacyRuns = await quarantineUnreferencedFiles(
    dataDir('runs'), new Set(), 'retired_legacy_run_file', nowMs, minAgeMs,
  );
  const errors = [
    ...quarantineRecovery.errors.map((error) => `lost+found: ${error}`),
    ...artifacts.errors.map((error) => `artifacts: ${error}`),
    ...meetingAudio.errors.map((error) => `meetings: ${error}`),
    ...nativeCaptures.errors.map((error) => `native captures: ${error}`),
    ...browserScreenshots.errors.map((error) => `browser screenshots: ${error}`),
    ...legacyRuns.errors.map((error) => `legacy runs: ${error}`),
  ];
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    quarantineRecovery,
    artifacts,
    meetingAudio,
    nativeCaptures,
    browserScreenshots,
    legacyRuns,
    errors,
  };
}

/**
 * Reconcile every binary file owned by a SQLite row. Concurrent callers share
 * one pass, missing/unsafe pointers are detached transactionally, and aged
 * unreferenced bytes are moved through crash-recoverable lost+found manifests.
 */
export function reconcileBinaryStorageIntegrity(
  options: BinaryStorageIntegrityOptions = {},
): Promise<BinaryStorageIntegrityReport> {
  if (globals.__shibaBinaryStorageIntegrityPass) return globals.__shibaBinaryStorageIntegrityPass;
  const pass = runReconciliation(options).finally(() => {
    if (globals.__shibaBinaryStorageIntegrityPass === pass) {
      globals.__shibaBinaryStorageIntegrityPass = undefined;
    }
  });
  globals.__shibaBinaryStorageIntegrityPass = pass;
  return pass;
}
