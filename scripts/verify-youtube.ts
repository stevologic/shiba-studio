/**
 * YouTube catalog, OAuth, id parsing, and shipped tool wiring.
 */
import './verify-isolate';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMPTY_INTEGRATION_SCOPE } from '../lib/types';
import { AGENT_INTEGRATION_IDS, getIntegrationMeta } from '../lib/integration-catalog';
import { parseGoogleOAuthService, YOUTUBE_SCOPES } from '../lib/google-oauth';
import { parseYoutubePrivacy, parseYoutubeVideoId, assertYoutubeUploadPath } from '../lib/youtube';

function main() {
  assert.equal(EMPTY_INTEGRATION_SCOPE.youtube, false);
  assert.equal(AGENT_INTEGRATION_IDS.includes('youtube'), true);
  assert.equal(getIntegrationMeta('youtube')?.label, 'YouTube');
  assert.equal(parseGoogleOAuthService('youtube'), 'youtube');
  assert.ok(YOUTUBE_SCOPES.some((s) => s.includes('youtube.upload')));

  const runtime = readFileSync(new URL('../lib/agent-runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /if \(scope\.youtube\)/);
  assert.match(runtime, /name: 'youtube_search'/);
  assert.match(runtime, /name: 'youtube_list'/);
  assert.match(runtime, /name: 'youtube_get'/);
  assert.match(runtime, /name: 'youtube_upload'/);

  assert.equal(parseYoutubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12'), 'dQw4w9WgXcQ');
  assert.equal(parseYoutubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.throws(() => parseYoutubeVideoId('../secret'), /Invalid YouTube video id/);
  assert.throws(() => parseYoutubeVideoId('not a video'), /Invalid YouTube video id/);
  assert.equal(parseYoutubePrivacy('public'), 'public');
  assert.equal(parseYoutubePrivacy('whatever'), 'unlisted');
  assert.equal(assertYoutubeUploadPath('clip.mp4'), 'clip.mp4');
  assert.throws(() => assertYoutubeUploadPath('notes.txt'), /video file/);

  const ui = readFileSync(new URL('../components/shiba-studio.tsx', import.meta.url), 'utf8');
  assert.match(ui, /integration\.id === 'youtube'/);
  assert.match(ui, /service: 'youtube'/);

  console.log('PASS: YouTube catalog, tools, ids, and OAuth wiring');
}

main();
