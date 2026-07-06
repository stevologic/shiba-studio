// Grok client — cloud (xAI API) and local (OpenAI-compatible Grok runtime).
// Cloud: https://api.x.ai/v1 · Local: LM Studio, Ollama, etc.

import {
  DEFAULT_LOCAL_GROK_BASE,
  encodeModelRef,
  FALLBACK_LOCAL_GROK_MODELS,
  parseModelRef,
  SelectableModel,
} from './model-providers';

export const XAI_BASE = 'https://api.x.ai/v1';

export interface GrokMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface GrokTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface GrokUsageContext {
  source: 'chat' | 'agent' | 'other';
  sourceId?: string;
}

export interface GrokChatParams {
  model: string;
  messages: GrokMessage[];
  tools?: GrokTool[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  usageContext?: GrokUsageContext;
}

export interface GrokChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: string;
}

export interface GrokChatResponse {
  id: string;
  choices: GrokChoice[];
  usage?: any;
}

let cachedKey: string | null = null;

export function setApiKey(key: string) {
  cachedKey = key?.trim() || null;
}

export function clearApiKey() {
  cachedKey = null;
}

export function getApiKey(): string | null {
  return cachedKey;
}

export interface XaiModelInfo {
  id: string;
  label: string;
  aliases: string[];
  contextLength?: number;
  inputModalities?: string[];
  outputModalities?: string[];
}

/** Parse xAI language-models or models list into selectable chat model entries. */
export function parseXaiModelList(data: unknown): XaiModelInfo[] {
  const raw = (data as any)?.models ?? (data as any)?.data ?? [];
  if (!Array.isArray(raw)) return [];

  const result: XaiModelInfo[] = [];
  for (const m of raw) {
    const id = m?.id;
    if (!id || typeof id !== 'string') continue;
    const aliases: string[] = Array.isArray(m.aliases) ? m.aliases.filter((a: unknown) => typeof a === 'string') : [];
    const aliasNote = aliases.length ? ` · aliases: ${aliases.join(', ')}` : '';
    result.push({
      id,
      label: `${id}${aliasNote}`,
      aliases,
      contextLength: m.context_length ?? m.long_context_threshold ?? undefined,
      inputModalities: m.input_modalities,
      outputModalities: m.output_modalities,
    });
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** Expand primary ids + alias strings into unique selectable values. */
export function expandModelSelectableIds(models: XaiModelInfo[]): XaiModelInfo[] {
  const seen = new Set<string>();
  const expanded: XaiModelInfo[] = [];
  for (const m of models) {
    const ids = [m.id, ...m.aliases];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      expanded.push({
        ...m,
        id,
        label: id === m.id ? m.label : `${id} (alias of ${m.id})`,
      });
    }
  }
  return expanded.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listGrokModels(key?: string): Promise<{ ok: boolean; models: XaiModelInfo[]; error?: string }> {
  try {
    const { fetchCloudWithAuth } = await import('./xai-oauth');

    const langRes = await fetchCloudWithAuth(`${XAI_BASE}/language-models`, { method: 'GET' }, { keyOverride: key });
    if (langRes.ok) {
      const data = await langRes.json();
      const parsed = parseXaiModelList(data);
      if (parsed.length > 0) {
        return { ok: true, models: expandModelSelectableIds(parsed) };
      }
    }

    const res = await fetchCloudWithAuth(`${XAI_BASE}/models`, { method: 'GET' }, { keyOverride: key });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, models: [], error: `${res.status} ${txt}` };
    }
    const data = await res.json();
    const parsed = expandModelSelectableIds(parseXaiModelList(data));
    return { ok: true, models: parsed };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to list models';
    if (msg.includes('Missing cloud credentials')) {
      return { ok: false, models: [], error: 'No cloud credentials configured (API key or OAuth with X)' };
    }
    return { ok: false, models: [], error: msg };
  }
}

export async function validateApiKey(key?: string): Promise<{ ok: boolean; models?: XaiModelInfo[]; error?: string }> {
  const useKey = key || getApiKey();
  if (!useKey) return { ok: false, error: 'No API key' };
  const listed = await listGrokModels(useKey);
  if (!listed.ok) return { ok: false, error: listed.error };
  return { ok: true, models: listed.models };
}

