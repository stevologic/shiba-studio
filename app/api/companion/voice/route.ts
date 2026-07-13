import { audit } from '@/lib/audit-log';
import { dispatchExistingTask } from '@/lib/background-tasks';
import {
  authenticateCompanion,
  beginCompanionAction,
  CompanionAuthError,
  finishCompanionAction,
  updateCompanionActionProgress,
} from '@/lib/companion-auth';
import { companionSafeText } from '@/lib/companion-projection';
import {
  deleteMeeting,
  MAX_MEETING_AUDIO_BYTES,
  meetingCitationUrl,
  saveMeetingAudio,
  transcribeMeetingNow,
  validateMeetingAudioType,
} from '@/lib/meetings';
import { recommendTaskMode } from '@/lib/task-router';
import { createTask, recordTaskEvidence, transitionTask } from '@/lib/task-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 1_800;

const REMOTE_AUDIO_RETENTION_DAYS = 1;

function decodedHeader(request: Request, name: string): string {
  const raw = request.headers.get(name) || '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function voiceTitle(value: string): string {
  return companionSafeText(value, 160) || 'Voice request';
}

function audioFilename(mime: string): string {
  const extension: Record<string, string> = {
    'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a',
    'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/amr': 'amr',
  };
  return `companion-voice.${extension[mime] || 'audio'}`;
}

function actionResponse(receipt: ReturnType<typeof beginCompanionAction>): Response | null {
  if (receipt.state === 'new') return null;
  const failed = receipt.result?.ok === false;
  const publicResult = {
    ...(typeof receipt.result?.status === 'string' ? { status: receipt.result.status.slice(0, 40) } : {}),
    ...(typeof receipt.result?.title === 'string' ? { title: receipt.result.title.slice(0, 160) } : {}),
    ...(typeof receipt.result?.taskId === 'string' ? { taskId: receipt.result.taskId.slice(0, 160) } : {}),
    ...(typeof receipt.result?.error === 'string' ? { error: receipt.result.error.slice(0, 500) } : {}),
  };
  return Response.json(
    { ok: !failed, replay: receipt.state === 'replay', pending: receipt.state === 'pending', requestId: receipt.id, ...publicResult },
    { status: failed ? 409 : receipt.state === 'pending' ? 202 : 200, headers: { 'Cache-Control': 'no-store' } },
  );
}

function taskTitle(transcript: string): string {
  const firstLine = transcript.replace(/\s+/g, ' ').trim();
  return firstLine.slice(0, 120) || 'Companion voice request';
}

async function processVoiceRequest(input: {
  receiptId: string;
  meetingId: string;
  deviceId: string;
  deviceName: string;
  publicTitle: string;
}): Promise<void> {
  try {
    const meeting = await transcribeMeetingNow(input.meetingId);
    const transcript = meeting.transcriptText.trim();
    if (!transcript) throw new Error('Voice transcription was empty');
    const recommendation = recommendTaskMode({ outcome: transcript });
    const kind = recommendation.recommendedMode === 'code' ? 'code' : 'work';
    const taskId = `companion-voice:${input.receiptId}`;
    const task = createTask({
      id: taskId,
      kind,
      title: taskTitle(transcript),
      description: transcript,
      status: 'queued',
      originType: 'api',
      originId: meeting.id,
      maxRetries: 1,
      contract: {
        outcome: transcript,
        constraints: [
          'This request was explicitly recorded and submitted from an authorized companion device.',
          `Source recording: ${meetingCitationUrl(meeting.id, 0)}`,
        ],
        requiredArtifacts: [],
        requirements: [],
      },
      metadata: {
        companionVoice: {
          receiptId: input.receiptId,
          deviceId: input.deviceId,
          meetingId: meeting.id,
          recommendation,
        },
      },
    });
    recordTaskEvidence({
      taskId: task.id,
      kind: 'integration',
      status: 'informational',
      label: 'Companion voice request transcribed',
      summary: `Speaker-aware transcript captured locally from ${input.deviceName}.`,
      uri: meetingCitationUrl(meeting.id, 0),
      scope: `meeting:${meeting.id}`,
      metadata: { meetingId: meeting.id, companionDeviceId: input.deviceId },
    });
    updateCompanionActionProgress(input.receiptId, {
      ok: true,
      status: 'dispatching',
      title: input.publicTitle,
      taskId: task.id,
      meetingId: meeting.id,
    });
    await dispatchExistingTask(task.id);
    finishCompanionAction(input.receiptId, {
      ok: true,
      status: 'dispatched',
      title: input.publicTitle,
      taskId: task.id,
      meetingId: meeting.id,
    });
    audit('auth', 'companion voice dispatched', task.title, {
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      meetingId: meeting.id,
      taskId: task.id,
    });
  } catch (error) {
    const internalMessage = error instanceof Error ? error.message : String(error);
    const publicMessage = 'Voice request could not be transcribed or started. Review the host logs for details.';
    try { finishCompanionAction(input.receiptId, { ok: false, status: 'failed', error: publicMessage, meetingId: input.meetingId }, false); } catch { /* receipt already terminal */ }
    audit('auth', 'companion voice rejected', internalMessage.slice(0, 500), {
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      meetingId: input.meetingId,
    });
  }
}

