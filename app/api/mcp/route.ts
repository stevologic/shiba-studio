import { NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '@/lib/persistence';
import {
  addCustomMcpServer,
  addMcpServerFromPreset,
  deleteMcpServer,
  getMcpServer,
  listMcpPresets,
  listMcpServers,
  testMcpServer,
  updateMcpServer,
} from '@/lib/mcp';

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const server = await getMcpServer(id);
    if (!server) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true, server });
  }
  const [servers, presets] = await Promise.all([listMcpServers(), Promise.resolve(listMcpPresets())]);
  return NextResponse.json({ ok: true, servers, presets });
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (body.action === 'addPreset') {
    const cfg = await loadConfig();
    const server = await addMcpServerFromPreset(body.presetId, body.fieldValues || {}, {
      workspacePath: cfg.defaultWorkspace,
      githubToken: cfg.integrations?.github?.token,
    });
    return NextResponse.json({ ok: true, server });
  }

  if (body.action === 'addCustom') {
    const server = await addCustomMcpServer({
      name: body.name,
      command: body.command,
      args: body.args,
      env: body.env,
      notes: body.notes,
    });
    return NextResponse.json({ ok: true, server });
  }

  if (body.action === 'update') {
    const server = await updateMcpServer(body.id, {
      name: body.name,
      enabled: body.enabled,
      command: body.command,
      args: body.args,
      env: body.env,
      notes: body.notes,
    });
    return NextResponse.json({ ok: true, server });
  }

  if (body.action === 'toggle') {
    const existing = await getMcpServer(body.id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const server = await updateMcpServer(body.id, { enabled: body.enabled ?? !existing.enabled });
    return NextResponse.json({ ok: true, server });
  }

  if (body.action === 'delete') {
    await deleteMcpServer(body.id);
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'test') {
    const server = await getMcpServer(body.id);
    if (!server) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const result = await testMcpServer(server);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}