function normalizeLocalBase(url?: string): string {
  const raw = (url || DEFAULT_LOCAL_GROK_BASE).trim().replace(/\/+$/, '');
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

export async function listLocalGrokModels(baseUrl?: string): Promise<{ ok: boolean; models: SelectableModel[]; error?: string }> {
  const base = normalizeLocalBase(baseUrl);
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, models: FALLBACK_LOCAL_GROK_MODELS, error: `${res.status} ${txt}` };
    }
    const data = await res.json();
    const raw = (data as any)?.data ?? (data as any)?.models ?? [];
    if (!Array.isArray(raw) || raw.length === 0) {
      return { ok: true, models: FALLBACK_LOCAL_GROK_MODELS };
    }
    const models: SelectableModel[] = raw
      .map((m: any) => {
        const id = m?.id;
        if (!id || typeof id !== 'string') return null;
        return {
          id: encodeModelRef('local', id),
          label: id,
          provider: 'local' as const,
        };
      })
      .filter(Boolean) as SelectableModel[];
    return { ok: true, models: models.length ? models : FALLBACK_LOCAL_GROK_MODELS };
  } catch (e: any) {
    return { ok: false, models: FALLBACK_LOCAL_GROK_MODELS, error: e.message };
  }
}

export async function listAllSelectableModels(cfg?: {
  xaiApiKey?: string;
  localGrokEnabled?: boolean;
  localGrokBaseUrl?: string;
}): Promise<{
  ok: boolean;
  models: SelectableModel[];
  cloudError?: string;
  localError?: string;
  hasCloudAuth: boolean;
  localEnabled: boolean;
  localReachable: boolean;
}> {
  const { loadConfig } = await import('./persistence');
  const config = cfg ? { ...(await loadConfig()), ...cfg } : (await loadConfig());
  const models: SelectableModel[] = [];
  let cloudError: string | undefined;
  let localError: string | undefined;
  let localReachable = false;

  const { resolveCloudBearer } = await import('./xai-oauth');
  const cloudAuth = await resolveCloudBearer(config);
  if (cloudAuth.hasCloudAuth) {
    const cloud = await listGrokModels();
    if (cloud.ok) {
      models.push(
        ...cloud.models.map((m) => ({
          id: encodeModelRef('cloud', m.id),
          label: m.label || m.id,
          provider: 'cloud' as const,
        })),
      );
    } else {
      cloudError = cloud.error;
      // Live listing unreachable — fall back to the known catalog so models stay
      // selectable. Requests still validate against the real API when sent.
      const { FALLBACK_CLOUD_GROK_MODELS } = await import('./model-providers');
      models.push(...FALLBACK_CLOUD_GROK_MODELS);
    }
  }

  if (config.localGrokEnabled) {
    const local = await listLocalGrokModels(config.localGrokBaseUrl);
    localReachable = local.ok;
    if (local.ok) models.push(...local.models);
    else localError = local.error;
    if (!local.ok && local.models.length) models.push(...local.models);
  }

  return {
    ok: models.length > 0,
    models,
    cloudError,
    localError,
    hasCloudAuth: cloudAuth.hasCloudAuth,
    localEnabled: !!config.localGrokEnabled,
    localReachable,
  };
}

export async function grokChat(params: GrokChatParams, keyOverride?: string): Promise<GrokChatResponse> {
  const ref = parseModelRef(params.model);
  const body = {
    model: ref.id,
    messages: params.messages,
    tools: params.tools,
    tool_choice: params.tool_choice,
    temperature: params.temperature ?? 0.7,
    max_tokens: params.max_tokens ?? 4096,
  };

  let base = XAI_BASE;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (ref.provider === 'local') {
    const { loadConfig } = await import('./persistence');
    const cfg = await loadConfig();
    if (!cfg.localGrokEnabled) {
      throw new Error('Local Grok models are disabled. Enable them in Settings.');
    }
    base = normalizeLocalBase(cfg.localGrokBaseUrl);
  }

  const res = ref.provider === 'local'
    ? await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    : await (async () => {
        const { fetchCloudWithAuth } = await import('./xai-oauth');
        return fetchCloudWithAuth(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }, { keyOverride: keyOverride || undefined });
      })();

  if (!res.ok) {
    const txt = await res.text();
    const src = ref.provider === 'local' ? 'Local Grok' : 'Grok API';
    throw new Error(`${src} error ${res.status}: ${txt}`);
  }
  const data: GrokChatResponse = await res.json();
  const usageModel = ref.encoded;
  if (params.usageContext && data.usage) {
    const { recordUsage } = await import('./usage');
    await recordUsage({
      model: usageModel,
      usage: data.usage,
      source: params.usageContext.source,
      sourceId: params.usageContext.sourceId,
    }).catch(() => {});
  }
  return data;
}

// Convenience for direct chat (no tools)
export async function grokComplete(prompt: string, model: string = 'grok-4', system?: string) {
  const messages: GrokMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const resp = await grokChat({ model, messages });
  return resp.choices?.[0]?.message?.content || '';
}
