/**
 * xAI Responses API helpers: built-in server tools, request bodies, and
 * citation / tool-trace parsing. Used by the cloud chat stream.
 */
import type { ChatMessagePayload, ChatStreamEvent } from './chat-types';
import type { GrokTool } from './grok-client';

export const XAI_BUILTIN_SERVER_TOOLS = [
  { type: 'x_search' },
  { type: 'web_search' },
  { type: 'code_interpreter' },
] as const;

export type XaiBuiltinServerTool = (typeof XAI_BUILTIN_SERVER_TOOLS)[number];

export function xaiBuiltinServerTools(): Array<{ type: string }> {
  return XAI_BUILTIN_SERVER_TOOLS.map((tool) => ({ type: tool.type }));
}

export function shouldUseXaiResponsesApi(provider: string, modelId: string, hasMultimodal = false): boolean {
  return provider === 'cloud' && (hasMultimodal || /grok-(?:[4-9]|\d{2,})/i.test(modelId));
}

export function functionToolsToResponses(tools: GrokTool[] | undefined): Array<Record<string, unknown>> {
  return (tools || []).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

export function buildXaiResponsesTools(opts?: {
  builtin?: boolean;
  functionTools?: GrokTool[];
}): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (opts?.builtin !== false) out.push(...xaiBuiltinServerTools());
  out.push(...functionToolsToResponses(opts?.functionTools));
  return out;
}

export function buildResponsesInput(messages: ChatMessagePayload[]) {
  return messages.map((m) => {
    if (m.attachments?.length) {
      const parts: Record<string, unknown>[] = [];
      for (const att of m.attachments) {
        if (att.kind === 'image' && att.dataUrl) {
          parts.push({ type: 'input_image', image_url: att.dataUrl, detail: 'high' });
        } else if (att.kind === 'file' && att.fileId) {
          parts.push({ type: 'input_file', file_id: att.fileId });
        }
      }
      if ((m.content || '').trim()) parts.push({ type: 'input_text', text: m.content });
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

export function buildXaiResponsesRequestBody(input: {
  model: string;
  messages: ChatMessagePayload[];
  stream?: boolean;
  conversationId?: string;
  reasoningEffort?: string;
  builtinTools?: boolean;
  functionTools?: GrokTool[];
}): Record<string, unknown> {
  const tools = buildXaiResponsesTools({
    builtin: input.builtinTools !== false,
    functionTools: input.functionTools,
  });
  const body: Record<string, unknown> = {
    model: input.model,
    input: buildResponsesInput(input.messages),
    stream: input.stream !== false,
    store: false,
    tools,
  };
  if (input.conversationId) body.prompt_cache_key = input.conversationId;
  if (input.reasoningEffort && input.reasoningEffort !== 'low') {
    body.reasoning = { effort: input.reasoningEffort };
  }
  return body;
}

export interface ParsedCitation {
  url: string;
  title?: string;
  tool?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pushCitation(into: ParsedCitation[], url: unknown, title?: unknown, tool?: string): void {
  const href = String(url || '').trim();
  if (!href || !/^https?:\/\//i.test(href)) return;
  if (into.some((c) => c.url === href)) return;
  into.push({
    url: href,
    ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}),
    ...(tool ? { tool } : {}),
  });
}

function collectCitationsFromUnknown(value: unknown, into: ParsedCitation[], tool?: string): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCitationsFromUnknown(item, into, tool);
    return;
  }
  const rec = asRecord(value);
  if (!rec) return;
  if (typeof rec.url === 'string') pushCitation(into, rec.url, rec.title || rec.name, tool);
  if (Array.isArray(rec.citations)) collectCitationsFromUnknown(rec.citations, into, tool);
  if (Array.isArray(rec.annotations)) collectCitationsFromUnknown(rec.annotations, into, tool);
  if (Array.isArray(rec.content)) collectCitationsFromUnknown(rec.content, into, tool);
  if (rec.output) collectCitationsFromUnknown(rec.output, into, tool);
}

export function parseXaiResponsesCitations(raw: Record<string, unknown>): ParsedCitation[] {
  const citations: ParsedCitation[] = [];
  const item = asRecord(raw.item) || asRecord(raw.output) || raw;
  const itemType = String(item.type || raw.type || '');
  const tool = /x_search/i.test(itemType) ? 'x_search'
    : /web_search/i.test(itemType) ? 'web_search'
      : /code_interpreter|code_execution/i.test(itemType) ? 'code_interpreter'
        : undefined;
  collectCitationsFromUnknown(raw.citations, citations, tool);
  collectCitationsFromUnknown(item.citations, citations, tool);
  collectCitationsFromUnknown(item.annotations, citations, tool);
  collectCitationsFromUnknown(asRecord(raw.response)?.citations, citations, tool);
  collectCitationsFromUnknown(asRecord(raw.response)?.output, citations, tool);
  if (typeof raw.url === 'string') pushCitation(citations, raw.url, raw.title, tool);
  if (typeof item.url === 'string') pushCitation(citations, item.url, item.title, tool);
  return citations;
}

export function parseXaiResponsesToolTrace(raw: Record<string, unknown>): { name: string; detail?: string } | null {
  const item = asRecord(raw.item) || raw;
  const type = String(item.type || raw.type || '');
  if (/x_search/i.test(type)) return { name: 'x_search', detail: String(item.query || item.action || '') || undefined };
  if (/web_search/i.test(type)) return { name: 'web_search', detail: String(item.query || item.action || '') || undefined };
  if (/code_interpreter|code_execution/i.test(type)) {
    return { name: 'code_interpreter', detail: String(item.code || item.action || '') || undefined };
  }
  return null;
}

/**
 * Map one Responses SSE event into chat stream events, including citations
 * and xAI-executed tool traces.
 */
export function* mapXaiResponsesEvent(raw: Record<string, unknown>): Generator<ChatStreamEvent> {
  const type = String(raw.type || '');

  if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
    const delta = String(raw.delta || '');
    if (delta) yield { type: 'thinking', delta };
  }

  if (type === 'response.output_text.delta') {
    const delta = String(raw.delta || '');
    if (delta) yield { type: 'content', delta };
  }

  const toolTrace = parseXaiResponsesToolTrace(raw);
  if (toolTrace && (
    type.endsWith('.in_progress')
    || type.endsWith('.completed')
    || type === 'response.output_item.added'
    || type === 'response.output_item.done'
  )) {
    const label = toolTrace.name === 'x_search' ? 'xAI X search'
      : toolTrace.name === 'web_search' ? 'xAI web search'
        : 'xAI code interpreter';
    yield { type: 'tool-trace', name: toolTrace.name, detail: toolTrace.detail };
    yield { type: 'thinking', delta: `${label}${toolTrace.detail ? `: ${toolTrace.detail}` : ''}\n` };
  }

  const citations = parseXaiResponsesCitations(raw);
  for (const citation of citations) {
    yield { type: 'citation', url: citation.url, title: citation.title, tool: citation.tool };
  }

  if (type === 'response.completed' || type === 'response.done') {
    const response = raw.response as Record<string, unknown> | undefined;
    const usage = response?.usage as Record<string, unknown> | undefined;
    if (usage) yield { type: 'usage', usage };
  }
}
