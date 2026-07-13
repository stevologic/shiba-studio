import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy.ts';
import {
  CLIENT_CLASS_HEADER,
  PROXY_SECRET_HEADER,
  allowLanUpgrade,
  buildUpstreamHeaders,
  classifyClientAddress,
  closeLanProxyServer,
  createLanProxyServer,
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

async function websocketUpgrade(port, secret) {
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write([
        'GET /hmr HTTP/1.1',
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
}

async function main() {
  const previousLan = process.env.SHIBA_LAN;
  const previousSecret = process.env.SHIBA_LAN_PROXY_SECRET;
  const secret = 'lan-boundary-test-secret-with-enough-entropy';
  process.env.SHIBA_LAN = '1';
  process.env.SHIBA_LAN_PROXY_SECRET = secret;

  assert.equal(classifyClientAddress('127.0.0.1'), 'local');
  assert.equal(classifyClientAddress('::1'), 'local');
  assert.equal(classifyClientAddress('::ffff:127.21.22.23'), 'local');
  assert.equal(classifyClientAddress('192.168.1.44'), 'remote');
  assert.equal(classifyClientAddress('100.64.10.2'), 'remote');
  assert.equal(classifyClientAddress(undefined), 'remote');
  assert.equal(allowLanUpgrade('127.0.0.1'), true, 'local HMR/upgrade remains available');
  assert.equal(allowLanUpgrade('192.168.1.44'), false, 'remote upgrade channels are not part of the companion surface');
  assert.equal(parsePublicPort([], { PORT: '4123' }), 4123);
  assert.equal(parsePublicPort(['--port', '4321'], { PORT: '4123' }), 4321);
  assert.deepEqual(
    nextPassthroughArgs(['--port', '4321', '--hostname=0.0.0.0', '--webpack']),
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

  if (previousLan === undefined) delete process.env.SHIBA_LAN;
  else process.env.SHIBA_LAN = previousLan;
  if (previousSecret === undefined) delete process.env.SHIBA_LAN_PROXY_SECRET;
  else process.env.SHIBA_LAN_PROXY_SECRET = previousSecret;
  console.log('LAN boundary verification passed: socket classification, Host spoof denial, HTTP forwarding, and WebSocket upgrades');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
