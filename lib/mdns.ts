// Minimal multicast-DNS (mDNS / "Bonjour") responder so the app is reachable
// on the local network by name — e.g. http://shiba.local:3000 — instead of an
// IP address. No dependency: static A records answered over UDP multicast
// (224.0.0.251:5353), which is how every host on the network resolves
// `.local` names.
//
// Which address it advertises follows what the server is actually reachable at:
//   • LAN mode  (SHIBA_LAN=1, i.e. `npm run *:lan`, bound to 0.0.0.0)
//                → the machine's LAN IPv4, so the whole network can reach it.
//   • localhost (default, bound to 127.0.0.1)
//                → 127.0.0.1, a convenience alias for this machine only.
//
// Disable with SHIBA_MDNS=off. Change the name(s) with SHIBA_MDNS_HOST —
// comma-separated, a bare label gets ".local" appended (default "shiba.local").

import dgram from 'dgram';
import { execFileSync } from 'node:child_process';
import { isIPv4 } from 'node:net';
import os, { type NetworkInterfaceInfo } from 'node:os';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const TTL_SECONDS = 120;

interface MdnsGlobals {
  __shibaMdns?: { socket: dgram.Socket; hostnames: string[]; ip: string } | null;
}
const g = globalThis as unknown as MdnsGlobals;

type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

function interfaceNameRank(name: string): number {
  if (/virtual|host-only|vmware|vbox|docker|wsl|hyper-v|vethernet|tailscale|zerotier|hamachi|vpn|tun|tap|utun|bridge|bluetooth/i.test(name)) return 3;
  if (/wi-?fi|wireless|wlan|ethernet|local area connection|^(eth|en\d|eno|enp|ens|wlp)/i.test(name)) return 0;
  return 1;
}

function ipv4RangeRank(address: string): number {
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) return 0;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 1;
  if (address.startsWith('169.254.')) return 3;
  return 2;
}

/** Select a reachable physical-LAN IPv4 instead of a host-only VM adapter. */
export function selectPrimaryLanIPv4(
  ifaces: NetworkInterfaces,
  override?: string,
  defaultRouteAddress?: string | null,
): string | null {
  const configured = override?.trim();
  if (configured && isIPv4(configured)) return configured;
  const candidates: Array<{ address: string; nameRank: number; rangeRank: number; order: number }> = [];
  let order = 0;
  for (const [name, list] of Object.entries(ifaces)) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.address || !isIPv4(entry.address)) continue;
      candidates.push({
        address: entry.address,
        nameRank: interfaceNameRank(name),
        rangeRank: ipv4RangeRank(entry.address),
        order: order++,
      });
    }
  }
  const routeAddress = defaultRouteAddress?.trim();
  if (routeAddress && isIPv4(routeAddress) && candidates.some((candidate) => candidate.address === routeAddress)) {
    return routeAddress;
  }
  candidates.sort((a, b) => a.nameRank - b.nameRank || a.rangeRank - b.rangeRank || a.order - b.order);
  return candidates[0]?.address || null;
}

/** Ask the OS routing table which local IPv4 owns the default route. */
function defaultRouteIPv4(ifaces: NetworkInterfaces): string | null {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('route.exe', ['print', '-4'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const matches = [...output.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/gm)]
        .map((match) => ({ address: match[1], metric: Number(match[2]) }))
        .sort((a, b) => a.metric - b.metric);
      return matches.find((match) => isIPv4(match.address))?.address || null;
    }
    if (process.platform === 'linux') {
      const output = execFileSync('ip', ['-4', 'route', 'get', '1.1.1.1'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return output.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1] || null;
    }
    if (process.platform === 'darwin') {
      const output = execFileSync('route', ['-n', 'get', 'default'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const name = output.match(/^\s*interface:\s*(\S+)\s*$/m)?.[1];
      return name
        ? (ifaces[name] || []).find((entry) => entry.family === 'IPv4' && !entry.internal)?.address || null
        : null;
    }
  } catch {
    // Fall through to deterministic interface ranking below.
  }
  return null;
}

/** Best LAN IPv4 (or SHIBA_LAN_IP override), or null if offline. */
export function primaryLanIPv4(): string | null {
  const ifaces = os.networkInterfaces();
  return selectPrimaryLanIPv4(ifaces, process.env.SHIBA_LAN_IP, defaultRouteIPv4(ifaces));
}

/** Normalize a configured host to a single-label `<name>.local`. */
export function normalizeHostname(raw: string | undefined): string {
  let h = (raw || 'shiba.local').trim().toLowerCase().replace(/\.$/, '');
  if (!h) h = 'shiba.local';
  if (!h.endsWith('.local')) h = `${h}.local`;
  return h;
}

/**
 * The full list of `.local` names the app answers for. SHIBA_MDNS_HOST may
 * hold several comma-separated names; unset, the app advertises shiba.local.
 */
export function advertisedHostnames(raw?: string | undefined): string[] {
  const src = raw ?? process.env.SHIBA_MDNS_HOST;
  const names = (src || 'shiba.local')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => normalizeHostname(p));
  return [...new Set(names)];
}

/** Encode a dotted name as DNS labels (length-prefixed) + terminating 0. */
function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const bufs: Buffer[] = [];
  for (const p of parts) {
    const label = Buffer.from(p, 'utf8');
    bufs.push(Buffer.from([label.length]), label);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

/**
 * Read a QNAME starting at `offset`. Returns the lowercased dotted name and the
 * offset just past it, or null if it uses a compression pointer (0xC0) — which
 * we don't expect in a question and safely decline to parse.
 */
function readName(buf: Buffer, offset: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let i = offset;
  while (i < buf.length) {
    const len = buf[i];
    if (len === 0) return { name: labels.join('.').toLowerCase(), next: i + 1 };
    if ((len & 0xc0) === 0xc0) return null; // pointer — bail
    i += 1;
    if (i + len > buf.length) return null;
    labels.push(buf.toString('utf8', i, i + len));
    i += len;
  }
  return null;
}

/** Build an mDNS response carrying one A record for `hostname` → `ip`. */
export function buildAnswer(hostname: string, ip: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0000, 0); // id
  header.writeUInt16BE(0x8400, 2); // flags: QR=1, AA=1
  header.writeUInt16BE(0, 4); // qdcount
  header.writeUInt16BE(1, 6); // ancount
  header.writeUInt16BE(0, 8); // nscount
  header.writeUInt16BE(0, 10); // arcount

  const name = encodeName(hostname);
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(1, 0); // TYPE = A
  rr.writeUInt16BE(0x8001, 2); // CLASS = IN + cache-flush bit
  rr.writeUInt32BE(TTL_SECONDS, 4); // TTL
  rr.writeUInt16BE(4, 8); // RDLENGTH
  const rdata = Buffer.from(ip.split('.').map((n) => parseInt(n, 10) & 0xff));

  return Buffer.concat([header, name, rr, rdata]);
}

/** Encode a DNS question for `hostname` (type A) — used by tests. */
export function buildQuery(hostname: string, type = 1): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // qdcount
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, encodeName(hostname), q]);
}

