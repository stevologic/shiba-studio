import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/persistence';
import { driveListFolders, withIntegrationCreds } from '@/lib/integrations';

/** Lists the connected Google Drive's folders — powers the per-agent folder
 *  isolation picker in the agent editor. */
export async function GET() {
  try {
    const cfg = await loadConfig();
    const folders = await withIntegrationCreds(cfg.integrations || {}, () => driveListFolders(200));
    return NextResponse.json({ ok: true, folders });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Could not list Drive folders' },
      { status: 400 },
    );
  }
}
