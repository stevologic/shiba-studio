/** Cloud (xAI API) vs local (OpenAI-compatible Grok runtime, e.g. LM Studio / Ollama). */

export type ModelProvider = 'cloud' | 'local';

export const DEFAULT_LOCAL_GROK_BASE = 'http://127.0.0.1:1234/v1';

export interface ModelRef {
  provider: ModelProvider;
  id: string;
  encoded: string;
}

export interface SelectableModel {
  id: string;
  label: string;
  provider: ModelProvider;
  /** Whether the model accepts reasoning-effort controls. Undefined = unknown. */
  reasoning?: boolean;
}

/**
 * Heuristic reasoning capability from a model id — used when the live catalog
 * flag is unavailable (fallback catalogs, saved models no longer listed).
 * The xAI catalog encodes capability in the id: explicit `non-reasoning`
 * variants exist, grok-4+ generations and grok-code stream reasoning,
 * grok-3-mini accepts reasoning_effort; older/image models do not.
 */
export function supportsReasoning(modelIdOrRef: string): boolean {
  const id = parseModelRef(modelIdOrRef).id.toLowerCase();
  if (!id) return false;
  if (id.includes('non-reasoning')) return false;
  if (id.includes('image') || id.includes('vision')) return false;
  if (id.includes('reasoning')) return true;
  if (/grok-(?:[4-9]|\d{2,})/.test(id)) return true;
  if (id.includes('grok-code')) return true;
  if (id.includes('grok-3-mini')) return true;
  if (id === 'grok-latest') return true;
  return false;
}

export function encodeModelRef(provider: ModelProvider, id: string): string {
  const clean = id.trim();
  return `${provider}:${clean}`;
}

export function parseModelRef(value: string): ModelRef {
  const v = (value || '').trim();
  if (v.startsWith('local:')) {
    const id = v.slice('local:'.length);
    return { provider: 'local', id, encoded: encodeModelRef('local', id) };
  }
  if (v.startsWith('cloud:')) {
    const id = v.slice('cloud:'.length);
    return { provider: 'cloud', id, encoded: encodeModelRef('cloud', id) };
  }
  // Replies routed through the local Grok CLI report as grok-cli:<model>.
  if (v.startsWith('grok-cli:')) {
    const id = v.slice('grok-cli:'.length);
    return { provider: 'local', id: `${id} · CLI`, encoded: v };
  }
  return { provider: 'cloud', id: v, encoded: encodeModelRef('cloud', v) };
}

export function providerLabel(provider: ModelProvider): string {
  return provider === 'local' ? 'Local' : 'Cloud';
}

export function modelDisplayName(encodedOrId: string): string {
  return parseModelRef(encodedOrId).id;
}

export function modelOptionLabel(m: SelectableModel): string {
  const tag = providerLabel(m.provider);
  return `[${tag}] ${m.label || m.id}`;
}

/**
 * Fallback cloud Grok ids when credentials exist but the live model listing is
 * unreachable (network hiccup, transient xAI outage). Keeps the model picker
 * usable — chat requests still validate against the real API.
 */
export const FALLBACK_CLOUD_GROK_MODELS: SelectableModel[] = [
  { id: 'cloud:grok-4.3-latest', label: 'grok-4.3-latest', provider: 'cloud', reasoning: true },
  { id: 'cloud:grok-latest', label: 'grok-latest', provider: 'cloud', reasoning: true },
  { id: 'cloud:grok-4.20-reasoning-latest', label: 'grok-4.20-reasoning-latest', provider: 'cloud', reasoning: true },
  { id: 'cloud:grok-code-fast-1', label: 'grok-code-fast-1', provider: 'cloud', reasoning: true },
  { id: 'cloud:grok-4', label: 'grok-4 (legacy)', provider: 'cloud', reasoning: true },
];

// NOTE: local models are never listed from a static fallback — the dropdowns
// only offer what the local server's /models endpoint actually reported.