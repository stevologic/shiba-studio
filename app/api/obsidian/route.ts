import { NextRequest, NextResponse } from 'next/server';
import { getIntegrationCreds, obsidianWriteNote } from '@/lib/integrations';
import { loadConfig } from '@/lib/persistence';

/** Create/overwrite an Obsidian note — used by Grok Chat's /note command.
 *  (Agents use the obsidian_write tool; this covers the chat path.) */
export async function POST(req: NextRequest) {
  try {
    // Config load hydrates integration creds server-side (decrypted in memory).
    await loadConfig();
    const body = await req.json();
    const path = String(body.path || '').trim();
    const content = String(body.content || '');
    if (!path) return NextResponse.json({ ok: false, error: 'Note path required — /note <path> | <content>' }, { status: 400 });
    if (path.includes('..')) return NextResponse.json({ ok: false, error: 'Note path may not contain ".."' }, { status: 400 });

    const creds = getIntegrationCreds();
    const configured = creds.obsidian?.vaultPath?.trim() || (creds.obsidian?.restApiUrl?.trim() && creds.obsidian?.restApiKey?.trim());
    if (!configured) {
      return NextResponse.json({ ok: false, error: 'Obsidian is not configured — set the vault on the Capabilities page.' }, { status: 400 });
    }

    const notePath = path.endsWith('.md') ? path : `${path}.md`;
    await obsidianWriteNote(creds, notePath, content);
    const { audit } = await import('@/lib/audit-log');
    audit('integration', 'obsidian note created', notePath, { via: 'chat' });
    return NextResponse.json({ ok: true, path: notePath });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'note creation failed' }, { status: 500 });
  }
}
