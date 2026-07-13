import type { ChatAttachment } from './chat-types';

export type ContextScopeType = 'session' | 'project' | 'run';
export type ContextSourceType =
  | 'message'
  | 'project'
  | 'project_file'
  | 'run_prompt'
  | 'run_output'
  | 'run_trace'
  | 'decision'
  | 'instruction';

export interface ContextSourceCitation {
  sourceId: string;
  scopeType: ContextScopeType;
  scopeId: string;
  sourceType: ContextSourceType;
  sourceKey: string;
  projectId?: string;
  runId?: string;
  role?: string;
  createdAt: string;
}

export interface ContextSourceRecord extends ContextSourceCitation {
  content: string;
  contentHash: string;
  ordinal: number;
  tokenEstimate: number;
  pinned: boolean;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface ContextCompactionRecord {
  id: string;
  scopeType: ContextScopeType;
  scopeId: string;
  fromOrdinal: number;
  toOrdinal: number;
  sourceIds: string[];
  sourceDigest: string;
  summary: string;
  tokenEstimate: number;
  algorithm: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextScopeInspection {
  scopeType: ContextScopeType;
  scopeId: string;
  sources: ContextSourceRecord[];
  compactions: ContextCompactionRecord[];
  meter: ContextWindowMeter;
  indexedAt?: string;
  compactedAt?: string;
  pagination: {
    sourceLimit: number;
    sourceOffset: number;
    totalSources: number;
    returnedSources: number;
    truncated: boolean;
  };
}

export interface ContextMatchWindow {
  citation: ContextSourceCitation;
  content: string;
  score: number;
  matchTerms: string[];
  before?: { sourceId: string; role?: string; excerpt: string };
  after?: { sourceId: string; role?: string; excerpt: string };
}

export interface ContextSearchResult {
  query: string;
  matches: ContextMatchWindow[];
  limits: {
    maxResults: number;
    maxChars: number;
    returnedChars: number;
    candidatesScanned: number;
    truncated: boolean;
  };
}

export interface ContextWindowMeter {
  model?: string;
  sourceTokens: number;
  summaryTokens: number;
  replayTokens: number;
  pinnedTokens: number;
  /** Pinned sources represented by citation only because the pin budget filled. */
  pinnedOverflowCount?: number;
  maxPinnedTokens?: number;
  attachmentTokens: number;
  totalTokens: number;
  sourceCount: number;
  summaryCount: number;
  replayCount: number;
  compactedSourceCount: number;
  maxReplayTokens: number;
  breakdown: {
    messageTokens: number;
    toolResultTokens: number;
    projectTokens: number;
    runTokens: number;
    otherTokens: number;
  };
}

export interface ContextModelMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  attachments?: ChatAttachment[];
  createdAt?: string;
}

export interface PreparedSessionContext {
  systemContext: string;
  replayMessages: ContextModelMessage[];
  meter: ContextWindowMeter;
  citations: ContextSourceCitation[];
}
