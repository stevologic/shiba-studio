import { NextRequest, NextResponse } from 'next/server';
import { getUsageSummary } from '@/lib/usage';
import { loadConfig } from '@/lib/persistence';
import { XAI_BASE } from '@/lib/grok-client';
import { clearXaiUsageCache, fetchXaiAccountUsage } from '@/lib/xai-billing-usage';

interface LiveXaiStatus {
  connected: boolean;
  checkedAt: string;
  keyName?: string;
  teamId?: string;
  modelCount?: number;
  error?: string;
}

/**
 * Live probe against the xAI inference API — confirms the account link and
 * model catalog. Actual billing usage is loaded separately via the management
 * billing API (see xaiAccount in the response).
 */
async function probeXaiLive(): Promise<LiveXaiStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const { fetchCloudWithAuth } = await import('@/lib/xai-oauth');
    const keyRes = await fetchCloudWithAuth(`${XAI_BASE}/api-key`, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    if (!keyRes.ok) {
      return { connected: false, checkedAt, error: `xAI API ${keyRes.status}` };
    }
    const keyInfo = await keyRes.json();

    let modelCount: number | undefined;
    try {
      const modelsRes = await fetchCloudWithAuth(`${XAI_BASE}/language-models`, {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
      });
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        const list = data.models ?? data.data ?? [];
        if (Array.isArray(list)) modelCount = list.length;
      }
    } catch {
      /* model catalog is optional enrichment */
    }

    return {
      connected: true,
      checkedAt,
      keyName: keyInfo.name || keyInfo.api_key_name || undefined,
      teamId: keyInfo.team_id || undefined,
      modelCount,
    };
  } catch (e: unknown) {
    return {
      connected: false,
      checkedAt,
      error: e instanceof Error ? e.message : 'xAI API unreachable',
    };
  }
}

export async function GET(req: NextRequest) {
  try {
    const force = req.nextUrl.searchParams.get('refresh') === '1'
      || req.nextUrl.searchParams.get('force') === '1';
    if (force) clearXaiUsageCache();

    const cfg = await loadConfig();
    const defaultModel = cfg.defaultGrokModel?.trim() || 'cloud:grok-4';
    const [summary, live, xaiAccount] = await Promise.all([
      getUsageSummary(defaultModel),
      probeXaiLive(),
      fetchXaiAccountUsage({ force, days: 30 }),
    ]);

    // Prefer xAI month-to-date for the "authoritative" cost badge consumers.
    const authoritativeCostUsd = xaiAccount.available && xaiAccount.monthToDateCostUsd != null
      ? xaiAccount.monthToDateCostUsd
      : summary.estimatedCostUsd;

    return NextResponse.json({
      ok: true,
      ...summary,
      live,
      xaiAccount,
      authoritativeCostUsd,
      pricingNote: xaiAccount.available
        ? `${xaiAccount.note} Studio-local metering (below) attributes tokens to chat/agents in this app only.`
        : summary.pricingNote,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to load usage';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
