import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

function jsonRequest(url: string, body: unknown, token?: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function voiceRequest(input: {
  token: string;
  bytes: Uint8Array;
  idempotencyKey: string;
  consent?: boolean;
  mime?: string;
  sha256?: string;
  declaredBytes?: number;
}): Request {
  const sha256 = input.sha256 || createHash('sha256').update(input.bytes).digest('hex');
  return new Request('http://shiba.local:3000/api/companion/voice', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Content-Type': input.mime || 'audio/webm',
      'x-audio-bytes': String(input.declaredBytes ?? input.bytes.byteLength),
      'x-audio-sha256': sha256,
      'x-idempotency-key': input.idempotencyKey,
      'x-recording-consent': input.consent === false ? 'false' : 'true',
      'x-voice-title': encodeURIComponent('Verifier voice request'),
    },
    body: new Blob([new Uint8Array(input.bytes)]),
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-companion-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '66'.repeat(32);

  const dbModule = await import('../lib/db');
  const auth = await import('../lib/companion-auth');
  const ledger = await import('../lib/task-ledger');
  const approvals = await import('../lib/tool-approval');
  const auditLog = await import('../lib/audit-log');
  const routines = await import('../lib/routines');
  const meetings = await import('../lib/meetings');
  const persistence = await import('../lib/persistence');
  const oauth = await import('../lib/xai-oauth');
  const adminRoute = await import('../app/api/companion/admin/route');
  const pairRoute = await import('../app/api/companion/pair/route');
  const dataRoute = await import('../app/api/companion/data/route');
  const actionRoute = await import('../app/api/companion/actions/route');
  const voiceRoute = await import('../app/api/companion/voice/route');
  const manifestRoute = await import('../app/companion/manifest.webmanifest/route');

  try {
    assert.equal((await auth.remoteAccessStatus()).enabled, false, 'remote access defaults off');
    await assert.rejects(
      () => auth.createCompanionPairing({ companionOrigin: 'http://shiba.local:3000' }),
      /disabled/,
    );
    assert.throws(
      () => auth.requireLocalCompanionAdmin(new Request('http://shiba.local:3000/api/companion/admin')),
      /localhost/,
    );

    const enabledResponse = await adminRoute.POST(jsonRequest('http://localhost:3000/api/companion/admin', {
      action: 'set_enabled',
      enabled: true,
    }));
    assert.equal(enabledResponse.status, 200);
    assert.equal((await auth.remoteAccessStatus()).enabled, true);
    assert.throws(() => auth.validateCompanionOrigin('https://public.example.com'), /LAN/);
    assert.equal(auth.validateCompanionOrigin('https://host.tailnet-name.ts.net'), 'https://host.tailnet-name.ts.net');

    const pairingResponse = await adminRoute.POST(jsonRequest('http://localhost:3000/api/companion/admin', {
      action: 'create_pairing',
      companionOrigin: 'http://shiba.local:3000',
      scopes: [...auth.COMPANION_SCOPES],
    }));
    assert.equal(pairingResponse.status, 201);
    const pairingPayload = await pairingResponse.json() as {
      pairing: { id: string; code: string; pairingUrl: string; expiresAt: string };
    };
    assert.match(pairingPayload.pairing.pairingUrl, /^http:\/\/shiba\.local:3000\/companion\?pair=/);
    assert(Date.parse(pairingPayload.pairing.expiresAt) - Date.now() <= 10 * 60_000);

    const db = dbModule.getDb();
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert(version.user_version >= 13, 'companion approvals require the approval-only Attention schema');
    const pairingRow = db.prepare('SELECT codeHash FROM companion_pairings WHERE id = ?')
      .get(pairingPayload.pairing.id) as { codeHash: string };
    assert.notEqual(pairingRow.codeHash, pairingPayload.pairing.code, 'raw pairing code is never stored');

    const wrongPair = await pairRoute.POST(jsonRequest('http://shiba.local:3000/api/companion/pair', {
      pairingId: pairingPayload.pairing.id,
      code: 'WRONGCODE1',
      deviceName: 'Phone',
    }));
    assert.equal(wrongPair.status, 401);
    const pairedResponse = await pairRoute.POST(jsonRequest('http://shiba.local:3000/api/companion/pair', {
      pairingId: pairingPayload.pairing.id,
      code: pairingPayload.pairing.code,
      deviceName: 'Phone',
    }));
    assert.equal(pairedResponse.status, 201);
    const paired = await pairedResponse.json() as {
      deviceKey: string;
      device: { id: string; name: string; scopes: string[] };
    };
    assert.match(paired.deviceKey, /^shiba_cmp_/);
    const deviceRow = db.prepare('SELECT keyHash FROM companion_devices WHERE id = ?')
      .get(paired.device.id) as { keyHash: string };
    assert.notEqual(deviceRow.keyHash, paired.deviceKey, 'raw device key is never stored');
    const usedAgain = await pairRoute.POST(jsonRequest('http://shiba.local:3000/api/companion/pair', {
      pairingId: pairingPayload.pairing.id,
      code: pairingPayload.pairing.code,
      deviceName: 'Second phone',
    }));
    assert.equal(usedAgain.status, 401, 'pairing code is one-time');

    const task = ledger.createTask({
      id: 'companion-private-task',
      kind: 'code',
      title: 'Remote-safe build task',
      status: 'running',
      runId: 'companion-run-1',
      workspaceRoots: [{ id: 'private-repo', path: 'C:\\private\\workspace', permission: 'write' }],
      metadata: { integrationToken: 'TOP_SECRET_METADATA' },
    });
    ledger.recordTaskEvidence({
      taskId: task.id,
      kind: 'test',
      status: 'passed',
      label: 'Focused tests',
      summary: 'TOP_SECRET_FILE_CONTENT',
      command: 'cat C:\\private\\workspace\\secret.txt',
      metadata: { token: 'TOP_SECRET_EVIDENCE' },
    });
    ledger.transitionTask({ taskId: task.id, status: 'waiting_for_approval' });
    const pending = approvals.beginToolApproval(task.runId!, 'shell_exec', {
      command: 'npm test',
      apiKey: 'TOP_SECRET_APPROVAL',
      content: 'TOP_SECRET_BODY',
    }, 60_000);
    const attention = ledger.requestTaskApproval({
      taskId: task.id,
      approvalId: pending.approvalId,
      toolName: 'shell_exec',
      args: { command: 'npm test', apiKey: 'TOP_SECRET_APPROVAL', content: 'TOP_SECRET_BODY' },
      title: 'Approve test command',
      body: 'Contains TOP_SECRET_BODY and must never be projected.',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const dataResponse = await dataRoute.GET(new Request('http://shiba.local:3000/api/companion/data', {
      headers: { Authorization: `Bearer ${paired.deviceKey}` },
    }));
    assert.equal(dataResponse.status, 200);
    assert.equal(dataResponse.headers.get('cache-control'), 'no-store');
    const data = await dataResponse.json() as {
      tasks: Array<{ id: string; version: number; evidence: Array<Record<string, unknown>> }>;
      attention: Array<{ id: string; updatedAt: string; approval?: {
        taskId: string; taskVersion: number; actionDigest: string; expiresAt: string; arguments: Record<string, unknown>;
      } }>;
      routines: unknown[];
    };
    const serialized = JSON.stringify(data);
    for (const forbidden of [
      'TOP_SECRET_METADATA', 'TOP_SECRET_FILE_CONTENT', 'TOP_SECRET_EVIDENCE',
      'TOP_SECRET_APPROVAL', 'TOP_SECRET_BODY', 'private-repo', 'C:\\\\private',
    ]) {
      assert(!serialized.includes(forbidden), `companion projection must omit ${forbidden}`);
    }
    const projectedTask = data.tasks.find((item) => item.id === task.id);
    assert(projectedTask);
    assert.equal('summary' in projectedTask.evidence[0], false, 'evidence bodies are not projected');
    const projectedAttention = data.attention.find((item) => item.id === attention.id);
    assert(projectedAttention?.approval);
    assert.equal(projectedAttention.approval.arguments.apiKey, '[redacted]');
    assert.equal(projectedAttention.approval.arguments.content, '[redacted]');

    const approvalBody = {
      action: 'approve',
      idempotencyKey: 'approve-action-0001',
      attentionId: attention.id,
      taskId: task.id,
      expectedVersion: projectedAttention.approval.taskVersion,
      actionDigest: projectedAttention.approval.actionDigest,
      expiresAt: projectedAttention.approval.expiresAt,
    };
    const approveResponse = await actionRoute.POST(jsonRequest(
      'http://shiba.local:3000/api/companion/actions', approvalBody, paired.deviceKey,
    ));
    assert.equal(approveResponse.status, 200);
    assert.equal(await pending.wait, true, 'exact remote decision resolves the host approval synchronously');
    assert.equal(ledger.listAttention({ taskId: task.id }).items.some((item) => item.id === attention.id), false);
    const replayResponse = await actionRoute.POST(jsonRequest(
      'http://shiba.local:3000/api/companion/actions', approvalBody, paired.deviceKey,
    ));
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json() as { replay?: boolean }).replay, true, 'action retry is idempotent');
    const keyReuse = await actionRoute.POST(jsonRequest(
      'http://shiba.local:3000/api/companion/actions', { ...approvalBody, action: 'deny' }, paired.deviceKey,
    ));
    assert.equal(keyReuse.status, 409, 'idempotency key cannot be reused for a different action');

    const staleTask = ledger.createTask({
      id: 'companion-stale-task', kind: 'work', title: 'Revision-bound approval',
      status: 'running', runId: 'companion-run-2',
    });
    ledger.transitionTask({ taskId: staleTask.id, status: 'waiting_for_approval' });
    const stalePending = approvals.beginToolApproval(staleTask.runId!, 'fs_write', { path: 'safe.txt', content: 'hello' }, 60_000);
    const staleAttention = ledger.requestTaskApproval({
      taskId: staleTask.id,
      approvalId: stalePending.approvalId,
      toolName: 'fs_write',
      args: { path: 'safe.txt', content: 'hello' },
      title: 'Write safe.txt',
      body: 'Exact write approval',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const staleData = await (await dataRoute.GET(new Request('http://shiba.local:3000/api/companion/data', {
      headers: { Authorization: `Bearer ${paired.deviceKey}` },
    }))).json() as typeof data;
    const staleProjection = staleData.attention.find((item) => item.id === staleAttention.id)?.approval;
    assert(staleProjection);
    ledger.recordTaskEvidence({
      taskId: staleTask.id,
      kind: 'assertion',
      status: 'informational',
      label: 'Task changed after phone sync',
      summary: 'A durable task update invalidates the stale companion revision.',
    });
    const staleDecision = await actionRoute.POST(jsonRequest('http://shiba.local:3000/api/companion/actions', {
      action: 'approve', idempotencyKey: 'stale-action-0001', attentionId: staleAttention.id,
      taskId: staleTask.id, expectedVersion: staleProjection.taskVersion,
      actionDigest: staleProjection.actionDigest, expiresAt: staleProjection.expiresAt,
    }, paired.deviceKey));
    assert.equal(staleDecision.status, 409, 'stale task revision cannot approve an action');
    assert(approvals.getPendingApproval(stalePending.approvalId), 'stale decision leaves approval pending');
    assert(ledger.listAttention({ taskId: staleTask.id }).items.some((item) => item.id === staleAttention.id));
    approvals.resolveToolApproval(stalePending.approvalId, false);
    assert.equal(await stalePending.wait, false);
    assert.equal(ledger.listAttention({ taskId: staleTask.id }).total, 0,
      'resolved pending-map approvals must be pruned from companion Attention data');

    const steerTask = ledger.createTask({
      id: 'companion-steer-task', kind: 'work', title: 'Steer or cancel', status: 'running', runId: 'no-live-run',
    });
    const steerResponse = await actionRoute.POST(jsonRequest('http://shiba.local:3000/api/companion/actions', {
      action: 'steer', idempotencyKey: 'steer-action-0001', taskId: steerTask.id,
      expectedVersion: steerTask.version, instruction: 'Focus on the verified path.',
    }, paired.deviceKey));
    assert.equal(steerResponse.status, 200);
    const cancelResponse = await actionRoute.POST(jsonRequest('http://shiba.local:3000/api/companion/actions', {
      action: 'cancel', idempotencyKey: 'cancel-action-0001', taskId: steerTask.id,
      expectedVersion: ledger.getTask(steerTask.id)?.version,
    }, paired.deviceKey));
    assert.equal(cancelResponse.status, 200);
    assert.equal(ledger.getTask(steerTask.id)?.status, 'cancelled');

    const auditEntries = auditLog.listAuditLogs({ category: 'auth', q: 'companion approve', limit: 20 }).entries;
    assert(auditEntries.some((entry) => entry.meta?.deviceId === paired.device.id), 'remote mutation audit is device-attributed');

    const limitedPairing = await auth.createCompanionPairing({
      companionOrigin: 'http://192.168.1.20:3000', scopes: ['read:tasks'],
    });
    const limited = await auth.exchangeCompanionPairing({
      id: limitedPairing.id, code: limitedPairing.code, deviceName: 'Read-only tablet',
    });
    const limitedData = await (await dataRoute.GET(new Request('http://192.168.1.20:3000/api/companion/data', {
      headers: { Authorization: `Bearer ${limited.deviceKey}` },
    }))).json() as { tasks: unknown[]; attention: unknown[]; routines: unknown[] };
    assert(limitedData.tasks.length > 0);
    assert.deepEqual(limitedData.attention, []);
    assert.deepEqual(limitedData.routines, []);
    const limitedCancel = await actionRoute.POST(jsonRequest('http://192.168.1.20:3000/api/companion/actions', {
      action: 'cancel', idempotencyKey: 'limited-cancel-1', taskId: task.id,
      expectedVersion: ledger.getTask(task.id)?.version,
    }, limited.deviceKey));
    assert.equal(limitedCancel.status, 403, 'device scope is enforced in the handler');

    const routine = routines.createRoutine({
      id: 'companion-manual-routine',
      name: 'Companion-safe routine',
      description: 'A safe projected name',
      enabled: true,
      agentId: 'routine-agent',
      prompt: 'TOP_SECRET_ROUTINE_PROMPT',
      triggers: [{ id: 'manual', type: 'manual', enabled: true }],
    });
    const routineDataResponse = await dataRoute.GET(new Request('http://shiba.local:3000/api/companion/data', {
      headers: { Authorization: `Bearer ${paired.deviceKey}` },
    }));
    const routineData = await routineDataResponse.json() as {
      routines: Array<{ routineId: string; version: number; name: string }>;
    };
    const projectedRoutine = routineData.routines.find((item) => item.routineId === routine.id);
    assert(projectedRoutine);
    assert(!JSON.stringify(routineData).includes('TOP_SECRET_ROUTINE_PROMPT'), 'routine prompts never reach companion');
    const runRoutine = await actionRoute.POST(jsonRequest('http://shiba.local:3000/api/companion/actions', {
      action: 'start_routine', idempotencyKey: 'run-routine-0001',
      routineId: routine.id, expectedVersion: projectedRoutine.version,
    }, paired.deviceKey));
    assert.equal(runRoutine.status, 200);
    assert.equal(routines.listRoutineInvocations(routine.id).length, 1, 'manual companion start queues one durable invocation');

    const missingRoutineBody = {
      action: 'start_routine', idempotencyKey: 'missing-routine-1',
      routineId: 'missing-routine', expectedVersion: 1,
    };
    const missingRoutine = await actionRoute.POST(jsonRequest(
      'http://shiba.local:3000/api/companion/actions', missingRoutineBody, paired.deviceKey,
    ));
    assert.equal(missingRoutine.status, 404, 'manual routine start requires an exact saved id and never falls back');
    const missingRoutineReplay = await actionRoute.POST(jsonRequest(
      'http://shiba.local:3000/api/companion/actions', missingRoutineBody, paired.deviceKey,
    ));
    assert.equal(missingRoutineReplay.status, 409, 'a failed action is not misreported as successful on retry');

    await persistence.saveConfig({
      xaiApiKey: 'xai-companion-voice-verifier',
      cloudAuthMode: 'api_key',
      defaultGrokModel: 'cloud:grok-4',
    });
    let sttCalls = 0;
    oauth.setTokenFetcher(async (url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer xai-companion-voice-verifier');
      if (String(url).endsWith('/v1/stt')) {
        sttCalls += 1;
        const form = init?.body as FormData;
        assert(form instanceof FormData);
        assert.equal(form.get('diarize'), 'true');
        assert(form.get('file') instanceof Blob);
        return new Response(JSON.stringify({
          text: 'Investigate the launch metrics and report the result.',
          language: 'en',
          duration: 3.4,
          words: [
            { text: 'Investigate', start: 0, end: 0.6, speaker: 0 },
            { text: 'the', start: 0.61, end: 0.8, speaker: 0 },
            { text: 'launch', start: 0.81, end: 1.2, speaker: 0 },
            { text: 'metrics', start: 1.21, end: 1.7, speaker: 0 },
            { text: 'and', start: 1.71, end: 1.9, speaker: 0 },
            { text: 'report', start: 1.91, end: 2.4, speaker: 0 },
            { text: 'the', start: 2.41, end: 2.6, speaker: 0 },
            { text: 'result.', start: 2.61, end: 3.2, speaker: 0 },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const requestBody = JSON.parse(String(init?.body || '{}')) as { messages?: Array<{ content?: string }> };
      const meetingReview = requestBody.messages?.some((message) => message.content?.includes('faithful meeting notes'));
      const content = meetingReview
        ? JSON.stringify({ summary: 'Investigate launch metrics.', decisions: [], action_items: [], owners: [] })
        : 'Completed the requested investigation.';
      return new Response(JSON.stringify({
        id: 'companion-voice-chat',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const voiceBytes = new TextEncoder().encode('verifier webm voice payload');
    const noConsent = await voiceRoute.POST(voiceRequest({
      token: paired.deviceKey, bytes: voiceBytes, idempotencyKey: 'voice-no-consent-0001', consent: false,
    }));
    assert.equal(noConsent.status, 400, 'voice upload requires explicit recording consent');
    const wrongMime = await voiceRoute.POST(voiceRequest({
      token: paired.deviceKey, bytes: voiceBytes, idempotencyKey: 'voice-wrong-mime-0001', mime: 'text/plain',
    }));
    assert.equal(wrongMime.status, 400, 'voice upload rejects unsupported media types');
    const oversized = await voiceRoute.POST(voiceRequest({
      token: paired.deviceKey, bytes: voiceBytes, idempotencyKey: 'voice-oversized-0001', declaredBytes: meetings.MAX_MEETING_AUDIO_BYTES + 1,
    }));
    assert.equal(oversized.status, 413, 'voice upload enforces its declared size before storage');
    const limitedVoice = await voiceRoute.POST(voiceRequest({
      token: limited.deviceKey, bytes: voiceBytes, idempotencyKey: 'voice-limited-scope-0001',
    }));
    assert.equal(limitedVoice.status, 403, 'voice upload requires the action:voice device scope');

    const acceptedVoice = await voiceRoute.POST(voiceRequest({
      token: paired.deviceKey, bytes: voiceBytes, idempotencyKey: 'voice-accepted-0001',
    }));
    assert.equal(acceptedVoice.status, 202);
    let voiceActions = auth.listCompanionVoiceActions(paired.device.id, 10);
    for (let attempt = 0; attempt < 200 && voiceActions[0]?.status === 'pending'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      voiceActions = auth.listCompanionVoiceActions(paired.device.id, 10);
    }
    assert.equal(voiceActions.length, 1);
    assert.equal(voiceActions[0].status, 'completed');
    assert.equal(voiceActions[0].result.status, 'dispatched');
    assert.equal(sttCalls, 1);
    const voiceTaskId = String(voiceActions[0].result.taskId || '');
    const voiceTask = ledger.getTask(voiceTaskId);
    assert(voiceTask);
    const voiceMeetingId = voiceTask.originId || '';
    assert(voiceMeetingId);
    assert.match(voiceTask.description, /launch metrics/);
    const voiceMeeting = meetings.getMeeting(voiceMeetingId);
    assert(voiceMeeting?.audioAvailable, 'raw voice audio remains only in local meeting storage');
    assert.equal(voiceMeeting.retentionDays, 1, 'remote voice audio has fixed short retention');
    assert.equal(voiceMeeting.audioBytes, voiceBytes.byteLength);

    const replayVoice = await voiceRoute.POST(voiceRequest({
      token: paired.deviceKey, bytes: voiceBytes, idempotencyKey: 'voice-accepted-0001',
    }));
    assert.equal(replayVoice.status, 200);
    assert.equal((await replayVoice.json() as { replay?: boolean }).replay, true);
    assert.equal(auth.listCompanionVoiceActions(paired.device.id, 10).length, 1, 'voice retry cannot create a second durable request');
    assert.equal(sttCalls, 1, 'voice retry cannot retranscribe the same request');
    const mismatchedReplay = await voiceRoute.POST(voiceRequest({
      token: paired.deviceKey,
      bytes: voiceBytes,
      idempotencyKey: 'voice-accepted-0001',
      sha256: 'a'.repeat(64),
    }));
    assert.equal(mismatchedReplay.status, 409, 'voice idempotency key cannot be reused for different audio');

    const voiceData = await (await dataRoute.GET(new Request('http://shiba.local:3000/api/companion/data', {
      headers: { Authorization: `Bearer ${paired.deviceKey}` },
    }))).json() as { voiceRequests: Array<{ status: string; result: Record<string, unknown> }> };
    assert.equal(voiceData.voiceRequests[0].status, 'completed');
    assert(!JSON.stringify(voiceData.voiceRequests).includes('Investigate the launch metrics'), 'companion status never projects transcript text');

    const interruptedReceipt = auth.beginCompanionAction({
      deviceId: paired.device.id,
      idempotencyKey: 'voice-restart-failed-0001',
      kind: 'voice',
      request: { action: 'voice', audioSha256: 'b'.repeat(64) },
    });
    auth.updateCompanionActionProgress(interruptedReceipt.id, {
      ok: true, status: 'transcribing', title: 'Interrupted voice', meetingId: 'missing-meeting',
    });
    const resumableReceipt = auth.beginCompanionAction({
      deviceId: paired.device.id,
      idempotencyKey: 'voice-restart-resume-0001',
      kind: 'voice',
      request: { action: 'voice', audioSha256: 'c'.repeat(64) },
    });
    const resumeTask = ledger.createTask({
      id: `companion-voice:${resumableReceipt.id}`,
      kind: 'work',
      title: 'Resume queued voice dispatch',
      description: 'Finish the safely resumed voice request.',
      status: 'queued',
      originType: 'api',
    });
    auth.updateCompanionActionProgress(resumableReceipt.id, {
      ok: true, status: 'transcribing', title: 'Resume voice',
    });
    const reconciledVoice = await auth.reconcileInterruptedCompanionVoiceActions();
    assert.deepEqual(reconciledVoice, { completed: 1, resumed: 1, failed: 1 });
    const reconciledActions = auth.listCompanionVoiceActions(paired.device.id, 20);
    assert.equal(reconciledActions.find((item) => item.id === interruptedReceipt.id)?.status, 'failed');
    assert.match(String(reconciledActions.find((item) => item.id === interruptedReceipt.id)?.result.error || ''), /interrupted/);
    assert.equal(reconciledActions.find((item) => item.id === resumableReceipt.id)?.status, 'completed');
    assert.notEqual(ledger.getTask(resumeTask.id)?.status, 'queued', 'startup safely dispatches a deterministically created queued task once');
    for (let attempt = 0; attempt < 200 && !['succeeded', 'failed'].includes(ledger.getTask(voiceTaskId)?.status || ''); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (let attempt = 0; attempt < 200 && !['succeeded', 'failed'].includes(ledger.getTask(resumeTask.id)?.status || ''); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const adminStatus = await adminRoute.GET(new Request('http://localhost:3000/api/companion/admin'));
    const adminPayload = await adminStatus.json() as { devices: Array<Record<string, unknown>> };
    assert.equal(adminStatus.status, 200);
    assert.equal('keyHash' in adminPayload.devices[0], false, 'admin API does not expose credential hashes');
    auth.revokeCompanionDevice(paired.device.id);
    const revokedData = await dataRoute.GET(new Request('http://shiba.local:3000/api/companion/data', {
      headers: { Authorization: `Bearer ${paired.deviceKey}` },
    }));
    assert.equal(revokedData.status, 401, 'revocation takes effect immediately');

    process.env.SHIBA_LAN = '1';
    process.env.SHIBA_LAN_PROXY_SECRET = 'companion-verifier-lan-proxy-secret';
    const { proxy } = await import('../proxy');
    const lanHeaders = (clientClass: 'local' | 'remote', extra: Record<string, string> = {}) => ({
      'x-shiba-client-class': clientClass,
      'x-shiba-lan-proxy-secret': process.env.SHIBA_LAN_PROXY_SECRET!,
      ...extra,
    });
    const blockedApi = proxy(new NextRequest('http://shiba.local:3000/api/tasks', {
      headers: lanHeaders('remote', { Origin: 'http://shiba.local:3000' }),
    }));
    assert.equal(blockedApi.status, 403, 'LAN cannot reach generic Studio APIs');
    const redirectedPage = proxy(new NextRequest('http://shiba.local:3000/settings', { headers: lanHeaders('remote') }));
    assert.equal(redirectedPage.status, 307);
    assert.match(redirectedPage.headers.get('location') || '', /\/companion$/);
    const missingBearer = proxy(new NextRequest('http://shiba.local:3000/api/companion/data', {
      headers: lanHeaders('remote', { Origin: 'http://shiba.local:3000' }),
    }));
    assert.equal(missingBearer.status, 401, 'Proxy performs optimistic companion auth check');
    const crossOrigin = proxy(new NextRequest('http://shiba.local:3000/api/companion/status', {
      headers: lanHeaders('remote', { Origin: 'https://evil.example.com' }),
    }));
    assert.equal(crossOrigin.status, 403, 'same-origin protection still applies to Companion');
    const localApi = proxy(new NextRequest('http://localhost:3000/api/tasks', {
      headers: lanHeaders('local', { Origin: 'http://localhost:3000' }),
    }));
    assert.equal(localApi.status, 200, 'localhost retains the full Studio API');

    const [cacheSource, workerSource, projectionSource] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'lib/companion-client-cache.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'public/companion-sw.js'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'lib/companion-projection.ts'), 'utf8'),
    ]);
    assert(cacheSource.includes('AES-GCM') && cacheSource.includes("false, ['encrypt', 'decrypt']"), 'offline cache uses a non-extractable AES-GCM key');
    assert(workerSource.includes("url.pathname.startsWith('/api/')") && !workerSource.includes("'/api/companion/data'"), 'service worker never caches API data');
    assert(workerSource.includes("url.pathname.startsWith('/_next/static/')"), 'service worker caches the hashed app shell needed to open summaries offline');
    assert(!projectionSource.includes('workspaceRoots:'), 'companion projection does not serialize workspace roots');
    const manifestResponse = manifestRoute.GET();
    assert.equal(manifestResponse.status, 200);
    assert.equal(manifestResponse.headers.get('content-type'), 'application/manifest+json');
    assert.equal((await manifestResponse.json() as { start_url: string }).start_url, '/companion');

    const disabledResponse = await adminRoute.POST(jsonRequest('http://localhost:3000/api/companion/admin', {
      action: 'set_enabled', enabled: false,
    }));
    assert.equal(disabledResponse.status, 200);
    const disabledAuth = await dataRoute.GET(new Request('http://192.168.1.20:3000/api/companion/data', {
      headers: { Authorization: `Bearer ${limited.deviceKey}` },
    }));
    assert.equal(disabledAuth.status, 403, 'global disable blocks still-valid device keys');

    console.log('Companion verification passed');
  } finally {
    oauth.setTokenFetcher(null);
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
