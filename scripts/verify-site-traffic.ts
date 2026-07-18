import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SITE_TRAFFIC_REPOSITORY,
  SITE_TRAFFIC_URL,
} from '../lib/site-traffic-types';

async function main() {
  assert.equal(SITE_TRAFFIC_URL, 'https://shiba-studio.io');
  assert.equal(SITE_TRAFFIC_REPOSITORY, 'stevologic/shiba-studio');

  const root = process.cwd();
  const route = await readFile(path.join(root, 'app/api/site-traffic/route.ts'), 'utf8');
  const service = await readFile(path.join(root, 'lib/site-traffic.ts'), 'utf8');
  const dashboard = await readFile(
    path.join(root, 'components/site-traffic-dashboard.tsx'),
    'utf8',
  );

  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function POST/);
  assert.match(service, /\/traffic\/views\?per=day/);
  assert.match(service, /\/traffic\/clones\?per=day/);
  assert.match(service, /Administration read access/);
  assert.match(dashboard, /These numbers are not website visitors/);
  assert.match(dashboard, /Repository Traffic/);

  console.log('Site traffic verification passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
