import { NextRequest, NextResponse } from 'next/server';
import { checkGrokCliUpdate, detectGrokCli, listGrokCliModels } from '@/lib/grok-cli';

export async function GET(req: NextRequest) {
  const status = await detectGrokCli();
  const cliModels = status.installed ? await listGrokCliModels() : { models: [] };

  // ?checkUpdate=1 → also ask the CLI's release channel for a newer version.
  const update = req.nextUrl.searchParams.get('checkUpdate') === '1' && status.installed
    ? await checkGrokCliUpdate()
    : undefined;

  return NextResponse.json({
    ok: true,
    ...status,
    models: cliModels.models,
    defaultModel: cliModels.defaultModel,
    ...(update ? { update } : {}),
  });
}
