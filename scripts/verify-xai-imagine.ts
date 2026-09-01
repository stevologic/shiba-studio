/**
 * Drive the shipped Imagine edit + video clients with a mocked fetch.
 * No live api.x.ai. Missing credentials and 401 must fail closed.
 */
import './verify-isolate';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
import {
  XAI_IMAGINE_EDIT_URL,
  XAI_IMAGINE_VIDEO_GET_URL,
  XAI_IMAGINE_VIDEO_URL,
  editXaiImage,
  generateXaiVideo,
  saveEditedImage,
  saveGeneratedVideo,
} from '../lib/xai-imagine';

const LOG = path.join(SCRATCH, 'verify-xai-imagine.log');
const lines: string[] = [];

function log(msg: string) {
  lines.push(msg);
  console.log(msg);
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  log(`XAI_IMAGINE_VERIFY ${new Date().toISOString()}`);

  await assert.rejects(
    () => editXaiImage({ prompt: 'make it blue', image: { url: 'data:image/png;base64,abc' } }, ''),
    /credentials/i,
    'edit fails closed without a bearer',
  );
  await assert.rejects(
    () => generateXaiVideo({ prompt: 'pan out' }, '   '),
    /credentials/i,
    'video fails closed without a bearer',
  );
  log('OK no-token fail-closed');

  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const editFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method || 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });
    if (url === XAI_IMAGINE_EDIT_URL && method === 'POST') {
      const parsed = JSON.parse(body || '{}') as { prompt?: string; image?: { url?: string }; model?: string };
      assert.equal(parsed.prompt, 'turn this into a pencil sketch');
      assert.ok(parsed.image?.url?.startsWith('data:image/png;base64,'), 'edit posts the source image');
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from('edited-bytes').toString('base64'), mime_type: 'image/png' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('unexpected', { status: 404 });
  };

  const edited = await editXaiImage({
    prompt: 'turn this into a pencil sketch',
    image: { url: 'data:image/png;base64,aaa' },
  }, 'xai-test', { fetch: editFetch });
  assert.equal(edited.b64, Buffer.from('edited-bytes').toString('base64'));
  assert.ok(calls.some((c) => c.url === XAI_IMAGINE_EDIT_URL && c.method === 'POST'));
  log('OK edit posts /v1/images/edits');

  const work = path.join(SCRATCH, `imagine-edit-${Date.now()}`);
  const saved = await saveEditedImage(work, edited);
  const disk = await fs.readFile(saved.path);
  assert.equal(disk.toString(), 'edited-bytes');
  log(`OK workspace edit artifact ${path.relative(work, saved.path)}`);

  calls.length = 0;
  const unauthorized: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: String(init?.method || 'GET').toUpperCase() });
    return new Response('nope', { status: 401 });
  };
  await assert.rejects(
    () => editXaiImage({ prompt: 'x', image: { url: 'data:image/png;base64,x' } }, 'xai-test', { fetch: unauthorized }),
    /401/,
    'edit 401 fails closed',
  );
  await assert.rejects(
    () => generateXaiVideo({ prompt: 'x' }, 'xai-test', { fetch: unauthorized, sleep: async () => {}, intervalMs: 0 }),
    /401/,
    'video 401 fails closed without polling',
  );
  assert.equal(
    calls.filter((c) => c.method === 'GET' && c.url.startsWith(`${XAI_IMAGINE_VIDEO_GET_URL}/`)).length,
    0,
  );
  log('OK 401 fail-closed, no poll');

  let polls = 0;
  const videoFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method || 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url === XAI_IMAGINE_VIDEO_URL && method === 'POST') {
      const parsed = JSON.parse(String(init?.body || '{}')) as { prompt?: string; model?: string };
      assert.equal(parsed.prompt, 'water crashes down');
      return new Response(JSON.stringify({ request_id: 'vid_verify_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === `${XAI_IMAGINE_VIDEO_GET_URL}/vid_verify_1`) {
      polls += 1;
      if (polls === 1) {
        return new Response(JSON.stringify({ status: 'pending' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        status: 'done',
        video: { url: 'https://cdn.example.test/out.mp4' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://cdn.example.test/out.mp4') {
      return new Response(Buffer.from('mp4-bytes'), { status: 200 });
    }
    return new Response('unexpected ' + url, { status: 404 });
  };

  calls.length = 0;
  const video = await generateXaiVideo(
    { prompt: 'water crashes down' },
    'xai-test',
    { fetch: videoFetch, sleep: async () => {}, intervalMs: 0, maxWaitMs: 10_000 },
  );
  assert.equal(video.status, 'done');
  assert.equal(video.url, 'https://cdn.example.test/out.mp4');
  assert.ok(calls.some((c) => c.url === XAI_IMAGINE_VIDEO_URL && c.method === 'POST'));
  assert.ok(polls >= 2, 'polls pending then done');
  const artifact = await saveGeneratedVideo(work, video, { fetch: videoFetch });
  assert.equal((await fs.readFile(artifact.path)).toString(), 'mp4-bytes');
  log('OK video POST /v1/videos/generations then poll pending→done');

  await fs.writeFile(LOG, lines.join('\n') + '\n');
  console.log('PASS: xAI Imagine edit + video');
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  console.error(`FAIL: ${msg}`);
  await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await fs.writeFile(LOG, `${lines.join('\n')}\nFAIL: ${msg}\n`).catch(() => {});
  process.exit(1);
});
