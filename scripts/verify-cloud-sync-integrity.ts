import './verify-isolate';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface RemoteFile {
  id: string;
  filename: string;
  bytes: number;
  created_at: number;
  content: Buffer;
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-cloud-integrity-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = 'a7'.repeat(32);

  const persistence = await import('../lib/persistence');
  const workspace = await import('../lib/workspace');
  const oauth = await import('../lib/xai-oauth');
  const cloudSync = await import('../lib/cloud-sync');
  const { dataDir } = await import('../lib/data-paths');
  const remotes = new Map<string, RemoteFile>();
  let sequence = 0;
  const deleted: string[] = [];

  oauth.setTokenFetcher(async (url, init) => {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (parsed.pathname.endsWith('/files') && method === 'POST') {
      const upload = (init.body as FormData).get('file') as File;
      const content = Buffer.from(await upload.arrayBuffer());
      const id = `remote-${++sequence}`;
      const record: RemoteFile = {
        id,
        filename: upload.name,
        bytes: content.length,
        created_at: Math.floor(Date.now() / 1_000),
        content,
      };
      remotes.set(id, record);
      return Response.json(record);
    }
    if (parsed.pathname.endsWith('/files') && method === 'GET') {
      return Response.json({ data: [...remotes.values()] });
    }
    const contentMatch = parsed.pathname.match(/\/files\/([^/]+)\/content$/);
    if (contentMatch && method === 'GET') {
      const remote = remotes.get(decodeURIComponent(contentMatch[1]));
      return remote
        ? new Response(Uint8Array.from(remote.content))
        : new Response('missing', { status: 404 });
    }
    const fileMatch = parsed.pathname.match(/\/files\/([^/]+)$/);
    if (fileMatch && method === 'DELETE') {
      const id = decodeURIComponent(fileMatch[1]);
      deleted.push(id);
      const existed = remotes.delete(id);
      return new Response('', { status: existed ? 200 : 404 });
    }
    if (fileMatch && method === 'GET') {
      const remote = remotes.get(decodeURIComponent(fileMatch[1]));
      return remote ? Response.json(remote) : new Response('missing', { status: 404 });
    }
    return new Response('unexpected verifier request', { status: 500 });
  });

  try {
    await persistence.saveConfig({
      defaultWorkspace: path.join(root, 'workspace'),
      xaiApiKey: 'xai-cloud-integrity-test',
      cloudAuthMode: 'api_key',
    });
    await workspace.saveUploadFromBuffer('document.txt', Buffer.from('version one'));
    const first = await cloudSync.syncUploadToCloud();
    assert.deepEqual(first.uploaded, ['document.txt']);
    assert.equal((await cloudSync.getCloudSyncEntries())[0].xaiFileId, 'remote-1');

    await new Promise((resolve) => setTimeout(resolve, 10));
    await workspace.saveUploadFromBuffer('document.txt', Buffer.from('version two'));
    const second = await cloudSync.syncUploadToCloud();
    assert.deepEqual(second.uploaded, ['document.txt']);
    assert(deleted.includes('remote-1'), 'replaced remote version is durably deleted');
    assert.equal(remotes.has('remote-1'), false);
    assert.equal((await cloudSync.getCloudSyncEntries())[0].xaiFileId, 'remote-2');
    const statePath = dataDir('cloud-sync.json');

    // A crash before download bytes land must not bless a same-sized local
    // edit as the remote object merely because its byte count matches.
    const uploadsDir = await workspace.getGlobalUploadsDir();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(path.join(uploadsDir, 'document.txt'), 'local edit!');
    const preDownloadState = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      downloadIntents?: unknown[];
    };
    preDownloadState.downloadIntents = [{
      id: 'interrupted-download',
      xaiFileId: 'remote-2',
      localName: 'document.txt',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
    }];
    await fs.writeFile(statePath, `${JSON.stringify(preDownloadState, null, 2)}\n`, 'utf8');
    await cloudSync.syncDownloadFromCloud();
    assert.equal(
      await fs.readFile(path.join(uploadsDir, 'document.txt'), 'utf8'),
      'version two',
      'interrupted download recovery re-fetches bytes instead of trusting size alone',
    );

    const crashFile = await workspace.saveUploadFromBuffer('crash.txt', Buffer.from('adopt me'));
    const crashRemote: RemoteFile = {
      id: 'remote-crash',
      filename: crashFile.name,
      bytes: crashFile.size,
      created_at: Math.floor(Date.now() / 1_000),
      content: Buffer.from('adopt me'),
    };
    remotes.set(crashRemote.id, crashRemote);
    remotes.set('external-upload-twin', {
      id: 'external-upload-twin',
      filename: crashFile.name,
      bytes: crashFile.size,
      created_at: Math.floor(Date.now() / 1_000),
      content: Buffer.from('not mine'),
    });
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      files: unknown[];
      uploadIntents?: unknown[];
    };
    state.uploadIntents = [{
      id: 'interrupted-upload',
      localName: crashFile.name,
      bytes: crashFile.size,
      localModifiedAt: crashFile.modifiedAt,
      sha256: workspace.sha256Checksum(Buffer.from('adopt me')),
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      previousFileIds: [],
      attempts: 0,
    }];
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    assert.deepEqual(await cloudSync.recoverPendingCloudUploadIntents(), { recovered: 1, pending: 0 });
    assert((await cloudSync.getCloudSyncEntries()).some((entry) => entry.xaiFileId === 'remote-crash'));
    assert(remotes.has('external-upload-twin'), 'same-name/size foreign bytes are never adopted or deleted');

    await workspace.deleteGlobalUploadFile('crash.txt');
    const ownership = await cloudSync.reconcileCloudSyncOwnership();
    assert.equal(ownership.remoteOnly, 1, 'missing local bytes retain an explicit remote-only owner');
    assert((await cloudSync.getCloudSyncEntries())
      .find((entry) => entry.xaiFileId === 'remote-crash')?.localMissingAt);

    remotes.set('external-collision', {
      id: 'external-collision',
      filename: 'document.txt',
      bytes: 16,
      created_at: Math.floor(Date.now() / 1_000),
      content: Buffer.from('external content'),
    });
    const download = await cloudSync.syncDownloadFromCloud();
    const collisionName = (await cloudSync.getCloudSyncEntries())
      .find((entry) => entry.xaiFileId === 'external-collision')?.localName;
    assert(download.downloaded.includes(collisionName || ''), 'external collision is reported as downloaded');
    assert(collisionName && collisionName !== 'document.txt', 'remote name collision gets a unique local owner');
    assert.equal(await fs.readFile(path.join(uploadsDir, 'document.txt'), 'utf8'), 'version two');
    assert.equal(await fs.readFile(path.join(uploadsDir, collisionName), 'utf8'), 'external content');

    // The periodic owner sweep must converge crash-left download intents. A
    // mapped intent is redundant, a provider-confirmed old missing id is
    // quarantined, malformed records are preserved in lost+found, and a fresh
    // intent survives the inventory/create race grace period. Ambiguous legacy
    // uploads remain pending because they may own remote bytes.
    const intentState = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      files: unknown[];
      uploadIntents?: unknown[];
      deletionIntents?: unknown[];
      downloadIntents?: unknown[];
    };
    intentState.files.push(null, {
      localName: 'invalid-owner.txt',
      xaiFileId: 'invalid/remote/id',
      bytes: 1,
      syncedAt: new Date().toISOString(),
      localModifiedAt: new Date().toISOString(),
    });
    intentState.uploadIntents = [{
      id: 'legacy-upload-intent',
      localName: 'legacy.txt',
      bytes: 12,
      localModifiedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      previousFileIds: [],
      attempts: 1,
    }, null];
    intentState.deletionIntents = [null];
    intentState.downloadIntents = [{
      id: 'redundant-download',
      xaiFileId: 'remote-crash',
      localName: 'crash.txt',
      startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    }, {
      id: 'stale-download',
      xaiFileId: 'remote-no-longer-exists',
      localName: 'stale.txt',
      startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    }, {
      id: 'fresh-download',
      xaiFileId: 'remote-created-concurrently',
      localName: 'fresh.txt',
      startedAt: new Date().toISOString(),
    }, null];
    await fs.writeFile(statePath, `${JSON.stringify(intentState, null, 2)}\n`, 'utf8');
    const intentRepair = await cloudSync.reconcileCloudSyncOwnership();
    assert.equal(intentRepair.redundantDownloadIntentsRemoved, 1);
    assert.equal(intentRepair.staleDownloadIntentsQuarantined, 1);
    assert.equal(intentRepair.invalidDownloadIntentsQuarantined, 1);
    assert.equal(intentRepair.invalidOwnershipMappingsQuarantined, 2);
    assert.equal(intentRepair.invalidUploadIntentsQuarantined, 1);
    assert.equal(intentRepair.invalidDeletionIntentsQuarantined, 1);
    assert.equal(intentRepair.uploadIntentsPending, 1,
      'a legacy upload intent without a checksum remains fail-closed and pending');
    const repairedIntentState = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      uploadIntents?: Array<{ id: string }>;
      deletionIntents?: unknown[];
      downloadIntents?: Array<{ id: string }>;
    };
    assert.deepEqual(repairedIntentState.downloadIntents?.map((intent) => intent.id), ['fresh-download']);
    assert.deepEqual(repairedIntentState.uploadIntents?.map((intent) => intent.id), ['legacy-upload-intent']);
    assert.deepEqual(repairedIntentState.deletionIntents, []);
    const lostFoundRoot = dataDir('lost+found', 'managed-storage');
    const issueDirectories = await fs.readdir(lostFoundRoot);
    const issueManifests = await Promise.all(issueDirectories.map(async (entry) =>
      JSON.parse(await fs.readFile(path.join(lostFoundRoot, entry, 'manifest.json'), 'utf8'))));
    assert(issueManifests.some((manifest) => manifest.reason === 'stale_cloud_download_intent'));
    assert(issueManifests.some((manifest) => manifest.reason === 'invalid_cloud_download_intent'));
    assert(issueManifests.some((manifest) => manifest.reason === 'invalid_cloud_upload_intent'));
    assert(issueManifests.some((manifest) => manifest.reason === 'invalid_cloud_deletion_intent'));
    assert.equal(issueManifests.filter((manifest) => manifest.reason === 'invalid_cloud_sync_mapping').length, 2);

    console.log('Cloud sync ownership verification passed');
  } finally {
    oauth.setTokenFetcher(null);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Cloud sync ownership verification failed', error);
  process.exit(1);
});
