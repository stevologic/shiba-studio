export type ChatAttachmentKind = 'image' | 'file';

export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  name: string;
  mimeType: string;
  /** Data URL for images (client preview + API payload). */
  dataUrl?: string;
  /** xAI Files API id for cloud document uploads. */
  fileId?: string;
  /** Inline text for local file previews. */
  textContent?: string;
  size?: number;
}

export interface ChatMessagePayload {
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  attachments?: ChatAttachment[];
  model?: string;
}

/** A file written during a chat turn (fs_write) — linked under the response. */
export interface ChatFileRef {
  name: string;
  /** Path as the tool wrote it — absolute, or relative to the chat workspace. */
  path: string;
}

export type ChatStreamEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'agent-perspective'; agentId: string; name: string; content: string }
  | { type: 'file-created'; file: ChatFileRef }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'done'; model: string }
  | { type: 'error'; message: string };

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';