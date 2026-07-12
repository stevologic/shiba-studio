import { NextRequest, NextResponse } from 'next/server';
import { loadConfig, saveConfig } from '@/lib/persistence';
import { getOAuthPublicStatus, resolveCloudBearer } from '@/lib/xai-oauth';
import { secretKeyLocation } from '@/lib/secure-store';
import { maskIntegrationCreds, maskSecret } from '@/lib/secret-mask';
import type { CloudAuthMode } from '@/lib/types';

export async function GET() {
  const cfg = await loadConfig();
  const oauth = await getOAuthPublicStatus();
  const auth = await resolveCloudBearer(cfg);
  const { isGoogleClientReady, bundledGoogleClient } = await import('@/lib/google-oauth');
  const safe = {
    ...cfg,
    // Full secrets never reach the browser: keys go out as partial
    // fingerprints, integrations through the same deep-masking helper.
    xaiApiKey: maskSecret(cfg.xaiApiKey || ''),
    xaiManagementKey: maskSecret(cfg.xaiManagementKey || ''),
    integrations: maskIntegrationCreds(cfg.integrations || {}),
    hasKey: !!cfg.xaiApiKey,
    hasManagementKey: !!cfg.xaiManagementKey?.trim(),
    hasOAuth: oauth.connected,
    hasCloudAuth: auth.hasCloudAuth,
    cloudAuthMode: (cfg.cloudAuthMode || 'api_key') as CloudAuthMode,
    activeCloudSource: auth.source,
    oauthStatus: oauth,
    secretKeyLocation: secretKeyLocation(),
    // Google Drive sign-in is available if a client exists (bundled env default
    // or a per-user one); `driveBundledClient` = the zero-setup env default.
    driveClientReady: await isGoogleClientReady(),
    driveBundledClient: !!bundledGoogleClient(),
  };
  return NextResponse.json(safe);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  // Action requests (testLocalGrok, testManagementKey) are read-only probes —
  // they carry config keys (e.g. localGrokBaseUrl) but never write, so they
  // must not audit as "settings updated" (they used to spam the log on every
  // page load via the silent local-models probe).
  const changedKeys = body.action ? [] : [
    'xaiApiKey', 'xaiManagementKey', 'cloudAuthMode', 'defaultWorkspace', 'defaultGrokModel',
    'defaultTtsVoice', 'defaultTtsSpeed',
    'localGrokEnabled', 'localGrokBaseUrl', 'localModelAllowlist', 'toolApprovalMode',
    'disabledTools', 'globalInstructions', 'useAgentsMd', 'usageBudgetUsd',
    'dailyBudgetUsd', 'budgetHardStop', 'maxConcurrentRuns', 'perRunTokenCap',
    'runRetentionDays', 'auditRetentionDays', 'sandboxMemoryMb', 'sandboxCpus',
  ].filter((k) => body[k] !== undefined);
  if (changedKeys.length) {
    const { audit } = await import('@/lib/audit-log');
    audit('config', 'settings updated', changedKeys.join(', '));
  }
  if (body.xaiApiKey !== undefined) {
    const cfg = await saveConfig({ xaiApiKey: body.xaiApiKey });
    const auth = await resolveCloudBearer(cfg);
    return NextResponse.json({ ok: true, hasKey: !!cfg.xaiApiKey, hasCloudAuth: auth.hasCloudAuth });
  }
  if (body.xaiManagementKey !== undefined) {
    const cfg = await saveConfig({ xaiManagementKey: String(body.xaiManagementKey || '') });
    try {
      const { clearXaiUsageCache } = await import('@/lib/xai-billing-usage');
      clearXaiUsageCache();
    } catch { /* */ }
    try {
      const { clearNavUsageCostCache } = await import('@/lib/nav-stats');
      clearNavUsageCostCache();
    } catch { /* */ }
    return NextResponse.json({
      ok: true,
      hasManagementKey: !!cfg.xaiManagementKey?.trim(),
    });
  }
  if (body.cloudAuthMode === 'api_key' || body.cloudAuthMode === 'oauth') {
    const cfg = await saveConfig({ cloudAuthMode: body.cloudAuthMode });
    const auth = await resolveCloudBearer(cfg);
    return NextResponse.json({
      ok: true,
      cloudAuthMode: cfg.cloudAuthMode,
      activeCloudSource: auth.source,
      hasCloudAuth: auth.hasCloudAuth,
    });
  }
  if (body.defaultWorkspace) {
    await saveConfig({ defaultWorkspace: body.defaultWorkspace });
  }
  if (body.defaultGrokModel !== undefined) {
    const cfg = await saveConfig({ defaultGrokModel: String(body.defaultGrokModel || '') });
    return NextResponse.json({ ok: true, defaultGrokModel: cfg.defaultGrokModel });
  }
  if (body.defaultTtsVoice !== undefined || body.defaultTtsSpeed !== undefined) {
    const partial: { defaultTtsVoice?: string; defaultTtsSpeed?: number } = {};
    if (body.defaultTtsVoice !== undefined) {
      partial.defaultTtsVoice = String(body.defaultTtsVoice || '').trim().toLowerCase() || '';
    }
    if (body.defaultTtsSpeed !== undefined) {
      const n = Number(body.defaultTtsSpeed);
      // Clamp to xAI TTS range without importing client-only helpers here.
      partial.defaultTtsSpeed = Number.isFinite(n)
        ? Math.min(1.5, Math.max(0.7, Math.round(n * 100) / 100))
        : 1;
    }
    const cfg = await saveConfig(partial);
    return NextResponse.json({
      ok: true,
      defaultTtsVoice: cfg.defaultTtsVoice || '',
      defaultTtsSpeed: cfg.defaultTtsSpeed ?? 1,
    });
  }
  // Cost & safety guardrails + retention — saved as one group so the Settings
  // card can submit them together (each field remains individually optional).
  if (
    body.usageBudgetUsd !== undefined
    || body.dailyBudgetUsd !== undefined
    || body.budgetHardStop !== undefined
    || body.maxConcurrentRuns !== undefined
    || body.perRunTokenCap !== undefined
    || body.runRetentionDays !== undefined
    || body.auditRetentionDays !== undefined
    || body.usageCostSource !== undefined
    || body.sandboxMemoryMb !== undefined
    || body.sandboxCpus !== undefined
  ) {
    const nonNeg = (v: unknown) => Math.max(0, Number(v) || 0);
    if (body.usageCostSource !== undefined) {
      // Nav quota badge re-resolves its source on next load.
      try {
        const { clearNavUsageCostCache } = await import('@/lib/nav-stats');
        clearNavUsageCostCache();
      } catch { /* cache clear is best-effort */ }
    }
    const cfg = await saveConfig({
      ...(body.usageCostSource === 'auto' || body.usageCostSource === 'xai' || body.usageCostSource === 'local'
        ? { usageCostSource: body.usageCostSource }
        : {}),
      ...(body.usageBudgetUsd !== undefined ? { usageBudgetUsd: nonNeg(body.usageBudgetUsd) } : {}),
      ...(body.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: nonNeg(body.dailyBudgetUsd) } : {}),
      ...(body.budgetHardStop !== undefined ? { budgetHardStop: !!body.budgetHardStop } : {}),
      ...(body.maxConcurrentRuns !== undefined
        ? { maxConcurrentRuns: Math.min(20, Math.max(1, Math.floor(Number(body.maxConcurrentRuns) || 3))) }
        : {}),
      ...(body.perRunTokenCap !== undefined ? { perRunTokenCap: Math.floor(nonNeg(body.perRunTokenCap)) } : {}),
      ...(body.runRetentionDays !== undefined ? { runRetentionDays: Math.floor(nonNeg(body.runRetentionDays)) } : {}),
      ...(body.auditRetentionDays !== undefined ? { auditRetentionDays: Math.floor(nonNeg(body.auditRetentionDays)) } : {}),
      // Sandbox limits: 0/empty = back to defaults (512 MB / 1 CPU). Clamps
      // mirror lib/agent-sandbox.ts; existing containers reconcile on next use.
      ...(body.sandboxMemoryMb !== undefined
        ? await import('@/lib/agent-sandbox').then(({ clampSandboxMemoryMb }) => ({ sandboxMemoryMb: clampSandboxMemoryMb(body.sandboxMemoryMb) }))
        : {}),
      ...(body.sandboxCpus !== undefined
        ? await import('@/lib/agent-sandbox').then(({ clampSandboxCpus }) => ({ sandboxCpus: clampSandboxCpus(body.sandboxCpus) }))
        : {}),
    });
    return NextResponse.json({
      ok: true,
      usageBudgetUsd: cfg.usageBudgetUsd,
      dailyBudgetUsd: cfg.dailyBudgetUsd,
      budgetHardStop: cfg.budgetHardStop,
      maxConcurrentRuns: cfg.maxConcurrentRuns,
      perRunTokenCap: cfg.perRunTokenCap,
      runRetentionDays: cfg.runRetentionDays,
      auditRetentionDays: cfg.auditRetentionDays,
      sandboxMemoryMb: cfg.sandboxMemoryMb,
      sandboxCpus: cfg.sandboxCpus,
    });
  }
  if (body.localModelAllowlist !== undefined) {
    const allowlist = Array.isArray(body.localModelAllowlist)
      ? body.localModelAllowlist.map((m: unknown) => String(m).trim()).filter(Boolean)
      : [];
    const cfg = await saveConfig({ localModelAllowlist: allowlist });
    return NextResponse.json({ ok: true, localModelAllowlist: cfg.localModelAllowlist });
  }
  // Must run before the settings-save branch below: the test request carries
  // localGrokBaseUrl but must never write config (it used to coerce
  // localGrokEnabled to false via !!undefined).
  if (body.action === 'testLocalGrok') {
    const { listLocalGrokModels } = await import('@/lib/grok-client');
    const base = body.localGrokBaseUrl as string | undefined;
    const r = await listLocalGrokModels(base);
    return NextResponse.json({ ok: r.ok, models: r.models, error: r.error });
  }
  // Probe management-api.x.ai with a pasted key or the saved management key.
  if (body.action === 'testManagementKey') {
    const { validateManagementKey } = await import('@/lib/xai-billing-usage');
    const key = typeof body.key === 'string' ? body.key : undefined;
    const result = await validateManagementKey({ key });
    return NextResponse.json(result);
  }
  if (body.localGrokEnabled !== undefined || body.localGrokBaseUrl !== undefined) {
    const cfg = await saveConfig({
      localGrokEnabled: !!body.localGrokEnabled,
      localGrokBaseUrl: body.localGrokBaseUrl ? String(body.localGrokBaseUrl) : undefined,
    });
    return NextResponse.json({
      ok: true,
      localGrokEnabled: cfg.localGrokEnabled,
      localGrokBaseUrl: cfg.localGrokBaseUrl,
    });
  }
  if (
    body.toolApprovalMode !== undefined
    || body.globalInstructions !== undefined
    || body.useAgentsMd !== undefined
  ) {
    const cfg = await saveConfig({
      ...(body.toolApprovalMode === 'ask' || body.toolApprovalMode === 'yolo'
        ? { toolApprovalMode: body.toolApprovalMode }
        : {}),
      ...(body.globalInstructions !== undefined ? { globalInstructions: String(body.globalInstructions) } : {}),
      ...(body.useAgentsMd !== undefined ? { useAgentsMd: !!body.useAgentsMd } : {}),
    });
    return NextResponse.json({
      ok: true,
      toolApprovalMode: cfg.toolApprovalMode,
      globalInstructions: cfg.globalInstructions,
      useAgentsMd: cfg.useAgentsMd,
    });
  }
  return NextResponse.json({ ok: true });
}