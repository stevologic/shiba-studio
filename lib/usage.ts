import { promises as fs } from 'fs';
import path from 'path';
import { dataDir } from './data-paths';
import { v4 as uuidv4 } from 'uuid';
import { parseModelRef } from './model-providers';

const DATA_DIR = dataDir();
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const USAGE_TMP = path.join(DATA_DIR, 'usage.json.tmp');
const MAX_RECORDS = 10_000;
const usageLockGlobal = globalThis as typeof globalThis & { __shibaUsageWriteChain?: Promise<unknown> };

function withUsageWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = usageLockGlobal.__shibaUsageWriteChain ?? Promise.resolve();
  const run = previous.then(fn, fn);
  usageLockGlobal.__shibaUsageWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

export type UsageSource = 'chat' | 'agent' | 'other';

export interface UsageRecord {
  id: string;
  ts: string;
  model: string;
  source: UsageSource;
  sourceId?: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  label: string;
}

/** Public xAI rates — matched by model id prefix. Fallback for unknown models. */
const PRICING_RULES: Array<{ match: RegExp; inputPer1M: number; outputPer1M: number }> = [
  { match: /^grok-4\.3/i, inputPer1M: 1.25, outputPer1M: 2.5 },
  { match: /^grok-4\.20/i, inputPer1M: 1.25, outputPer1M: 2.5 },
  { match: /^grok-build/i, inputPer1M: 1.0, outputPer1M: 2.0 },
  { match: /^grok-3-mini/i, inputPer1M: 0.3, outputPer1M: 0.5 },
  { match: /^grok-3/i, inputPer1M: 3.0, outputPer1M: 15.0 },
  { match: /^grok-2/i, inputPer1M: 2.0, outputPer1M: 10.0 },
  { match: /^grok-4/i, inputPer1M: 1.25, outputPer1M: 2.5 },
];

const DEFAULT_PRICING: ModelPricing = {
  inputPer1M: 1.25,
  outputPer1M: 2.5,
  label: 'default estimate',
};

export function getModelPricing(model: string): ModelPricing {
  const id = parseModelRef(model.trim()).id;
  for (const rule of PRICING_RULES) {
    if (rule.match.test(id)) {
      return { inputPer1M: rule.inputPer1M, outputPer1M: rule.outputPer1M, label: id };
    }
  }
  return { ...DEFAULT_PRICING, label: id || 'unknown' };
}

export function estimateTokenCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  reasoningTokens = 0,
): number {
  const rates = getModelPricing(model);
  const inputCost = (promptTokens / 1_000_000) * rates.inputPer1M;
  const outputCost = ((completionTokens + reasoningTokens) / 1_000_000) * rates.outputPer1M;
  return inputCost + outputCost;
}

