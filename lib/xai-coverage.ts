/**
 * Machine-checkable map of current public xAI REST families and Grok CLI
 * harnesses to a shipped Shiba path (`wired`) or an explicit deferral.
 */
export type XaiCoverageStatus = 'wired' | 'deferred';
export type XaiCoverageFamily = 'rest' | 'cli';

export interface XaiCoverageEntry {
  id: string;
  family: XaiCoverageFamily;
  status: XaiCoverageStatus;
  /** Shipped module that owns the path, or the reason it is deferred. */
  path: string;
  note?: string;
}

export const XAI_SURFACE_COVERAGE = [
  {
    id: 'chat-completions',
    family: 'rest',
    status: 'wired',
    path: 'lib/grok-client.ts',
    note: 'Agent tool loops and local models POST /v1/chat/completions.',
  },
  {
    id: 'responses',
    family: 'rest',
    status: 'wired',
    path: 'lib/grok-chat-stream.ts',
    note: 'Cloud grok-4+ chat streams POST /v1/responses with built-in server tools.',
  },
  {
    id: 'image-generation',
    family: 'rest',
    status: 'wired',
    path: 'lib/agent-power-tools.ts',
    note: 'generate_image → /v1/images/generations.',
  },
  {
    id: 'image-edit',
    family: 'rest',
    status: 'wired',
    path: 'lib/xai-imagine.ts',
    note: 'edit_image → /v1/images/edits.',
  },
  {
    id: 'video-generation',
    family: 'rest',
    status: 'wired',
    path: 'lib/xai-imagine.ts',
    note: 'generate_video → /v1/videos/generations then poll /v1/videos/{id}.',
  },
  {
    id: 'voice-realtime',
    family: 'rest',
    status: 'wired',
    path: 'lib/grok-voice.ts',
    note: 'Meetings and phone assistant mint realtime client secrets.',
  },
  {
    id: 'tts',
    family: 'rest',
    status: 'wired',
    path: 'lib/xai-tts.ts',
    note: 'POST /v1/tts from chat and /api/tts.',
  },
  {
    id: 'stt',
    family: 'rest',
    status: 'wired',
    path: 'lib/meetings.ts',
    note: 'Meeting transcripts POST /v1/stt.',
  },
  {
    id: 'files',
    family: 'rest',
    status: 'wired',
    path: 'lib/xai-files.ts',
    note: 'Chat attachments and cloud-sync snapshots use the Files API.',
  },
  {
    id: 'models',
    family: 'rest',
    status: 'wired',
    path: 'lib/grok-client.ts',
    note: 'GET /v1/language-models (and /v1/models fallback) for the picker.',
  },
  {
    id: 'collections',
    family: 'rest',
    status: 'deferred',
    path: 'deferred',
    note: 'RAG collections are a cloud document store; Shiba already has local memories, Files, and workspace search.',
  },
  {
    id: 'batches',
    family: 'rest',
    status: 'deferred',
    path: 'deferred',
    note: 'Offline JSONL batches do not fit the interactive local studio loop.',
  },
  {
    id: 'x-search',
    family: 'rest',
    status: 'wired',
    path: 'lib/xai-responses.ts',
    note: 'Built-in x_search on cloud Responses turns (not the X OAuth timeline tool).',
  },
  {
    id: 'headless-one-shot',
    family: 'cli',
    status: 'wired',
    path: 'lib/grok-cli.ts',
    note: 'grok --no-auto-update -p/--prompt-file --output-format for chat and grok_cli.',
  },
  {
    id: 'acp-stdio',
    family: 'cli',
    status: 'deferred',
    path: 'deferred',
    note: 'Persistent grok agent stdio is a different IDE harness; Shiba does not launch it.',
  },
] as const satisfies readonly XaiCoverageEntry[];

const REQUIRED_IDS = [
  'chat-completions',
  'responses',
  'image-generation',
  'image-edit',
  'video-generation',
  'voice-realtime',
  'tts',
  'stt',
  'files',
  'models',
  'collections',
  'batches',
  'headless-one-shot',
  'acp-stdio',
] as const;

export function xaiCoverageById(id: string): XaiCoverageEntry | undefined {
  return XAI_SURFACE_COVERAGE.find((entry) => entry.id === id);
}

export function assertXaiCoverageComplete(): string[] {
  const ids = new Set(XAI_SURFACE_COVERAGE.map((entry) => entry.id));
  const missing = REQUIRED_IDS.filter((id) => !ids.has(id));
  const wiredRequired = ['image-edit', 'video-generation', 'x-search'] as const;
  const notWired = wiredRequired.filter((id) => xaiCoverageById(id)?.status !== 'wired');
  return [...missing.map((id) => `missing family ${id}`), ...notWired.map((id) => `${id} must be wired`)];
}
