// Verifies the mDNS responder: hostname normalization, query detection,
// answer-packet encoding, and a real UDP multicast round-trip on this machine.

import * as path from 'path';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
import {
  normalizeHostname,
  advertisedHostnames,
  buildAnswer,
  buildQuery,
  queryWantsHost,
  startMdns,
  stopMdns,
  primaryLanIPv4,
} from '../lib/mdns';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; } else console.log(`ok: ${msg}`);
}

/** Decode the A record IP out of an mDNS answer built by buildAnswer. */
function ipFromAnswer(buf: Buffer): string {
  const ip = buf.subarray(buf.length - 4);
  return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
}

async function roundTrip(hostname: string, timeoutMs = 2500): Promise<string | null> {
  const dgram = await import('dgram');
  return new Promise((resolve) => {
    const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (v: string | null) => { if (done) return; done = true; try { client.close(); } catch {} resolve(v); };
    client.on('message', (msg) => { if (queryWantsHostAnswer(msg, hostname)) finish(ipFromAnswer(msg)); });
    client.bind(0, () => {
      try { client.setMulticastTTL(255); } catch {}
      client.send(buildQuery(hostname), 5353, '224.0.0.251');
    });
    setTimeout(() => finish(null), timeoutMs);
  });
}

/** An answer packet has ancount>=1 and (loosely) our hostname's labels. */
function queryWantsHostAnswer(buf: Buffer, hostname: string): boolean {
  if (buf.length < 12) return false;
  const flags = buf.readUInt16BE(2);
  const isResponse = (flags & 0x8000) !== 0;
  const anCount = buf.readUInt16BE(6);
  if (!isResponse || anCount < 1) return false;
  // hostname's first label should appear in the packet
  const first = hostname.split('.')[0];
  return buf.includes(Buffer.from(first, 'utf8'));
}

async function main() {
  // --- normalizeHostname ---
  assert(normalizeHostname(undefined) === 'shiba.local', 'default hostname is shiba.local');
  assert(normalizeHostname('shib') === 'shib.local', 'bare label gets .local');
  assert(normalizeHostname('Shiba.Local') === 'shiba.local', 'lowercased');
  assert(normalizeHostname('mybox.local.') === 'mybox.local', 'trailing dot trimmed');

  // --- advertisedHostnames ---
  assert(
    JSON.stringify(advertisedHostnames('')) === JSON.stringify(['shiba.local']),
    'default advertises shiba.local only',
  );
  assert(
    JSON.stringify(advertisedHostnames('a, B.local ,a.local')) === JSON.stringify(['a.local', 'b.local']),
    'comma list normalized + deduped',
  );

  // --- query detection ---
  assert(queryWantsHost(buildQuery('shib.local', 1), 'shib.local'), 'A query for shib.local matches');
  assert(queryWantsHost(buildQuery('shib.local', 255), 'shib.local'), 'ANY query matches');
  assert(!queryWantsHost(buildQuery('shib.local', 28), 'shib.local'), 'AAAA query does not match (A-only)');
  assert(!queryWantsHost(buildQuery('other.local', 1), 'shib.local'), 'query for another host does not match');

  // --- answer encoding ---
  const ans = buildAnswer('shib.local', '192.168.1.42');
  assert(ipFromAnswer(ans) === '192.168.1.42', 'answer carries the advertised IP');
  assert(ans.readUInt16BE(6) === 1, 'answer has ancount=1');
  assert(ans.includes(Buffer.from('shib')) && ans.includes(Buffer.from('local')), 'answer encodes the hostname labels');

  // --- primaryLanIPv4 shape ---
  const lan = primaryLanIPv4();
  assert(lan === null || /^\d{1,3}(\.\d{1,3}){3}$/.test(lan), `primaryLanIPv4 is an IPv4 or null (${lan})`);

  // --- live UDP multicast round-trip (best-effort; multicast can be blocked) ---
  // Use UNIQUE hostnames so only THIS responder answers — the mDNS bus is
  // shared, and a stale responder or a second Shiba instance on the network
  // could otherwise answer `shiba.local` and make the assertion flaky. Two
  // names prove the multi-name answering path (shiba.local + shib.local).
  const stamp = `${process.pid}-${Date.now()}`;
  const uniqueHost = `shibtest-${stamp}.local`;
  const aliasHost = `shibalias-${stamp}.local`;
  process.env.SHIBA_MDNS_HOST = `${uniqueHost},${aliasHost}`;
  delete process.env.SHIBA_LAN; // localhost mode → advertises 127.0.0.1
  const info = startMdns();
  if (info) {
    assert(info.hostnames.length === 2, 'responder carries both configured names');
    await new Promise((r) => setTimeout(r, 300));
    const resolved = await roundTrip(uniqueHost);
    const resolvedAlias = await roundTrip(aliasHost);
    if (resolved || resolvedAlias) {
      assert(resolved === '127.0.0.1', `round-trip resolves ${uniqueHost} → ${resolved} (localhost mode)`);
      assert(resolvedAlias === '127.0.0.1', `round-trip resolves alias ${aliasHost} → ${resolvedAlias}`);
    } else {
      console.log('note: multicast round-trip returned nothing (multicast may be blocked here) — packet logic verified above');
    }
  } else {
    console.log('note: responder did not start (port 5353 busy) — packet logic verified above');
  }
  stopMdns();

  const fs = await import('fs/promises');
  await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(SCRATCH, 'mdns-verify.log'), `failures=${failures} lan=${lan}\n`);

  if (failures) { console.error(`\n${failures} mDNS checks FAILED`); process.exit(1); }
  console.log('\nALL mDNS CHECKS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('verify-mdns crashed', e); process.exit(1); });
