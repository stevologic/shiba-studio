/** Cloud (xAI API) · local (OpenAI-compatible, e.g. LM Studio / Ollama) · CLI (Grok CLI). */

export type ModelProvider = 'cloud' | 'local' | 'cli';

/** Which cloud credential a cloud-model selection uses. Undefined = follow the
 *  global cloudAuthMode preference (back-compat with plain `cloud:` refs). */
export type CloudAuthSource = 'oauth' | 'token';

export const DEFAULT_LOCAL_GROK_BASE = 'http://127.0.0.1:1234/v1';

export interface ModelRef {
  provider: ModelProvider;
  id: string;
  encoded: string;
  /** For cloud models only: the pinned credential source, if any. */
  authSource?: CloudAuthSource;
}

export interface SelectableModel {
  id: string;
  label: string;
  provider: ModelProvider;
  /** Whether the model accepts reasoning-effort controls. Undefined = unknown. */
  reasoning?: boolean;
  /** Cloud models: which credential this entry uses (when both are configured). */
  authSource?: CloudAuthSource;
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

/** Canonical xAI flagship id and encoded cloud ref. */
export const DEFAULT_CLOUD_MODEL_ID = 'grok-4.6';
export const DEFAULT_CLOUD_MODEL_REF = `cloud:${DEFAULT_CLOUD_MODEL_ID}`;
/** Cheap/fast cloud model for titles and other background summaries. */
export const CHEAP_CLOUD_MODEL_ID = 'grok-code-fast-1';
export const CHEAP_CLOUD_MODEL_REF = `cloud:${CHEAP_CLOUD_MODEL_ID}`;

/** Bare or encoded ids that were leftover first-paint placeholders, not a user choice. */
const LEGACY_PLACEHOLDER_IDS = new Set(['grok-4', 'grok-3', 'grok-2', 'grok-4.5']);

export function resolveDefaultCloudModel(saved?: string | null): string {
  const value = (saved || '').trim();
  return value || DEFAULT_CLOUD_MODEL_REF;
}

export function isLegacyPlaceholderModel(value?: string | null): boolean {
  const raw = (value || '').trim();
  if (!raw) return true;
  return LEGACY_PLACEHOLDER_IDS.has(parseModelRef(raw).id.toLowerCase());
}

/**
 * Rank a catalog entry so the picker prefers the current flagship over a
 * locale-sorted leftover like `cloud:grok-4`. Higher is better.
 */
export function modelPreferenceScore(modelIdOrRef: string): number {
  const id = parseModelRef(modelIdOrRef).id.toLowerCase();
  if (!id) return -1;
  if (id.includes('image') || id.includes('imagine') || id.includes('vision') || id.includes('voice')) {
    return -1;
  }
  let score = 0;
  const generation = id.match(/grok-(\d+)(?:\.(\d+))?/);
  if (generation) {
    score = Number(generation[1]) * 10_000 + Number(generation[2] || 0) * 100;
  } else if (id === 'grok-latest') {
    // Alias to "whatever is current" — slightly below an explicit 4.6 pin.
    score = 40_550;
  } else if (id.includes('grok-code')) {
    score = 3_500;
  } else if (id.includes('grok')) {
    score = 100;
  } else {
    return 0;
  }
  if (id.includes('non-reasoning')) score -= 50;
  if (id.includes('fast')) score -= 500;
  if (id.endsWith('-latest') || id === 'grok-latest') score += 10;
  return score;
}

/**
 * Choose the catalog entry a new chat/agent should use. Keeps an explicit
 * non-legacy current selection; otherwise picks the highest-ranked Grok.
 */
export function pickPreferredCloudModel(
  catalog: Array<{ id: string }>,
  current?: string | null,
): string {
  const currentValue = (current || '').trim();
  if (
    currentValue
    && !isLegacyPlaceholderModel(currentValue)
    && catalog.some((entry) => entry.id === currentValue)
  ) {
    return currentValue;
  }
  const ranked = catalog
    .map((entry) => ({ id: entry.id, score: modelPreferenceScore(entry.id) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return ranked[0]?.id || currentValue || DEFAULT_CLOUD_MODEL_REF;
}

/** Published xAI context windows. Conservative fallback for unknown ids. */
export function contextWindowTokensForModel(modelIdOrRef: string): number {
  const id = parseModelRef(modelIdOrRef).id.toLowerCase();
  if (/grok-4\.(?:3|20)/.test(id)) return 1_000_000;
  if (/grok-4\.(?:6|5)/.test(id) || id === 'grok-latest') return 500_000;
  if (/grok-4/.test(id) || id.includes('grok-code')) return 256_000;
  if (/grok-3/.test(id)) return 131_072;
  return 128_000;
}

/**
 * How many recent-turn tokens to replay for a model. Leaves most of the
 * window for the live turn (system, tools, images, output).
 */
export function replayBudgetForModel(modelIdOrRef?: string | null): number {
  if (!modelIdOrRef?.trim()) return 14_000;
  const windowTokens = contextWindowTokensForModel(modelIdOrRef);
  return Math.max(8_000, Math.min(80_000, Math.floor(windowTokens * 0.08)));
}

export function encodeModelRef(provider: ModelProvider, id: string): string {
  const clean = id.trim();
  return `${provider}:${clean}`;
}

/** Encode a cloud model pinned to a specific credential source. */
export function encodeCloudModel(id: string, source?: CloudAuthSource): string {
  const clean = id.trim();
  if (source === 'oauth') return `cloud-oauth:${clean}`;
  if (source === 'token') return `cloud-token:${clean}`;
  return `cloud:${clean}`;
}

export function parseModelRef(value: string): ModelRef {
  const v = (value || '').trim();
  if (v.startsWith('local:')) {
    const id = v.slice('local:'.length);
    return { provider: 'local', id, encoded: encodeModelRef('local', id) };
  }
  // Cloud models pinned to a credential source (shown when both OAuth + API
  // key are configured). The bare `id` is what the xAI API receives.
  if (v.startsWith('cloud-oauth:')) {
    const id = v.slice('cloud-oauth:'.length);
    return { provider: 'cloud', id, authSource: 'oauth', encoded: `cloud-oauth:${id}` };
  }
  if (v.startsWith('cloud-token:')) {
    const id = v.slice('cloud-token:'.length);
    return { provider: 'cloud', id, authSource: 'token', encoded: `cloud-token:${id}` };
  }
  if (v.startsWith('cloud:')) {
    const id = v.slice('cloud:'.length);
    return { provider: 'cloud', id, encoded: encodeModelRef('cloud', id) };
  }
  // Grok CLI models — preferred prefix `cli:`, legacy stream tag `grok-cli:`.
  if (v.startsWith('cli:')) {
    const id = v.slice('cli:'.length);
    return { provider: 'cli', id, encoded: encodeModelRef('cli', id) };
  }
  if (v.startsWith('grok-cli:')) {
    const id = v.slice('grok-cli:'.length);
    return { provider: 'cli', id, encoded: encodeModelRef('cli', id) };
  }
  return { provider: 'cloud', id: v, encoded: encodeModelRef('cloud', v) };
}

export function providerLabel(provider: ModelProvider): string {
  if (provider === 'local') return 'Local';
  if (provider === 'cli') return 'CLI';
  return 'Cloud';
}

/** Tooltip for provider badges in the UI. */
export function providerTitle(provider: ModelProvider, authSource?: CloudAuthSource): string {
  if (provider === 'local') {
    return 'Local model on this machine — any OpenAI-compatible server (LM Studio, Ollama, …)';
  }
  if (provider === 'cli') {
    return 'Grok CLI — agentic coding model running via the local `grok` binary';
  }
  if (authSource === 'oauth') {
    return 'xAI Grok cloud via OAuth 2.0 (SuperGrok / Premium+ quota)';
  }
  if (authSource === 'token') {
    return 'xAI Grok cloud via your API key (pay-as-you-go)';
  }
  return 'xAI Grok cloud API';
}

/** Short label for a model entry's source — used in pickers. */
export function modelSourceLabel(m: SelectableModel): string {
  if (m.provider === 'local') return 'Local';
  if (m.provider === 'cli') return 'CLI';
  if (m.authSource === 'oauth') return 'OAuth';
  if (m.authSource === 'token') return 'Token';
  return 'Cloud';
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
  { id: DEFAULT_CLOUD_MODEL_REF, label: DEFAULT_CLOUD_MODEL_ID, provider: 'cloud', reasoning: true },
  { id: 'cloud:grok-4.6-latest', label: 'grok-4.6-latest', provider: 'cloud', reasoning: true },
  { id: 'cloud:grok-latest', label: 'grok-latest', provider: 'cloud', reasoning: true },
  { id: 'cloud:grok-4.3-latest', label: 'grok-4.3-latest', provider: 'cloud', reasoning: true },
  { id: 'cloud:grok-4.20-reasoning-latest', label: 'grok-4.20-reasoning-latest', provider: 'cloud', reasoning: true },
  { id: CHEAP_CLOUD_MODEL_REF, label: CHEAP_CLOUD_MODEL_ID, provider: 'cloud', reasoning: true },
  { id: 'cloud:grok-4', label: 'grok-4 (legacy)', provider: 'cloud', reasoning: true },
];

// NOTE: local models are never listed from a static fallback — the dropdowns
// only offer what the local server's /models endpoint actually reported.