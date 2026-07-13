import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDb } from './db';
import { dataDir } from './data-paths';
import { emitAppEvent } from './app-events';
import { audit } from './audit-log';
import { fetchCloudWithAuth } from './xai-oauth';
import { grokChat } from './grok-client';
import { loadConfig } from './persistence';
import { createBoardTask } from './board';
import { createRoutine, getRoutine } from './routines';
import {
  createTask,
  getTask,
  recordTaskEvidence,
  transitionTask,
} from './task-ledger';
import type {
  MeetingActionItem,
  MeetingDecision,
  MeetingOutput,
  MeetingRecord,
  MeetingSegment,
  MeetingSource,
  MeetingTranscribeOptions,
  MeetingWord,
} from './meeting-types';

export const MAX_MEETING_AUDIO_BYTES = 50 * 1024 * 1024;
export const MEETING_CONSENT_VERSION = 'meeting-recording-v1';
export const MEETING_CONSENT_TEXT = 'I confirm that everyone required has consented to this recording and that I am responsible for complying with applicable recording laws.';
const XAI_STT_URL = 'https://api.x.ai/v1/stt';

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/quicktime': '.m4a',
  'video/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'application/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
};

interface MeetingRow {
  id: string;
  title: string;
  source: string;
  status: string;
  consentAt: string;
  consentVersion: string;
  originalFilename: string;
  audioPath: string | null;
  audioMime: string;
  audioBytes: number;
  audioSha256: string;
  audioDeletedAt: string | null;
  retentionDays: number;
  deleteAudioAt: string | null;
  duration: number | null;
  language: string | null;
  transcriptText: string;
  words: string;
  segments: string;
  speakerLabels: string;
  summary: string;
  decisions: string;
  actionItems: string;
  owners: string;
  taskId: string;
  error: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  transcribedAt: string | null;
  deletedAt: string | null;
}

interface OutputRow {
  id: string;
  meetingId: string;
  actionItemId: string;
  type: string;
  status: string;
  externalId: string;
  taskId: string | null;
  error: string | null;
  createdAt: string;
}

const initializedHandles = new WeakSet<object>();

