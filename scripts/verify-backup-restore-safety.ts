import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function assertMissing(file: string, message: string): Promise<void> {
  await assert.rejects(
    fs.access(file),
    (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT',
    message,
  );
}

async function stopBackgroundWork(): Promise<void> {
  await (await import('../lib/integrity-coordinator')).stopDataIntegritySchedule();
  await (await import('../lib/background-tasks')).stopQueuedRetryDispatcher();
  await (await import('../lib/task-ledger')).stopTaskCommandReconciler();
  await (await import('../lib/task-teams')).stopTeamWorkerClaimReconciler();
  await (await import('../lib/task-delivery')).stopTaskDeliveryPump();
  await (await import('../lib/agent-runs-store')).stopRunLeaseReconciler();
  await (await import('../lib/routines')).stopRoutineEngine();
  await (await import('../lib/scheduler')).stopAllScheduledTasks();
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-backup-safety-'));
  const data = path.join(root, 'data');
  process.env.SHIBA_DATA_DIR = data;
  process.env.SHIBA_SECRET_KEY = '31'.repeat(32);
  await fs.mkdir(data, { recursive: true });

  const backup = await import('../lib/backup');
  const database = await import('../lib/db');
  const configPath = path.join(data, 'config.json');
  const journalPath = path.join(data, 'backup-restore-journal.json');

  try {
    // Export must distinguish an absent optional store from an unreadable one.
    await fs.mkdir(configPath);
    await assert.rejects(
      backup.buildBackup({ includeKey: false }),
      /Could not read config\.json for backup/i,
      'non-ENOENT store read errors must fail the export instead of producing an incomplete backup',
    );
    await fs.rm(configPath, { recursive: true });

    // A crash after the live -> rollback rename must restore the old generation
    // and remove every transaction artifact on the next startup.
    const originalConfig = `${JSON.stringify({ generation: 'original' }, null, 2)}\n`;
    await fs.writeFile(configPath, originalConfig);
    const originalStat = await fs.stat(configPath);
    const rollbackId = randomUUID();
    const rollbackPath = `${configPath}.${rollbackId}.rollback`;
    const stagedPath = `${configPath}.${rollbackId}.restore`;
    await fs.rename(configPath, rollbackPath);
    await fs.writeFile(configPath, JSON.stringify({ generation: 'interrupted' }));
    await fs.writeFile(stagedPath, JSON.stringify({ generation: 'staged-leftover' }));
    await fs.writeFile(journalPath, JSON.stringify({
      version: 1,
      restoreId: rollbackId,
      phase: 'installing',
      createdAt: new Date().toISOString(),
      stores: [{
        name: 'config.json',
        hadPrevious: true,
        previous: { size: originalStat.size, mtimeMs: originalStat.mtimeMs },
      }],
    }));

    assert.deepEqual(
      await backup.recoverInterruptedBackupRestore(),
      { recovered: true, action: 'rolled_back', restoreId: rollbackId },
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), originalConfig);
    await assertMissing(journalPath, 'successful rollback must retire its journal');
    await assertMissing(rollbackPath, 'successful rollback must consume its rollback file');
    await assertMissing(stagedPath, 'successful rollback must remove its staged file');

    // Once semantic validation has committed, recovery rolls forward cleanup;
    // it must never resurrect the superseded generation.
    const preCommitConfig = await fs.readFile(configPath, 'utf8');
    const preCommitStat = await fs.stat(configPath);
    const committedConfig = `${JSON.stringify({ generation: 'committed' }, null, 2)}\n`;
    const committedId = randomUUID();
    const committedRollback = `${configPath}.${committedId}.rollback`;
    const committedStaged = `${configPath}.${committedId}.restore`;
    await fs.rename(configPath, committedRollback);
    await fs.writeFile(configPath, committedConfig);
    await fs.writeFile(committedStaged, JSON.stringify({ generation: 'unused' }));
    await fs.writeFile(journalPath, JSON.stringify({
      version: 1,
      restoreId: committedId,
      phase: 'committed',
      createdAt: new Date().toISOString(),
      stores: [{
        name: 'config.json',
        hadPrevious: true,
        previous: { size: preCommitStat.size, mtimeMs: preCommitStat.mtimeMs },
      }],
    }));

    assert.deepEqual(
      await backup.recoverInterruptedBackupRestore(),
      { recovered: true, action: 'completed_commit', restoreId: committedId },
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), committedConfig);
    assert.notEqual(await fs.readFile(configPath, 'utf8'), preCommitConfig);
    await assertMissing(journalPath, 'committed recovery must retire its journal');
    await assertMissing(committedRollback, 'committed recovery must clean the old generation');
    await assertMissing(committedStaged, 'committed recovery must clean staged leftovers');

    // A missing rollback is accepted only when the live file still matches the
    // journaled original. Divergence must fail closed and preserve evidence.
    const divergenceStat = await fs.stat(configPath);
    const divergentId = randomUUID();
    await fs.writeFile(configPath, JSON.stringify({ generation: 'unexpected-third-generation' }));
    await fs.writeFile(journalPath, JSON.stringify({
      version: 1,
      restoreId: divergentId,
      phase: 'prepared',
      createdAt: new Date().toISOString(),
      stores: [{
        name: 'config.json',
        hadPrevious: true,
        previous: { size: divergenceStat.size, mtimeMs: divergenceStat.mtimeMs },
      }],
    }));
    await assert.rejects(
      backup.recoverInterruptedBackupRestore(),
      /rollback was incomplete|rollback is missing/i,
      'recovery must not silently bless a divergent live file when rollback evidence is missing',
    );
    const preservedJournal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as { phase?: string };
    assert.equal(preservedJournal.phase, 'rolling_back');
    await fs.rm(journalPath);
    database.getDb();

    // Syntactic JSON is not sufficient: if the restored stores fail the
    // semantic integrity pass, the complete JSON + SQLite generation comes
    // back instead of leaving a cross-store split brain.
    const boardPath = path.join(data, 'board.json');
    const originalBoard = `${JSON.stringify({ nextNumber: 1, tasks: [], syncState: {} }, null, 2)}\n`;
    await fs.writeFile(boardPath, originalBoard);
    const liveDatabase = database.getDb();
    liveDatabase.exec(`
      CREATE TABLE IF NOT EXISTS backup_restore_semantic_sentinel (value TEXT NOT NULL);
      DELETE FROM backup_restore_semantic_sentinel;
      INSERT INTO backup_restore_semantic_sentinel VALUES ('original');
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    database.closeDb();
    const alternateDatabasePath = path.join(root, 'semantically-rejected-generation.db');
    await fs.copyFile(database.databasePath(), alternateDatabasePath);
    const sqlite = process.getBuiltinModule?.('node:sqlite') as {
      DatabaseSync: new (filename: string) => {
        exec(sql: string): void;
        close(): void;
      };
    } | undefined;
    assert(sqlite, 'node:sqlite is required for SQLite rollback verification');
    const alternateDatabase = new sqlite.DatabaseSync(alternateDatabasePath);
    alternateDatabase.exec("UPDATE backup_restore_semantic_sentinel SET value = 'rejected'");
    alternateDatabase.close();
    database.getDb();
    const now = new Date().toISOString();
    const semanticallyBrokenBoard = JSON.stringify({
      nextNumber: 2,
      tasks: [{
        id: 'broken-card',
        key: 'SHIB-1',
        title: 'Broken card',
        description: '',
        status: 'todo',
        priority: 1,
        assigneeAgentId: null,
        projectId: null,
        labels: [],
        order: 100,
        activity: [],
        runIds: null,
        working: false,
        externalRefs: [],
        createdAt: now,
        updatedAt: now,
        syncUpdatedAt: now,
      }],
      syncState: {},
    });
    const failedRestore = await backup.restoreBackup({
      format: backup.BACKUP_FORMAT,
      version: backup.BACKUP_VERSION,
      exportedAt: now,
      stores: { 'board.json': semanticallyBrokenBoard },
      sqliteBase64: (await fs.readFile(alternateDatabasePath)).toString('base64'),
      secretKeyHex: process.env.SHIBA_SECRET_KEY,
    });
    assert.equal(failedRestore.ok, false, 'semantic validation failure must fail the restore');
    assert.match(failedRestore.error || '', /failed|filter|pre-restore state/i);
    assert.equal(
      await fs.readFile(boardPath, 'utf8'),
      originalBoard,
      'semantic validation failure must atomically restore the previous JSON generation',
    );
    const restoredSentinel = database.getDb()
      .prepare('SELECT value FROM backup_restore_semantic_sentinel')
      .get() as { value?: string };
    assert.equal(
      restoredSentinel.value,
      'original',
      'semantic validation failure must atomically restore the previous SQLite generation',
    );
    await assertMissing(journalPath, 'successful semantic rollback must retire its journal');
    const artifacts = (await fs.readdir(data)).filter((name) =>
      name.includes('.restore') || name.includes('.rollback'));
    assert.deepEqual(artifacts, [], 'successful rollback must not strand staging or rollback artifacts');

    console.log('Backup restore crash-safety verification passed');
  } finally {
    await stopBackgroundWork();
    database.closeDb();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EBUSY' || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }
}

main().catch((error) => {
  console.error('Backup restore crash-safety verification failed', error);
  process.exit(1);
});
