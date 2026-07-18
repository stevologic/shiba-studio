import * as fs from 'fs/promises';
import * as path from 'path';
import {
  GOATCOUNTER_DISCLOSURE_START,
  GOATCOUNTER_TRACKER_START,
  hasExactGoatCounterTracker,
  injectGoatCounterTracker,
  normalizeGoatCounterSiteCode,
  normalizeTrafficDays,
  removeGoatCounterTracker,
} from '../lib/site-traffic-types';
import { GOAL_SCRATCH } from '../lib/verify-scratch';

const ROOT = path.resolve(__dirname, '..');
let passed = 0;

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  passed += 1;
}

function throws(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  check(error instanceof Error && pattern.test(error.message), message);
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(ROOT, relativePath), 'utf8');
}

async function main() {
  check(normalizeTrafficDays(undefined) === 30, 'traffic range defaults to 30 days');
  check(normalizeTrafficDays('7') === 7, 'traffic range accepts supported numeric strings');
  check(normalizeTrafficDays(90) === 90, 'traffic range accepts supported numbers');
  throws(() => normalizeTrafficDays(14), /7, 30, or 90/, 'unsupported ranges are rejected');

  check(
    normalizeGoatCounterSiteCode(' Shiba-Studio ') === 'shiba-studio',
    'hosted GoatCounter codes are normalized',
  );
  for (const unsafe of [
    'https://shiba-studio.goatcounter.com',
    'shiba.studio',
    '../shiba',
    'shiba_studio',
    '-shiba',
  ]) {
    throws(
      () => normalizeGoatCounterSiteCode(unsafe),
      /lowercase letters, numbers, or hyphens/,
      `unsafe GoatCounter code is rejected: ${unsafe}`,
    );
  }

  const fixture = [
    '<!doctype html>',
    '<html>',
    '<head><title>Shiba Studio</title></head>',
    '<body><main>Site</main><footer><span>Footer</span></footer></body>',
    '</html>',
  ].join('\n');
  const installed = injectGoatCounterTracker(fixture, 'shiba-studio');
  check(installed.changed, 'first tracker installation changes the document');
  check(
    installed.html.includes('https://shiba-studio.goatcounter.com/count'),
    'tracker count URL is the fixed hosted GoatCounter origin',
  );
  check(
    installed.html.includes('https://gc.zgo.at/count.js'),
    'tracker script uses the official HTTPS source',
  );
  check(
    installed.html.indexOf(GOATCOUNTER_TRACKER_START) < installed.html.indexOf('</head>'),
    'tracker is installed before the closing head',
  );
  check(
    installed.html.indexOf(GOATCOUNTER_DISCLOSURE_START) < installed.html.indexOf('</footer>'),
    'privacy disclosure is installed inside the existing footer',
  );
  check(
    hasExactGoatCounterTracker(installed.html, 'shiba-studio'),
    'exact tracker detection succeeds after installation',
  );

  const idempotent = injectGoatCounterTracker(installed.html, 'shiba-studio');
  check(!idempotent.changed && idempotent.html === installed.html, 'installation is idempotent');

  const replaced = injectGoatCounterTracker(installed.html, 'shiba-studio-2');
  check(replaced.changed, 'changing the site code updates the managed tracker');
  check(!replaced.html.includes('https://shiba-studio.goatcounter.com/count'), 'old code is removed');
  check(
    count(replaced.html, GOATCOUNTER_TRACKER_START) === 1
      && count(replaced.html, GOATCOUNTER_DISCLOSURE_START) === 1,
    'managed blocks are never duplicated',
  );

  const removed = removeGoatCounterTracker(replaced.html);
  check(removed.changed, 'disconnect removes managed tracker blocks');
  check(
    !removed.html.includes(GOATCOUNTER_TRACKER_START)
      && !removed.html.includes(GOATCOUNTER_DISCLOSURE_START),
    'disconnect removes both tracker and disclosure',
  );
  check(!removeGoatCounterTracker(removed.html).changed, 'tracker removal is idempotent');

  const fallbackInstalled = injectGoatCounterTracker(
    '<!doctype html><html><head><title>Shiba Studio</title></head><body><main>Site</main></body></html>',
    'shiba-studio',
  );
  check(
    hasExactGoatCounterTracker(fallbackInstalled.html, 'shiba-studio'),
    'tracker detection accepts the managed body disclosure fallback',
  );

  throws(
    () => injectGoatCounterTracker(
      fixture.replace(
        '</head>',
        '<script data-goatcounter="https://manual.goatcounter.com/count" src="https://gc.zgo.at/count.js"></script></head>',
      ),
      'shiba-studio',
    ),
    /unmanaged GoatCounter tracker/,
    'manual trackers cannot be silently duplicated',
  );
  throws(
    () => injectGoatCounterTracker('<html><body></body></html>', 'shiba-studio'),
    /closing head/,
    'malformed Pages documents fail closed',
  );
  throws(
    () => removeGoatCounterTracker(
      `<html><head>${GOATCOUNTER_TRACKER_START}</head><body></body></html>`,
    ),
    /incomplete Shiba Studio analytics marker/,
    'incomplete managed markers fail closed',
  );

  const [service, route, component, persistence, navigation, types] = await Promise.all([
    read('lib/site-traffic.ts'),
    read('app/api/site-traffic/route.ts'),
    read('components/site-traffic-dashboard.tsx'),
    read('lib/persistence.ts'),
    read('lib/app-navigation.ts'),
    read('lib/site-traffic-types.ts'),
  ]);
  check(
    service.includes("const GITHUB_API_ROOT =\n  'https://api.github.com/repos/stevologic/shiba-studio'")
      && service.includes('https://${code}.goatcounter.com/api/v0/'),
    'upstream origins and repository are fixed server-side',
  );
  check(
    service.includes("import 'server-only'")
      && route.includes('siteCode: credentials.siteCode')
      && !route.includes('apiToken: credentials.apiToken'),
    'provider secrets stay in the server-only module and save responses omit the token',
  );
  check(
    service.includes("'stats/total',\n      dateWindow(7)")
      && service.includes('GOATCOUNTER_STATS_PERMISSION_REQUIRED'),
    'credential setup verifies statistics-read access before storing the token',
  );
  check(
    route.includes('req.body?.getReader()')
      && route.includes('size > MAX_BODY_BYTES')
      && !route.includes('await req.json()'),
    'traffic settings enforce the byte limit on streamed request bodies',
  );
  check(
    count(route, 'return withSiteTrafficMutationLock') === 4
      && route.includes("action === 'forget'")
      && route.includes('trackerMayRemain: true'),
    'traffic mutations are serialized and local credentials can be explicitly forgotten',
  );
  check(
    service.includes('const date = safeDay(row.timestamp)'),
    'GitHub traffic buckets preserve their UTC calendar day',
  );
  check(
    service.includes('end.getTime() - days * 24 * 60 * 60_000')
      && !service.includes('.slice(-days)'),
    'GoatCounter charts retain every account-timezone bucket in the rolling range',
  );
  check(
    types.includes('color:var(--muted,#a3a3a3)')
      && types.includes('trackerPartial: boolean')
      && component.includes('patchFailureDetails(error.files)'),
    'published disclosure contrast and partial tracker recovery stay explicit',
  );
  check(
    persistence.includes("'integrations.goatcounter.apiToken'"),
    'GoatCounter API tokens are included in encrypted config paths',
  );
  check(
    component.includes('These numbers are not website visitors')
      && component.includes('GitHub Pages does not include visitor analytics')
      && !component.includes('All-time visits'),
    'UI separates website visits from repository traffic without false totals',
  );
  check(
    component.includes("&refresh=1")
      && component.includes("runAction('install'")
      && component.includes("runAction('disconnect'"),
    'UI exposes real refresh, installation, and removal controls',
  );
  check(
    navigation.includes("'traffic'"),
    'Traffic is a canonical Shiba Studio route',
  );
  check(
    types.includes("['index.html', 'docs.html', 'traffic/index.html']"),
    'tracker installation covers the public traffic page',
  );

  await fs.mkdir(GOAL_SCRATCH, { recursive: true });
  await fs.writeFile(
    path.join(GOAL_SCRATCH, 'site-traffic-verify.log'),
    `SITE_TRAFFIC_VERIFY\n${passed} passed, 0 failed\n`,
    'utf8',
  );
  console.log(`${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