/** Guarded extension schema: meeting storage is deployable without changing the main DB version. */
export function ensureMeetingSchema(): void {
  const db = getDb();
  if (initializedHandles.has(db as object)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      consentAt TEXT NOT NULL,
      consentVersion TEXT NOT NULL,
      originalFilename TEXT NOT NULL,
      audioPath TEXT,
      audioMime TEXT NOT NULL,
      audioBytes INTEGER NOT NULL,
      audioSha256 TEXT NOT NULL,
      audioDeletedAt TEXT,
      retentionDays INTEGER NOT NULL,
      deleteAudioAt TEXT,
      duration REAL,
      language TEXT,
      transcriptText TEXT NOT NULL DEFAULT '',
      words TEXT NOT NULL DEFAULT '[]',
      segments TEXT NOT NULL DEFAULT '[]',
      speakerLabels TEXT NOT NULL DEFAULT '{}',
      summary TEXT NOT NULL DEFAULT '',
      decisions TEXT NOT NULL DEFAULT '[]',
      actionItems TEXT NOT NULL DEFAULT '[]',
      owners TEXT NOT NULL DEFAULT '[]',
      taskId TEXT NOT NULL,
      error TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      transcribedAt TEXT,
      deletedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_updated ON meetings(deletedAt, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_meetings_retention ON meetings(deleteAudioAt, audioDeletedAt);

    CREATE TABLE IF NOT EXISTS meeting_outputs (
      id TEXT PRIMARY KEY,
      meetingId TEXT NOT NULL REFERENCES meetings(id),
      actionItemId TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      externalId TEXT NOT NULL DEFAULT '',
      taskId TEXT,
      error TEXT,
      createdAt TEXT NOT NULL,
      UNIQUE(meetingId, actionItemId, type)
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_outputs_meeting ON meeting_outputs(meetingId, createdAt ASC);
  `);
  initializedHandles.add(db as object);
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertMeetingId(id: string): string {
  const value = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error('Invalid meeting id');
  return value;
}

function cleanText(value: unknown, max: number, required = false): string {
  const text = String(value ?? '').trim().slice(0, max);
  if (required && !text) throw new Error('Required meeting field is empty');
  return text;
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function meetingOutputs(id: string): MeetingOutput[] {
  ensureMeetingSchema();
  return (getDb().prepare("SELECT * FROM meeting_outputs WHERE meetingId = ? AND status = 'ready' ORDER BY createdAt ASC")
    .all(id) as unknown as OutputRow[]).map((row) => ({
      id: row.id,
      meetingId: row.meetingId,
      actionItemId: row.actionItemId,
      type: row.type as MeetingOutput['type'],
      externalId: row.externalId,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      createdAt: row.createdAt,
    }));
}

function rowToMeeting(row: MeetingRow): MeetingRecord {
  return {
    id: row.id,
    title: row.title,
    source: row.source as MeetingSource,
    status: row.status as MeetingRecord['status'],
    consentAt: row.consentAt,
    consentVersion: row.consentVersion,
    originalFilename: row.originalFilename,
    audioMime: row.audioMime,
    audioBytes: row.audioBytes,
    audioSha256: row.audioSha256,
    audioAvailable: Boolean(row.audioPath && !row.audioDeletedAt),
    ...(row.audioDeletedAt ? { audioDeletedAt: row.audioDeletedAt } : {}),
    retentionDays: row.retentionDays,
    ...(row.deleteAudioAt ? { deleteAudioAt: row.deleteAudioAt } : {}),
    ...(row.duration != null ? { duration: row.duration } : {}),
    ...(row.language ? { language: row.language } : {}),
    transcriptText: row.transcriptText,
    words: parseJson<MeetingWord[]>(row.words, []),
    segments: parseJson<MeetingSegment[]>(row.segments, []),
    speakerLabels: parseJson<Record<string, string>>(row.speakerLabels, {}),
    summary: row.summary,
    decisions: parseJson<MeetingDecision[]>(row.decisions, []),
    actionItems: parseJson<MeetingActionItem[]>(row.actionItems, []),
    owners: parseJson<string[]>(row.owners, []),
    outputs: meetingOutputs(row.id),
    taskId: row.taskId,
    ...(row.error ? { error: row.error } : {}),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.transcribedAt ? { transcribedAt: row.transcribedAt } : {}),
  };
}

function meetingRow(id: string): MeetingRow | undefined {
  ensureMeetingSchema();
  return getDb().prepare('SELECT * FROM meetings WHERE id = ? AND deletedAt IS NULL')
    .get(assertMeetingId(id)) as unknown as MeetingRow | undefined;
}

export function getMeeting(id: string): MeetingRecord | null {
  const row = meetingRow(id);
  return row ? rowToMeeting(row) : null;
}

export async function listMeetings(limit = 100): Promise<MeetingRecord[]> {
  await pruneExpiredMeetingAudio();
  const rows = getDb().prepare('SELECT * FROM meetings WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, Number(limit) || 100))) as unknown as MeetingRow[];
  return rows.map(rowToMeeting);
}

function retentionDays(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 30;
  return Math.max(0, Math.min(3650, Math.round(number)));
}

function deleteAt(days: number, base = Date.now()): string | null {
  return days > 0 ? new Date(base + days * 24 * 60 * 60_000).toISOString() : null;
}

function normalizedMime(value: string): string {
  return value.split(';')[0].trim().toLowerCase();
}

export function validateMeetingAudioType(mimeInput: string): { mime: string; extension: string } {
  const mime = normalizedMime(mimeInput);
  const extension = MIME_EXTENSIONS[mime];
  if (!extension) throw new Error('Unsupported audio type. Use WebM, MP3, WAV, M4A/MP4, OGG, FLAC, AAC, or AMR.');
  return { mime, extension };
}

async function writeBoundedAudio(stream: ReadableStream<Uint8Array>, destination: string): Promise<{ bytes: number; sha256: string }> {
  const temporary = `${destination}.upload-${randomUUID()}`;
  const handle = await fs.open(/* turbopackIgnore: true */ temporary, 'wx');
  const hash = createHash('sha256');
  let bytes = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      bytes += value.byteLength;
      if (bytes > MAX_MEETING_AUDIO_BYTES) throw new Error('Audio exceeds the 50 MB upload limit');
      hash.update(value);
      await handle.write(value);
    }
    if (bytes === 0) throw new Error('Audio upload is empty');
    await handle.sync();
    await handle.close();
    await fs.rename(/* turbopackIgnore: true */ temporary, destination);
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    try { await handle.close(); } catch { /* already closed */ }
    try { await fs.unlink(/* turbopackIgnore: true */ temporary); } catch { /* best effort */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function saveMeetingAudio(input: {
  title: string;
  source: MeetingSource;
  originalFilename: string;
  mime: string;
  retentionDays?: number;
  consentConfirmed: boolean;
  stream: ReadableStream<Uint8Array>;
}): Promise<MeetingRecord> {
  ensureMeetingSchema();
  if (input.consentConfirmed !== true) throw new Error('Explicit recording consent confirmation is required');
  if (input.source !== 'microphone' && input.source !== 'upload') throw new Error('Invalid meeting audio source');
  const title = cleanText(input.title, 300, true);
  const originalFilename = cleanText(input.originalFilename, 300, true).replace(/[\r\n]/g, '');
  const { mime, extension } = validateMeetingAudioType(input.mime);
  const id = randomUUID();
  const directory = dataDir('meetings', 'audio');
  await fs.mkdir(/* turbopackIgnore: true */ directory, { recursive: true });
  const audioPath = path.join(/* turbopackIgnore: true */ directory, `${id}${extension}`);
  const stored = await writeBoundedAudio(input.stream, audioPath);
  const days = retentionDays(input.retentionDays);
  const now = nowIso();
  const task = createTask({
    id: `meeting:${id}`,
    kind: 'artifact',
    title: `Transcribe ${title}`,
    description: `Create a speaker-aware transcript and review for ${title}.`,
    status: 'queued',
    originType: 'manual',
    originId: id,
    maxRetries: 1,
    contract: {
      outcome: 'The recording has a timestamped transcript and reviewable meeting notes.',
      constraints: ['No Board card or Routine is created without explicit confirmation.'],
      requiredArtifacts: [],
      requirements: [
        { id: 'transcript', label: 'Speaker-aware transcript recorded', required: true, acceptedKinds: ['integration'], scope: `meeting:${id}` },
        { id: 'review', label: 'Summary and action review recorded', required: true, acceptedKinds: ['assertion'], scope: `meeting:${id}` },
      ],
    },
    metadata: { meetingId: id, consentVersion: MEETING_CONSENT_VERSION },
  });
  try {
    getDb().prepare(`
      INSERT INTO meetings (
        id, title, source, status, consentAt, consentVersion, originalFilename,
        audioPath, audioMime, audioBytes, audioSha256, audioDeletedAt,
        retentionDays, deleteAudioAt, duration, language, transcriptText, words,
        segments, speakerLabels, summary, decisions, actionItems, owners, taskId,
        error, version, createdAt, updatedAt, transcribedAt, deletedAt
      ) VALUES (?, ?, ?, 'uploaded', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL,
        '', '[]', '[]', '{}', '', '[]', '[]', '[]', ?, NULL, 1, ?, ?, NULL, NULL)
    `).run(
      id, title, input.source, now, MEETING_CONSENT_VERSION, originalFilename,
      audioPath, mime, stored.bytes, stored.sha256, days, deleteAt(days), task.id, now, now,
    );
  } catch (error) {
    try { await fs.unlink(/* turbopackIgnore: true */ audioPath); } catch { /* best effort */ }
    throw error;
  }
  recordTaskEvidence({
    taskId: task.id,
    kind: 'artifact',
    status: 'informational',
    label: originalFilename,
    summary: `Locally stored consented audio (${stored.bytes} bytes, SHA-256 ${stored.sha256}).`,
    uri: `/api/meetings/${id}/audio`,
    scope: `meeting:${id}`,
    metadata: { meetingId: id, bytes: stored.bytes, sha256: stored.sha256, mime },
  });
  audit('run', 'meeting audio stored', title, { meetingId: id, bytes: stored.bytes, source: input.source, retentionDays: days });
  emitAppEvent('meetings');
  return getMeeting(id)!;
}

export function getMeetingAudioDescriptor(id: string): { path: string; mime: string; bytes: number; filename: string } | null {
  const row = meetingRow(id);
  if (!row?.audioPath || row.audioDeletedAt) return null;
  return { path: row.audioPath, mime: row.audioMime, bytes: row.audioBytes, filename: row.originalFilename };
}

export async function deleteMeetingAudio(id: string): Promise<MeetingRecord> {
  const row = meetingRow(id);
  if (!row) throw new Error('Meeting not found');
  if (row.status === 'transcribing') throw new Error('Wait for transcription to finish before deleting its audio');
  if (row.audioPath) {
    try { await fs.unlink(/* turbopackIgnore: true */ row.audioPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const now = nowIso();
  getDb().prepare(`
    UPDATE meetings SET audioPath = NULL, audioDeletedAt = ?, deleteAudioAt = NULL,
      version = version + 1, updatedAt = ? WHERE id = ?
  `).run(now, now, row.id);
  emitAppEvent('meetings');
  return getMeeting(row.id)!;
}

export async function deleteMeeting(id: string): Promise<void> {
  const row = meetingRow(id);
  if (!row) throw new Error('Meeting not found');
  if (row.status === 'transcribing') throw new Error('Wait for transcription to finish before deleting this meeting');
  if (row.audioPath) {
    try { await fs.unlink(/* turbopackIgnore: true */ row.audioPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const now = nowIso();
  getDb().prepare(`
    UPDATE meetings SET audioPath = NULL, audioDeletedAt = COALESCE(audioDeletedAt, ?),
      deletedAt = ?, version = version + 1, updatedAt = ? WHERE id = ?
  `).run(now, now, now, row.id);
  audit('run', 'meeting deleted', row.title, { meetingId: row.id });
  emitAppEvent('meetings');
}

function normalizeDecisions(input: unknown): MeetingDecision[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).map((item, index) => {
    const value = item as Partial<MeetingDecision>;
    return {
      id: cleanText(value.id || `decision-${index + 1}`, 160, true),
      text: cleanText(value.text, 5_000, true),
      ...(value.segmentId ? { segmentId: cleanText(value.segmentId, 160) } : {}),
      ...(Number.isFinite(value.start) ? { start: Number(value.start) } : {}),
      ...(Number.isFinite(value.end) ? { end: Number(value.end) } : {}),
      ...(value.citationUrl ? { citationUrl: cleanText(value.citationUrl, 1_000) } : {}),
    };
  });
}

function normalizeActionItems(input: unknown): MeetingActionItem[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).map((item, index) => {
    const value = item as Partial<MeetingActionItem>;
    return {
      id: cleanText(value.id || `action-${index + 1}`, 160, true),
      text: cleanText(value.text, 5_000, true),
      ...(value.owner ? { owner: cleanText(value.owner, 300) } : {}),
      ...(value.due ? { due: cleanText(value.due, 300) } : {}),
      ...(value.segmentId ? { segmentId: cleanText(value.segmentId, 160) } : {}),
      ...(Number.isFinite(value.start) ? { start: Number(value.start) } : {}),
      ...(Number.isFinite(value.end) ? { end: Number(value.end) } : {}),
      ...(value.citationUrl ? { citationUrl: cleanText(value.citationUrl, 1_000) } : {}),
    };
  });
}

export function updateMeetingReview(id: string, input: {
  expectedVersion: number;
  title?: string;
  summary?: string;
  decisions?: MeetingDecision[];
  actionItems?: MeetingActionItem[];
  speakerLabels?: Record<string, string>;
  retentionDays?: number;
}): MeetingRecord {
  const meeting = getMeeting(id);
  if (!meeting) throw new Error('Meeting not found');
  if (input.expectedVersion !== meeting.version) throw new Error('Meeting changed concurrently; reload and retry');
  const days = input.retentionDays == null ? meeting.retentionDays : retentionDays(input.retentionDays);
  const labels = input.speakerLabels && typeof input.speakerLabels === 'object'
    ? Object.fromEntries(Object.entries(input.speakerLabels).slice(0, 50).map(([key, value]) => [cleanText(key, 100, true), cleanText(value, 300, true)]))
    : meeting.speakerLabels;
  const decisions = input.decisions ? normalizeDecisions(input.decisions) : meeting.decisions;
  const actionItems = input.actionItems ? normalizeActionItems(input.actionItems) : meeting.actionItems;
  const canonicalCitation = <T extends MeetingDecision | MeetingActionItem>(item: T): T => {
    const segment = meeting.segments.find((candidate) => candidate.id === item.segmentId)
      || (Number.isFinite(item.start) ? meeting.segments.find((candidate) => Math.abs(candidate.start - Number(item.start)) < 0.01) : undefined);
    const result = { ...item };
    delete result.segmentId;
    delete result.start;
    delete result.end;
    delete result.citationUrl;
    if (segment) Object.assign(result, { segmentId: segment.id, start: segment.start, end: segment.end, citationUrl: meetingCitationUrl(meeting.id, segment.start, segment.end) });
    return result;
  };
  const citedDecisions = decisions.map(canonicalCitation);
  const citedActionItems = actionItems.map(canonicalCitation);
  const owners = [...new Set(citedActionItems.map((item) => item.owner).filter((owner): owner is string => Boolean(owner)))];
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE meetings SET title = ?, summary = ?, decisions = ?, actionItems = ?, owners = ?,
      speakerLabels = ?, retentionDays = ?, deleteAudioAt = CASE WHEN audioPath IS NULL THEN NULL ELSE ? END,
      version = version + 1, updatedAt = ? WHERE id = ? AND version = ?
  `).run(
    input.title == null ? meeting.title : cleanText(input.title, 300, true),
    input.summary == null ? meeting.summary : cleanText(input.summary, 50_000),
    JSON.stringify(citedDecisions), JSON.stringify(citedActionItems), JSON.stringify(owners), JSON.stringify(labels),
    days, deleteAt(days), now, meeting.id, meeting.version,
  );
  if (Number(result.changes) !== 1) throw new Error('Meeting changed concurrently; reload and retry');
  emitAppEvent('meetings');
  return getMeeting(meeting.id)!;
}

export function meetingCitationUrl(meetingId: string, start: number, end?: number): string {
  const query = new URLSearchParams({ meeting: meetingId, t: Math.max(0, start).toFixed(2) });
  if (Number.isFinite(end)) query.set('end', Math.max(start, Number(end)).toFixed(2));
  return `/meetings?${query.toString()}`;
}

function normalizeWord(raw: unknown, index: number): MeetingWord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { text?: unknown; word?: unknown; start?: unknown; end?: unknown; speaker?: unknown };
  const text = cleanText(value.text ?? value.word, 500);
  const start = Number(value.start);
  const end = Number(value.end);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const speaker = value.speaker == null ? 0 : value.speaker;
  return { text, start: Math.max(0, start), end: Math.max(start, end), speakerId: `speaker-${cleanText(speaker, 40) || index}` };
}

export function wordsToSegments(meetingId: string, words: MeetingWord[]): MeetingSegment[] {
  const segments: MeetingSegment[] = [];
  let startIndex = 0;
  while (startIndex < words.length) {
    const first = words[startIndex];
    let endIndex = startIndex;
    let length = first.text.length;
    while (endIndex + 1 < words.length) {
      const next = words[endIndex + 1];
      if (next.speakerId !== first.speakerId || next.start - words[endIndex].end > 1.5 || length + next.text.length > 500) break;
      endIndex += 1;
      length += next.text.length + 1;
    }
    const last = words[endIndex];
    const text = words.slice(startIndex, endIndex + 1).map((word) => word.text).join(' ');
    segments.push({
      id: `segment-${segments.length + 1}`,
      speakerId: first.speakerId,
      start: first.start,
      end: last.end,
      text,
      wordStartIndex: startIndex,
      wordEndIndex: endIndex,
      citationUrl: meetingCitationUrl(meetingId, first.start, last.end),
    });
    startIndex = endIndex + 1;
  }
  return segments;
}

interface SummaryItem { text?: unknown; owner?: unknown; due?: unknown; source_quote?: unknown }
interface SummaryPayload { summary?: unknown; decisions?: SummaryItem[]; action_items?: SummaryItem[]; owners?: unknown[] }

function parseSummaryPayload(content: string): SummaryPayload {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Meeting review response did not contain JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as SummaryPayload;
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function bestSegment(segments: MeetingSegment[], source: string): MeetingSegment | undefined {
  const exact = source.trim().toLowerCase();
  if (exact) {
    const containing = segments.find((segment) => segment.text.toLowerCase().includes(exact));
    if (containing) return containing;
  }
  const wanted = tokenSet(source);
  let best: MeetingSegment | undefined;
  let score = 0;
  for (const segment of segments) {
    const tokens = tokenSet(segment.text);
    let overlap = 0;
    for (const token of wanted) if (tokens.has(token)) overlap += 1;
    if (overlap > score) { score = overlap; best = segment; }
  }
  return score > 0 ? best : undefined;
}

async function summarizeChunk(model: string, transcript: string): Promise<SummaryPayload> {
  const response = await grokChat({
    model,
    temperature: 0.1,
    max_tokens: 4_096,
    usageContext: { source: 'other', sourceId: 'meeting-review' },
    messages: [
      { role: 'system', content: 'You produce faithful meeting notes. Never invent facts, owners, dates, or decisions. Return JSON only.' },
      { role: 'user', content: `Review this timestamped speaker transcript. Return {"summary":"...","decisions":[{"text":"...","source_quote":"exact short quote"}],"action_items":[{"text":"...","owner":"only if explicit","due":"only if explicit","source_quote":"exact short quote"}],"owners":["explicit names only"]}.\n\n${transcript}` },
    ],
  });
  return parseSummaryPayload(response.choices[0]?.message?.content || '');
}

async function summarizeMeeting(segments: MeetingSegment[]): Promise<SummaryPayload> {
  const cfg = await loadConfig();
  const model = cfg.defaultGrokModel || 'cloud:grok-4';
  const chunks: string[] = [];
  let current = '';
  for (const segment of segments) {
    const line = `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.speakerId}: ${segment.text}\n`;
    if (current.length + line.length > 40_000 && current) { chunks.push(current); current = ''; }
    current += line;
  }
  if (current) chunks.push(current);
  const reviews: SummaryPayload[] = [];
  for (const chunk of chunks) reviews.push(await summarizeChunk(model, chunk));
  if (reviews.length <= 1) return reviews[0] || { summary: '', decisions: [], action_items: [], owners: [] };
  return summarizeChunk(model, `Consolidate these chunk reviews without adding facts. Preserve source_quote values exactly.\n${JSON.stringify(reviews)}`);
}

function attachReviewCitations(meetingId: string, segments: MeetingSegment[], review: SummaryPayload): {
  summary: string;
  decisions: MeetingDecision[];
  actionItems: MeetingActionItem[];
  owners: string[];
} {
  const decisions = (Array.isArray(review.decisions) ? review.decisions : []).slice(0, 100).flatMap((item, index) => {
    const text = cleanText(item.text, 5_000);
    if (!text) return [];
    const segment = bestSegment(segments, cleanText(item.source_quote || text, 2_000));
    return [{
      id: `decision-${index + 1}`,
      text,
      ...(segment ? { segmentId: segment.id, start: segment.start, end: segment.end, citationUrl: meetingCitationUrl(meetingId, segment.start, segment.end) } : {}),
    }];
  });
  const actionItems = (Array.isArray(review.action_items) ? review.action_items : []).slice(0, 100).flatMap((item, index) => {
    const text = cleanText(item.text, 5_000);
    if (!text) return [];
    const segment = bestSegment(segments, cleanText(item.source_quote || text, 2_000));
    return [{
      id: `action-${index + 1}`,
      text,
      ...(item.owner ? { owner: cleanText(item.owner, 300) } : {}),
      ...(item.due ? { due: cleanText(item.due, 300) } : {}),
      ...(segment ? { segmentId: segment.id, start: segment.start, end: segment.end, citationUrl: meetingCitationUrl(meetingId, segment.start, segment.end) } : {}),
    }];
  });
  const owners = [...new Set([
    ...(Array.isArray(review.owners) ? review.owners.map((owner) => cleanText(owner, 300)).filter(Boolean) : []),
    ...actionItems.map((item) => item.owner).filter((owner): owner is string => Boolean(owner)),
  ])];
  return { summary: cleanText(review.summary, 50_000), decisions, actionItems, owners };
}

function freshMeetingTask(meeting: MeetingRecord): string {
  const existing = getTask(meeting.taskId);
  if (existing && !['succeeded', 'failed', 'cancelled', 'lost'].includes(existing.status)) return existing.id;
  const id = `meeting:${meeting.id}:${randomUUID().slice(0, 8)}`;
  createTask({
    id,
    kind: 'artifact',
    title: `Transcribe ${meeting.title}`,
    description: `Create a speaker-aware transcript and review for ${meeting.title}.`,
    status: 'queued',
    originType: 'manual',
    originId: meeting.id,
    maxRetries: 1,
    contract: {
      outcome: 'The recording has a timestamped transcript and reviewable meeting notes.',
      constraints: ['No Board card or Routine is created without explicit confirmation.'],
      requiredArtifacts: [],
      requirements: [
        { id: 'transcript', label: 'Speaker-aware transcript recorded', required: true, acceptedKinds: ['integration'], scope: `meeting:${meeting.id}` },
        { id: 'review', label: 'Summary and action review recorded', required: true, acceptedKinds: ['assertion'], scope: `meeting:${meeting.id}` },
      ],
    },
    metadata: { meetingId: meeting.id, retryOfTaskId: meeting.taskId },
  });
  getDb().prepare('UPDATE meetings SET taskId = ?, version = version + 1, updatedAt = ? WHERE id = ?')
    .run(id, nowIso(), meeting.id);
  return id;
}

function beginMeetingTranscription(id: string): { meeting: MeetingRecord; taskId: string } {
  const meeting = getMeeting(id);
  if (!meeting) throw new Error('Meeting not found');
  if (!meeting.audioAvailable) throw new Error('Meeting audio is no longer available');
  if (meeting.status === 'transcribing') throw new Error('Meeting transcription is already running');
  const now = nowIso();
  const claimed = getDb().prepare(`
    UPDATE meetings SET status = 'transcribing', error = NULL, version = version + 1, updatedAt = ?
    WHERE id = ? AND status != 'transcribing' AND deletedAt IS NULL AND audioPath IS NOT NULL
  `).run(now, meeting.id);
  if (Number(claimed.changes) !== 1) throw new Error('Meeting transcription is already running');
  const current = getMeeting(meeting.id)!;
  const taskId = freshMeetingTask(current);
  const task = getTask(taskId)!;
  if (task.status === 'queued' || task.status === 'blocked' || task.status === 'paused') {
    transitionTask({ taskId, status: 'running', expectedVersion: task.version, currentStep: 'Uploading audio to xAI STT', nextAction: 'Build speaker turns and meeting review' });
  }
  emitAppEvent('meetings');
  return { meeting: getMeeting(meeting.id)!, taskId };
}

async function performMeetingTranscription(id: string, taskId: string, options: MeetingTranscribeOptions): Promise<MeetingRecord> {
  const row = meetingRow(id);
  if (!row?.audioPath) throw new Error('Meeting audio is no longer available');
  const scope = `meeting:${row.id}`;
  try {
    const audio = await fs.readFile(/* turbopackIgnore: true */ row.audioPath);
    if (audio.byteLength > MAX_MEETING_AUDIO_BYTES) throw new Error('Stored audio exceeds the transcription limit');
    const form = new FormData();
    form.append('format', 'true');
    form.append('diarize', 'true');
    form.append('filler_words', options.fillerWords ? 'true' : 'false');
    const language = cleanText(options.language, 30);
    if (language) form.append('language', language);
    for (const keyterm of (options.keyterms || []).slice(0, 100)) {
      const value = cleanText(keyterm, 50);
      if (value) form.append('keyterm', value);
    }
    // xAI requires the file field after all other multipart parameters.
    form.append('file', new Blob([audio], { type: row.audioMime }), row.originalFilename);
    const response = await fetchCloudWithAuth(XAI_STT_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(30 * 60_000) });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`xAI STT error ${response.status}: ${responseText.slice(0, 500)}`);
    const payload = JSON.parse(responseText) as { text?: unknown; language?: unknown; duration?: unknown; words?: unknown[] };
    const words = (Array.isArray(payload.words) ? payload.words : []).map(normalizeWord).filter((word): word is MeetingWord => Boolean(word));
    const transcriptText = cleanText(payload.text, 1_000_000) || words.map((word) => word.text).join(' ');
    if (!transcriptText || !words.length) throw new Error('xAI STT returned no timestamped words');
    const segments = wordsToSegments(row.id, words);
    const review = attachReviewCitations(row.id, segments, await summarizeMeeting(segments));
    const duration = Number(payload.duration);
    const now = nowIso();
    getDb().prepare(`
      UPDATE meetings SET status = 'ready', duration = ?, language = ?, transcriptText = ?,
        words = ?, segments = ?, speakerLabels = ?, summary = ?, decisions = ?,
        actionItems = ?, owners = ?, error = NULL, version = version + 1,
        updatedAt = ?, transcribedAt = ? WHERE id = ?
    `).run(
      Number.isFinite(duration) ? duration : words[words.length - 1].end,
      cleanText(payload.language, 100), transcriptText, JSON.stringify(words), JSON.stringify(segments),
      JSON.stringify(Object.fromEntries([...new Set(words.map((word) => word.speakerId))].map((speaker) => [speaker, speaker.replace('-', ' ')]))),
      review.summary, JSON.stringify(review.decisions), JSON.stringify(review.actionItems), JSON.stringify(review.owners),
      now, now, row.id,
    );
    recordTaskEvidence({
      taskId,
      requirementId: 'transcript',
      kind: 'integration',
      status: 'passed',
      label: 'xAI speaker-aware transcript',
      summary: `${words.length} timestamped words across ${new Set(words.map((word) => word.speakerId)).size} detected speaker(s).`,
      uri: meetingCitationUrl(row.id, 0),
      scope,
      metadata: { meetingId: row.id, endpoint: '/v1/stt', diarized: true, wordCount: words.length },
    });
    recordTaskEvidence({
      taskId,
      requirementId: 'review',
      kind: 'assertion',
      status: 'passed',
      label: 'Meeting review generated',
      summary: `${review.decisions.length} decision(s), ${review.actionItems.length} action item(s), and ${review.owners.length} explicit owner(s) are ready for review.`,
      uri: meetingCitationUrl(row.id, 0),
      scope,
      metadata: { meetingId: row.id },
    });
    const task = getTask(taskId);
    if (task?.status === 'running') transitionTask({ taskId, status: 'succeeded', result: `Meeting transcript ready: ${meetingCitationUrl(row.id, 0)}` });
    audit('run', 'meeting transcribed', row.title, { meetingId: row.id, words: words.length, speakers: new Set(words.map((word) => word.speakerId)).size });
    emitAppEvent('meetings');
    return getMeeting(row.id)!;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = nowIso();
    getDb().prepare("UPDATE meetings SET status = 'failed', error = ?, version = version + 1, updatedAt = ? WHERE id = ?")
      .run(message.slice(0, 20_000), now, row.id);
    recordTaskEvidence({ taskId, requirementId: 'transcript', kind: 'integration', status: 'failed', label: 'Meeting transcription failed', summary: message.slice(0, 8_000), scope, metadata: { meetingId: row.id, endpoint: '/v1/stt' } });
    const task = getTask(taskId);
    if (task?.status === 'running') transitionTask({ taskId, status: 'failed', error: message });
    emitAppEvent('meetings');
    throw error;
  }
}

