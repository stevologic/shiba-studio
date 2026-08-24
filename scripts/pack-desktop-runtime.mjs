#!/usr/bin/env node
/**
 * Pack a production Shiba Studio tree plus the current Node binary so the
 * Windows / macOS hosts can start without a git checkout or a system Node.
 *
 * Expects a production build (`npm run build`) and installed dependencies
 * (ideally `npm prune --omit=dev`) in --root. Copies only what `next start`
 * and a few runtime file reads need.
 *
 *   node scripts/pack-desktop-runtime.mjs \
 *     --out dist/native/windows/ShibaStudio/runtime \
 *     --platform windows \
 *     --channel development \
 *     --sha "$(git rev-parse HEAD)"
 */
import { cpSync, copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANNELS = new Set(['main', 'development']);
const PLATFORMS = new Set(['windows', 'macos']);

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.github',
  '.turbo',
  '.cache',
  'cache',
  'playwright-report',
  'test-results',
  '.local-chromium',
  '.local-firefox',
  'chrome-headless-shell',
]);

function printHelp() {
  process.stdout.write(`Pack a bundled Studio runtime for the desktop hosts.

Usage:
  node scripts/pack-desktop-runtime.mjs --out <dir> --platform <windows|macos> --channel <main|development> --sha <git-sha>

Options:
  --root <dir>     Studio checkout to pack (default: repository root)
  --skip-node      Do not copy process.execPath into the runtime
  --help           Show this help
`);
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    return { help: true };
  }
  const out = argValue(argv, '--out');
  const platform = argValue(argv, '--platform');
  const channel = argValue(argv, '--channel');
  const sha = (argValue(argv, '--sha') || '').trim();
  const root = path.resolve(argValue(argv, '--root') || ROOT_DEFAULT);
  if (!out) fail('--out is required');
  if (!PLATFORMS.has(platform || '')) fail('--platform must be windows or macos');
  if (!CHANNELS.has(channel || '')) fail('--channel must be main or development');
  if (!sha || sha.length < 7) fail('--sha must be a git commit SHA');
  return {
    help: false,
    out: path.resolve(out),
    platform,
    channel,
    sha,
    root,
    skipNode: hasFlag(argv, '--skip-node'),
  };
}

function readPackageName(root) {
  const file = path.join(root, 'package.json');
  if (!existsSync(file)) fail(`Missing ${file}`);
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (pkg.name !== 'shiba-studio') fail(`${file} is not shiba-studio`);
  return pkg;
}

function assertBuild(root) {
  const nextDir = path.join(root, '.next');
  const nextCli = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextDir)) fail(`No production build at ${nextDir}. Run npm run build first.`);
  if (!existsSync(nextCli)) fail(`Next CLI missing at ${nextCli}. Run npm ci first.`);
}

function shouldSkip(src, root) {
  const rel = path.relative(root, src);
  if (!rel || rel.startsWith('..')) return false;
  const parts = rel.split(path.sep);
  if (parts.some((part) => SKIP_DIR_NAMES.has(part))) return true;
  if (parts[0] === '.next' && parts[1] === 'cache') return true;
  if (parts[0] === 'node_modules' && parts.includes('.cache')) return true;
  return false;
}

function copyFiltered(from, to, root) {
  if (!existsSync(from)) return;
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => !shouldSkip(src, root),
  });
}

function copyFileIfExists(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function copyNode(out, platform) {
  const source = realpathSync(process.execPath);
  const dest = platform === 'windows'
    ? path.join(out, 'node.exe')
    : path.join(out, 'bin', 'node');
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  if (platform !== 'windows') chmodSync(dest, 0o755);
  return dest;
}

function writeIdentity(out, { platform, channel, sha, nodePath }) {
  const identity = {
    version: 1,
    kind: 'bundled-desktop',
    platform,
    channel,
    sha,
    builtAt: new Date().toISOString(),
    node: process.version,
    nodePath: path.relative(out, nodePath).replaceAll('\\', '/') || path.basename(nodePath),
    preferredPort: 18765,
    manifestUrl: 'https://shiba-studio.io/packages/manifest.json',
    packagesPage: 'https://shiba-studio.io/packages.html',
  };
  writeFileSync(path.join(out, 'app.json'), `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

export function packDesktopRuntime(options) {
  const { out, platform, channel, sha, root, skipNode } = options;
  readPackageName(root);
  assertBuild(root);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const file of [
    'package.json',
    'next.config.ts',
    'tsconfig.json',
    'next-env.d.ts',
    'AGENTS.md',
    'CLAUDE.md',
    'LICENSE',
  ]) {
    copyFileIfExists(path.join(root, file), path.join(out, file));
  }

  copyFiltered(path.join(root, 'public'), path.join(out, 'public'), root);
  copyFiltered(path.join(root, 'lib'), path.join(out, 'lib'), root);
  copyFiltered(path.join(root, '.next'), path.join(out, '.next'), root);
  copyFiltered(path.join(root, 'node_modules'), path.join(out, 'node_modules'), root);
  copyFiltered(path.join(root, 'scripts', 'native-node'), path.join(out, 'scripts', 'native-node'), root);

  const nodePath = skipNode
    ? (platform === 'windows' ? path.join(out, 'node.exe') : path.join(out, 'bin', 'node'))
    : copyNode(out, platform);

  const identity = writeIdentity(out, { platform, channel, sha, nodePath });
  return { out, identity };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = packDesktopRuntime(options);
  process.stdout.write(`Packed ${result.identity.platform} ${result.identity.channel} runtime → ${result.out}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
