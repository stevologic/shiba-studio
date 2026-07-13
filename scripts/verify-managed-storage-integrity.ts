import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-managed-storage-'));
  const data = path.join(root, 'data');
  const userWorkspace = path.join(root, 'user-workspace');
  process.env.SHIBA_DATA_DIR = data;
  process.env.SHIBA_PROJECT_ROOT = userWorkspace;
  await fs.mkdir(path.join(userWorkspace, 'uploads'), { recursive: true });

  const projects = await import('../lib/projects');
  const workspace = await import('../lib/workspace');
  const integrity = await import('../lib/managed-storage-integrity');
  const quarantine = await import('../lib/managed-storage-quarantine');
  const database = await import('../lib/db');

  try {
    // A prepared quarantine from a prior process must not move a replacement
    // file that appeared later at the same path.
    const recoverySource = path.join(data, 'prepared-conflict.bin');
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(recoverySource, 'old');
    const recoveryStat = await fs.stat(recoverySource);
    const recoveryItem = path.join(data, 'lost+found', 'managed-storage', 'prepared-source-conflict');
    await fs.mkdir(recoveryItem, { recursive: true });
    await fs.writeFile(path.join(recoveryItem, 'manifest.json'), JSON.stringify({
      version: 1,
      id: 'prepared-source-conflict',
      state: 'prepared',
      reason: 'test_prepared_conflict',
      originalRelativePath: path.relative(data, recoverySource),
      discoveredAt: recoveryStat.mtime.toISOString(),
      size: recoveryStat.size,
      modifiedAt: recoveryStat.mtime.toISOString(),
      entryType: 'file',
      details: {},
    }));
    await fs.writeFile(recoverySource, 'new replacement bytes');
    const preparedRecovery = await quarantine.recoverPreparedManagedQuarantines();
    assert.equal(preparedRecovery.markedMissing, 1);
    assert.equal(await fs.readFile(recoverySource, 'utf8'), 'new replacement bytes');

    const project = await projects.createProject('Integrity fixture');
    const valid = await projects.addProjectFile(project.id, 'owned.txt', Buffer.from('owned bytes'), 'text/plain');
    const missing = await projects.addProjectFile(project.id, 'missing.txt', Buffer.from('missing bytes'), 'text/plain');
    await fs.rm(path.join(projects.projectFilesDir(project.id), missing.storedName));

    const orphanPath = path.join(projects.projectFilesDir(project.id), 'manual-unindexed.txt');
    await fs.writeFile(orphanPath, 'recover me');

    // uploads-meta is derived. Seed both project and global rows without files.
    await workspace.recordUploadMeta(`project:${project.id}:ghost.txt`, 'a'.repeat(64));
    await workspace.recordUploadMeta('missing-global.txt', 'b'.repeat(64));

    // A successful project delete must clear every legacy cache row it owned.
    const deletedProject = await projects.createProject('Delete metadata fixture');
    await projects.addProjectFile(deletedProject.id, 'tracked-before-delete.txt', Buffer.from('deleted project bytes'));
    await fs.writeFile(path.join(projects.projectFilesDir(deletedProject.id), 'unindexed-before-delete.txt'), 'also preserve me');
    await workspace.recordUploadMeta(`project:${deletedProject.id}:legacy.txt`, 'c'.repeat(64));
    await projects.deleteProject(deletedProject.id);
    const metadataAfterDelete = JSON.parse(await fs.readFile(path.join(data, 'uploads-meta.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(`project:${deletedProject.id}:legacy.txt` in metadataAfterDelete, false);

    // This is outside SHIBA_DATA_DIR and must never be classified as orphaned.
    const userFile = path.join(userWorkspace, 'uploads', 'user-authored.txt');
    await fs.writeFile(userFile, 'do not move');

    const staleTemp = path.join(data, 'agents.json.999.fixture.tmp');
    await fs.writeFile(staleTemp, '{"recoverable":true}\n');
    const old = new Date(Date.now() - 60_000);
    await Promise.all([
      fs.utimes(orphanPath, old, old),
      fs.utimes(staleTemp, old, old),
    ]);

    const first = await integrity.reconcileManagedStorage({
      defaultWorkspace: userWorkspace,
      minOrphanAgeMs: 0,
      minTemporaryAgeMs: 0,
      nowMs: Date.now(),
    });
    assert.deepEqual(first.errors, []);
    assert.equal(first.projects?.missingReferencesRemoved, 1);
    assert.equal(first.projects?.unownedFilesQuarantined, 1);
    assert.equal(first.projects?.unownedBytesQuarantined, Buffer.byteLength('recover me'));
    assert.equal(first.uploadMetadata?.projectEntriesRemoved, 1);
    assert.equal(first.uploadMetadata?.globalEntriesRemoved, 1);
    assert.equal(first.staleManagedFiles.quarantined, 1);
    assert.equal(await fs.readFile(userFile, 'utf8'), 'do not move');
    assert.equal(await fs.readFile(path.join(projects.projectFilesDir(project.id), valid.storedName), 'utf8'), 'owned bytes');

    const repaired = await projects.getProject(project.id);
    assert.deepEqual(repaired?.files.map((file) => file.storedName), [valid.storedName]);
    await assert.rejects(fs.lstat(orphanPath), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(staleTemp), { code: 'ENOENT' });

    const lostFound = path.join(data, 'lost+found', 'managed-storage');
    const itemNames = await fs.readdir(lostFound);
    const manifests = await Promise.all(itemNames.map(async (name) => {
      const directory = path.join(lostFound, name);
      return {
        directory,
        manifest: JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')) as {
          state: string;
          reason: string;
          originalRelativePath?: string;
        },
      };
    }));
    assert(manifests.every(({ manifest }) => ['quarantined', 'recorded', 'missing'].includes(manifest.state)));
    assert(manifests.some(({ manifest }) => manifest.reason === 'missing_project_file_reference'));
    const deletedStorage = manifests.find(({ manifest }) => manifest.reason === 'unowned_project_file_on_delete');
    assert(deletedStorage, 'unindexed bytes from a deleted project have a lost+found manifest');
    assert.equal(
      await fs.readFile(path.join(deletedStorage.directory, 'payload'), 'utf8'),
      'also preserve me',
    );
    const orphan = manifests.find(({ manifest }) => manifest.reason === 'unowned_project_file');
    assert(orphan, 'unindexed project bytes have a lost+found manifest');
    assert.equal(await fs.readFile(path.join(orphan.directory, 'payload'), 'utf8'), 'recover me');
    const temporary = manifests.find(({ manifest }) => manifest.reason === 'stale_managed_staging_file');
    assert(temporary, 'stale temp bytes have a lost+found manifest');
    assert.match(await fs.readFile(path.join(temporary.directory, 'payload'), 'utf8'), /recoverable/);

    const second = await integrity.reconcileManagedStorage({
      defaultWorkspace: userWorkspace,
      minOrphanAgeMs: 0,
      minTemporaryAgeMs: 0,
      nowMs: Date.now() + 1_000,
    });
    assert.deepEqual(second.errors, []);
    assert.equal(second.quarantineRecovery.recovered, 0);
    assert.equal(second.projects?.missingReferencesRemoved, 0);
    assert.equal(second.projects?.unownedFilesQuarantined, 0);
    assert.equal(second.uploadMetadata?.projectEntriesRemoved, 0);
    assert.equal(second.uploadMetadata?.globalEntriesRemoved, 0);
    assert.equal(second.staleManagedFiles.quarantined, 0);

    // Invalid runtime option values must fall back to the production grace,
    // never collapse it to an immediate sweep.
    const youngUnindexed = path.join(projects.projectFilesDir(project.id), 'young-unindexed.txt');
    await fs.writeFile(youngUnindexed, 'not old enough');
    const invalidOptions = await integrity.reconcileManagedStorage({
      defaultWorkspace: userWorkspace,
      minOrphanAgeMs: Number.NaN,
      minTemporaryAgeMs: Number.NaN,
      nowMs: Number.NaN,
    });
    assert.deepEqual(invalidOptions.errors, []);
    assert.equal(invalidOptions.projects?.youngUnownedFilesRetained, 1);
    assert.equal(await fs.readFile(youngUnindexed, 'utf8'), 'not old enough');
    await fs.rm(youngUnindexed);

    // Corrupt derived metadata is preserved and rebuilt; it cannot block the
    // authoritative project/file reconciliation pass.
    const uploadsMetaPath = path.join(data, 'uploads-meta.json');
    await fs.writeFile(uploadsMetaPath, '{not-json');
    const corruptMetadata = await integrity.reconcileManagedStorage({
      defaultWorkspace: userWorkspace,
      minOrphanAgeMs: 0,
      minTemporaryAgeMs: 0,
      nowMs: Date.now() + 2_000,
    });
    assert.deepEqual(corruptMetadata.errors, []);
    assert.equal(corruptMetadata.uploadMetadata?.corruptStoreQuarantined, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(uploadsMetaPath, 'utf8')), {});

    // An invalid authoritative owner snapshot must fail closed. It may never
    // cause bytes to be classified as orphaned merely because the JSON shape
    // is corrupt.
    const projectsPath = path.join(data, 'projects.json');
    const validProjectsStore = await fs.readFile(projectsPath, 'utf8');
    const failClosedBytes = path.join(projects.projectFilesDir(project.id), 'fail-closed.txt');
    await fs.writeFile(failClosedBytes, 'must stay in place');
    await fs.writeFile(projectsPath, '{}\n');
    const invalidOwnerSnapshot = await integrity.reconcileManagedStorage({
      defaultWorkspace: userWorkspace,
      minOrphanAgeMs: 0,
      minTemporaryAgeMs: 0,
      nowMs: Date.now() + 3_000,
    });
    assert.equal(invalidOwnerSnapshot.projects, null);
    assert(invalidOwnerSnapshot.errors.some((error) => error.includes('Invalid projects store')));
    assert.equal(await fs.readFile(failClosedBytes, 'utf8'), 'must stay in place');
    await fs.writeFile(projectsPath, validProjectsStore);

    console.log('MANAGED_STORAGE_INTEGRITY_OK missing=1 project_orphans=1 stale_temp=1 second_pass=clean corrupt_cache=recovered corrupt_owner=fail-closed user_workspace=untouched');
  } finally {
    database.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
