import { NextResponse } from 'next/server';
import { discoverIdeWorkspaceOptions } from '@/lib/ide-workspace-options';
import type {
  IdeWorkspaceOptionsErrorResponse,
  IdeWorkspaceOptionsResponse,
} from '@/lib/ide-workspace-options-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
} as const;

export async function GET(): Promise<
  NextResponse<IdeWorkspaceOptionsResponse | IdeWorkspaceOptionsErrorResponse>
> {
  try {
    const response = await discoverIdeWorkspaceOptions();
    return NextResponse.json(response, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('[shiba-studio] IDE workspace discovery failed', error);
    return NextResponse.json(
      { ok: false, error: 'Failed to discover IDE workspaces.' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
