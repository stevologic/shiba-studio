import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/persistence';
import { listAllSelectableModels, setApiKey } from '@/lib/grok-client';
import { resolveCloudBearer } from '@/lib/xai-oauth';

export async function GET() {
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (auth.token) setApiKey(auth.token);

  const result = await listAllSelectableModels(cfg);
  if (!result.ok) {
    // Always 200 so the client can read the JSON body without browser console 502 noise.
    return NextResponse.json({
      ok: false,
      models: [],
      error: result.cloudError || result.localError || 'No models available',
      cloudError: result.cloudError,
      localError: result.localError,
      hasCloudAuth: result.hasCloudAuth,
      localEnabled: result.localEnabled,
      localReachable: result.localReachable,
    });
  }

  return NextResponse.json({
    ok: true,
    models: result.models,
    hasCloudAuth: result.hasCloudAuth,
    localEnabled: result.localEnabled,
    localReachable: result.localReachable,
    cloudError: result.cloudError,
    localError: result.localError,
  });
}