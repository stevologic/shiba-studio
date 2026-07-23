/**
 * Regression checks for user-facing stream error normalization.
 * Drives the shipped lib/stream-errors helpers (not a reimplementation).
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { formatUserFacingStreamError, isAbortLikeError } from '../lib/stream-errors';

async function main() {
  // Empty / unknown → generic recovery copy.
  assert.match(formatUserFacingStreamError(''), /could not finish/i);
  assert.match(formatUserFacingStreamError(null), /could not finish/i);

  // HTML gateway pages collapse to short friendly text (no raw markup).
  const html504 = '<!DOCTYPE html><html><head></head><body>504 Gateway Timeout</body></html>';
  const friendly504 = formatUserFacingStreamError(html504);
  assert(!/<html/i.test(friendly504), 'HTML is stripped from user-facing text');
  assert.match(friendly504, /timed out/i);

  const html502 = '<html><body>502 Bad Gateway</body></html>';
  assert.match(formatUserFacingStreamError(html502), /502|unavailable/i);

  // Timeout / AbortError family.
  const timeoutErr = new Error('The operation was aborted due to timeout');
  timeoutErr.name = 'TimeoutError';
  assert.match(formatUserFacingStreamError(timeoutErr), /timed out/i);

  const userAbort = new Error('The user aborted a request');
  userAbort.name = 'AbortError';
  assert.equal(formatUserFacingStreamError(userAbort), '', 'user cancel is silent');
  assert.equal(isAbortLikeError(userAbort), true);
  // TimeoutError is abort-like (name check); the stream route still needs
  // req.signal.aborted to quiet-close — timeouts surface as friendly copy.
  assert.equal(isAbortLikeError(timeoutErr), true);
  assert.match(formatUserFacingStreamError(timeoutErr), /timed out/i);

  // Long JSON dumps get clipped, not dumped into the bubble.
  const dump = JSON.stringify({ error: { message: 'rate limit', status: 429, stack: 'x'.repeat(500) } });
  const clipped = formatUserFacingStreamError(dump);
  assert.ok(clipped.length < 400, `expected short message, got ${clipped.length}`);
  assert.ok(!clipped.includes('x'.repeat(100)), 'stack dump must not pass through');

  // Tools used annotation.
  const withTools = formatUserFacingStreamError(new Error('boom'), { toolsUsed: ['web_search', 'web_search'] });
  assert.match(withTools, /web_search/);
  assert.ok((withTools.match(/web_search/g) || []).length === 1, 'tools are deduped');

  // Stream route and client must wire the helper (structural contract on shipped files).
  const root = path.resolve(__dirname, '..');
  const route = await fs.readFile(path.join(root, 'app/api/grok/stream/route.ts'), 'utf8');
  assert(route.includes("from '@/lib/stream-errors'"), 'stream route imports stream-errors');
  assert(route.includes('formatUserFacingStreamError'), 'stream route uses friendly formatter');
  assert(route.includes('let wroteContent = false'), 'wroteContent is hoisted for catch');
  assert(route.includes('const toolsUsed: string[] = []'), 'toolsUsed is hoisted for catch');

  const client = await fs.readFile(path.join(root, 'lib/grok-client.ts'), 'utf8');
  assert(client.includes('COMPLETION_TIMEOUT_MS'), 'completion timeout is named and raised');
  assert(client.includes('900_000') || client.includes('900000'), 'long agentic turns get ≥15 min');

  console.log('verify-stream-errors: OK');
}

main().catch((error) => {
  console.error('verify-stream-errors: FAILED');
  console.error(error);
  process.exit(1);
});