export function parseGrokUsage(usage: unknown): {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
} | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completionTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const reasoningTokens = Number(
    u.reasoning_tokens
    ?? (u.completion_tokens_details as { reasoning_tokens?: number } | undefined)?.reasoning_tokens
    ?? 0,
  ) || 0;
  const cachedTokens = Number(
    (u.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens
    ?? u.cached_prompt_tokens
    ?? 0,
  ) || 0;
  const totalTokens = Number(u.total_tokens ?? promptTokens + completionTokens + reasoningTokens) || 0;
  if (totalTokens === 0 && promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens, reasoningTokens, cachedTokens, totalTokens };
}

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadUsageRecords(): Promise<UsageRecord[]> {
  await ensureData();
  try {
    const raw = await fs.readFile(USAGE_FILE, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function recordUsage(input: {
  model: string;
  usage: unknown;
  source: UsageSource;
  sourceId?: string;
}): Promise<UsageRecord | null> {
  const parsed = parseGrokUsage(input.usage);
  if (!parsed) return null;

  const isLocal = parseModelRef(input.model).provider === 'local';
  const estimatedCostUsd = isLocal
    ? 0
    : estimateTokenCost(
        input.model,
        parsed.promptTokens,
        parsed.completionTokens,
        parsed.reasoningTokens,
      );

  const record: UsageRecord = {
    id: uuidv4(),
    ts: new Date().toISOString(),
    model: input.model,
    source: input.source,
    sourceId: input.sourceId,
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    reasoningTokens: parsed.reasoningTokens,
    cachedTokens: parsed.cachedTokens,
    totalTokens: parsed.totalTokens,
    estimatedCostUsd,
  };

  return withUsageWriteLock(async () => {
    const records = await loadUsageRecords();
    records.push(record);
    const trimmed = records.slice(-MAX_RECORDS);
    await fs.writeFile(USAGE_TMP, JSON.stringify(trimmed, null, 2));
    await fs.rename(USAGE_TMP, USAGE_FILE);
    return record;
  });
}

export interface ModelUsageRow {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  inputPer1M: number;
  outputPer1M: number;
  sharePct: number;
}

export interface LocalModelUsageRow {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  hypotheticalCostUsd: number;
}

export interface LocalUsageSavings {
  defaultModel: string;
  totalRequests: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number;
  hypotheticalCostUsd: number;
  estimatedSavingsUsd: number;
  savingsPct: number;
  byLocalModel: LocalModelUsageRow[];
  note: string;
}

export interface UsageSummary {
  totalRequests: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number;
  estimatedCostUsd: number;
  byModel: ModelUsageRow[];
  bySource: Array<{ source: UsageSource; requests: number; totalTokens: number; estimatedCostUsd: number }>;
  byDay: Array<{ date: string; requests: number; totalTokens: number; estimatedCostUsd: number }>;
  recent: UsageRecord[];
  localSavings: LocalUsageSavings | null;
  pricingNote: string;
}

function dayKey(ts: string): string {
  return ts.slice(0, 10);
}

export function computeLocalUsageSavings(
  records: UsageRecord[],
  defaultModel: string,
): LocalUsageSavings | null {
  const localRecords = records.filter((r) => parseModelRef(r.model).provider === 'local');
  if (localRecords.length === 0) return null;

  const byLocalModel = new Map<string, LocalModelUsageRow>();
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalReasoningTokens = 0;
  let totalTokens = 0;
  let hypotheticalCostUsd = 0;

  for (const r of localRecords) {
    const hypo = estimateTokenCost(
      defaultModel,
      r.promptTokens,
      r.completionTokens,
      r.reasoningTokens,
    );
    hypotheticalCostUsd += hypo;
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;
    totalReasoningTokens += r.reasoningTokens;
    totalTokens += r.totalTokens;

    const row = byLocalModel.get(r.model) || {
      model: r.model,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      hypotheticalCostUsd: 0,
    };
    row.requests += 1;
    row.promptTokens += r.promptTokens;
    row.completionTokens += r.completionTokens;
    row.reasoningTokens += r.reasoningTokens;
    row.totalTokens += r.totalTokens;
    row.hypotheticalCostUsd += hypo;
    byLocalModel.set(r.model, row);
  }

  const defaultRef = parseModelRef(defaultModel);
  const defaultIsLocal = defaultRef.provider === 'local';
  const estimatedSavingsUsd = defaultIsLocal ? 0 : hypotheticalCostUsd;
  const savingsPct = hypotheticalCostUsd > 0
    ? (estimatedSavingsUsd / hypotheticalCostUsd) * 100
    : 0;

  return {
    defaultModel,
    totalRequests: localRecords.length,
    totalTokens,
    totalPromptTokens,
    totalCompletionTokens,
    totalReasoningTokens,
    hypotheticalCostUsd,
    estimatedSavingsUsd,
    savingsPct,
    byLocalModel: Array.from(byLocalModel.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    note: defaultIsLocal
      ? 'Your configured default model is also local — no cloud cost comparison applies.'
      : 'Local runs are free on your machine. Savings estimate what the same tokens would cost on your configured default cloud model.',
  };
}

export function aggregateUsage(records: UsageRecord[], defaultModel = 'cloud:grok-4'): UsageSummary {
  const byModelMap = new Map<string, ModelUsageRow>();
  const bySourceMap = new Map<UsageSource, { requests: number; totalTokens: number; estimatedCostUsd: number }>();
  const byDayMap = new Map<string, { requests: number; totalTokens: number; estimatedCostUsd: number }>();

  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalReasoningTokens = 0;
  let estimatedCostUsd = 0;

  for (const r of records) {
    const isLocal = parseModelRef(r.model).provider === 'local';
    const recordCost = isLocal ? 0 : r.estimatedCostUsd;

    totalTokens += r.totalTokens;
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;
    totalReasoningTokens += r.reasoningTokens;
    estimatedCostUsd += recordCost;

    const pricing = getModelPricing(r.model);
    const row = byModelMap.get(r.model) || {
      model: r.model,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      inputPer1M: pricing.inputPer1M,
      outputPer1M: pricing.outputPer1M,
      sharePct: 0,
    };
    row.requests += 1;
    row.promptTokens += r.promptTokens;
    row.completionTokens += r.completionTokens;
    row.reasoningTokens += r.reasoningTokens;
    row.totalTokens += r.totalTokens;
    row.estimatedCostUsd += recordCost;
    byModelMap.set(r.model, row);

    const src = bySourceMap.get(r.source) || { requests: 0, totalTokens: 0, estimatedCostUsd: 0 };
    src.requests += 1;
    src.totalTokens += r.totalTokens;
    src.estimatedCostUsd += recordCost;
    bySourceMap.set(r.source, src);

    const dk = dayKey(r.ts);
    const day = byDayMap.get(dk) || { requests: 0, totalTokens: 0, estimatedCostUsd: 0 };
    day.requests += 1;
    day.totalTokens += r.totalTokens;
    day.estimatedCostUsd += recordCost;
    byDayMap.set(dk, day);
  }

  const byModel = Array.from(byModelMap.values())
    .map((m) => ({
      ...m,
      sharePct: totalTokens > 0 ? (m.totalTokens / totalTokens) * 100 : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const bySource = Array.from(bySourceMap.entries())
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const today = new Date();
  const byDay: UsageSummary['byDay'] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const entry = byDayMap.get(key) || { requests: 0, totalTokens: 0, estimatedCostUsd: 0 };
    byDay.push({ date: key, ...entry });
  }

  return {
    totalRequests: records.length,
    totalTokens,
    totalPromptTokens,
    totalCompletionTokens,
    totalReasoningTokens,
    estimatedCostUsd,
    byModel,
    bySource,
    byDay,
    recent: [...records]
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, 25)
      .map((r) => ({
        ...r,
        estimatedCostUsd: parseModelRef(r.model).provider === 'local' ? 0 : r.estimatedCostUsd,
      })),
    localSavings: computeLocalUsageSavings(records, defaultModel),
    pricingNote: 'Costs are estimated from public xAI per-million-token rates. Local model runs are $0. Actual billing may differ.',
  };
}

export async function getUsageSummary(defaultModel?: string): Promise<UsageSummary> {
  const records = await loadUsageRecords();
  const resolvedDefault = defaultModel?.trim() || 'cloud:grok-4';
  return aggregateUsage(records, resolvedDefault);
}