/** True if the query packet asks for `hostname` with type A or ANY. */
export function queryWantsHost(buf: Buffer, hostname: string): boolean {
  if (buf.length < 12) return false;
  const qd = buf.readUInt16BE(4);
  let off = 12;
  for (let q = 0; q < qd; q++) {
    const rn = readName(buf, off);
    if (!rn) return false;
    const type = buf.readUInt16BE(rn.next);
    // qclass at rn.next+2 (ignore the unicast-response bit; we always multicast)
    off = rn.next + 4;
    if (rn.name === hostname && (type === 1 || type === 255)) return true;
  }
  return false;
}

export interface MdnsInfo { hostnames: string[]; ip: string }

/**
 * Start advertising shiba.local (or SHIBA_MDNS_HOST). Idempotent and
 * best-effort — never throws; a bind failure just logs and skips.
 */
export function startMdns(): MdnsInfo | null {
  if (process.env.SHIBA_MDNS === 'off') return null;
  if (g.__shibaMdns) return { hostnames: g.__shibaMdns.hostnames, ip: g.__shibaMdns.ip };

  const hostnames = advertisedHostnames();
  const lanMode = process.env.SHIBA_LAN === '1';
  if (process.env.SHIBA_LAN_IP?.trim() && !isIPv4(process.env.SHIBA_LAN_IP.trim())) {
    console.warn(`[shiba-studio] ignoring invalid SHIBA_LAN_IP=${process.env.SHIBA_LAN_IP}`);
  }
  const ip = lanMode ? (primaryLanIPv4() || '127.0.0.1') : '127.0.0.1';

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[shiba-studio] mDNS port ${MDNS_PORT} busy — ${hostnames.join(', ')} not advertised (another responder owns it)`);
    } else {
      console.warn('[shiba-studio] mDNS error:', err.message);
    }
    try { socket.close(); } catch { /* already closed */ }
    g.__shibaMdns = null;
  });

  socket.on('message', (msg, rinfo) => {
    try {
      for (const hostname of hostnames) {
        if (!queryWantsHost(msg, hostname)) continue;
        const answer = buildAnswer(hostname, ip);
        // Respond both to the multicast group (so every host caches it) and
        // unicast to the asker (faster first resolve).
        socket.send(answer, MDNS_PORT, MDNS_ADDR);
        socket.send(answer, rinfo.port, rinfo.address);
      }
    } catch { /* malformed query — ignore */ }
  });

  socket.bind(MDNS_PORT, () => {
    try {
      socket.addMembership(MDNS_ADDR);
      socket.setMulticastTTL(255);
      // Unsolicited announcements so resolvers cache the records immediately.
      for (const hostname of hostnames) {
        socket.send(buildAnswer(hostname, ip), MDNS_PORT, MDNS_ADDR);
      }
      g.__shibaMdns = { socket, hostnames, ip };
      console.log(`[shiba-studio] mDNS advertising ${hostnames.join(', ')} → ${ip}${lanMode ? ' (LAN)' : ' (localhost)'}`);
    } catch (e) {
      console.warn('[shiba-studio] mDNS membership failed:', e instanceof Error ? e.message : String(e));
    }
  });

  return { hostnames, ip };
}

export function stopMdns(): void {
  const cur = g.__shibaMdns;
  if (!cur) return;
  try { cur.socket.close(); } catch { /* already closed */ }
  g.__shibaMdns = null;
}
