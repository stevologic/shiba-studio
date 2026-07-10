import { NextRequest, NextResponse } from 'next/server';
import { getUsageSummary } from '@/lib/usage';
import { loadConfig } from '@/lib/persistence';
import { clearXaiUsageCache, fetchXaiAccountUsage } from '@/lib/xai-billing-usage';

export async function GET(req: NextRequest) {
  try {
    const force = req.nextUrl.searchParams.get('refresh') === '1'
      || req.nextUrl.searchParams.get('force') === '1';
    if (force) clearXaiUsageCache();

    const cfg = await loadConfig();
    const defaultModel = cfg.defaultGrokModel?.trim() || 'cloud:grok-4';
    const [summary, xaiAccount] = await Promise.all([
      getUsageSummary(defaultModel),
      fetchXaiAccountUsage({ force, days: 30 }),
    ]);

    // Prefer xAI month-to-date for the "authoritative" cost badge consumers.
    const authoritativeCostUsd = xaiAccount.available && xaiAccount.monthToDateCostUsd != null
      ? xaiAccount.monthToDateCostUsd
      : summary.estimatedCostUsd;

    return NextResponse.json({
      ok: true,
      ...summary,
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
