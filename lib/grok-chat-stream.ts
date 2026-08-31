import { grokConversationId, XAI_BASE, XAI_CONV_ID_HEADER } from './grok-client';
import type { ChatMessagePayload, ChatStreamEvent, ReasoningEffort } from './chat-types';
import { parseModelRef, supportsReasoning } from './model-providers';
import {
  buildXaiResponsesRequestBody,
  mapXaiResponsesEvent,
  shouldUseXaiResponsesApi,
} from './xai-responses';

const DEFAULT_LOCAL_GROK_BASE = 'http://127.0.0.1:1234/v1';

export interface GrokChatStreamParams {
  model: string;
  /** Request-scoped cloud bearer selected for this model. */
  cloudKey?: string;
  /** Identity of cloudKey so OAuth refresh survives concurrent token rotation. */
  cloudAuthSource?: 'api_key' | 'oauth';
  signal?: AbortSignal;
  messages: ChatMessagePayload[];
  temperature?: number;
  max_tokens?: number;
  reasoningEffort?: ReasoningEffort;
  usageContext?: { source: 'chat' | 'agent' | 'other'; sourceId?: string };
  /** Sticky conversation id for xAI prompt-cache routing. */
  conversationId?: string;
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

function shouldUseResponsesApi(provider: string, modelId: string, messages: ChatMessagePayload[]): boolean {
  // Responses API streams reasoning for grok-4+ generations (including 4.6).
  return shouldUseXaiResponsesApi(provider, modelId, hasMultimodalInput(messages));
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
  yield* mapXaiResponsesEvent(raw);
}

export function buildGrokChatStreamRequest(params: {
  model: string;
  messages: ChatMessagePayload[];
  base?: string;
  conversationId?: string;
  reasoningEffort?: ReasoningEffort;
  builtinServerTools?: boolean;
}): { url: string; body: Record<string, unknown>; useResponses: boolean } {
  const ref = parseModelRef(params.model);
  const useResponses = shouldUseResponsesApi(ref.provider, ref.id, params.messages);
  const base = (params.base || XAI_BASE).replace(/\/$/, '');
  if (useResponses) {
    const body = buildXaiResponsesRequestBody({
      model: ref.id,
      messages: params.messages,
      stream: true,
      conversationId: params.conversationId,
      reasoningEffort: params.reasoningEffort && supportsReasoning(ref.id) ? params.reasoningEffort : undefined,
      builtinTools: params.builtinServerTools !== false && ref.provider === 'cloud',
    });
    return { url: `${base}/responses`, body, useResponses: true };
  }
  const body: Record<string, unknown> = {
    model: ref.id,
    messages: buildCompletionsMessages(params.messages),
    stream: true,
    ...(ref.provider === 'cloud' ? { stream_options: { include_usage: true } } : {}),
  };
  return { url: `${base}/chat/completions`, body, useResponses: false };
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
  const conversationId = grokConversationId(params.conversationId || params.usageContext?.sourceId);
  if (ref.provider === 'cloud' && conversationId) {
    headers[XAI_CONV_ID_HEADER] = conversationId;
  }

  if (ref.provider === 'local') {
    const { loadConfig } = await import('./persistence');
    const cfg = await loadConfig();
    if (!cfg.localGrokEnabled) {
      yield { type: 'error', message: 'Local models are disabled. Enable them in Settings.' };
      return;
    }
    base = normalizeLocalBase(cfg.localGrokBaseUrl);
  }

  const built = buildGrokChatStreamRequest({
    model: params.model,
    messages: params.messages,
    base,
    conversationId,
    reasoningEffort: params.reasoningEffort,
  });
  const url = built.url;
  const body = built.body;
  if (!useResponses) {
    body.temperature = params.temperature ?? 0.7;
    body.max_tokens = params.max_tokens ?? 4096;
    if (params.reasoningEffort && supportsReasoning(ref.id)) {
      body.reasoning_effort = params.reasoningEffort;
    }
  }

  const doFetch = async (): Promise<Response> => {
    const signal = params.signal
      ? AbortSignal.any([params.signal, AbortSignal.timeout(3600_000)])
      : AbortSignal.timeout(3600_000);
    if (ref.provider === 'local') {
      return fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    }
    const { fetchCloudWithAuth } = await import('./xai-oauth');
    return fetchCloudWithAuth(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, {
      keyOverride: params.cloudKey,
      keySource: params.cloudAuthSource,
      preferSource: ref.authSource,
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
    const { formatUserFacingStreamError } = await import('./stream-errors');
    yield {
      type: 'error',
      message: formatUserFacingStreamError(e) || (e instanceof Error ? e.message : 'Request failed'),
    };
    return;
  }

  if (!res.ok) {
    const txt = await res.text();
    const src = ref.provider === 'local' ? 'Local server' : 'Grok API';
    const clipped = txt
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    yield {
      type: 'error',
      message: `${src} error ${res.status}${clipped ? `: ${clipped}` : ''}`,
    };
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
