import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy.ts';
import {
  CLIENT_CLASS_HEADER,
  LAN_STUDIO_FLAG,
  PROXY_SECRET_HEADER,
  allowLanUpgrade,
  buildUpstreamHeaders,
  classifyClientAddress,
  classifyProxyClientAddress,
  closeLanProxyServer,
  createLanProxyServer,
  isPrivateNetworkAddress,
  nextPassthroughArgs,
  parsePublicPort,
} from './lan.mjs';

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function request(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/headers',
      agent: false,
      headers: { ...headers, Connection: 'close' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.once('error', reject);
    req.end();
  });
}

async function websocketUpgrade(port, secret, requestPath = '/hmr') {
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        'Host: localhost:3000',
        'Connection: Upgrade',
        'Upgrade: websocket',
        `${CLIENT_CLASS_HEADER}: remote`,
        `${PROXY_SECRET_HEADER}: attacker-value`,
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (received.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.setTimeout(3_000, () => {
      socket.destroy();
      reject(new Error('WebSocket upgrade verification timed out'));
    });
  });
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/i);
  assert.match(response, /x-observed-class: local/i);
  assert.match(response, new RegExp(`x-observed-secret: ${secret}`, 'i'));
  return response;
}

async function main() {
  const previousLan = process.env.SHIBA_LAN;
  const previousLanStudio = process.env.SHIBA_LAN_STUDIO;
  const previousLanIp = process.env.SHIBA_LAN_IP;
  const previousSecret = process.env.SHIBA_LAN_PROXY_SECRET;
  const previousMdnsHost = process.env.SHIBA_MDNS_HOST;
  const secret = 'lan-boundary-test-secret-with-enough-entropy';
  process.env.SHIBA_LAN = '1';
  process.env.SHIBA_LAN_STUDIO = '0';
  process.env.SHIBA_LAN_IP = '192.168.1.44';
  process.env.SHIBA_LAN_PROXY_SECRET = secret;
  process.env.SHIBA_MDNS_HOST = 'shiba.local';

  assert.equal(classifyClientAddress('127.0.0.1'), 'local');
  assert.equal(classifyClientAddress('::1'), 'local');
  assert.equal(classifyClientAddress('::ffff:127.21.22.23'), 'local');
  assert.equal(classifyClientAddress('192.168.1.44'), 'remote');
  assert.equal(classifyClientAddress('100.64.10.2'), 'remote');
  assert.equal(classifyClientAddress(undefined), 'remote');
  assert.equal(isPrivateNetworkAddress('10.2.3.4'), true);
  assert.equal(isPrivateNetworkAddress('172.31.2.4'), true);
  assert.equal(isPrivateNetworkAddress('192.168.1.44'), true);
  assert.equal(isPrivateNetworkAddress('100.64.10.2'), true);
  assert.equal(isPrivateNetworkAddress('fd12::4'), true);
  assert.equal(isPrivateNetworkAddress('8.8.8.8'), false);
  assert.equal(classifyProxyClientAddress('192.168.1.44', false), 'remote');
  assert.equal(classifyProxyClientAddress('192.168.1.44', true), 'studio');
  assert.equal(classifyProxyClientAddress('8.8.8.8', true), 'remote');
  assert.equal(allowLanUpgrade('127.0.0.1'), true, 'local HMR/upgrade remains available');
  assert.equal(allowLanUpgrade('192.168.1.44'), false, 'remote upgrade channels are not part of the companion surface');
  assert.equal(allowLanUpgrade('192.168.1.44', true), true, 'private peers get upgrades only in Studio LAN mode');
  assert.equal(allowLanUpgrade('8.8.8.8', true), false, 'public peers never get upgrade channels');
  assert.equal(parsePublicPort([], { PORT: '4123' }), 4123);
  assert.equal(parsePublicPort(['--port', '4321'], { PORT: '4123' }), 4321);
  assert.deepEqual(
    nextPassthroughArgs(['--port', '4321', '--hostname=0.0.0.0', LAN_STUDIO_FLAG, '--webpack']),
    ['--webpack'],
  );

  // Exact attack: a remote TCP peer sends Host: localhost and forged internal
  // headers. The launcher overwrites them from the peer address; proxy denies.
  const remoteHeaders = buildUpstreamHeaders({
    host: 'localhost:3000',
    origin: 'http://localhost:3000',
    [CLIENT_CLASS_HEADER]: 'local',
    [PROXY_SECRET_HEADER]: secret,
    'x-forwarded-for': '127.0.0.1',
  }, '192.168.1.44', secret);
  assert.equal(remoteHeaders.host, 'localhost:3000');
  assert.equal(remoteHeaders[CLIENT_CLASS_HEADER], 'remote');
  assert.equal(remoteHeaders[PROXY_SECRET_HEADER], secret);
  assert.equal(remoteHeaders['x-forwarded-for'], '192.168.1.44');
  const spoofedHostResponse = proxy(new NextRequest('http://localhost:3000/api/tasks', { headers: remoteHeaders }));
  assert.equal(spoofedHostResponse.status, 403, 'remote Host: localhost request must be denied');

  const publicationToken = `sha_${'a'.repeat(43)}`;
  const publicArtifactResponse = proxy(new NextRequest(
    `http://localhost:3000/api/artifact-public/${publicationToken}`,
    { headers: remoteHeaders },
  ));
  assert.equal(publicArtifactResponse.status, 200, 'remote clients may fetch an exact tokenized artifact publication');
  const publicArtifactHeadResponse = proxy(new NextRequest(
    `http://localhost:3000/api/artifact-public/${publicationToken}`,
    { method: 'HEAD', headers: remoteHeaders },
  ));
  assert.equal(publicArtifactHeadResponse.status, 200, 'tokenized artifact publications support remote HEAD requests');
  const malformedPublicationResponse = proxy(new NextRequest(
    'http://localhost:3000/api/artifact-public/not-a-token',
    { headers: remoteHeaders },
  ));
  assert.equal(malformedPublicationResponse.status, 403, 'malformed public artifact URLs stay behind the LAN boundary');
  const publicArtifactPostResponse = proxy(new NextRequest(
    `http://localhost:3000/api/artifact-public/${publicationToken}`,
    { method: 'POST', headers: remoteHeaders },
  ));
  assert.equal(publicArtifactPostResponse.status, 403, 'remote public artifact access must remain read-only');
  const rawArtifactResponse = proxy(new NextRequest(
    'http://localhost:3000/api/artifacts/example/versions/one/raw',
    { headers: remoteHeaders },
  ));
  assert.equal(rawArtifactResponse.status, 403, 'artifact administration and raw storage remain localhost-only');

  const forgedDirectResponse = proxy(new NextRequest('http://localhost:3000/api/tasks', {
    headers: { [CLIENT_CLASS_HEADER]: 'local', [PROXY_SECRET_HEADER]: 'forged' },
  }));
  assert.equal(forgedDirectResponse.status, 403, 'untrusted local classification fails closed');
  const missingClassificationResponse = proxy(new NextRequest('http://localhost:3000/api/tasks'));
  assert.equal(missingClassificationResponse.status, 403, 'missing launcher metadata fails closed');

  const localHeaders = buildUpstreamHeaders({
    host: 'localhost:3000',
    origin: 'http://localhost:3000',
  }, '::ffff:127.0.0.1', secret);
  const localResponse = proxy(new NextRequest('http://localhost:3000/api/tasks', { headers: localHeaders }));
  assert.equal(localResponse.status, 200, 'socket-classified loopback retains the Studio API');

  const rebindingHeaders = buildUpstreamHeaders({
    host: 'evil.example:3000',
    origin: 'http://evil.example:3000',
  }, '127.0.0.1', secret);
  const rebindingResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', { headers: rebindingHeaders }));
  assert.equal(rebindingResponse.status, 421, 'matching arbitrary Host and Origin must not bypass destination validation');

  const wrongLoopbackPort = proxy(new NextRequest('http://localhost:3000/api/tasks', {
    method: 'POST',
    headers: { host: 'localhost:3000', origin: 'http://localhost:4000' },
  }));
  assert.equal(wrongLoopbackPort.status, 403, 'loopback Origin must match the exact destination port');

  // Next may normalize its internal URL to loopback while preserving the mDNS
  // authority in Host. The real same-origin browser request must remain valid,
  // without allowing a different port or an mDNS lookalike through the guard.
  const mdnsHeaders = (origin, secFetchSite = 'same-origin') => buildUpstreamHeaders({
    host: 'shiba.local:3000',
    ...(origin === undefined ? {} : { origin }),
    'sec-fetch-site': secFetchSite,
  }, '127.0.0.1', secret);
  const mdnsSameOriginResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
    method: 'POST',
    headers: mdnsHeaders('http://shiba.local:3000'),
  }));
  assert.equal(mdnsSameOriginResponse.status, 200, 'configured mDNS same-origin requests must be allowed');

  const scopedLanIpHeaders = buildUpstreamHeaders({
    host: '192.168.1.44:3000',
    origin: 'http://192.168.1.44:3000',
    'sec-fetch-site': 'same-origin',
  }, '192.168.1.44', secret);
  const scopedLanIpResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
    method: 'POST',
    headers: scopedLanIpHeaders,
  }));
  assert.equal(scopedLanIpResponse.status, 403, 'Companion-only mode keeps generic Studio APIs closed to LAN IP peers');

  process.env.SHIBA_LAN_STUDIO = '1';
  const studioMdnsHeaders = buildUpstreamHeaders({
    host: 'shiba.local:3000',
    origin: 'http://shiba.local:3000',
    'sec-fetch-site': 'same-origin',
  }, '192.168.1.44', secret, true);
  assert.equal(studioMdnsHeaders[CLIENT_CLASS_HEADER], 'studio');
  const studioPageResponse = proxy(new NextRequest('http://127.0.0.1:3000/settings', { headers: studioMdnsHeaders }));
  assert.equal(studioPageResponse.status, 200, 'private peer can load the full Studio in explicit LAN Studio mode');
  const studioApiResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
    method: 'POST',
    headers: studioMdnsHeaders,
  }));
  assert.equal(studioApiResponse.status, 200, 'private peer can use same-origin Studio APIs in explicit mode');

  const studioIpHeaders = buildUpstreamHeaders({
    host: '192.168.1.44:3000',
    origin: 'http://192.168.1.44:3000',
    'sec-fetch-site': 'same-origin',
  }, '192.168.1.44', secret, true);
  const studioIpResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
    method: 'POST',
    headers: studioIpHeaders,
  }));
  assert.equal(studioIpResponse.status, 200, 'configured LAN IP works when Next normalizes internally to loopback');

  const studioCrossOrigin = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
    method: 'POST',
    headers: { ...studioMdnsHeaders, origin: 'https://evil.example' },
  }));
  assert.equal(studioCrossOrigin.status, 403, 'Studio LAN mode keeps cross-site API requests blocked');

  const forgedStudioResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
    headers: {
      host: 'shiba.local:3000',
      origin: 'http://shiba.local:3000',
      [CLIENT_CLASS_HEADER]: 'studio',
      [PROXY_SECRET_HEADER]: 'forged',
    },
  }));
  assert.equal(forgedStudioResponse.status, 403, 'forged Studio classification cannot cross the LAN boundary');

  const publicStudioHeaders = buildUpstreamHeaders({
    host: 'shiba.local:3000',
    origin: 'http://shiba.local:3000',
  }, '8.8.8.8', secret, true);
  const publicStudioResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', { headers: publicStudioHeaders }));
  assert.equal(publicStudioResponse.status, 403, 'public socket peers remain outside full Studio access');
  process.env.SHIBA_LAN_STUDIO = '0';

  process.env.SHIBA_MDNS_HOST = 'studio';
  const customMdnsSameOriginResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
    method: 'POST',
    headers: buildUpstreamHeaders({
      host: 'studio.local:3000',
      origin: 'http://studio.local:3000',
      'sec-fetch-site': 'same-origin',
    }, '127.0.0.1', secret),
  }));
  assert.equal(customMdnsSameOriginResponse.status, 200, 'a configured bare mDNS alias must normalize and remain allowed');
  process.env.SHIBA_MDNS_HOST = 'shiba.local';

  for (const rejectedOrigin of [
    'http://shiba.local:4000',
    'https://shiba.local:3000',
    'https://evil.example',
    'http://shiba.local.evil.example:3000',
    'http://evil-shiba.local:3000',
    'null',
  ]) {
    const rejectedResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
      method: 'POST',
      headers: mdnsHeaders(rejectedOrigin),
    }));
    assert.equal(rejectedResponse.status, 403, `origin ${rejectedOrigin} must remain denied`);
  }
  const originlessCrossSiteResponse = proxy(new NextRequest('http://127.0.0.1:3000/api/tasks', {
    method: 'POST',
    headers: mdnsHeaders(undefined, 'cross-site'),
  }));
  assert.equal(originlessCrossSiteResponse.status, 403, 'origin-less cross-site requests must remain denied');

  // Exercise real HTTP and upgrade forwarding. Forged metadata is overwritten
  // before either request reaches the loopback upstream.
  let observedUpgradeHeaders;
  let observedUpgradeSocket;
  const upstream = http.createServer((upstreamRequest, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(upstreamRequest.headers));
  });
  upstream.on('upgrade', (upgradeRequest, socket) => {
    observedUpgradeHeaders = upgradeRequest.headers;
    observedUpgradeSocket = socket;
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      `x-observed-class: ${upgradeRequest.headers[CLIENT_CLASS_HEADER]}`,
      `x-observed-secret: ${upgradeRequest.headers[PROXY_SECRET_HEADER]}`,
      '',
      '',
    ].join('\r\n'));
  });
  const upstreamPort = await listen(upstream);
  const front = createLanProxyServer({ internalPort: upstreamPort, secret });
  const frontPort = await listen(front);
  try {
    const observed = await request(frontPort, {
      Host: 'localhost:3000',
      [CLIENT_CLASS_HEADER]: 'remote',
      [PROXY_SECRET_HEADER]: 'attacker-value',
    });
    assert.equal(observed[CLIENT_CLASS_HEADER], 'local');
    assert.equal(observed[PROXY_SECRET_HEADER], secret);
    assert.equal(observed.host, 'localhost:3000');
    await websocketUpgrade(frontPort, secret);
    assert.equal(observedUpgradeHeaders[CLIENT_CLASS_HEADER], 'local');
    assert.equal(observedUpgradeHeaders[PROXY_SECRET_HEADER], secret);
    observedUpgradeSocket?.destroy();
  } finally {
    closeLanProxyServer(front);
    await close(upstream);
  }

  const terminalUpstream = http.createServer();
  terminalUpstream.on('upgrade', (upgradeRequest, socket) => {
    socket.end([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      `x-observed-class: ${upgradeRequest.headers[CLIENT_CLASS_HEADER]}`,
      `x-observed-secret: ${upgradeRequest.headers[PROXY_SECRET_HEADER]}`,
      'x-terminal-upstream: yes',
      '',
      '',
    ].join('\r\n'));
  });
  const terminalPort = await listen(terminalUpstream);
  const internalForTerminalTest = http.createServer();
  const internalForTerminalPort = await listen(internalForTerminalTest);
  const studioFront = createLanProxyServer({
    internalPort: internalForTerminalPort,
    secret,
    studioAccess: true,
    terminalPort,
  });
  const studioFrontPort = await listen(studioFront);
  try {
    const terminalResponse = await websocketUpgrade(studioFrontPort, secret, '/api/terminal/ws');
    assert.match(terminalResponse, /x-terminal-upstream: yes/i, 'terminal upgrade uses the loopback PTY bridge');
  } finally {
    closeLanProxyServer(studioFront);
    await close(internalForTerminalTest);
    await close(terminalUpstream);
  }

  if (previousLan === undefined) delete process.env.SHIBA_LAN;
  else process.env.SHIBA_LAN = previousLan;
  if (previousLanStudio === undefined) delete process.env.SHIBA_LAN_STUDIO;
  else process.env.SHIBA_LAN_STUDIO = previousLanStudio;
  if (previousLanIp === undefined) delete process.env.SHIBA_LAN_IP;
  else process.env.SHIBA_LAN_IP = previousLanIp;
  if (previousSecret === undefined) delete process.env.SHIBA_LAN_PROXY_SECRET;
  else process.env.SHIBA_LAN_PROXY_SECRET = previousSecret;
  if (previousMdnsHost === undefined) delete process.env.SHIBA_MDNS_HOST;
  else process.env.SHIBA_MDNS_HOST = previousMdnsHost;
  console.log('LAN boundary verification passed: socket classification, Host spoof denial, HTTP forwarding, and WebSocket upgrades');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