export async function transcribeMeetingNow(id: string, options: MeetingTranscribeOptions = {}): Promise<MeetingRecord> {
  const started = beginMeetingTranscription(id);
  return performMeetingTranscription(started.meeting.id, started.taskId, options);
}

export function queueMeetingTranscription(id: string, options: MeetingTranscribeOptions = {}): MeetingRecord {
  const started = beginMeetingTranscription(id);
  void performMeetingTranscription(started.meeting.id, started.taskId, options).catch(() => {});
  return getMeeting(started.meeting.id)!;
}

export async function createMeetingOutputs(input: {
  meetingId: string;
  confirmed: boolean;
  actionItemIds: string[];
  createBoardCards?: boolean;
  createRoutines?: boolean;
  routineAgentId?: string;
}): Promise<MeetingOutput[]> {
  if (input.confirmed !== true) throw new Error('Explicit output confirmation is required');
  if (!input.createBoardCards && !input.createRoutines) throw new Error('Choose Board cards, Routines, or both');
  const meeting = getMeeting(input.meetingId);
  if (!meeting || meeting.status !== 'ready') throw new Error('Meeting review is not ready');
  const selected = [...new Set(input.actionItemIds)].slice(0, 50).map((id) => meeting.actionItems.find((item) => item.id === id)).filter((item): item is MeetingActionItem => Boolean(item));
  if (!selected.length) throw new Error('Select at least one action item');
  if (input.createRoutines && !cleanText(input.routineAgentId, 160)) throw new Error('Choose an agent for Routine outputs');
  for (const item of selected) {
    for (const type of [input.createBoardCards ? 'board_card' : null, input.createRoutines ? 'routine' : null].filter((value): value is MeetingOutput['type'] => Boolean(value))) {
      const outputKey = createHash('sha256').update(`${meeting.id}\0${item.id}\0${type}`).digest('hex').slice(0, 32);
      const id = `meeting-output-${outputKey}`;
      const now = nowIso();
      getDb().prepare(`
        INSERT OR IGNORE INTO meeting_outputs (id, meetingId, actionItemId, type, status, externalId, taskId, error, createdAt)
        VALUES (?, ?, ?, ?, 'creating', '', ?, NULL, ?)
      `).run(id, meeting.id, item.id, type, meeting.taskId, now);
      const existing = getDb().prepare('SELECT id, status FROM meeting_outputs WHERE meetingId = ? AND actionItemId = ? AND type = ?')
        .get(meeting.id, item.id, type) as { id: string; status: string } | undefined;
      if (existing?.status === 'ready') continue;
      // Reuse an existing claim ID so upgrades from older, randomly keyed rows
      // remain retryable instead of updating a new ID that lost the UNIQUE race.
      const claimId = existing?.id || id;
      getDb().prepare("UPDATE meeting_outputs SET status = 'creating', error = NULL WHERE id = ?").run(claimId);
      try {
        const citation = item.citationUrl || meetingCitationUrl(meeting.id, item.start || 0, item.end);
        const context = [item.owner ? `Owner: ${item.owner}` : '', item.due ? `Due: ${item.due}` : '', `Source: ${citation}`].filter(Boolean).join('\n');
        let externalId: string;
        if (type === 'board_card') {
          const card = await createBoardTask({ id: `meeting-board-${outputKey}`, title: item.text, description: context, status: 'todo', labels: ['meeting', meeting.id], createdBy: `meeting ${meeting.title}` });
          externalId = card.id;
        } else {
          const routineId = `meeting-routine-${outputKey}`;
          const routine = getRoutine(routineId) || createRoutine({
            id: routineId,
            name: item.text.slice(0, 100),
            description: `Confirmed action from ${meeting.title}. ${citation}`,
            agentId: cleanText(input.routineAgentId, 160, true),
            prompt: `${item.text}\n\n${context}`,
            triggers: [{ id: 'manual', type: 'manual', enabled: true }],
            catchUpPolicy: 'run_once',
          });
          externalId = routine.id;
        }
        getDb().prepare("UPDATE meeting_outputs SET status = 'ready', externalId = ?, error = NULL WHERE id = ?")
          .run(externalId, claimId);
        recordTaskEvidence({
          taskId: meeting.taskId,
          kind: 'artifact',
          status: 'passed',
          label: type === 'board_card' ? 'Confirmed Board card created' : 'Confirmed Routine created',
          summary: item.text,
          uri: type === 'board_card' ? `/board?card=${encodeURIComponent(externalId)}` : `/routines?routine=${encodeURIComponent(externalId)}`,
          scope: `meeting:${meeting.id}`,
          metadata: { meetingId: meeting.id, actionItemId: item.id, outputType: type, externalId, confirmed: true },
        });
      } catch (error) {
        getDb().prepare("UPDATE meeting_outputs SET status = 'failed', error = ? WHERE id = ?")
          .run((error instanceof Error ? error.message : String(error)).slice(0, 4_000), claimId);
        throw error;
      }
    }
  }
  emitAppEvent('meetings');
  emitAppEvent('board');
  emitAppEvent('routines');
  return meetingOutputs(meeting.id);
}

