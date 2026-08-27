#!/usr/bin/env node
/**
 * Publish compiled native packages for the current branch channel.
 *
 * GitHub Actions supplies the Windows zip. macOS zips are local / Luigi
 * (not a GitHub-hosted macOS runner) and are optional: a missing Mac
 * artifact keeps the previous rolling-release asset and manifest entry.
 *
 * Expects:
 *   source/                 repo checkout
 *   site/                   gh-pages checkout
 *   artifacts/              downloaded native zips (Windows required from CI)
 *   CHANNEL                 main | development
 *   GH_TOKEN / GITHUB_TOKEN
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const workspace = process.cwd();
const sourceRoot = existsSync(path.join(workspace, 'source', 'apps', 'catalog.json'))
  ? path.join(workspace, 'source')
  : workspace;
const siteRoot = existsSync(path.join(workspace, 'site', '.git'))
  ? path.join(workspace, 'site')
  : path.join(workspace, 'gh-pages');
const artifactsRoot = path.join(workspace, 'artifacts');

const catalog = JSON.parse(readFileSync(path.join(sourceRoot, 'apps', 'catalog.json'), 'utf8'));
const channel = String(process.env.CHANNEL || process.env.GITHUB_REF_NAME || '').trim();
if (!catalog.channels.includes(channel)) {
  throw new Error(`CHANNEL must be one of ${catalog.channels.join(', ')}; got ${channel || '(empty)'}`);
}

const repo = process.env.GITHUB_REPOSITORY || 'stevologic/shiba-studio';
const sha = process.env.GITHUB_SHA || '';
const runId = process.env.GITHUB_RUN_ID || '';
const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required to publish packages.');

const tag = `${catalog.releaseTagPrefix}-${channel}`;
const pageUrl = 'https://shiba-studio.io/packages.html';
const releaseUrl = `${server}/${repo}/releases/tag/${tag}`;
const runUrl = runId ? `${server}/${repo}/actions/runs/${runId}` : releaseUrl;

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function findArtifact(fileName) {
  const matches = walk(artifactsRoot).filter((file) => path.basename(file) === fileName);
  return matches[0] || null;
}

function loadExistingManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), page: pageUrl, channels: {} };
  }
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), page: pageUrl, channels: {} };
  }
}

const siteManifestPath = path.join(siteRoot, 'packages', 'manifest.json');
const existing = existsSync(siteRoot)
  ? loadExistingManifest(siteManifestPath)
  : { version: 1, updatedAt: new Date(0).toISOString(), page: pageUrl, channels: {} };
const previousApps = existing.channels?.[channel]?.apps || {};

const apps = { ...previousApps };
const uploadFiles = [];
const uploaded = [];
for (const app of catalog.apps) {
  const file = findArtifact(app.artifact);
  if (!file) {
    if (!previousApps[app.id]) {
      console.log(`Skipping ${app.artifact} (not in this run; no previous ${channel} entry).`);
    } else {
      console.log(`Keeping previous ${channel} ${app.artifact}; not in this run.`);
    }
    continue;
  }
  uploadFiles.push(file);
  uploaded.push(app.id);
  apps[app.id] = {
    name: app.name,
    file: app.artifact,
    url: `${server}/${repo}/releases/download/${tag}/${app.artifact}`,
  };
}

if (!uploadFiles.length) {
  throw new Error(`No compiled artifacts found under ${artifactsRoot}`);
}

function sh(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const notes = [
  `Rolling ${channel} packages from ${sha || 'HEAD'} (${uploaded.join(', ') || 'none'} this run).`,
  'Windows is compiled on GitHub Actions. macOS builds are local / Luigi, not a GitHub-hosted macOS runner.',
  runUrl ? `CI run: ${runUrl}` : '',
  'The macOS zip is an unsigned universal .app. First launch may need right-click → Open until a Developer ID certificate is added.',
].filter(Boolean).join('\n');

const view = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { encoding: 'utf8' });
if (view.status !== 0) {
  sh('gh', [
    'release', 'create', tag,
    '--repo', repo,
    '--title', `Shiba Studio packages (${channel})`,
    '--notes', notes,
    '--target', sha || channel,
    ...(channel === 'development' ? ['--prerelease'] : []),
    ...uploadFiles,
  ]);
} else {
  sh('gh', ['release', 'edit', tag, '--repo', repo, '--notes', notes, '--target', sha || channel]);
  sh('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...uploadFiles]);
}

const keep = new Set(catalog.apps.map((app) => app.artifact));
const listed = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'], { encoding: 'utf8' });
if (listed.status === 0) {
  const assets = JSON.parse(listed.stdout).assets || [];
  for (const asset of assets) {
    if (!keep.has(asset.name)) {
      sh('gh', ['release', 'delete-asset', tag, asset.name, '--repo', repo, '--yes']);
    }
  }
}

if (!existsSync(siteRoot)) {
  throw new Error(`gh-pages checkout was not found at ${siteRoot}`);
}

mkdirSync(path.join(siteRoot, 'packages'), { recursive: true });
for (const name of ['index.html', 'docs.html', 'packages.html']) {
  const from = path.join(sourceRoot, 'site', name);
  if (existsSync(from)) cpSync(from, path.join(siteRoot, name));
}

const manifest = {
  version: 1,
  updatedAt: new Date().toISOString(),
  page: pageUrl,
  channels: { ...(existing.channels || {}) },
};
manifest.channels[channel] = { sha, runUrl, releaseUrl, apps };
writeFileSync(siteManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const git = (args) => sh('git', args, { cwd: siteRoot, env: { ...process.env, GH_TOKEN: token } });
git(['config', 'user.name', 'github-actions[bot]']);
git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
git(['add', 'index.html', 'docs.html', 'packages.html', 'packages/manifest.json']);
const dirty = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: siteRoot });
if (dirty.status === 0) {
  console.log('Packages page is already current.');
} else {
  git(['commit', '-m', `chore(pages): publish ${channel} native packages`]);
  git(['push', 'origin', 'HEAD:gh-pages']);
}

console.log(`Published ${channel} packages to ${releaseUrl}`);
