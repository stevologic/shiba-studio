import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function touchOld(file: string, nowMs: number): Promise<void> {
  const old = new Date(nowMs - 60_000);
  await fs.utimes(file, old, old);
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-binary-integrity-'));
  const data = path.join(root, 'data');
  const userWorkspace = path.join(root, 'user-workspace');
  process.env.SHIBA_DATA_DIR = data;
  process.env.SHIBA_SECRET_KEY = 'aa'.repeat(32);
  await fs.mkdir(path.join(data, 'runs'), { recursive: true });
  await fs.mkdir(userWorkspace, { recursive: true });

  const nowMs = Date.now();
  const legacyRun = path.join(data, 'runs', 'legacy-run.json');
  await fs.writeFile(legacyRun, JSON.stringify({
    id: 'legacy-run',
    agentId: 'legacy-agent',
    agentName: 'Legacy agent',
    model: 'legacy-model',
    status: 'completed',
    prompt: 'Imported from the retired JSON run store',
    startedAt: new Date(nowMs - 120_000).toISOString(),
    completedAt: new Date(nowMs - 60_000).toISOString(),
    finalOutput: 'Imported',
    sideEffects: [],
    trace: [],
  }));
  await touchOld(legacyRun, nowMs);

  const database = await import('../lib/db');
  const ledger = await import('../lib/task-ledger');
  const artifacts = await import('../lib/artifacts');
  const meetings = await import('../lib/meetings');
  const native = await import('../lib/native-nodes');
  const browser = await import('../lib/browser');
  const integrity = await import('../lib/binary-storage-integrity');

  try {
    const db = database.getDb();
    assert(db.prepare('SELECT 1 FROM runs WHERE id = ?').get('legacy-run'), 'legacy JSON is imported before cleanup');
    const escapedScreenshot = browser.browserScreenshotPath('../../outside\\escape', nowMs, 'fixture-one');
    const uniqueScreenshot = browser.browserScreenshotPath('../../outside\\escape', nowMs, 'fixture-two');
    assert.equal(path.dirname(escapedScreenshot), path.resolve(data, 'screenshots'));
    assert.equal(path.basename(escapedScreenshot).includes('..'), false);
    assert.notEqual(escapedScreenshot, uniqueScreenshot, 'UUID suffixes prevent same-millisecond collisions');
    artifacts.listArtifacts();
    meetings.ensureMeetingSchema();
    native.ensureNativeNodeSchema();

    for (const id of ['artifact-task', 'meeting-task']) {
      ledger.createTask({ id, kind: 'artifact', title: id, originType: 'manual' });
    }

    const artifactRoot = path.join(data, 'artifacts');
    const artifactDirectory = path.join(artifactRoot, 'artifact-reassign');
    await fs.mkdir(artifactDirectory, { recursive: true });
    const validArtifact = path.join(artifactDirectory, 'valid-version.txt');
    const missingArtifact = path.join(artifactDirectory, 'missing-version.txt');
    await fs.writeFile(validArtifact, 'valid artifact bytes');
    const now = new Date(nowMs).toISOString();
    db.prepare(`
      INSERT INTO artifacts (
        id, taskId, name, kind, mimeType, status, currentVersionId,
        sourceLineage, liveSource, createdAt, updatedAt
      ) VALUES (?, ?, ?, 'text', 'text/plain', 'published', ?, '{}', NULL, ?, ?)
    `).run('artifact-reassign', 'artifact-task', 'Reassign', 'version-missing', now, now);
    db.prepare(`
      INSERT INTO artifact_versions (
        id, artifactId, checkpointId, version, filePath, relativePath, sha256,
        bytes, renderStatus, renderReport, evidenceId, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run('version-valid', 'artifact-reassign', 'checkpoint-valid', 1, validArtifact, 'valid-version.txt', 'a'.repeat(64), 20, 'passed', null, now);
    const evidence = ledger.recordTaskEvidence({
      taskId: 'artifact-task',
      kind: 'artifact',
      status: 'passed',
      label: 'Missing artifact version',
      summary: 'Previously verified artifact snapshot.',
      uri: missingArtifact,
      metadata: { artifactId: 'artifact-reassign', versionId: 'version-missing' },
    });
    db.prepare(`
      INSERT INTO artifact_versions (
        id, artifactId, checkpointId, version, filePath, relativePath, sha256,
        bytes, renderStatus, renderReport, evidenceId, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run('version-missing', 'artifact-reassign', 'checkpoint-missing', 2, missingArtifact, 'missing-version.txt', 'b'.repeat(64), 20, 'pending', evidence.id, now);
    db.prepare(`
      INSERT INTO artifact_annotations (
        id, artifactId, versionId, locator, comment, status, createdAt, resolvedAt
      ) VALUES ('missing-annotation', 'artifact-reassign', 'version-missing', '{}', 'stale', 'open', ?, NULL)
    `).run(now);
    db.prepare(`
      INSERT INTO artifact_publications (
        id, artifactId, versionId, tokenHash, audience, expiresAt, createdAt, revokedAt
      ) VALUES ('missing-publication', 'artifact-reassign', 'version-missing', ?, 'private_link', NULL, ?, NULL)
    `).run('c'.repeat(64), now);

    const onlyMissingPath = path.join(artifactRoot, 'artifact-empty', 'missing.txt');
    db.prepare(`
      INSERT INTO artifacts (
        id, taskId, name, kind, mimeType, status, currentVersionId,
        sourceLineage, liveSource, createdAt, updatedAt
      ) VALUES ('artifact-empty', 'artifact-task', 'Empty', 'text', 'text/plain',
        'draft', 'only-missing', '{}', NULL, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO artifact_versions (
        id, artifactId, checkpointId, version, filePath, relativePath, sha256,
        bytes, renderStatus, renderReport, evidenceId, createdAt
      ) VALUES ('only-missing', 'artifact-empty', 'checkpoint-empty', 1, ?, 'missing.txt',
        ?, 10, 'pending', '{}', NULL, ?)
    `).run(onlyMissingPath, 'd'.repeat(64), now);

    const externalFile = path.join(userWorkspace, 'user-owned.bin');
    await fs.writeFile(externalFile, 'never move or delete this file');
    db.prepare(`
      INSERT INTO artifacts (
        id, taskId, name, kind, mimeType, status, currentVersionId,
        sourceLineage, liveSource, createdAt, updatedAt
      ) VALUES ('artifact-external', 'artifact-task', 'External', 'other',
        'application/octet-stream', 'draft', 'external-version', '{}', NULL, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO artifact_versions (
        id, artifactId, checkpointId, version, filePath, relativePath, sha256,
        bytes, renderStatus, renderReport, evidenceId, createdAt
      ) VALUES ('external-version', 'artifact-external', 'checkpoint-external', 1, ?,
        'user-owned.bin', ?, 30, 'pending', '{}', NULL, ?)
    `).run(externalFile, 'e'.repeat(64), now);

    const oldArtifactOrphan = path.join(artifactRoot, 'orphan', 'old.bin');
    const youngArtifactOrphan = path.join(artifactRoot, 'orphan', 'young.bin');
    await fs.mkdir(path.dirname(oldArtifactOrphan), { recursive: true });
    await fs.writeFile(oldArtifactOrphan, 'old artifact orphan');
    await fs.writeFile(youngArtifactOrphan, 'young artifact orphan');
    await touchOld(oldArtifactOrphan, nowMs);

    const meetingRoot = path.join(data, 'meetings', 'audio');
    await fs.mkdir(meetingRoot, { recursive: true });
    const validMeetingAudio = path.join(meetingRoot, 'valid.webm');
    const missingMeetingAudio = path.join(meetingRoot, 'missing.webm');
    await fs.writeFile(validMeetingAudio, 'valid meeting audio');
    const insertMeeting = db.prepare(`
      INSERT INTO meetings (
        id, title, source, status, consentAt, consentVersion, originalFilename,
        audioPath, audioMime, audioBytes, audioSha256, audioDeletedAt,
        retentionDays, deleteAudioAt, duration, language, transcriptText, words,
        segments, speakerLabels, summary, decisions, actionItems, owners, taskId,
        error, version, createdAt, updatedAt, transcribedAt, deletedAt
      ) VALUES (?, ?, 'upload', ?, ?, 'meeting-recording-v1', ?, ?, 'audio/webm',
        20, ?, NULL, 30, ?, NULL, NULL, ?, '[]', '[]', '{}', '', '[]', '[]',
        '[]', 'meeting-task', NULL, 1, ?, ?, NULL, NULL)
    `);
    insertMeeting.run(
      'meeting-missing', 'Missing meeting', 'uploaded', now, 'missing.webm',
      missingMeetingAudio, 'f'.repeat(64), new Date(nowMs + 30 * 86_400_000).toISOString(), '', now, now,
    );
    insertMeeting.run(
      'meeting-valid', 'Valid meeting', 'ready', now, 'valid.webm',
      validMeetingAudio, '1'.repeat(64), new Date(nowMs + 30 * 86_400_000).toISOString(), 'Transcript', now, now,
    );
    insertMeeting.run(
      'meeting-external', 'External meeting', 'ready', now, 'external.webm',
      externalFile, '2'.repeat(64), new Date(nowMs + 30 * 86_400_000).toISOString(), 'Transcript', now, now,
    );
    ledger.recordTaskEvidence({
      taskId: 'meeting-task',
      kind: 'artifact',
      status: 'informational',
      label: 'Meeting audio',
      summary: 'Stored meeting recording.',
      uri: '/api/meetings/meeting-missing/audio',
      metadata: { meetingId: 'meeting-missing' },
    });
    const oldMeetingOrphan = path.join(meetingRoot, 'old-orphan.webm');
    const youngMeetingOrphan = path.join(meetingRoot, 'young-orphan.webm');
    await fs.writeFile(oldMeetingOrphan, 'old meeting orphan');
    await fs.writeFile(youngMeetingOrphan, 'young meeting orphan');
    await touchOld(oldMeetingOrphan, nowMs);

    const captureRoot = path.join(data, 'native-node-captures');
    await fs.mkdir(captureRoot, { recursive: true });
    const validCapture = path.join(captureRoot, 'valid-job.png');
    const missingCapture = path.join(captureRoot, 'missing-job.png');
    const invalidCaptureDirectory = path.join(captureRoot, 'directory-job.png');
    await fs.writeFile(validCapture, 'valid capture');
    await fs.mkdir(invalidCaptureDirectory);
    db.prepare(`
      INSERT INTO native_nodes (
        id, name, keyHash, platform, releaseId, releaseDigest, capabilities,
        captureState, createdAt, expiresAt, lastSeenAt, revokedAt
      ) VALUES ('native-node', 'Native', ?, 'win32', 'release', ?, '["capture"]',
        'idle', ?, ?, NULL, NULL)
    `).run('3'.repeat(64), '4'.repeat(64), now, new Date(nowMs + 60_000).toISOString());
    const insertJob = db.prepare(`
      INSERT INTO native_node_jobs (
        id, nodeId, action, status, args, targetAppId, targetAppRevision,
        grantId, grantRevision, actionDigest, leaseTokenHash, leaseExpiresAt,
        result, error, securityScan, createdAt, updatedAt, completedAt
      ) VALUES (?, 'native-node', 'capture', 'succeeded', '{}', NULL, NULL, NULL,
        NULL, ?, NULL, NULL, ?, NULL, '{}', ?, ?, ?)
    `);
    insertJob.run('valid-job', '5'.repeat(64), JSON.stringify({ screenshotPath: validCapture }), now, now, now);
    insertJob.run('missing-job', '6'.repeat(64), JSON.stringify({ screenshotPath: missingCapture }), now, now, now);
    insertJob.run('external-job', '7'.repeat(64), JSON.stringify({ screenshotPath: externalFile }), now, now, now);
    insertJob.run('directory-job', '8'.repeat(64), JSON.stringify({ screenshotPath: invalidCaptureDirectory }), now, now, now);
    const oldCaptureOrphan = path.join(captureRoot, 'old-orphan.png');
    const youngCaptureOrphan = path.join(captureRoot, 'young-orphan.png');
    await fs.writeFile(oldCaptureOrphan, 'old capture orphan');
    await fs.writeFile(youngCaptureOrphan, 'young capture orphan');
    await touchOld(oldCaptureOrphan, nowMs);

    const screenshotRoot = path.join(data, 'screenshots');
    await fs.mkdir(screenshotRoot, { recursive: true });
    const validBrowserScreenshot = path.join(screenshotRoot, 'valid-browser.png');
    const missingBrowserScreenshot = path.join(screenshotRoot, 'missing-browser.png');
    const oldBrowserOrphan = path.join(screenshotRoot, 'old-orphan.png');
    const youngBrowserOrphan = path.join(screenshotRoot, 'young-orphan.png');
    await fs.writeFile(validBrowserScreenshot, 'valid browser screenshot');
    await fs.writeFile(oldBrowserOrphan, 'old browser orphan');
    await fs.writeFile(youngBrowserOrphan, 'young browser orphan');
    await touchOld(oldBrowserOrphan, nowMs);
    db.prepare('UPDATE runs SET trace = ? WHERE id = ?').run(JSON.stringify([
      { type: 'result', tool: { name: 'browser_screenshot', args: {}, result: { path: validBrowserScreenshot } } },
      { type: 'result', tool: { name: 'browser_screenshot', args: {}, result: { path: missingBrowserScreenshot } } },
      { type: 'result', tool: { name: 'browser_screenshot', args: {}, result: { path: externalFile } } },
    ]), 'legacy-run');

    const firstPromise = integrity.reconcileBinaryStorageIntegrity({ nowMs, minOrphanAgeMs: 1_000 });
    const sharedPromise = integrity.reconcileBinaryStorageIntegrity({ nowMs, minOrphanAgeMs: 1_000 });
    assert.strictEqual(sharedPromise, firstPromise, 'concurrent callers share one binary-storage pass');
    const first = await firstPromise;
    assert.deepEqual(first.errors, []);
    assert.equal(first.artifacts.referencesRepaired, 3);
    assert.equal(first.artifacts.artifactsRemoved, 2);
    assert.equal(first.artifacts.currentVersionsReassigned, 1);
    assert.equal(first.artifacts.filesQuarantined, 1);
    assert.equal(first.artifacts.youngFilesRetained, 1);
    assert.equal(first.meetingAudio.referencesRepaired, 2);
    assert.equal(first.meetingAudio.activeMeetingsFailed, 1);
    assert.equal(first.meetingAudio.activeTasksFailed, 1);
    assert.equal(first.meetingAudio.filesQuarantined, 1);
    assert.equal(first.nativeCaptures.referencesRepaired, 3);
    assert.equal(first.nativeCaptures.filesQuarantined, 1);
    assert.equal(first.browserScreenshots.referencesRepaired, 2);
    assert.equal(first.browserScreenshots.filesQuarantined, 1);
    assert.equal(first.browserScreenshots.youngFilesRetained, 1);
    assert.equal(first.legacyRuns.filesQuarantined, 1);

    const repairedArtifact = db.prepare('SELECT currentVersionId, status FROM artifacts WHERE id = ?')
      .get('artifact-reassign') as { currentVersionId: string; status: string };
    assert.equal(repairedArtifact.currentVersionId, 'version-valid');
    assert.equal(repairedArtifact.status, 'verified');
    assert.equal(db.prepare('SELECT 1 FROM artifacts WHERE id = ?').get('artifact-empty'), undefined);
    assert.equal(db.prepare('SELECT 1 FROM artifacts WHERE id = ?').get('artifact-external'), undefined);
    assert.equal(db.prepare('SELECT 1 FROM artifact_annotations WHERE id = ?').get('missing-annotation'), undefined);
    assert.equal(db.prepare('SELECT 1 FROM artifact_publications WHERE id = ?').get('missing-publication'), undefined);
    const repairedEvidence = db.prepare('SELECT status, uri, metadata FROM task_evidence WHERE id = ?')
      .get(evidence.id) as { status: string; uri: string | null; metadata: string };
    assert.equal(repairedEvidence.status, 'failed');
    assert.equal(repairedEvidence.uri, null);
    assert.equal(JSON.parse(repairedEvidence.metadata).storageUnavailable, 1);

    const repairedMeeting = db.prepare('SELECT status, audioPath, audioDeletedAt, deleteAudioAt FROM meetings WHERE id = ?')
      .get('meeting-missing') as { status: string; audioPath: string | null; audioDeletedAt: string | null; deleteAudioAt: string | null };
    assert.equal(repairedMeeting.status, 'failed');
    assert.equal(repairedMeeting.audioPath, null);
    assert(repairedMeeting.audioDeletedAt);
    assert.equal(repairedMeeting.deleteAudioAt, null);
    assert.equal(
      (db.prepare('SELECT status FROM tasks WHERE id = ?').get('meeting-task') as { status: string }).status,
      'failed',
    );
    assert.equal(
      (db.prepare('SELECT audioPath FROM meetings WHERE id = ?').get('meeting-valid') as { audioPath: string }).audioPath,
      validMeetingAudio,
    );

    const repairedJob = JSON.parse((db.prepare('SELECT result FROM native_node_jobs WHERE id = ?')
      .get('missing-job') as { result: string }).result) as Record<string, unknown>;
    assert.equal('screenshotPath' in repairedJob, false);
    assert.equal(typeof repairedJob.screenshotUnavailable, 'object');
    assert.equal(
      JSON.parse((db.prepare('SELECT result FROM native_node_jobs WHERE id = ?')
        .get('valid-job') as { result: string }).result).screenshotPath,
      validCapture,
    );
    const repairedTrace = JSON.parse((db.prepare('SELECT trace FROM runs WHERE id = ?')
      .get('legacy-run') as { trace: string }).trace) as Array<{ tool: { result: Record<string, unknown> } }>;
    assert.equal(repairedTrace[0].tool.result.path, validBrowserScreenshot);
    assert.equal('path' in repairedTrace[1].tool.result, false);
    assert.equal(typeof repairedTrace[1].tool.result.screenshotUnavailable, 'object');
    assert.equal('path' in repairedTrace[2].tool.result, false);

    assert.equal(await fs.readFile(externalFile, 'utf8'), 'never move or delete this file');
    assert.equal(await fs.readFile(validArtifact, 'utf8'), 'valid artifact bytes');
    assert.equal(await fs.readFile(validMeetingAudio, 'utf8'), 'valid meeting audio');
    assert.equal(await fs.readFile(validCapture, 'utf8'), 'valid capture');
    assert.equal(await fs.readFile(validBrowserScreenshot, 'utf8'), 'valid browser screenshot');
    await assert.rejects(fs.lstat(oldArtifactOrphan), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(oldMeetingOrphan), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(oldCaptureOrphan), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(oldBrowserOrphan), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(legacyRun), { code: 'ENOENT' });

    const lostFoundRoot = path.join(data, 'lost+found', 'managed-storage');
    const manifests = await Promise.all((await fs.readdir(lostFoundRoot)).map(async (name) =>
      JSON.parse(await fs.readFile(path.join(lostFoundRoot, name, 'manifest.json'), 'utf8')) as {
        state: string;
        reason: string;
      }));
    assert(manifests.every((manifest) => ['recorded', 'quarantined'].includes(manifest.state)));
    for (const reason of [
      'artifact_version_file_reference_repaired',
      'meeting_audio_file_reference_repaired',
      'native_capture_file_reference_repaired',
      'browser_screenshot_file_reference_repaired',
      'unowned_artifact_snapshot',
      'unowned_meeting_audio',
      'unowned_native_capture',
      'unowned_browser_screenshot',
      'retired_legacy_run_file',
    ]) {
      assert(manifests.some((manifest) => manifest.reason === reason), `missing manifest for ${reason}`);
    }

    const second = await integrity.reconcileBinaryStorageIntegrity({
      nowMs: nowMs + 100,
      minOrphanAgeMs: 1_000,
    });
    assert.deepEqual(second.errors, []);
    assert.equal(second.artifacts.referencesRepaired, 0);
    assert.equal(second.artifacts.filesQuarantined, 0);
    assert.equal(second.meetingAudio.referencesRepaired, 0);
    assert.equal(second.meetingAudio.activeTasksFailed, 0);
    assert.equal(second.meetingAudio.filesQuarantined, 0);
    assert.equal(second.nativeCaptures.referencesRepaired, 0);
    assert.equal(second.nativeCaptures.filesQuarantined, 0);
    assert.equal(second.browserScreenshots.referencesRepaired, 0);
    assert.equal(second.browserScreenshots.filesQuarantined, 0);
    assert.equal(second.legacyRuns.filesQuarantined, 0);
    assert.equal(second.quarantineRecovery.recovered, 0);

    console.log('BINARY_STORAGE_INTEGRITY_OK references=repaired orphans=quarantined external=untouched legacy=retired second_pass=idempotent');
  } finally {
    database.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