export async function POST(request: Request) {
  let receiptId: string | null = null;
  let meetingId: string | null = null;
  let auth: Awaited<ReturnType<typeof authenticateCompanion>> | null = null;
  try {
    auth = await authenticateCompanion(request);
    if (!auth.scopes.has('action:voice')) throw new CompanionAuthError('Companion device lacks action:voice permission', 403);
    if (request.headers.get('x-recording-consent') !== 'true') {
      throw new CompanionAuthError('Explicit recording consent confirmation is required', 400);
    }
    if (!request.body) throw new CompanionAuthError('Voice audio body is required', 400);
    const declaredBytes = Number(request.headers.get('x-audio-bytes') || request.headers.get('content-length') || 0);
    if (!Number.isInteger(declaredBytes) || declaredBytes <= 0) throw new CompanionAuthError('A valid audio byte count is required', 400);
    if (declaredBytes > MAX_MEETING_AUDIO_BYTES) throw new CompanionAuthError('Voice audio exceeds the 50 MB limit', 413);
    const audioSha256 = (request.headers.get('x-audio-sha256') || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(audioSha256)) throw new CompanionAuthError('A SHA-256 audio digest is required', 400);
    const { mime } = validateMeetingAudioType(request.headers.get('content-type') || '');
    const title = voiceTitle(decodedHeader(request, 'x-voice-title'));
    const receipt = beginCompanionAction({
      deviceId: auth.device.id,
      idempotencyKey: request.headers.get('x-idempotency-key') || '',
      kind: 'voice',
      request: { action: 'voice', title, mime, bytes: declaredBytes, audioSha256, retentionDays: REMOTE_AUDIO_RETENTION_DAYS, consent: true },
    });
    const existing = actionResponse(receipt);
    if (existing) return existing;
    receiptId = receipt.id;
    updateCompanionActionProgress(receipt.id, { ok: true, status: 'uploading', title });
    const meeting = await saveMeetingAudio({
      title: `Voice request: ${title}`,
      source: 'microphone',
      originalFilename: audioFilename(mime),
      mime,
      retentionDays: REMOTE_AUDIO_RETENTION_DAYS,
      consentConfirmed: true,
      stream: request.body,
    });
    meetingId = meeting.id;
    if (meeting.audioBytes !== declaredBytes || meeting.audioSha256 !== audioSha256) {
      const task = transitionTask({ taskId: meeting.taskId, status: 'failed', error: 'Declared audio size or digest did not match the uploaded bytes' });
      await deleteMeeting(meeting.id);
      throw new CompanionAuthError(`Audio integrity validation failed for task ${task.id}`, 400);
    }
    updateCompanionActionProgress(receipt.id, { ok: true, status: 'transcribing', title, meetingId: meeting.id });
    void processVoiceRequest({ receiptId: receipt.id, meetingId: meeting.id, deviceId: auth.device.id, deviceName: auth.device.name, publicTitle: title });
    return Response.json({ ok: true, accepted: true, pending: true, requestId: receipt.id, status: 'transcribing' }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const internalMessage = error instanceof Error ? error.message : 'Companion voice request failed';
    const safeClientMessage = error instanceof CompanionAuthError
      ? companionSafeText(error.message, 300)
      : 'Voice request could not be accepted';
    if (receiptId) {
      try { finishCompanionAction(receiptId, { ok: false, status: 'failed', error: safeClientMessage, ...(meetingId ? { meetingId } : {}) }, false); } catch { /* receipt already terminal */ }
    }
    if (auth) audit('auth', 'companion voice upload rejected', internalMessage.slice(0, 500), { deviceId: auth.device.id, deviceName: auth.device.name, meetingId });
    const status = error instanceof CompanionAuthError ? error.status : /50 MB/i.test(internalMessage) ? 413 : 400;
    return Response.json({ ok: false, error: safeClientMessage }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
