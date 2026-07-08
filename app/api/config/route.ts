import { NextRequest, NextResponse } from 'next/server';
import { loadConfig, saveConfig } from '@/lib/persistence';
import { getOAuthPublicStatus, resolveCloudBearer } from '@/lib/xai-oauth';
import { secretKeyLocation } from '@/lib/secure-store';
import type { CloudAuthMode } from '@/lib/types';

export async function GET() {
  const cfg = await loadConfig();
  const oauth = await getOAuthPublicStatus();
  const auth = await resolveCloudBearer(cfg);
  const { isGoogleClientReady, bundledGoogleClient } = await import('@/lib/google-oauth');
  const safe = {
    ...cfg,
    xaiApiKey: cfg.xaiApiKey ? (cfg.xaiApiKey.slice(0, 6) + '…' + cfg.xaiApiKey.slice(-4)) : '',
    xaiManagementKey: cfg.xaiManagementKey
      ? (cfg.xaiManagementKey.slice(0, 6) + '…' + cfg.xaiManagementKey.slice(-4))
      : '',
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
  const changedKeys = [
    'xaiApiKey', 'xaiManagementKey', 'cloudAuthMode', 'defaultWorkspace', 'defaultGrokModel',
    'localGrokEnabled', 'localGrokBaseUrl', 'localModelAllowlist', 'toolApprovalMode',
    'disabledTools', 'globalInstructions', 'useAgentsMd', 'usageBudgetUsd',
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
  if (body.usageBudgetUsd !== undefined) {
    const budget = Math.max(0, Number(body.usageBudgetUsd) || 0);
    const cfg = await saveConfig({ usageBudgetUsd: budget });
    return NextResponse.json({ ok: true, usageBudgetUsd: cfg.usageBudgetUsd });
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
  const cfg = await loadConfig();
  return NextResponse.json({ ok: true });
}