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

/**
 * Studio's reasoning-effort control. `none` means "do not send a parameter"
 * (xAI grok-4.6+ then defaults to `high` and cannot disable reasoning).
 * `xhigh` is grok-4.6+ maximum depth; older models treat it as `high`.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export const REASONING_EFFORT_VALUES = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

export function normalizeReasoningEffort(value?: string | null): ReasoningEffort {
  return isReasoningEffort(value) ? value : DEFAULT_REASONING_EFFORT;
}

/**
 * Value to send on xAI Chat Completions (`reasoning_effort`) or Responses
 * (`reasoning.effort`). Missing values and `none` omit the field so the
 * provider default applies (high on Grok 4.6).
 */
export function xaiReasoningEffortParam(value?: string | null): Exclude<ReasoningEffort, 'none'> | undefined {
  if (!isReasoningEffort(value) || value === 'none') return undefined;
  return value;
}
