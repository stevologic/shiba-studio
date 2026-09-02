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
  /** Stable persisted id used by the context engine for citations. */
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  attachments?: ChatAttachment[];
  model?: string;
  /** Present when this assistant turn was spoken by a specific agent. */
  agentId?: string;
  agentName?: string;
}

/** A file written during a chat turn (fs_write) — linked under the response. */
export interface ChatFileRef {
  name: string;
  /** Path as the tool wrote it — absolute, or relative to the chat workspace. */
  path: string;
}

export type ChatPendingApproval = {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied';
};

export type ChatStreamEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'agent-turn-start'; agentId: string; name: string; messageId: string; model?: string }
  | { type: 'agent-perspective'; agentId: string; name: string; content: string }
  | { type: 'file-created'; file: ChatFileRef }
  | { type: 'citation'; url: string; title?: string; tool?: string }
  | { type: 'tool-trace'; name: string; detail?: string }
  | { type: 'approval_required'; approvalId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'approval_resolved'; approvalId: string; approved: boolean }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'done'; model: string }
  | { type: 'error'; message: string };

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
