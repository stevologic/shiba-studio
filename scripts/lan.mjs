#!/usr/bin/env node
// LAN launcher and security boundary.
//
// Next itself listens only on a randomly assigned loopback port. This outer
// HTTP server is the only listener bound to the LAN. It classifies each client
// from the TCP peer address (never Host/X-Forwarded-*), removes any
// client-supplied classification, and adds a per-process authenticated header
// for proxy.ts. HTTP streaming and WebSocket upgrades (including local HMR)
// are forwarded without buffering.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLIENT_CLASS_HEADER = 'x-shiba-client-class';
export const PROXY_SECRET_HEADER = 'x-shiba-lan-proxy-secret';

const LOOPBACK_HOST = '127.0.0.1';
const PUBLIC_HOST = '0.0.0.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverSockets = new WeakMap();

/** Classify only the actual TCP peer. Host and forwarding headers are inert. */
export function classifyClientAddress(remoteAddress) {
  const address = String(remoteAddress || '').trim().toLowerCase().split('%')[0];
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return 'local';
  if (address.startsWith('::ffff:')) return classifyClientAddress(address.slice(7));
  if (/^127(?:\.\d{1,3}){3}$/.test(address)) return 'local';
  return 'remote';
}

/** Companion/native-node traffic is HTTP-only; upgrade channels stay local. */
export function allowLanUpgrade(remoteAddress) {
  return classifyClientAddress(remoteAddress) === 'local';
}

/**
 * Build upstream headers from an untrusted client request. Exported so the
 * security verifier can prove that hostile headers are overwritten.
 */
export function buildUpstreamHeaders(headers, remoteAddress, secret) {
  const forwarded = { ...headers };
  delete forwarded[CLIENT_CLASS_HEADER];
  delete forwarded[PROXY_SECRET_HEADER];
  delete forwarded['x-forwarded-for'];
  delete forwarded['x-forwarded-host'];
  delete forwarded['x-forwarded-proto'];

  const host = typeof forwarded.host === 'string' ? forwarded.host : '';
  forwarded[CLIENT_CLASS_HEADER] = classifyClientAddress(remoteAddress);
  forwarded[PROXY_SECRET_HEADER] = secret;
  forwarded['x-forwarded-for'] = String(remoteAddress || 'unknown');
  forwarded['x-forwarded-host'] = host;
  forwarded['x-forwarded-proto'] = 'http';
  return forwarded;
}

function writeUpgradeResponse(socket, response) {
  const status = `HTTP/${response.httpVersion} ${response.statusCode || 502} ${response.statusMessage || ''}\r\n`;
  const rawHeaders = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    rawHeaders.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
  }
  socket.write(`${status}${rawHeaders.join('\r\n')}\r\n\r\n`);
}

/** Create the public reverse proxy. The caller controls when it starts. */
export function createLanProxyServer({ internalPort, secret }) {
  const server = http.createServer((request, response) => {
    const headers = buildUpstreamHeaders(request.headers, request.socket.remoteAddress, secret);
    const upstream = http.request({
      host: LOOPBACK_HOST,
      port: internalPort,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      if (upstreamResponse.statusMessage) {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      } else {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      }
      upstreamResponse.pipe(response);
    });

    upstream.on('error', () => {
      if (!response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      response.end('Shiba Studio is starting or unavailable.');
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  const sockets = new Set();
  serverSockets.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (request, clientSocket, clientHead) => {
    if (!allowLanUpgrade(request.socket.remoteAddress)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n');
      return;
    }
    const headers = buildUpstreamHeaders(request.headers, request.socket.remoteAddress, secret);
    headers.connection = 'Upgrade';
    headers.upgrade = request.headers.upgrade || 'websocket';

    const upstream = http.request({
      host: LOOPBACK_HOST,
      port: internalPort,
      method: request.method,
      path: request.url,
      headers,
    });

    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      writeUpgradeResponse(clientSocket, upstreamResponse);
      if (upstreamHead.length) clientSocket.write(upstreamHead);
      if (clientHead.length) upstreamSocket.write(clientHead);
      clientSocket.once('close', () => upstreamSocket.destroy());
      upstreamSocket.once('close', () => clientSocket.destroy());
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });
    upstream.on('response', (upstreamResponse) => {
      writeUpgradeResponse(clientSocket, upstreamResponse);
      upstreamResponse.pipe(clientSocket);
    });
    upstream.on('error', () => {
      if (clientSocket.writable) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
    });
    clientSocket.on('error', () => upstream.destroy());
    upstream.end();
  });

  return server;
}

/** Stop accepting requests and close HTTP keep-alive and upgraded sockets. */
export function closeLanProxyServer(server, callback = () => {}) {
  server.close(callback);
  for (const socket of serverSockets.get(server) || []) socket.destroy();
  server.closeAllConnections?.();
}

export function parsePublicPort(args, env) {
  let value = env.PORT || '3000';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-p' || arg === '--port') value = args[index + 1];
    else if (arg.startsWith('--port=')) value = arg.slice('--port='.length);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid LAN port: ${value}`);
  }
  return port;
}

export function nextPassthroughArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-p' || arg === '--port' || arg === '-H' || arg === '--hostname') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--port=') || arg.startsWith('--hostname=')) continue;
    result.push(arg);
  }
  return result;
}

function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.unref();
    reservation.once('error', reject);
    reservation.listen(0, LOOPBACK_HOST, () => {
      const address = reservation.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      reservation.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function main() {
  const mode = process.argv[2] === 'start' ? 'start' : 'dev';
  const userArgs = process.argv.slice(3);
  const publicPort = parsePublicPort(userArgs, process.env);
  const internalPort = await findFreeLoopbackPort();
  const secret = randomBytes(32).toString('base64url');
  const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  const server = createLanProxyServer({ internalPort, secret });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(publicPort, PUBLIC_HOST, resolve);
  });

  const child = spawn(process.execPath, [
    nextBin,
    mode,
    '-H', LOOPBACK_HOST,
    '-p', String(internalPort),
    ...nextPassthroughArgs(userArgs),
  ], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      SHIBA_LAN: '1',
      SHIBA_APP_PORT: String(publicPort),
      SHIBA_INTERNAL_PORT: String(internalPort),
      SHIBA_LAN_PROXY_SECRET: secret,
    },
  });

  console.log(`[shiba-studio] LAN boundary listening on http://${PUBLIC_HOST}:${publicPort}; Next is loopback-only on ${LOOPBACK_HOST}:${internalPort}`);

  let closing = false;
  const close = (exitCode, signal) => {
    if (closing) return;
    closing = true;
    if (signal && !child.killed) child.kill(signal);
    closeLanProxyServer(server, () => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 2_000).unref();
  };
  process.once('SIGINT', () => close(130, 'SIGINT'));
  process.once('SIGTERM', () => close(143, 'SIGTERM'));
  child.once('error', (error) => {
    console.error('[shiba-studio] could not launch Next:', error.message);
    close(1);
  });
  child.once('exit', (code, signal) => {
    close(code ?? (signal ? 1 : 0));
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error('[shiba-studio] LAN launch failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
