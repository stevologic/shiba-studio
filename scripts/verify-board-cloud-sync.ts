/**
 * Focused verification for the Board snapshot stored in private xAI/Grok Files.
 * Provider traffic and every local store are isolated from the live Studio.
 */
import './verify-isolate';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface RemoteFile {
  id: string;
  filename: string;
  bytes: number;
  created_at: number;
  content: Buffer;
}

interface BoardEnvelope {
  _shibaOwnership?: {
    schema?: string;
    kind?: string;
    ownerKey?: string;
  };
  kind?: string;
  payload?: {
    schema?: string;
    version?: number;
    exportedAt?: string;
    tasks?: Array<Record<string, unknown>>;
  };
}

async function main(): Promise<void> {
  const parentDataDir = process.env.SHIBA_DATA_DIR || process.cwd();
  const testDataDir = path.join(parentDataDir, `verify-board-cloud-sync-${process.pid}-${Date.now()}`);
  process.env.SHIBA_DATA_DIR = testDataDir;
  process.env.SHIBA_SECRET_KEY = 'b7'.repeat(32);
  await fs.mkdir(testDataDir, { recursive: true });

  const remote = new Map<string, RemoteFile>();
  let remoteOrdinal = 0;
  const xaiOAuth = await import('../lib/xai-oauth');
  xaiOAuth.setTokenFetcher(async (url, init) => {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (parsed.pathname.endsWith('/files') && method === 'POST') {
      const form = init.body as FormData;
      const file = form.get('file');
      assert(file instanceof File, 'xAI upload contains a file');
      const content = Buffer.from(await file.arrayBuffer());
      const stored: RemoteFile = {
        id: `board-cloud-${++remoteOrdinal}`,
        filename: file.name,
        bytes: content.length,
        created_at: Date.now() + remoteOrdinal,
        content,
      };
      remote.set(stored.id, stored);
      return Response.json({
        id: stored.id,
        filename: stored.filename,
        bytes: stored.bytes,
        created_at: stored.created_at,
      });
    }
    if (parsed.pathname.endsWith('/files') && method === 'GET') {
      return Response.json({
        data: [...remote.values()].map((file) => ({
          id: file.id,
          filename: file.filename,
          bytes: file.bytes,
          created_at: file.created_at,
        })),
      });
    }
    const contentMatch = /\/files\/([^/]+)\/content$/.exec(parsed.pathname);
    if (contentMatch && method === 'GET') {
      const file = remote.get(decodeURIComponent(contentMatch[1]));
      return file ? new Response(new Uint8Array(file.content)) : new Response('missing', { status: 404 });
    }
    const fileMatch = /\/files\/([^/]+)$/.exec(parsed.pathname);
    if (fileMatch && method === 'DELETE') {
      return new Response(null, { status: remote.delete(decodeURIComponent(fileMatch[1])) ? 204 : 404 });
    }
    return new Response(`unexpected ${method} ${parsed.pathname}`, { status: 500 });
  });

  const persistence = await import('../lib/persistence');
  const board = await import('../lib/board');
  const projects = await import('../lib/projects');
  const entitySync = await import('../lib/entity-sync');
  const db = await import('../lib/db');

  try {
    await persistence.saveConfig({ xaiApiKey: 'board-cloud-key', cloudAuthMode: 'api_key' });
    const project = await projects.createProject('Local project', 'Must remain a local relationship');
    const base = new Date('2026-07-14T12:00:00.000Z');
    const existing = await board.createBoardTask({
      id: 'board-cloud-existing',
      title: 'Local title',
      description: 'Local description',
      status: 'todo',
      priority: 2,
      labels: ['local'],
      createdAt: base.toISOString(),
      syncUpdatedAt: base.toISOString(),
    });
    await board.updateBoardTask(existing.id, {
      projectId: project.id,
      addRunId: 'local-run-id',
      note: { kind: 'user', text: 'Local activity must survive cloud pulls' },
      externalRef: {
        provider: 'linear',
        connectionId: 'local-connection',
        containerId: 'local-team',
        containerName: 'Local Linear team',
        remoteId: 'remote-1',
        remoteKey: 'LIN-1',
        url: 'https://linear.example/LIN-1',
        remoteUpdatedAt: base.toISOString(),
        lastSyncedAt: base.toISOString(),
        lastLocalFingerprint: 'local-fingerprint',
        lastRemoteFingerprint: 'remote-fingerprint',
      },
    });
    const active = await board.createBoardTask({
      id: 'board-cloud-active',
      title: 'Live local work',
      status: 'in_progress',
      createdAt: base.toISOString(),
      syncUpdatedAt: base.toISOString(),
    });
    await board.updateBoardTask(active.id, { working: true });

    const pushed = await entitySync.pushKind('board');
    assert.equal(pushed.ok, true, pushed.error);
    assert.match(pushed.detail, /2 Board card\(s\) pushed/);
    const stored = [...remote.values()].find((file) => file.filename === 'shiba-sync-board.json');
    assert(stored, 'push creates shiba-sync-board.json');
    const envelope = JSON.parse(stored.content.toString('utf8')) as BoardEnvelope;
    assert.equal(envelope._shibaOwnership?.schema, 'shiba-external-resource-v1');
    assert.equal(envelope._shibaOwnership?.kind, 'entity_snapshot');
    assert.equal(envelope._shibaOwnership?.ownerKey, 'entity-sync:board');
    assert.equal(envelope.kind, 'board');
    assert.equal(envelope.payload?.schema, 'shiba.board/v1');
    assert.equal(envelope.payload?.version, 1);
    assert.equal(envelope.payload?.tasks?.length, 2);
    const portableKeys = [
      'createdAt', 'description', 'id', 'key', 'labels', 'priority', 'status', 'syncUpdatedAt', 'title',
    ];
    for (const task of envelope.payload?.tasks || []) {
      assert.deepEqual(Object.keys(task).sort(), portableKeys, 'snapshot uses the strict safe-field allowlist');
      for (const forbidden of [
        'activeWork', 'assigneeAgentId', 'activity', 'autoAssignment', 'externalRefs',
        'projectId', 'runIds', 'working',
      ]) {
        assert(!(forbidden in task), `snapshot excludes ${forbidden}`);
      }
    }

    const localOnly = await board.createBoardTask({
      id: 'board-cloud-local-only',
      title: 'Never delete me',
      createdAt: base.toISOString(),
      syncUpdatedAt: base.toISOString(),
    });
    const originalExisting = await board.getBoardTask(existing.id);
    assert(originalExisting);
    const originalActivity = originalExisting.activity.map((item) => ({ ...item }));
    const existingCloud = envelope.payload?.tasks?.find((task) => task.id === existing.id);
    const activeCloud = envelope.payload?.tasks?.find((task) => task.id === active.id);
    assert(existingCloud && activeCloud);
    const newer = new Date(base.getTime() + 60_000).toISOString();
    const newest = new Date(base.getTime() + 120_000).toISOString();
    envelope.payload = {
      schema: 'shiba.board/v1',
      version: 1,
      exportedAt: newest,
      tasks: [
        {
          ...existingCloud,
          title: 'Newer cloud title',
          description: 'Newer cloud description',
          status: 'in_review',
          priority: 1,
          labels: ['cloud'],
          syncUpdatedAt: newer,
        },
        {
          ...activeCloud,
          title: 'Must not replace live work',
          syncUpdatedAt: newest,
        },
        {
          id: 'board-cloud-new',
          key: 'SHIB-9000',
          title: 'Imported safely',
          description: 'Portable cloud card',
          status: 'done',
          priority: 3,
          labels: ['cloud', 'portable'],
          createdAt: base.toISOString(),
          syncUpdatedAt: newer,
        },
      ],
    };
    stored.content = Buffer.from(JSON.stringify(envelope));
    stored.bytes = stored.content.length;

    const pulled = await entitySync.pullKind('board');
    assert.equal(pulled.ok, true, pulled.error);
    assert.match(pulled.detail, /1 added, 1 updated, 0 already current, 1 skipped with active work/);
    const afterPull = await board.listBoardTasks();
    assert.equal(afterPull.length, 4, 'pull adds one card and never deletes the local-only card');
    assert(afterPull.some((task) => task.id === localOnly.id));
    const updated = afterPull.find((task) => task.id === existing.id);
    assert(updated);
    assert.equal(updated.title, 'Newer cloud title');
    assert.equal(updated.status, 'in_review');
    assert.equal(updated.projectId, project.id, 'local project relationship survives');
    assert.deepEqual(updated.runIds, ['local-run-id'], 'local run links survive');
    assert.equal(updated.externalRefs?.[0]?.remoteKey, 'LIN-1', 'tracker link survives');
    assert.deepEqual(updated.activity.slice(0, originalActivity.length), originalActivity, 'local activity survives');
    const stillActive = afterPull.find((task) => task.id === active.id);
    assert(stillActive);
    assert.equal(stillActive.title, 'Live local work');
    assert.equal(stillActive.working, true, 'working card is not changed underneath live work');
    const imported = afterPull.find((task) => task.id === 'board-cloud-new');
    assert(imported);
    assert.notEqual(imported.key, 'SHIB-9000', 'import allocates a collision-safe local display key');
    assert.equal(imported.assigneeAgentId, null);
    assert.equal(imported.projectId, null);
    assert.deepEqual(imported.runIds, []);
    assert.deepEqual(imported.externalRefs, []);
    assert.equal(imported.working, undefined);
    assert.equal(imported.activeWork, undefined);
    assert.equal(imported.autoAssignment, undefined);

    const activityCount = updated.activity.length;
    const repeated = await entitySync.pullKind('board');
    assert.equal(repeated.ok, true, repeated.error);
    const afterRepeat = await board.listBoardTasks();
    assert.equal(afterRepeat.length, 4, 'repeating a pull is idempotent');
    assert.equal(afterRepeat.find((task) => task.id === existing.id)?.activity.length, activityCount,
      'repeating a pull does not duplicate activity');

    const olderPayload = envelope.payload.tasks?.find((task) => task.id === existing.id);
    assert(olderPayload);
    olderPayload.title = 'Older cloud title';
    olderPayload.syncUpdatedAt = base.toISOString();
    stored.content = Buffer.from(JSON.stringify(envelope));
    stored.bytes = stored.content.length;
    const olderPull = await entitySync.pullKind('board');
    assert.equal(olderPull.ok, true, olderPull.error);
    assert.equal((await board.getBoardTask(existing.id))?.title, 'Newer cloud title',
      'an older cloud snapshot cannot roll back local fields');

    const boardFile = path.join(testDataDir, 'board.json');
    const beforeMalformed = await fs.readFile(boardFile, 'utf8');
    envelope.payload.tasks = [{ ...olderPayload, assigneeAgentId: 'cloud-agent-must-not-run' }];
    stored.content = Buffer.from(JSON.stringify(envelope));
    stored.bytes = stored.content.length;
    const malformed = await entitySync.pullKind('board');
    assert.equal(malformed.ok, false, 'unknown operational fields reject the entire snapshot');
    assert.match(malformed.error || '', /Cloud Board snapshot is malformed/);
    assert.equal(await fs.readFile(boardFile, 'utf8'), beforeMalformed,
      'a malformed snapshot leaves the Board byte-for-byte unchanged');

    const overview = await entitySync.getSyncOverview();
    assert.equal(overview.counts.board, 4);
    assert(entitySync.SYNC_KINDS.includes('board'));
    console.log('BOARD_CLOUD_SYNC_VERIFY passed');
  } finally {
    xaiOAuth.setTokenFetcher(null);
    db.closeDb();
    await fs.rm(testDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('BOARD_CLOUD_SYNC_VERIFY failed', error);
  process.exitCode = 1;
});
