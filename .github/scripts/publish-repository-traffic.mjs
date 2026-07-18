import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const repository = process.env.GITHUB_REPOSITORY || 'stevologic/shiba-studio';
const token = process.env.REPOSITORY_TRAFFIC_TOKEN;
const destination = resolve(process.argv[2] || 'traffic/repository-traffic.json');

if (!token) {
  throw new Error('REPOSITORY_TRAFFIC_TOKEN is required.');
}

async function getTraffic(metric) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/traffic/${metric}?per=day`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'shiba-studio-traffic-publisher',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub traffic ${metric} request failed (${response.status}).`);
  }

  return response.json();
}

const [views, clones] = await Promise.all([
  getTraffic('views'),
  getTraffic('clones'),
]);

const snapshot = {
  version: 1,
  repository,
  scope: 'repository',
  window: 'rolling-14-days',
  generatedAt: new Date().toISOString(),
  views: {
    count: Number(views.count) || 0,
    uniques: Number(views.uniques) || 0,
    daily: Array.isArray(views.views) ? views.views : [],
  },
  clones: {
    count: Number(clones.count) || 0,
    uniques: Number(clones.uniques) || 0,
    daily: Array.isArray(clones.clones) ? clones.clones : [],
  },
};

await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`Published repository traffic snapshot to ${destination}`);
