import './verify-isolate';
import assert from 'node:assert/strict';
import {
  getAvatarPath,
  imagineAvatarRef,
  isImagineAvatarId,
  isValidAvatarId,
  parseImagineAvatarId,
  resolveAgentAvatarPath,
} from '../lib/agent-avatars';
import { readImagineAvatar, saveImagineAvatar } from '../lib/agent-avatar-store';
import {
  buildAvatarImaginePrompt,
  generateXaiImage,
  XAI_IMAGINE_IMAGE_MODEL,
} from '../lib/agent-power-tools';

const JPEG_STUB = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP///w==', 'base64');

async function main() {
  assert.equal(isValidAvatarId('alien-01'), true);
  assert.equal(isValidAvatarId('alien-99'), false);
  assert.equal(parseImagineAvatarId('imagine:not-a-uuid'), null);
  assert.equal(parseImagineAvatarId('imagine:../etc/passwd'), null);
  assert.equal(parseImagineAvatarId('imagine:'), null);
  const fileId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const ref = imagineAvatarRef(fileId);
  assert.equal(ref, `imagine:${fileId}`);
  assert.equal(isImagineAvatarId(ref), true);
  assert.equal(isValidAvatarId(ref), true);
  assert.equal(getAvatarPath(ref), `/api/agent-avatars/${fileId}`);
  assert.equal(
    resolveAgentAvatarPath({ id: 'agent-1', avatar: ref }),
    `/api/agent-avatars/${fileId}`,
  );
  assert.equal(resolveAgentAvatarPath({ id: 'agent-1', avatar: 'alien-02' }), '/avatars/alien-02.svg');
  assert.match(resolveAgentAvatarPath({ id: 'agent-1' }), /^\/avatars\/alien-\d{2}\.svg$/);

  assert.match(buildAvatarImaginePrompt({ prompt: 'a fox in a flight jacket' }), /a fox in a flight jacket/);
  assert.match(buildAvatarImaginePrompt({ name: 'Scout' }), /Scout/);
  assert.equal(XAI_IMAGINE_IMAGE_MODEL, 'grok-imagine-image-1.5');

  const stored = await saveImagineAvatar(JPEG_STUB, 'image/jpeg');
  assert.match(stored.avatarId, /^imagine:[0-9a-f-]{36}$/);
  const parsed = parseImagineAvatarId(stored.avatarId);
  assert.ok(parsed);
  const read = await readImagineAvatar(parsed!);
  assert.ok(read);
  assert.equal(read!.bytes.equals(JPEG_STUB), true);
  assert.equal(await readImagineAvatar('../secret'), null);
  assert.equal(await readImagineAvatar('not-uuid'), null);

  const originalFetch = globalThis.fetch;
  const attempted: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model?: string };
    attempted.push(String(body.model || ''));
    if (body.model !== 'grok-imagine-image') {
      return new Response(JSON.stringify({ error: 'model_not_found' }), { status: 404 });
    }
    return new Response(JSON.stringify({
      data: [{ b64_json: JPEG_STUB.toString('base64'), mime_type: 'image/jpeg' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const generated = await generateXaiImage('a fox', 'test-token', { aspectRatio: '1:1' });
    assert.equal(generated.model, 'grok-imagine-image');
    assert.ok(attempted[0] === 'grok-imagine-image-1.5', 'tries Imagine 1.5 first');
    assert.ok(attempted.includes('grok-imagine-image'), 'falls back to grok-imagine-image');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const { GET } = await import('../app/api/agent-avatars/[id]/route');
  const missing = await GET(new Request('http://localhost/api/agent-avatars/nope'), {
    params: Promise.resolve({ id: 'nope' }),
  });
  assert.equal(missing.status, 404);
  const traversal = await GET(new Request('http://localhost/api/agent-avatars/..%2Fsecret'), {
    params: Promise.resolve({ id: '../secret' }),
  });
  assert.equal(traversal.status, 404);
  const served = await GET(new Request(`http://localhost/api/agent-avatars/${parsed}`), {
    params: Promise.resolve({ id: parsed! }),
  });
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') || '', /image\/jpeg/);

  console.log('PASS: Imagine avatars, store isolation, and model fallback');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
