import { NextRequest } from 'next/server';
import {
  activateCapabilityPackProposal,
  exportCapabilityPack,
  instantiateCapabilityPackRoutine,
  listCapabilityPackProposals,
  listCapabilityPacks,
  proposeCapabilityPackFromFolder,
  proposeCapabilityPackFromRun,
  proposeCapabilityPackFromUrl,
  proposeCapabilityPackManifest,
  rejectCapabilityPackProposal,
  rollbackCapabilityPack,
  uninstallCapabilityPack,
  updateCapabilityPackMetadata,
} from '@/lib/capability-packs';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    const exportId = query.get('export');
    if (exportId) {
      const manifest = exportCapabilityPack(exportId, query.get('version') || undefined);
      return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${manifest.id}-${manifest.version}.shiba-pack.json"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    const { loadConfig } = await import('@/lib/persistence');
    return Response.json({
      ok: true,
      packs: listCapabilityPacks({ includeArchived: query.get('archived') === '1' }),
      proposals: listCapabilityPackProposals(),
      safeMode: !!(await loadConfig()).safeMode,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Could not list capability packs' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || '');
    if (action === 'propose_manifest') {
      let manifest = body.manifest;
      if (typeof manifest === 'string') manifest = JSON.parse(manifest);
      return Response.json({ ok: true, proposal: await proposeCapabilityPackManifest(manifest) }, { status: 201 });
    }
    if (action === 'propose_run') return Response.json({ ok: true, proposal: await proposeCapabilityPackFromRun(String(body.runId || '')) }, { status: 201 });
    if (action === 'propose_url') return Response.json({ ok: true, proposal: await proposeCapabilityPackFromUrl(String(body.url || '')) }, { status: 201 });
    if (action === 'propose_folder') return Response.json({ ok: true, proposal: await proposeCapabilityPackFromFolder(String(body.folder || '')) }, { status: 201 });
    if (action === 'activate') return Response.json({ ok: true, pack: await activateCapabilityPackProposal(String(body.proposalId || ''), Array.isArray(body.approvedPermissionKeys) ? body.approvedPermissionKeys.map(String) : []) });
    if (action === 'reject') return Response.json({ ok: true, proposal: rejectCapabilityPackProposal(String(body.proposalId || '')) });
    if (action === 'uninstall') return Response.json({ ok: true, pack: uninstallCapabilityPack(String(body.packId || '')) });
    if (action === 'rollback') return Response.json({ ok: true, pack: await rollbackCapabilityPack(String(body.packId || ''), String(body.version || '')) });
    if (action === 'metadata') return Response.json({ ok: true, pack: updateCapabilityPackMetadata(String(body.packId || ''), {
      ...(body.pinned === undefined ? {} : { pinned: !!body.pinned }),
      ...(body.archived === undefined ? {} : { archived: !!body.archived }),
      ...(body.enabled === undefined ? {} : { enabled: !!body.enabled }),
    }) });
    if (action === 'instantiate_routine') return Response.json({ ok: true, routine: await instantiateCapabilityPackRoutine(String(body.packId || ''), String(body.templateId || ''), String(body.agentId || '')) }, { status: 201 });
    return Response.json({ ok: false, error: 'Unknown capability pack action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Capability pack action failed';
    return Response.json({ ok: false, error: message }, { status: /not found/i.test(message) ? 404 : /immutable|already/i.test(message) ? 409 : 400 });
  }
}
