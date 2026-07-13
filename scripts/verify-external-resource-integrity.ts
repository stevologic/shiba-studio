import './verify-isolate';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

interface RemoteFile {
  id: string;
  filename: string;
  bytes: number;
  created_at: number;
  content: Buffer;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-external-integrity-'));
  const data = path.join(root, 'data');
  process.env.SHIBA_DATA_DIR = data;
  process.env.SHIBA_SECRET_KEY = 'a7'.repeat(32);

  const remote = new Map<string, RemoteFile>();
  const deleteFailures = new Map<string, number>();
  let remoteOrdinal = 0;
  const addRemote = (input: Omit<RemoteFile, 'created_at'> & { created_at?: number }): RemoteFile => {
    const file = { ...input, created_at: input.created_at ?? Date.now() };
    remote.set(file.id, file);
    return file;
  };

  const xaiOAuth = await import('../lib/xai-oauth');
  xaiOAuth.setTokenFetcher(async (url, init) => {
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (parsed.pathname.endsWith('/files') && method === 'POST') {
      const form = init.body as FormData;
      const file = form.get('file');
      assert(file instanceof File, 'xAI upload body contains a File');
      const content = Buffer.from(await file.arrayBuffer());
      const created = addRemote({
        id: `owned-remote-${++remoteOrdinal}`,
        filename: file.name,
        bytes: content.length,
        content,
      });
      return Response.json({
        id: created.id,
        filename: created.filename,
        bytes: created.bytes,
        created_at: created.created_at,
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
      const id = decodeURIComponent(fileMatch[1]);
      const failures = deleteFailures.get(id) || 0;
      if (failures > 0) {
        deleteFailures.set(id, failures - 1);
        return new Response('temporary provider failure', { status: 503 });
      }
      if (!remote.delete(id)) return new Response('missing', { status: 404 });
      return new Response(null, { status: 204 });
    }
    return new Response(`unexpected ${method} ${parsed.pathname}`, { status: 500 });
  });

  const dbModule = await import('../lib/db');
  const persistence = await import('../lib/persistence');
  const external = await import('../lib/external-resource-integrity');
  const entitySync = await import('../lib/entity-sync');
  const mcp = await import('../lib/mcp');
  const mcpCatalog = await import('../lib/mcp-catalog');
  const coordinator = await import('../lib/integrity-coordinator');

  try {
    await persistence.saveConfig({ xaiApiKey: 'external-integrity-key', cloudAuthMode: 'api_key' });

    const manualSnapshot = addRemote({
      id: 'provider-owned-snapshot',
      filename: 'shiba-sync-agents.json',
      bytes: 20,
      content: Buffer.from('{"provider":"user"}'),
      created_at: Date.now() + 10 * 60_000,
    });
    const firstPush = await entitySync.pushKind('agents');
    assert.equal(firstPush.ok, true, firstPush.error);
    const firstOwnedSnapshot = [...remote.values()].find((file) => {
      if (file.id === manualSnapshot.id || file.filename !== 'shiba-sync-agents.json') return false;
      const parsed = JSON.parse(file.content.toString('utf8')) as { _shibaOwnership?: { schema?: string } };
      return parsed._shibaOwnership?.schema === 'shiba-external-resource-v1';
    });
    assert(firstOwnedSnapshot, 'entity snapshot embeds exact Shiba ownership proof');
    deleteFailures.set(firstOwnedSnapshot.id, 1);
    const secondPush = await entitySync.pushKind('agents');
    assert.equal(secondPush.ok, true, secondPush.error);
    assert(remote.has(manualSnapshot.id), 'same-named provider file is never deleted without a local ledger');
    assert(remote.has(firstOwnedSnapshot.id), 'failed replacement cleanup remains remotely pending');
    let snapshot = external.inspectOwnedXaiResources();
    assert(snapshot.resources.some((row) =>
      row.resourceId === firstOwnedSnapshot.id && row.deletionRequestedAt),
    'replaced entity snapshot keeps a durable deletion tombstone');
    const entityCleanup = await external.reconcileOwnedXaiResources({
      nowMs: Date.now() + 2 * 60_000,
      tombstoneGraceMs: 0,
    });
    assert.equal(entityCleanup.remoteFilesDeleted, 1);
    assert(!remote.has(firstOwnedSnapshot.id), 'coordinator retry deletes the replaced owned snapshot');
    assert(remote.has(manualSnapshot.id), 'coordinator still preserves unowned same-name data');
    const pull = await entitySync.pullKind('agents');
    assert.equal(pull.ok, true, 'pull prefers the exact owned snapshot over a newer same-name provider file');

    const uploadBody = Buffer.from('owned chat attachment');
    const form = new FormData();
    form.append('file', new File([uploadBody], 'quarterly-report.pdf', { type: 'application/pdf' }));
    form.append('model', 'cloud:grok-4');
    const uploadRoute = await import('../app/api/chat/upload/route');
    const uploadResponse = await uploadRoute.POST(new NextRequest('http://localhost/api/chat/upload', {
      method: 'POST',
      headers: { 'content-length': String(uploadBody.length + 1_024) },
      body: form,
    }));
    assert.equal(uploadResponse.status, 200);
    const uploadPayload = await uploadResponse.json() as {
      attachment: { fileId: string; name: string };
    };
    assert.equal(uploadPayload.attachment.name, 'quarterly-report.pdf');
    const chatId = uploadPayload.attachment.fileId;
    const chatRemote = remote.get(chatId);
    assert(chatRemote);
    assert.match(chatRemote.filename, /^shiba-chat-[0-9a-f-]{36}\.pdf$/);
    assert.notEqual(chatRemote.filename, uploadPayload.attachment.name,
      'remote UUID filename makes crash recovery ownership unambiguous');

    const providerLookalike = addRemote({
      id: 'provider-chat-lookalike',
      filename: 'shiba-chat-00000000-0000-4000-8000-000000000000.pdf',
      bytes: 4,
      content: Buffer.from('user'),
    });
    const base = Date.now();
    const livePass = await external.reconcileOwnedXaiResources({
      liveChatFileIds: new Set([chatId]),
      nowMs: base,
      chatUnreferencedAgeMs: 60_000,
    });
    assert.equal(livePass.chatFilesTombstoned, 0, 'live chat attachment remains owned');
    await external.reconcileOwnedXaiResources({
      liveChatFileIds: new Set(),
      nowMs: base + 2 * 60_000,
      chatUnreferencedAgeMs: 60_000,
    });
    const tombstonePass = await external.reconcileOwnedXaiResources({
      liveChatFileIds: new Set(),
      nowMs: base + 4 * 60_000,
      chatUnreferencedAgeMs: 60_000,
      tombstoneGraceMs: 60_000,
    });
    assert.equal(tombstonePass.chatFilesTombstoned, 1);
    await persistence.saveConfig({ xaiApiKey: 'different-account-key' });
    const wrongCredential = await external.reconcileOwnedXaiResources({
      liveChatFileIds: new Set(),
      nowMs: base + 6 * 60_000,
      chatUnreferencedAgeMs: 60_000,
      tombstoneGraceMs: 60_000,
    });
    assert.equal(wrongCredential.remoteFilesDeleted, 0);
    assert(remote.has(chatId), 'a different credential cannot retire an old account tombstone on 404');
    await persistence.saveConfig({ xaiApiKey: 'external-integrity-key' });
    deleteFailures.set(chatId, 1);
    const failedDelete = await external.reconcileOwnedXaiResources({
      liveChatFileIds: new Set(),
      nowMs: base + 8 * 60_000,
      chatUnreferencedAgeMs: 60_000,
      tombstoneGraceMs: 60_000,
    });
    assert(failedDelete.errors.some((error) => error.includes(chatId)));
    assert(remote.has(chatId), 'provider failure retains the tombstone and remote object');
    const successfulDelete = await external.reconcileOwnedXaiResources({
      liveChatFileIds: new Set(),
      nowMs: base + 10 * 60_000,
      chatUnreferencedAgeMs: 60_000,
      tombstoneGraceMs: 60_000,
    });
    assert.equal(successfulDelete.remoteFilesDeleted, 1);
    assert(!remote.has(chatId));
    assert(remote.has(providerLookalike.id), 'lookalike remote files without ledger proof survive');

    const recoveryToken = '11111111-2222-4333-8444-555555555555';
    const recoveryContent = Buffer.from('recover exact upload');
    dbModule.getDb().prepare(`
      INSERT INTO external_xai_upload_intents
        (id, kind, ownerKey, filename, bytes, authSource, authFingerprint, startedAt, lastError)
      VALUES (?, 'chat_file', 'chat-attachment', ?, ?, 'api_key', ?, ?, NULL)
    `).run(
      recoveryToken,
      `shiba-chat-${recoveryToken}.txt`,
      recoveryContent.length,
      createHash('sha256').update('api_key\0external-integrity-key').digest('hex'),
      new Date().toISOString(),
    );
    const recoveredRemote = addRemote({
      id: 'owned-recovered-chat',
      filename: `shiba-chat-${recoveryToken}.txt`,
      bytes: recoveryContent.length,
      content: recoveryContent,
    });
    const recovered = await external.reconcileOwnedXaiResources({
      liveChatFileIds: new Set([recoveredRemote.id]),
      nowMs: Date.now(),
    });
    assert.equal(recovered.uploadIntentsRecovered, 1,
      'successful provider upload is adopted after a response/persistence crash');

    const firstX = await mcp.addMcpServerFromPreset('x', {}, {
      xClientId: 'external-client-one',
      xClientSecret: 'external-secret-one',
    });
    const firstHome = firstX.env.HOME;
    assert(firstHome && await exists(firstHome));
    assert(await exists(path.join(firstHome, '.shiba-x-mcp-profile.json')));
    const secondX = await mcp.addMcpServerFromPreset('x', {
      CLIENT_ID: 'external-client-two',
      CLIENT_SECRET: 'external-secret-two',
    });
    assert.equal(await exists(firstHome), false, 'profile replacement removes the exact old credential home');
    assert(secondX.env.HOME && await exists(secondX.env.HOME));

    const xRoot = path.join(data, 'x-mcp');
    const unmarked = path.join(xRoot, 'shiba-studio-deadbeef');
    const marked = path.join(xRoot, 'shiba-studio-feedface');
    const lookalike = path.join(xRoot, 'shiba-studio-feedface-extra');
    await Promise.all([fs.mkdir(unmarked), fs.mkdir(marked), fs.mkdir(lookalike)]);
    await fs.writeFile(path.join(marked, '.shiba-x-mcp-profile.json'), JSON.stringify({
      schema: 'shiba-x-mcp-profile-v1',
      profile: path.basename(marked),
      nonce: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    }));
    const profileSweep = await mcp.reconcileXurlCredentialHomes();
    assert.equal(profileSweep.orphanedProfilesRemoved, 1);
    assert.equal(await exists(marked), false);
    assert.equal(await exists(unmarked), true, 'unmarked exact-shape directory is preserved without ownership proof');
    assert.equal(await exists(lookalike), true, 'non-exact profile shape is ignored');

    const secondHome = secondX.env.HOME;
    await mcp.deleteMcpServer(secondX.id);
    assert.equal(await exists(secondHome), false, 'server deletion removes its exact marked profile');

    const occupiedClient = 'preexisting-user-profile';
    const occupiedHome = path.join(xRoot, mcpCatalog.xurlCredentialProfile(occupiedClient));
    await fs.mkdir(occupiedHome);
    await fs.writeFile(path.join(occupiedHome, 'user-keeps-this.txt'), 'not Shiba-owned');
    await assert.rejects(
      mcp.addMcpServerFromPreset('x', {}, {
        xClientId: occupiedClient,
        xClientSecret: 'must-not-claim-user-profile',
      }),
      /unmarked|preserved/i,
    );
    assert.equal(await fs.readFile(path.join(occupiedHome, 'user-keeps-this.txt'), 'utf8'), 'not Shiba-owned',
      'a preexisting nonempty profile is never claimed by adding a marker');

    const junctionClient = 'preexisting-junction-profile';
    const junctionHome = path.join(xRoot, mcpCatalog.xurlCredentialProfile(junctionClient));
    const junctionTarget = path.join(root, 'junction-target');
    await fs.mkdir(junctionTarget);
    await fs.writeFile(path.join(junctionTarget, 'outside.txt'), 'outside bytes');
    await fs.symlink(junctionTarget, junctionHome, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      mcp.addMcpServerFromPreset('x', {}, {
        xClientId: junctionClient,
        xClientSecret: 'must-not-follow-junction',
      }),
      /real directory/i,
    );
    assert.equal(await fs.readFile(path.join(junctionTarget, 'outside.txt'), 'utf8'), 'outside bytes',
      'junction target survives profile creation/deletion checks');

    const thirdX = await mcp.addMcpServerFromPreset('x', {}, {
      xClientId: 'external-client-three',
      xClientSecret: 'external-secret-three',
    });
    await persistence.saveConfig({
      integrations: {
        x: {
          apiKey: 'oauth1-key',
          apiSecret: 'oauth1-secret',
          accessToken: 'oauth1-token',
          accessTokenSecret: 'oauth1-token-secret',
          clientId: 'external-client-three',
          clientSecret: 'external-secret-three',
        },
      },
    });
    const integrationsRoute = await import('../app/api/integrations/route');
    const clientDeleteResponse = await integrationsRoute.POST(new NextRequest('http://localhost/api/integrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', which: 'x' }),
    }));
    assert.equal(clientDeleteResponse.status, 200);
    assert.equal(await exists(thirdX.env.HOME), false, 'client deletion removes only its matching profile');
    assert.equal((await mcp.listMcpServers()).some((server) => server.id === thirdX.id), false);
    assert.equal(await exists(unmarked), true, 'client/server cleanup never widens to unproven profiles');

    snapshot = external.inspectOwnedXaiResources();
    assert.equal(snapshot.intents.length, 0);
    assert(!snapshot.resources.some((row) => row.resourceId === chatId));
    console.log('external resource integrity verification passed');
  } finally {
    xaiOAuth.setTokenFetcher(null);
    await coordinator.stopDataIntegritySchedule();
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
