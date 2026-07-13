import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-meetings-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '77'.repeat(32);

  const dbModule = await import('../lib/db');
  const persistence = await import('../lib/persistence');
  const oauth = await import('../lib/xai-oauth');
  const meetings = await import('../lib/meetings');
  const ledger = await import('../lib/task-ledger');
  const routines = await import('../lib/routines');
  try {
    await persistence.saveConfig({ xaiApiKey: 'xai-verifier-key', cloudAuthMode: 'api_key', defaultGrokModel: 'cloud:grok-4' });
    const db = dbModule.getDb();
    meetings.ensureMeetingSchema();
    let sttCalls = 0;
    let reviewCalls = 0;
    oauth.setTokenFetcher(async (input, init) => {
      const url = String(input);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer xai-verifier-key', 'cloud auth stays in the server-side request');
      if (url.endsWith('/v1/stt')) {
        sttCalls++;
        assert(init?.body instanceof FormData);
        const form = init.body as FormData;
        assert.equal(form.get('format'), 'true');
        assert.equal(form.get('diarize'), 'true');
        assert(form.get('file') instanceof Blob);
        return new Response(JSON.stringify({
          text: 'We approved the launch. Alex will publish the release notes Friday.',
          language: 'en',
          duration: 5.4,
          words: [
            { text: 'We', start: 0, end: 0.3, speaker: 0 },
            { text: 'approved', start: 0.31, end: 0.8, speaker: 0 },
            { text: 'the', start: 0.81, end: 1, speaker: 0 },
            { text: 'launch.', start: 1.01, end: 1.5, speaker: 0 },
            { text: 'Alex', start: 2.2, end: 2.6, speaker: 1 },
            { text: 'will', start: 2.61, end: 2.85, speaker: 1 },
            { text: 'publish', start: 2.86, end: 3.3, speaker: 1 },
            { text: 'the', start: 3.31, end: 3.5, speaker: 1 },
            { text: 'release', start: 3.51, end: 4, speaker: 1 },
            { text: 'notes', start: 4.01, end: 4.4, speaker: 1 },
            { text: 'Friday.', start: 4.41, end: 5.2, speaker: 1 },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/chat/completions')) {
        reviewCalls++;
        return new Response(JSON.stringify({
          id: 'review-verifier',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
            summary: 'The launch was approved and release notes are assigned.',
            decisions: [{ text: 'Approve the launch', source_quote: 'approved the launch' }],
            action_items: [{ text: 'Publish the release notes', owner: 'Alex', due: 'Friday', source_quote: 'Alex will publish the release notes Friday' }],
            owners: ['Alex'],
          }) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('unexpected verifier URL', { status: 500 });
    });

    const bytes = new TextEncoder().encode('small fake webm payload');
    const stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    await assert.rejects(() => meetings.saveMeetingAudio({ title: 'No consent', source: 'upload', originalFilename: 'test.webm', mime: 'audio/webm', retentionDays: 30, consentConfirmed: false, stream: stream() }), /consent/i);
    db.exec(`
      CREATE TEMP TRIGGER fail_meeting_creation
      BEFORE INSERT ON meetings
      BEGIN
        SELECT RAISE(ABORT, 'forced meeting insert failure');
      END;
    `);
    try {
      await assert.rejects(
        () => meetings.saveMeetingAudio({ title: 'Failed creation', source: 'upload', originalFilename: 'failed.webm', mime: 'audio/webm', retentionDays: 30, consentConfirmed: true, stream: stream() }),
        /forced meeting insert failure|Meeting creation failed/,
      );
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_meeting_creation');
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Transcribe Failed creation'").get() as { n: number }).n, 0, 'failed meeting creation removes its task');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number }).n, 0, 'failed meeting creation leaves no meeting row');
    const failedCreationFiles = await fs.readdir(path.join(process.env.SHIBA_DATA_DIR!, 'meetings', 'audio')).catch(() => []);
    assert.equal(failedCreationFiles.length, 0, 'failed meeting creation removes its owned audio');
    const uploaded = await meetings.saveMeetingAudio({ title: 'Launch sync', source: 'microphone', originalFilename: 'launch.webm', mime: 'audio/webm;codecs=opus', retentionDays: 30, consentConfirmed: true, stream: stream() });
    assert.equal(uploaded.status, 'uploaded');
    assert.equal(uploaded.audioAvailable, true);
    assert.equal(uploaded.audioBytes, bytes.byteLength);
    assert.match(uploaded.audioSha256, /^[a-f0-9]{64}$/);
    assert.equal(ledger.getTask(uploaded.taskId)?.status, 'queued');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(uploaded.taskId);
    assert.equal(ledger.getTask(uploaded.taskId), null, 'verifier creates a missing meeting task projection');
    assert.equal(meetings.repairMissingMeetingTaskProjections(), 1, 'missing meeting task is reconstructed');
    assert.equal(ledger.getTask(uploaded.taskId)?.status, 'queued', 'uploaded meeting recovers as queued work');
    assert.equal(meetings.repairMissingMeetingTaskProjections(), 0, 'meeting task repair is idempotent');
    const audioDeletedQueued = await meetings.saveMeetingAudio({ title: 'Delete queued audio', source: 'upload', originalFilename: 'delete-audio.webm', mime: 'audio/webm', retentionDays: 30, consentConfirmed: true, stream: stream() });
    const audioDeleted = await meetings.deleteMeetingAudio(audioDeletedQueued.id);
    assert.equal(audioDeleted.status, 'failed', 'deleting required queued audio terminates its owner state');
    assert.equal(audioDeleted.audioAvailable, false);
    assert.equal(ledger.getTask(audioDeletedQueued.taskId)?.status, 'cancelled', 'queued meeting task is cancelled atomically with user audio deletion');

    const deletedQueued = await meetings.saveMeetingAudio({ title: 'Delete queued meeting', source: 'upload', originalFilename: 'delete-meeting.webm', mime: 'audio/webm', retentionDays: 30, consentConfirmed: true, stream: stream() });
    await meetings.deleteMeeting(deletedQueued.id);
    assert.equal(meetings.getMeeting(deletedQueued.id), null);
    assert.equal(ledger.getTask(deletedQueued.taskId)?.status, 'cancelled', 'meeting deletion cancels its queued task');

    const expiredQueued = await meetings.saveMeetingAudio({ title: 'Expire queued audio', source: 'upload', originalFilename: 'expire.webm', mime: 'audio/webm', retentionDays: 30, consentConfirmed: true, stream: stream() });
    db.prepare('UPDATE meetings SET deleteAudioAt = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), expiredQueued.id);
    assert.equal(await meetings.pruneExpiredMeetingAudio(), 1);
    assert.equal(meetings.getMeeting(expiredQueued.id)?.status, 'failed');
    assert.equal(ledger.getTask(expiredQueued.taskId)?.status, 'failed', 'retention cannot strand queued transcription work');

    const interrupted = await meetings.saveMeetingAudio({ title: 'Interrupted meeting', source: 'upload', originalFilename: 'interrupted.webm', mime: 'audio/webm', retentionDays: 30, consentConfirmed: true, stream: stream() });
    db.prepare("UPDATE meetings SET status = 'transcribing' WHERE id = ?").run(interrupted.id);
    const interruptedTask = ledger.getTask(interrupted.taskId)!;
    ledger.transitionTask({ taskId: interruptedTask.id, status: 'running', expectedVersion: interruptedTask.version });
    assert.equal(meetings.reconcileInterruptedMeetings(), 1);
    assert.equal(ledger.getTask(interrupted.taskId)?.status, 'lost', 'startup reconciliation settles interrupted meeting task');
    assert.equal(meetings.repairMeetingTaskLifecycleProjections(), 0, 'meeting lifecycle repair is idempotent');
    const audioRoute = await import('../app/api/meetings/[id]/audio/route');
    const rangeResponse = await audioRoute.GET(new Request('http://localhost/audio', { headers: { Range: 'bytes=-4' } }), { params: Promise.resolve({ id: uploaded.id }) });
    assert.equal(rangeResponse.status, 206);
    assert.equal(await rangeResponse.text(), 'load', 'suffix byte ranges return the tail of local audio');

    let ready = await meetings.transcribeMeetingNow(uploaded.id, { language: 'en', keyterms: ['Alex'] });
    assert.equal(sttCalls, 1);
    assert.equal(reviewCalls, 1);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.words.length, 11);
    assert.equal(ready.segments.length, 2);
    assert.deepEqual(ready.segments.map((segment) => segment.speakerId), ['speaker-0', 'speaker-1']);
    assert.equal(ready.segments[1].start, 2.2);
    const expectedCitation = `/api/meetings/${encodeURIComponent(ready.id)}/citation?t=2.20&end=5.20`;
    assert.equal(ready.segments[1].citationUrl, expectedCitation);
    assert.equal(ready.actionItems[0].owner, 'Alex');
    assert.equal(ready.actionItems[0].due, 'Friday');
    ready = meetings.updateMeetingReview(ready.id, {
      expectedVersion: ready.version,
      actionItems: [{ ...ready.actionItems[0], start: 999, end: 1_000, citationUrl: 'https://invalid.example/citation' }],
    });
    assert.equal(ready.actionItems[0].start, 2.2, 'review writes retain canonical transcript timing');
    assert.equal(ready.actionItems[0].citationUrl, expectedCitation, 'review writes cannot inject citation URLs');
    assert.equal(ledger.getTask(ready.taskId)?.status, 'succeeded');
    const taskDetail = ledger.getTaskDetails(ready.taskId);
    assert(taskDetail?.evidence.some((item) => item.requirementId === 'transcript' && item.status === 'passed'));
    assert(taskDetail?.evidence.some((item) => item.requirementId === 'review' && item.status === 'passed'));

    const search = meetings.searchMeetingTranscripts('release notes', 5);
    assert.equal(search.length, 1);
    assert.equal(search[0].start, 2.2);
    assert.equal(search[0].citationUrl, expectedCitation);

    await assert.rejects(() => meetings.createMeetingOutputs({ meetingId: ready.id, confirmed: false, actionItemIds: [ready.actionItems[0].id], createBoardCards: true }), /confirmation/i);
    const outputs = await meetings.createMeetingOutputs({ meetingId: ready.id, confirmed: true, actionItemIds: [ready.actionItems[0].id], createBoardCards: true, createRoutines: true, routineAgentId: 'agent-verifier' });
    assert.equal(outputs.length, 2);
    assert.deepEqual(new Set(outputs.map((output) => output.type)), new Set(['board_card', 'routine']));
    const repeated = await meetings.createMeetingOutputs({ meetingId: ready.id, confirmed: true, actionItemIds: [ready.actionItems[0].id], createBoardCards: true, createRoutines: true, routineAgentId: 'agent-verifier' });
    assert.equal(repeated.length, 2, 'confirmed output creation is idempotent');

    db.prepare('UPDATE meetings SET deleteAudioAt = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), ready.id);
    assert.equal(await meetings.pruneExpiredMeetingAudio(), 1);
    const retained = meetings.getMeeting(ready.id)!;
    assert.equal(retained.audioAvailable, false);
    assert(retained.transcriptText.includes('release notes'), 'retention deletes only local audio');
    assert.equal(meetings.getMeetingAudioDescriptor(ready.id), null);
    const citationRoute = await import('../app/api/meetings/[id]/citation/route');
    const citationResponse = await citationRoute.GET(
      new Request(`http://localhost${expectedCitation}`),
      { params: Promise.resolve({ id: ready.id }) },
    );
    assert.equal(citationResponse.status, 200, 'transcript citation survives audio retention cleanup');
    assert.match(await citationResponse.text(), /release notes/i);

    await meetings.deleteMeeting(ready.id);
    assert.equal(meetings.getMeeting(ready.id), null);
    console.log('Meeting verification passed');
  } finally {
    oauth.setTokenFetcher(null);
    await routines.stopRoutineEngine();
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Meeting verification failed', error);
  process.exit(1);
});
