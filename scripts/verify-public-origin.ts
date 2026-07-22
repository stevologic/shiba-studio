import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
import { isAllowedTerminalOrigin } from '../lib/terminal-server';
import {
  parsePublicOrigin,
  publicOriginForRequestHost,
  publicTerminalWebSocketUrlForRequestHost,
} from '../lib/public-origin';

const KEYS = [
  'SHIBA_PUBLIC_ORIGIN',
  'SHIBA_PUBLIC_TERMINAL_PROXY',
  'SHIBA_LAN',
  'SHIBA_LAN_STUDIO',
  'SHIBA_LAN_PROXY_SECRET',
  'SHIBA_MDNS_HOST',
] as const;
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function publicRequest(input: {
  host?: string;
  origin?: string;
  forwardedProto?: string;
  secFetchSite?: string;
} = {}) {
  const headers = new Headers({
    host: input.host || 'studio.example.com',
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.forwardedProto ? { 'x-forwarded-proto': input.forwardedProto } : {}),
    ...(input.secFetchSite ? { 'sec-fetch-site': input.secFetchSite } : {}),
  });
  return proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
    method: 'POST',
    headers,
  }));
}

try {
  assert.equal(parsePublicOrigin(undefined), null);
  assert.equal(parsePublicOrigin(''), null);
  assert.equal(parsePublicOrigin('https://studio.example.com')?.origin, 'https://studio.example.com');
  assert.equal(parsePublicOrigin('http://studio.example.com:8443/')?.origin, 'http://studio.example.com:8443');

  for (const rejected of [
    'ftp://studio.example.com',
    'https://*.example.com',
    'https://user:pass@studio.example.com',
    'https://studio.example.com/path',
    'https://studio.example.com?mode=public',
    'https://studio.example.com#public',
    ' https://studio.example.com',
    'https://studio.example.com ',
    'https://studio.example.com\\path',
    'https://%73tudio.example.com',
    'https://studio.example.com:',
    'https://one.example.com,https://two.example.com',
  ]) {
    assert.throws(() => parsePublicOrigin(rejected), /SHIBA_PUBLIC_ORIGIN/);
  }

  process.env.SHIBA_PUBLIC_ORIGIN = 'https://studio.example.com';
  process.env.SHIBA_MDNS_HOST = 'shiba.local';
  delete process.env.SHIBA_LAN;
  delete process.env.SHIBA_LAN_STUDIO;
  delete process.env.SHIBA_LAN_PROXY_SECRET;
  delete process.env.SHIBA_PUBLIC_TERMINAL_PROXY;

  assert.equal(publicOriginForRequestHost('studio.example.com')?.origin, 'https://studio.example.com');
  assert.equal(publicOriginForRequestHost('STUDIO.EXAMPLE.COM')?.origin, 'https://studio.example.com');
  assert.equal(publicOriginForRequestHost('studio.example.com:444'), null);
  assert.equal(publicOriginForRequestHost('sub.studio.example.com'), null);
  assert.equal(publicOriginForRequestHost('studio.example.com@evil.example'), null);
  assert.equal(publicOriginForRequestHost('%73tudio.example.com'), null);

  assert.equal(
    publicRequest({ origin: 'https://studio.example.com', forwardedProto: 'http' }).status,
    200,
    'the configured scheme wins over an untrusted forwarded protocol',
  );
  assert.equal(
    publicRequest({ origin: 'http://studio.example.com', forwardedProto: 'https' }).status,
    403,
    'a forwarded protocol cannot turn the wrong browser origin into the configured origin',
  );
  assert.equal(
    publicRequest({ host: 'studio.example.com:444', origin: 'https://studio.example.com:444' }).status,
    421,
    'the configured hostname on another port is not trusted',
  );
  assert.equal(
    publicRequest({ host: 'lookalike.studio.example.com', origin: 'https://lookalike.studio.example.com' }).status,
    421,
    'subdomains are not implicitly trusted',
  );
  assert.equal(
    publicRequest({ host: '%73tudio.example.com', origin: 'https://studio.example.com' }).status,
    421,
    'percent-encoded host aliases are not treated as the configured host',
  );
  assert.equal(
    publicRequest({ origin: undefined, secFetchSite: 'cross-site' }).status,
    403,
    'origin-less cross-site requests remain blocked',
  );

  process.env.SHIBA_LAN = '1';
  process.env.SHIBA_LAN_STUDIO = '1';
  assert.equal(
    publicRequest({ origin: 'https://studio.example.com' }).status,
    403,
    'a public origin cannot bypass missing authenticated LAN socket classification',
  );
  delete process.env.SHIBA_LAN;
  delete process.env.SHIBA_LAN_STUDIO;

  assert.equal(publicTerminalWebSocketUrlForRequestHost('studio.example.com'), null);
  assert.equal(isAllowedTerminalOrigin('https://studio.example.com'), false);
  process.env.SHIBA_PUBLIC_TERMINAL_PROXY = '1';
  assert.equal(
    publicTerminalWebSocketUrlForRequestHost('studio.example.com'),
    'wss://studio.example.com/api/terminal/ws',
  );
  assert.equal(isAllowedTerminalOrigin('https://studio.example.com'), true);
  assert.equal(isAllowedTerminalOrigin('http://studio.example.com'), false);
  assert.equal(isAllowedTerminalOrigin('https://studio.example.com:444'), false);
  assert.equal(isAllowedTerminalOrigin('https://sub.studio.example.com'), false);
  assert.equal(isAllowedTerminalOrigin('https://evil.example'), false);

  process.env.SHIBA_PUBLIC_ORIGIN = 'http://studio.example.com:8080';
  assert.equal(
    publicTerminalWebSocketUrlForRequestHost('studio.example.com:8080'),
    'ws://studio.example.com:8080/api/terminal/ws',
  );

  console.log('Public origin verification passed: exact Host/origin enforcement, forwarded-header denial, LAN isolation, OAuth-safe origin, and terminal opt-in');
} finally {
  for (const key of KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
