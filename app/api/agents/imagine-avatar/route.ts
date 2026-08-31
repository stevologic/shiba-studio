import { NextRequest, NextResponse } from 'next/server';
import { saveImagineAvatar } from '@/lib/agent-avatar-store';
import { buildAvatarImaginePrompt, generateXaiImage } from '@/lib/agent-power-tools';
import { loadConfig } from '@/lib/persistence';
import { resolveCloudBearer } from '@/lib/xai-oauth';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/agents/imagine-avatar
 * Generate a square Grok Imagine portrait and store it as an agent avatar.
 */
export async function POST(req: NextRequest) {
  let body: { prompt?: string; name?: string; description?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const prompt = buildAvatarImaginePrompt({
    prompt: body.prompt,
    name: body.name,
    description: body.description,
  });
  const cfg = await loadConfig();
  const auth = await resolveCloudBearer(cfg);
  if (!auth.token) {
    return NextResponse.json(
      { error: 'Grok Imagine needs cloud xAI credentials (API key or X OAuth) — add them in Settings.' },
      { status: 409 },
    );
  }

  try {
    const generated = await generateXaiImage(prompt, auth.token, {
      aspectRatio: '1:1',
      signal: req.signal,
    });
    const stored = await saveImagineAvatar(Buffer.from(generated.b64, 'base64'), generated.mimeType);
    return NextResponse.json({
      ok: true,
      avatar: stored.avatarId,
      url: stored.url,
      model: generated.model,
      revisedPrompt: generated.revisedPrompt || undefined,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Imagine avatar generation failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
