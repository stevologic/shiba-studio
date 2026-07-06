import { NextResponse } from 'next/server';
import { detectGrokCli, listGrokCliModels } from '@/lib/grok-cli';

export async function GET() {
  const status = await detectGrokCli();
  const cliModels = status.installed ? await listGrokCliModels() : { models: [] };
  return NextResponse.json({
    ok: true,
    ...status,
    models: cliModels.models,
    defaultModel: cliModels.defaultModel,
  });
}