export interface MeetingSearchResult {
  meetingId: string;
  meetingTitle: string;
  segmentId: string;
  speakerId: string;
  speakerLabel: string;
  start: number;
  end: number;
  text: string;
  citationUrl: string;
  score: number;
}

export function searchMeetingTranscripts(query: string, limit = 10): MeetingSearchResult[] {
  const tokens = tokenSet(cleanText(query, 500, true));
  if (!tokens.size) return [];
  const rows = getDb().prepare("SELECT * FROM meetings WHERE deletedAt IS NULL AND status = 'ready' ORDER BY updatedAt DESC LIMIT 500")
    .all() as unknown as MeetingRow[];
  const results: MeetingSearchResult[] = [];
  for (const row of rows) {
    const meeting = rowToMeeting(row);
    for (const segment of meeting.segments) {
      const haystack = tokenSet(`${meeting.title} ${segment.text}`);
      let score = 0;
      for (const token of tokens) if (haystack.has(token)) score += 1;
      if (!score) continue;
      results.push({
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        segmentId: segment.id,
        speakerId: segment.speakerId,
        speakerLabel: meeting.speakerLabels[segment.speakerId] || segment.speakerId,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        citationUrl: segment.citationUrl,
        score,
      });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.start - b.start).slice(0, Math.max(1, Math.min(50, limit)));
}

export async function pruneExpiredMeetingAudio(at = new Date()): Promise<number> {
  ensureMeetingSchema();
  const rows = getDb().prepare(`
    SELECT * FROM meetings WHERE deletedAt IS NULL AND audioPath IS NOT NULL
      AND audioDeletedAt IS NULL AND deleteAudioAt IS NOT NULL AND deleteAudioAt <= ?
  `).all(at.toISOString()) as unknown as MeetingRow[];
  let removed = 0;
  for (const row of rows) {
    try { await fs.unlink(/* turbopackIgnore: true */ row.audioPath!); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
    const now = nowIso();
    getDb().prepare('UPDATE meetings SET audioPath = NULL, audioDeletedAt = ?, deleteAudioAt = NULL, version = version + 1, updatedAt = ? WHERE id = ?')
      .run(now, now, row.id);
    removed += 1;
  }
  if (removed) {
    audit('system', 'meeting audio retention prune', `${removed} recording(s) removed`);
    emitAppEvent('meetings');
  }
  return removed;
}

interface MeetingGlobals { __shibaMeetingRetention?: ReturnType<typeof setInterval> }
const meetingGlobals = globalThis as typeof globalThis & MeetingGlobals;

export function startMeetingRetention(): void {
  ensureMeetingSchema();
  if (meetingGlobals.__shibaMeetingRetention) return;
  void pruneExpiredMeetingAudio();
  meetingGlobals.__shibaMeetingRetention = setInterval(() => { void pruneExpiredMeetingAudio(); }, 60 * 60_000);
  meetingGlobals.__shibaMeetingRetention.unref?.();
}

export function reconcileInterruptedMeetings(): number {
  ensureMeetingSchema();
  const now = nowIso();
  const result = getDb().prepare(`
    UPDATE meetings SET status = 'failed', error = 'Transcription was interrupted when the Shiba Studio server stopped.',
      version = version + 1, updatedAt = ? WHERE status = 'transcribing' AND deletedAt IS NULL
  `).run(now);
  if (Number(result.changes)) emitAppEvent('meetings');
  return Number(result.changes);
}
