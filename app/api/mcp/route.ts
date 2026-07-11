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

/** Env values under secret-looking keys go to the browser as fingerprints only. */
async function maskServerEnv<T extends { env?: Record<string, string> }>(server: T): Promise<T> {
  if (!server?.env) return server;
  const { isSecretFieldName, maskSecret } = await import('@/lib/secret-mask');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.env)) {
    env[k] = typeof v === 'string' && v && isSecretFieldName(k) ? maskSecret(v) : v;
  }
  return { ...server, env };
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const server = await getMcpServer(id);
    if (!server) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true, server: await maskServerEnv(server) });
  }
  const [servers, presets] = await Promise.all([listMcpServers(), Promise.resolve(listMcpPresets())]);
  return NextResponse.json({ ok: true, servers: await Promise.all(servers.map(maskServerEnv)), presets });
}

/**
 * The browser only ever holds masked credential fingerprints (see
 * lib/secret-mask) — a masked value arriving here means "use the stored
 * secret". Empty preset fields fall back server-side (buildServerFromPreset);
 * env maps get the stored GitHub token substituted, other masked entries
 * keep the previously saved value (or are dropped for new servers).
 */
async function sanitizeIncomingEnv(
  env: Record<string, string> | undefined,
  existingEnv?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  if (!env || typeof env !== 'object') return env;
  const { isMaskedSecret } = await import('@/lib/secret-mask');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isMaskedSecret(v)) { out[k] = v; continue; }
    if (k === 'GITHUB_PERSONAL_ACCESS_TOKEN') {
      const cfg = await loadConfig();
      const stored = cfg.integrations?.github?.token;
      if (stored) { out[k] = stored; continue; }
    }
    if (existingEnv && typeof existingEnv[k] === 'string') out[k] = existingEnv[k];
    // else: masked value with nothing stored — drop it rather than save a mask.
  }
  return out;
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (body.action === 'addPreset') {
    const cfg = await loadConfig();
    const { isMaskedSecret } = await import('@/lib/secret-mask');
    // Masked field values mean "unchanged" — blank them so preset defaults
    // (e.g. the stored GitHub token) fill in server-side.
    const fieldValues: Record<string, string> = { ...(body.fieldValues || {}) };
    for (const [k, v] of Object.entries(fieldValues)) {
      if (isMaskedSecret(v)) fieldValues[k] = '';
    }
    const server = await addMcpServerFromPreset(body.presetId, fieldValues, {
      workspacePath: cfg.defaultWorkspace,
      githubToken: cfg.integrations?.github?.token,
    });
    return NextResponse.json({ ok: true, server: await maskServerEnv(server) });
  }

  if (body.action === 'addCustom') {
    const server = await addCustomMcpServer({
      name: body.name,
      command: body.command,
      args: body.args,
      env: await sanitizeIncomingEnv(body.env),
      notes: body.notes,
    });
    return NextResponse.json({ ok: true, server: await maskServerEnv(server) });
  }

  if (body.action === 'update') {
    const existing = await getMcpServer(body.id);
    const server = await updateMcpServer(body.id, {
      name: body.name,
      enabled: body.enabled,
      command: body.command,
      args: body.args,
      env: await sanitizeIncomingEnv(body.env, existing?.env),
      notes: body.notes,
    });
    return NextResponse.json({ ok: true, server: await maskServerEnv(server) });
  }

  if (body.action === 'toggle') {
    const existing = await getMcpServer(body.id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const server = await updateMcpServer(body.id, { enabled: body.enabled ?? !existing.enabled });
    return NextResponse.json({ ok: true, server: await maskServerEnv(server) });
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