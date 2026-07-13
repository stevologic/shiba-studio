export type MeetingSource = 'microphone' | 'upload';
export type MeetingStatus = 'uploaded' | 'transcribing' | 'ready' | 'failed';

export interface MeetingWord {
  text: string;
  start: number;
  end: number;
  speakerId: string;
}

export interface MeetingSegment {
  id: string;
  speakerId: string;
  start: number;
  end: number;
  text: string;
  wordStartIndex: number;
  wordEndIndex: number;
  citationUrl: string;
}

export interface MeetingDecision {
  id: string;
  text: string;
  segmentId?: string;
  start?: number;
  end?: number;
  citationUrl?: string;
}

export interface MeetingActionItem {
  id: string;
  text: string;
  owner?: string;
  due?: string;
  segmentId?: string;
  start?: number;
  end?: number;
  citationUrl?: string;
}

export interface MeetingOutput {
  id: string;
  meetingId: string;
  actionItemId: string;
  type: 'board_card' | 'routine';
  externalId: string;
  taskId?: string;
  createdAt: string;
}

export interface MeetingRecord {
  id: string;
  title: string;
  source: MeetingSource;
  status: MeetingStatus;
  consentAt: string;
  consentVersion: string;
  originalFilename: string;
  audioMime: string;
  audioBytes: number;
  audioSha256: string;
  audioAvailable: boolean;
  audioDeletedAt?: string;
  retentionDays: number;
  deleteAudioAt?: string;
  duration?: number;
  language?: string;
  transcriptText: string;
  words: MeetingWord[];
  segments: MeetingSegment[];
  speakerLabels: Record<string, string>;
  summary: string;
  decisions: MeetingDecision[];
  actionItems: MeetingActionItem[];
  owners: string[];
  outputs: MeetingOutput[];
  taskId: string;
  error?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  transcribedAt?: string;
}

export interface MeetingTranscribeOptions {
  language?: string;
  keyterms?: string[];
  fillerWords?: boolean;
}
