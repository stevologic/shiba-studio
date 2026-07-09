/**
 * Backport actual model usage from the xAI Management / Billing API.
 * Docs: POST https://management-api.x.ai/v1/billing/teams/{teamId}/usage
 * Plus invoices + prepaid balance for token lines and credit remaining.
 */

import { XAI_BASE } from './grok-client';
import { parseModelRef } from './model-providers';

export const XAI_MANAGEMENT_BASE = 'https://management-api.x.ai';

export interface XaiModelUsageRow {
  /** Normalized model id (e.g. grok-4-0709) */
  model: string;
  /** Raw billing description from xAI (e.g. "Chat grok-4-0709") */
  label: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  otherTokens: number;
  totalTokens: number;
  requests: number;
}

export interface XaiDailyUsageRow {
  date: string;
  costUsd: number;
  totalTokens: number;
}

export interface XaiAccountUsage {
  available: boolean;
  checkedAt: string;
  teamId?: string;
  /** Auth used for the billing call */
  authSource?: 'api_key' | 'oauth' | 'management_key' | null;
  /** Current prepaid credit balance in USD (positive = credits remaining) */
  prepaidBalanceUsd?: number;
  /** Month-to-date billed cost from xAI (authoritative) */
  monthToDateCostUsd?: number;
  /** Soft spending limit if set */
  spendingLimitUsd?: number;
  billingCycle?: { year: number; month: number };
  byModel: XaiModelUsageRow[];
  byDay: XaiDailyUsageRow[];
  /** Inclusive start of the analytics window */
  rangeStart?: string;
  rangeEnd?: string;
  error?: string;
  note: string;
}

type CacheEntry = { at: number; data: XaiAccountUsage };
let cache: CacheEntry | null = null;
const CACHE_MS = 10 * 60_000;

function centsToUsd(val: unknown): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  // Billing API documents amounts as USD cents strings.
  return n / 100;
}

/** Prepaid balances use signed cents (negative purchase / remaining credit). */
function prepaidCentsToUsd(val: unknown): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  // Remaining credit is typically negative; report as positive balance.
  return Math.abs(n) / 100;
}

/** Pull a model id out of billing descriptions like "Chat grok-4-0709". */
export function parseBillingModelLabel(description: string): string {
  const raw = String(description || '').trim();
  if (!raw) return 'unknown';
  // "Chat grok-4-0709" | "Image grok-2-image-1212" | "grok-4-fast"
  const parts = raw.split(/\s+/);
  const candidate = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
  // Drop version suffixes like "-1.0.0" after a date stamp when present.
  return candidate.replace(/-\d+\.\d+\.\d+$/, '') || raw;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatLocalRange(daysBack: number): {
  startTime: string;
  endTime: string;
  startIso: string;
  endIso: string;
} {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - daysBack);
  start.setHours(0, 0, 0, 0);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return {
    startTime: fmt(start),
    endTime: fmt(end),
    startIso: start.toISOString().slice(0, 10),
    endIso: end.toISOString().slice(0, 10),
  };
}

