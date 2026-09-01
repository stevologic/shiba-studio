import './verify-isolate';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMPTY_INTEGRATION_SCOPE } from '../lib/types';
import { AGENT_INTEGRATION_IDS, getIntegrationMeta } from '../lib/integration-catalog';
import {
  assertGmailMessageId,
  encodeGmailRfc2822,
  parseEmailList,
  parseGmailPayload,
} from '../lib/gmail';
import { GMAIL_SCOPES, parseGoogleOAuthService } from '../lib/google-oauth';

function main() {
  assert.equal(EMPTY_INTEGRATION_SCOPE.gmail, false);
  assert.equal(AGENT_INTEGRATION_IDS.includes('gmail'), true);
  assert.equal(getIntegrationMeta('gmail')?.label, 'Gmail');
  assert.equal(parseGoogleOAuthService('gmail'), 'gmail');
  assert.equal(parseGoogleOAuthService('drive'), 'drive');
  assert.equal(parseGoogleOAuthService('nope'), 'drive');
  assert.ok(GMAIL_SCOPES.some((s) => s.includes('gmail.modify')));

  const runtime = readFileSync(new URL('../lib/agent-runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /if \(scope\.gmail\)/);
  assert.match(runtime, /name: 'gmail_list'/);
  assert.match(runtime, /name: 'gmail_read'/);
  assert.match(runtime, /name: 'gmail_send'/);

  const persistence = readFileSync(new URL('../lib/persistence.ts', import.meta.url), 'utf8');
  assert.match(persistence, /integrations\.gmail\.accessToken/);
  assert.match(persistence, /integrations\.gmail\.refreshToken/);
  const approval = readFileSync(new URL('../lib/tool-approval.ts', import.meta.url), 'utf8');
  assert.match(approval, /gmail_send/);
  const toolsRoute = readFileSync(new URL('../app/api/tools/route.ts', import.meta.url), 'utf8');
  assert.match(toolsRoute, /gmail: true/);

  assert.deepEqual(parseEmailList('Ada <ada@example.com>, bob@example.com'), [
    'Ada <ada@example.com>',
    'bob@example.com',
  ]);
  assert.throws(() => parseEmailList('not-an-email'), /Invalid email address/);
  assert.throws(() => parseEmailList('evil@x.com\r\nBcc: hidden@x.com'), /Invalid email address/);
  assert.equal(assertGmailMessageId('18f2ab-cd'), '18f2ab-cd');
  assert.throws(() => assertGmailMessageId('../secret'), /Invalid Gmail message id/);
  assert.throws(() => assertGmailMessageId('id with space'), /Invalid Gmail message id/);

  const parsed = parseGmailPayload({
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Ada <ada@example.com>' },
      { name: 'To', value: 'bob@example.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Date', value: 'Mon, 1 Jan 2026 00:00:00 +0000' },
    ],
    parts: [
      {
        mimeType: 'text/plain',
        body: { data: Buffer.from('Plain body').toString('base64url') },
      },
      {
        mimeType: 'text/html',
        body: { data: Buffer.from('<p>Ignore me</p>').toString('base64url') },
      },
    ],
  }, { id: 'm1', threadId: 't1', snippet: 'Plain body', labelIds: ['UNREAD', 'INBOX'] });
  assert.equal(parsed.from, 'Ada <ada@example.com>');
  assert.equal(parsed.subject, 'Hello');
  assert.equal(parsed.body, 'Plain body');
  assert.equal(parsed.unread, true);

  const htmlOnly = parseGmailPayload({
    mimeType: 'text/html',
    headers: [{ name: 'Subject', value: 'HTML' }],
    body: { data: Buffer.from('<p>Hi <b>there</b></p>').toString('base64url') },
  }, { id: 'm2', threadId: 't2', snippet: '' });
  assert.match(htmlOnly.body, /Hi there/);

  const raw = encodeGmailRfc2822({
    to: ['bob@example.com'],
    subject: 'Hi\r\nBcc: hidden@evil.com',
    body: 'hello',
  });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /Subject: Hi Bcc: hidden@evil.com/);
  assert.doesNotMatch(decoded, /\nBcc:/);

  console.log('PASS: Gmail catalog, tools, parsing, and address safety');
}

main();
