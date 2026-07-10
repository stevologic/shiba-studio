import { XAI_BASE } from './grok-client';
import type { ChatMessagePayload, ChatStreamEvent, ReasoningEffort } from './chat-types';
import { parseModelRef, supportsReasoning } from './model-providers';

const DEFAULT_LOCAL_GROK_BASE = 'http://127.0.0.1:1234/v1';

export interface GrokChatStreamParams {
  model: string;
  messages: ChatMessagePayload[];
  temperature?: number;
  max_tokens?: number;
  reasoningEffort?: ReasoningEffort;
  usageContext?: { source: 'chat' | 'agent' | 'other'; sourceId?: string };
}

function normalizeLocalBase(url?: string): string {
  const raw = (url || DEFAULT_LOCAL_GROK_BASE).trim().replace(/\/+$/, '');
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

function hasMultimodalInput(messages: ChatMessagePayload[]): boolean {
  return messages.some((m) =>
    m.attachments?.some((a) => (a.kind === 'image' && a.dataUrl) || (a.kind === 'file' && a.fileId)),
  );
}

function isReasoningModel(modelId: string): boolean {
  return /grok-4/i.test(modelId);
}

function shouldUseResponsesApi(provider: string, modelId: string, messages: ChatMessagePayload[]): boolean {
  return provider === 'cloud' && (hasMultimodalInput(messages) || isReasoningModel(modelId));
}

function buildResponsesInput(messages: ChatMessagePayload[]) {
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

function buildCompletionsMessages(messages: ChatMessagePayload[]) {
  return messages.map((m) => {
    if (m.attachments?.length) {
      const parts: Record<string, unknown>[] = [];
      for (const att of m.attachments) {
        if (att.kind === 'image' && att.dataUrl) {
          parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
        } else if (att.kind === 'file') {
          if (att.textContent) {
            parts.push({ type: 'text', text: `--- ${att.name} ---\n${att.textContent}` });
          } else if (att.fileId) {
            parts.push({ type: 'text', text: `[Attached file: ${att.name} (id: ${att.fileId})]` });
          }
        }
      }
      if ((m.content || '').trim()) parts.push({ type: 'text', text: m.content });
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';

    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          /* skip malformed */
        }
      }
    }
  }
}

function* mapResponsesEvent(raw: Record<string, unknown>): Generator<ChatStreamEvent> {
  const type = String(raw.type || '');

  if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
    const delta = String(raw.delta || '');
    if (delta) yield { type: 'thinking', delta };
    return;
  }

  if (type === 'response.output_text.delta') {
    const delta = String(raw.delta || '');
    if (delta) yield { type: 'content', delta };
    return;
  }

  if (type === 'response.completed' || type === 'response.done') {
    const response = raw.response as Record<string, unknown> | undefined;
    const usage = response?.usage as Record<string, unknown> | undefined;
    if (usage) yield { type: 'usage', usage };
  }
}

function* mapCompletionsChunk(raw: Record<string, unknown>): Generator<ChatStreamEvent> {
  const choices = raw.choices as Array<Record<string, unknown>> | undefined;
  const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
  if (!delta) return;

  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (reasoning) yield { type: 'thinking', delta: String(reasoning) };

  const content = delta.content;
  if (content) yield { type: 'content', delta: String(content) };

  if (raw.usage) yield { type: 'usage', usage: raw.usage as Record<string, unknown> };
}

export async function* grokChatStream(params: GrokChatStreamParams): AsyncGenerator<ChatStreamEvent> {
  const ref = parseModelRef(params.model);
  const useResponses = shouldUseResponsesApi(ref.provider, ref.id, params.messages);

  let base = XAI_BASE;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (ref.provider === 'local') {
    const { loadConfig } = await import('./persistence');
    const cfg = await loadConfig();
    if (!cfg.localGrokEnabled) {
      yield { type: 'error', message: 'Local models are disabled. Enable them in Settings.' };
      return;
    }
    base = normalizeLocalBase(cfg.localGrokBaseUrl);
  }

  const url = useResponses ? `${base}/responses` : `${base}/chat/completions`;
  const body: Record<string, unknown> = useResponses
    ? {
        model: ref.id,
        input: buildResponsesInput(params.messages),
        stream: true,
        store: false,
      }
    : {
        model: ref.id,
        messages: buildCompletionsMessages(params.messages),
        stream: true,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.max_tokens ?? 4096,
      };

  // Reasoning params are only attached for models that actually accept them
  // (explicit non-reasoning variants and legacy models get none, regardless
  // of what the client sent).
  if (params.reasoningEffort && supportsReasoning(ref.id)) {
    if (useResponses) {
      if (params.reasoningEffort !== 'low') body.reasoning = { effort: params.reasoningEffort };
    } else if (isReasoningModel(ref.id)) {
      body.reasoning_effort = params.reasoningEffort;
    }
  }

  const doFetch = async (): Promise<Response> => {
    if (ref.provider === 'local') {
      return fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3600_000),
      });
    }
    const { fetchCloudWithAuth } = await import('./xai-oauth');
    return fetchCloudWithAuth(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3600_000),
    });
  };

  // Nothing has streamed yet, so a transient network failure (dead keep-alive
  // socket, DNS blip) is safe to retry once before surfacing an error.
  let res: Response;
  try {
    try {
      res = await doFetch();
    } catch (first: unknown) {
      const msg = first instanceof Error ? first.message : '';
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network/i.test(msg);
      if (!transient) throw first;
      await new Promise((resolve) => setTimeout(resolve, 400));
      res = await doFetch();
    }
  } catch (e: unknown) {
    yield { type: 'error', message: e instanceof Error ? e.message : 'Request failed' };
    return;
  }

  if (!res.ok) {
    const txt = await res.text();
    const src = ref.provider === 'local' ? 'Local server' : 'Grok API';
    yield { type: 'error', message: `${src} error ${res.status}: ${txt}` };
    return;
  }

  if (!res.body) {
    yield { type: 'error', message: 'No response stream' };
    return;
  }

  let lastUsage: Record<string, unknown> | undefined;

  for await (const raw of parseSseStream(res.body)) {
    const events = useResponses ? mapResponsesEvent(raw) : mapCompletionsChunk(raw);
    for (const ev of events) {
      if (ev.type === 'usage') lastUsage = ev.usage;
      yield ev;
    }
  }

  if (lastUsage && params.usageContext) {
    const { recordUsage } = await import('./usage');
    await recordUsage({
      model: ref.encoded,
      usage: lastUsage,
      source: params.usageContext.source,
      sourceId: params.usageContext.sourceId,
    }).catch(() => {});
    yield { type: 'usage', usage: lastUsage };
  }

  yield { type: 'done', model: ref.encoded };
}

export { encodeSseEvent } from './sse-events';