async function resolveTeamId(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${XAI_BASE}/api-key`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.team_id || data.teamId || data.team?.id || null) as string | null;
  } catch {
    return null;
  }
}

/** Pull a team id from any loosely-shaped JSON payload. */
function pickTeamId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const direct = o.team_id || o.teamId || o.teamID;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const team = o.team;
  if (team && typeof team === 'object') {
    const t = team as Record<string, unknown>;
    const id = t.id || t.team_id || t.teamId;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  const key = o.apiKey || o.managementKey || o.management_key || o.key;
  if (key && typeof key === 'object') {
    const nested = pickTeamId(key);
    if (nested) return nested;
  }
  // Some list endpoints return { teams: [...] }
  const teams = o.teams;
  if (Array.isArray(teams) && teams[0]) {
    const first = pickTeamId(teams[0]);
    if (first) return first;
  }
  return null;
}

/**
 * Official management-key probe — does not require ACL permissions or team id.
 * Docs: GET https://management-api.x.ai/auth/management-keys/validation
 */
async function validateManagementKeyEndpoint(token: string): Promise<{
  ok: boolean;
  teamId?: string;
  raw?: unknown;
  error?: string;
  status?: number;
}> {
  try {
    const res = await managementFetch('/auth/management-keys/validation', token, {
      method: 'GET',
    });
    const status = res.status;
    const txt = await res.text().catch(() => '');
    let data: unknown = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = { raw: txt.slice(0, 200) };
    }
    if (!res.ok) {
      return {
        ok: false,
        status,
        error: `validation ${status}${txt ? `: ${txt.slice(0, 160)}` : ''}`,
        raw: data,
      };
    }
    const teamId = pickTeamId(data) || undefined;
    return { ok: true, teamId, raw: data, status };
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'validation request failed',
    };
  }
}

/**
 * Best-effort team id for billing paths.
 * Management keys usually cannot call api.x.ai/v1/api-key — use validation
 * payload, then inference credentials, then a few management list endpoints.
 */
async function resolveTeamIdForManagement(token: string): Promise<string | null> {
  // 1) Validation response may include team binding
  const validation = await validateManagementKeyEndpoint(token);
  if (validation.teamId) return validation.teamId;

  // 2) Inference key metadata (only works if `token` is actually an API key)
  const fromApiKey = await resolveTeamId(token);
  if (fromApiKey) return fromApiKey;

  // 3) Try common management endpoints that list teams or return team context
  const probes = [
    '/auth/teams',
    '/v1/auth/teams',
    '/auth/me',
    '/v1/auth/me',
  ];
  for (const path of probes) {
    try {
      const res = await managementFetch(path, token, { method: 'GET' });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const id = pickTeamId(data);
      if (id) return id;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function managementFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${XAI_MANAGEMENT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(20_000),
  });
}

async function fetchUsageAnalytics(
  teamId: string,
  token: string,
  opts: {
    startTime: string;
    endTime: string;
    timezone: string;
    timeUnit: string;
    valueName: string;
    groupBy: string[];
  },
): Promise<{ series: Array<{ group: string[]; dataPoints: Array<{ timestamp: string; values: number[] }> }>; error?: string }> {
  try {
    const res = await managementFetch(`/v1/billing/teams/${encodeURIComponent(teamId)}/usage`, token, {
      method: 'POST',
      body: JSON.stringify({
        analyticsRequest: {
          timeRange: {
            startTime: opts.startTime,
            endTime: opts.endTime,
            timezone: opts.timezone,
          },
          timeUnit: opts.timeUnit,
          values: [{ name: opts.valueName, aggregation: 'AGGREGATION_SUM' }],
          groupBy: opts.groupBy,
          filters: [],
        },
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { series: [], error: `usage analytics ${res.status}: ${txt.slice(0, 200)}` };
    }
    const data = await res.json();
    const series = Array.isArray(data.timeSeries) ? data.timeSeries : [];
    return { series };
  } catch (e: unknown) {
    return { series: [], error: e instanceof Error ? e.message : 'usage analytics failed' };
  }
}

function sumSeries(series: Array<{ group: string[]; dataPoints: Array<{ timestamp: string; values: number[] }> }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of series) {
    const key = (s.group && s.group[0]) || 'unknown';
    let total = 0;
    for (const dp of s.dataPoints || []) {
      total += Number(dp.values?.[0] || 0) || 0;
    }
    out.set(key, (out.get(key) || 0) + total);
  }
  return out;
}

function dailyFromSeries(
  series: Array<{ group: string[]; dataPoints: Array<{ timestamp: string; values: number[] }> }>,
): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const s of series) {
    for (const dp of s.dataPoints || []) {
      const day = String(dp.timestamp || '').slice(0, 10);
      if (!day) continue;
      byDay.set(day, (byDay.get(day) || 0) + (Number(dp.values?.[0] || 0) || 0));
    }
  }
  return byDay;
}

async function fetchInvoicesTokens(
  teamId: string,
  token: string,
  monthsBack = 2,
): Promise<{ byModel: Map<string, { prompt: number; completion: number; other: number; costCents: number; label: string }>; monthCostCents: number }> {
  const byModel = new Map<string, { prompt: number; completion: number; other: number; costCents: number; label: string }>();
  let monthCostCents = 0;
  const now = new Date();

  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    try {
      const qs = new URLSearchParams({
        'billingCycle.year': String(year),
        'billingCycle.month': String(month),
      });
      const res = await managementFetch(
        `/v1/billing/teams/${encodeURIComponent(teamId)}/invoices?${qs}`,
        token,
        { method: 'GET' },
      );
      if (!res.ok) continue;
      const data = await res.json();
      const invoices = Array.isArray(data.invoices) ? data.invoices : [];
      for (const inv of invoices) {
        const total = Number(inv.total || 0) || 0;
        if (i === 0) monthCostCents += total;
        const lines = Array.isArray(inv.lines) ? inv.lines : [];
        for (const line of lines) {
          const desc = String(line.description || 'unknown');
          const model = parseBillingModelLabel(desc);
          const unitType = String(line.unitType || '').toLowerCase();
          const units = Number(line.numUnits || 0) || 0;
          const amount = Number(line.amount || 0) || 0;
          const row = byModel.get(model) || {
            prompt: 0,
            completion: 0,
            other: 0,
            costCents: 0,
            label: desc,
          };
          if (unitType.includes('prompt') || unitType.includes('input')) row.prompt += units;
          else if (unitType.includes('completion') || unitType.includes('output')) row.completion += units;
          else if (unitType.includes('token')) row.other += units;
          row.costCents += amount;
          byModel.set(model, row);
        }
      }
    } catch {
      /* continue other months */
    }
  }

  return { byModel, monthCostCents };
}

async function fetchPrepaidBalance(teamId: string, token: string): Promise<number | undefined> {
  try {
    const res = await managementFetch(
      `/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`,
      token,
      { method: 'GET' },
    );
    if (!res.ok) return undefined;
    const data = await res.json();
    if (data.total?.val != null) return prepaidCentsToUsd(data.total.val);
    if (data.total != null) return prepaidCentsToUsd(data.total);
    return undefined;
  } catch {
    return undefined;
  }
}

async function fetchPostpaidPreview(teamId: string, token: string): Promise<{
  monthCostUsd?: number;
  spendingLimitUsd?: number;
  cycle?: { year: number; month: number };
}> {
  try {
    const res = await managementFetch(
      `/v1/billing/teams/${encodeURIComponent(teamId)}/postpaid/invoice/preview`,
      token,
      { method: 'GET' },
    );
    if (!res.ok) return {};
    const data = await res.json();
    const core = data.coreInvoice || {};
    // Prefer amount after VAT; fall back to before VAT. Values are USD cents.
    const after = core.amountAfterVat ?? core.amountBeforeVat ?? core.totalWithCorr?.val;
    const monthCostUsd = after != null ? centsToUsd(after) : undefined;
    const spendingLimitUsd = data.effectiveSpendingLimit != null
      ? centsToUsd(data.effectiveSpendingLimit)
      : undefined;
    const cycle = data.billingCycle
      ? { year: Number(data.billingCycle.year), month: Number(data.billingCycle.month) }
      : undefined;
    return { monthCostUsd, spendingLimitUsd, cycle };
  } catch {
    return {};
  }
}

/**
 * Probe an xAI Management key against management-api.x.ai.
 * Primary check: GET /auth/management-keys/validation (no team id required).
 * Optional enrichment: billing snapshot when a team id can be resolved.
 */
export async function validateManagementKey(opts?: {
  key?: string;
}): Promise<{
  ok: boolean;
  teamId?: string;
  prepaidBalanceUsd?: number;
  monthToDateCostUsd?: number;
  error?: string;
  note?: string;
}> {
  try {
    const { loadConfig } = await import('./persistence');
    const { resolveCloudBearer } = await import('./xai-oauth');
    const cfg = await loadConfig();
    const raw = typeof opts?.key === 'string' ? opts.key.trim() : '';
    const token = raw && !raw.startsWith('••••')
      ? raw
      : (cfg as { xaiManagementKey?: string }).xaiManagementKey?.trim() || '';

    if (!token) {
      return {
        ok: false,
        error: 'No management key',
        note: 'Paste a management key from console.x.ai → Settings → Management Keys, or save one first.',
      };
    }

    // 1) Official validation — proves the key is a valid management key.
    const validation = await validateManagementKeyEndpoint(token);
    if (!validation.ok) {
      return {
        ok: false,
        error: validation.error || 'Invalid management key',
        note: validation.status === 401 || validation.status === 403
          ? 'Key was rejected — copy a Management Key (not an inference API key) from console.x.ai → Settings → Management Keys.'
          : 'Could not reach management-api.x.ai or the key is not authorized.',
      };
    }

    // 2) Resolve team id for optional billing enrichment (not required for "ok").
    const auth = await resolveCloudBearer(cfg);
    let teamId = validation.teamId
      || await resolveTeamIdForManagement(token)
      || (auth.token ? await resolveTeamId(auth.token) : null)
      || undefined;

    let prepaidBalanceUsd: number | undefined;
    let monthToDateCostUsd: number | undefined;
    if (teamId) {
      prepaidBalanceUsd = await fetchPrepaidBalance(teamId, token);
      const postpaid = await fetchPostpaidPreview(teamId, token);
      monthToDateCostUsd = postpaid.monthCostUsd;
    }

    const parts: string[] = ['Management key is valid'];
    if (teamId) parts.push(`team ${teamId}`);
    else {
      parts.push(
        'team id not auto-detected (billing snapshot skipped — optional: save an inference API key / OAuth so we can resolve the team)',
      );
    }
    if (prepaidBalanceUsd != null) parts.push(`prepaid ~$${prepaidBalanceUsd.toFixed(2)}`);
    if (monthToDateCostUsd != null) parts.push(`MTD ~$${monthToDateCostUsd.toFixed(2)}`);

    return {
      ok: true,
      teamId,
      prepaidBalanceUsd,
      monthToDateCostUsd,
      note: parts.join(' · '),
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Management key test failed',
    };
  }
}

/**
 * Pull authoritative usage from xAI billing. Cached ~10 minutes.
 * Requires cloud auth; management key (Settings) is preferred when set.
 */
export async function fetchXaiAccountUsage(opts?: {
  force?: boolean;
  days?: number;
}): Promise<XaiAccountUsage> {
  const checkedAt = new Date().toISOString();
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  const empty = (error?: string, note?: string): XaiAccountUsage => ({
    available: false,
    checkedAt,
    byModel: [],
    byDay: [],
    error,
    note: note || 'Could not load xAI account usage.',
  });

  try {
    const { loadConfig } = await import('./persistence');
    const { resolveCloudBearer } = await import('./xai-oauth');
    const cfg = await loadConfig();
    const managementKey = (cfg as { xaiManagementKey?: string }).xaiManagementKey?.trim();
    const auth = await resolveCloudBearer(cfg);

    const tokensToTry: Array<{ token: string; source: XaiAccountUsage['authSource'] }> = [];
    if (managementKey) tokensToTry.push({ token: managementKey, source: 'management_key' });
    if (auth.token) {
      tokensToTry.push({
        token: auth.token,
        source: auth.source === 'oauth' ? 'oauth' : 'api_key',
      });
    }

    if (!tokensToTry.length) {
      return empty(
        'No cloud credentials',
        'Add an xAI API key or sign in with X (OAuth) in Settings to load account usage from xAI.',
      );
    }

    let lastError = '';
    for (const attempt of tokensToTry) {
      // Management keys usually cannot call api.x.ai/v1/api-key — use management
      // validation + list probes, then fall back to inference credentials for team id.
      let resolvedTeam: string | null = null;
      if (attempt.source === 'management_key') {
        resolvedTeam = await resolveTeamIdForManagement(attempt.token);
        if (!resolvedTeam && auth.token) {
          resolvedTeam = await resolveTeamId(auth.token);
        }
      } else {
        resolvedTeam = await resolveTeamId(attempt.token);
      }
      if (!resolvedTeam) {
        lastError = 'Could not resolve team id (management key needs team context from validation, inference API key, or OAuth)';
        continue;
      }

      const range = formatLocalRange(opts?.days ?? 30);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';

      // Cost by model description (authoritative USD from Usage Explorer backend)
      const costByModel = await fetchUsageAnalytics(resolvedTeam, attempt.token, {
        startTime: range.startTime,
        endTime: range.endTime,
        timezone,
        timeUnit: 'TIME_UNIT_NONE',
        valueName: 'usd',
        groupBy: ['description'],
      });

      // Daily cost series
      const costDaily = await fetchUsageAnalytics(resolvedTeam, attempt.token, {
        startTime: range.startTime,
        endTime: range.endTime,
        timezone,
        timeUnit: 'TIME_UNIT_DAY',
        valueName: 'usd',
        groupBy: [],
      });

      // Try token counts by description (field name may vary)
      let tokensByModel = new Map<string, number>();
      for (const field of ['tokens', 'num_units', 'token_count', 'units']) {
        const tok = await fetchUsageAnalytics(resolvedTeam, attempt.token, {
          startTime: range.startTime,
          endTime: range.endTime,
          timezone,
          timeUnit: 'TIME_UNIT_NONE',
          valueName: field,
          groupBy: ['description'],
        });
        if (!tok.error && tok.series.length) {
          tokensByModel = sumSeries(tok.series);
          break;
        }
      }

      const invoiceData = await fetchInvoicesTokens(resolvedTeam, attempt.token, 2);
      const prepaidBalanceUsd = await fetchPrepaidBalance(resolvedTeam, attempt.token);
      const postpaid = await fetchPostpaidPreview(resolvedTeam, attempt.token);

      // If analytics failed hard and invoices empty, try next credential
      if (costByModel.error && invoiceData.byModel.size === 0 && postpaid.monthCostUsd == null) {
        lastError = costByModel.error || 'Billing API unauthorized';
        // 401/403 → try next token
        if (/401|403|unauthor|forbidden/i.test(lastError)) continue;
      }

      const costMap = sumSeries(costByModel.series);
      const dailyCost = dailyFromSeries(costDaily.series.length ? costDaily.series : costByModel.series);

      // Merge model rows from analytics + invoices
      const modelKeys = new Set<string>([
        ...[...costMap.keys()].map(parseBillingModelLabel),
        ...invoiceData.byModel.keys(),
        ...[...tokensByModel.keys()].map(parseBillingModelLabel),
      ]);

      const byModel: XaiModelUsageRow[] = [];
      for (const model of modelKeys) {
        // Find matching analytics labels
        let costUsd = 0;
        let label = model;
        for (const [desc, cost] of costMap) {
          if (parseBillingModelLabel(desc) === model) {
            costUsd += cost;
            label = desc;
          }
        }
        const inv = invoiceData.byModel.get(model);
        if (inv && costUsd === 0) costUsd = inv.costCents / 100;
        if (inv?.label) label = inv.label;

        let totalFromAnalytics = 0;
        for (const [desc, toks] of tokensByModel) {
          if (parseBillingModelLabel(desc) === model) totalFromAnalytics += toks;
        }

        const promptTokens = inv?.prompt || 0;
        const completionTokens = inv?.completion || 0;
        const otherTokens = inv?.other || 0;
        const invoiceTokens = promptTokens + completionTokens + otherTokens;
        const totalTokens = invoiceTokens > 0 ? invoiceTokens : totalFromAnalytics;

        byModel.push({
          model: parseModelRef(model).id || model,
          label,
          costUsd,
          promptTokens,
          completionTokens,
          otherTokens,
          totalTokens,
          requests: 0,
        });
      }

      byModel.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

      // Build last 14 days of cost (pad zeros)
      const byDay: XaiDailyUsageRow[] = [];
      const today = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        byDay.push({
          date: key,
          costUsd: dailyCost.get(key) || 0,
          totalTokens: 0,
        });
      }

      // Month-to-date cost: prefer postpaid preview, else sum analytics for this calendar month
      let monthToDateCostUsd = postpaid.monthCostUsd;
      if (monthToDateCostUsd == null) {
        const monthPrefix = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}`;
        let sum = 0;
        for (const [day, cost] of dailyCost) {
          if (day.startsWith(monthPrefix)) sum += cost;
        }
        if (sum > 0) monthToDateCostUsd = sum;
        else if (invoiceData.monthCostCents) monthToDateCostUsd = invoiceData.monthCostCents / 100;
        else monthToDateCostUsd = byModel.reduce((s, m) => s + m.costUsd, 0);
      }

      const result: XaiAccountUsage = {
        available: byModel.length > 0 || monthToDateCostUsd != null || prepaidBalanceUsd != null,
        checkedAt,
        teamId: resolvedTeam,
        authSource: attempt.source,
        prepaidBalanceUsd,
        monthToDateCostUsd,
        spendingLimitUsd: postpaid.spendingLimitUsd,
        billingCycle: postpaid.cycle,
        byModel,
        byDay,
        rangeStart: range.startIso,
        rangeEnd: range.endIso,
        error: costByModel.error && !byModel.length ? costByModel.error : undefined,
        note: byModel.length
          ? 'Costs and tokens backported from the xAI Billing / Usage API (account-wide, not only this app).'
          : costByModel.error
            ? `xAI billing: ${costByModel.error}. Add a Management Key in Settings if your API key cannot read billing.`
            : 'No xAI billing rows returned for this period.',
      };

      // Consider partial success available when we got any signal
      if (!result.available && !result.error) {
        result.available = false;
        result.error = lastError || 'Empty billing response';
      }

      if (result.available || !/401|403|unauthor|forbidden/i.test(result.error || '')) {
        cache = { at: Date.now(), data: result };
        return result;
      }
      lastError = result.error || lastError;
    }

    return empty(
      lastError || 'Unauthorized',
      'xAI billing requires a Management Key (Console → Settings → Management Keys) or an API key with billing read access. Local studio metering is still available below.',
    );
  } catch (e: unknown) {
    return empty(e instanceof Error ? e.message : 'Failed to load xAI usage');
  }
}

export function clearXaiUsageCache() {
  cache = null;
}
