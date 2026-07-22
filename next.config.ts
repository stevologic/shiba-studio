import type { NextConfig } from 'next';
import { execSync } from 'child_process';
import { isIP } from 'node:net';
import os from 'os';
import { configuredPublicOrigin } from './lib/public-origin';

// Initial bake only — the UI prefers live SHAs from GET /api/version which
// re-reads git HEAD from the process project root (keeps pace with local commits
// without restarting the Next server). Env override for non-git installs.
function resolveGitCommit(): string {
  if (process.env.SHIBA_GIT_COMMIT) return process.env.SHIBA_GIT_COMMIT;
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
    }).toString().trim() || 'unreleased';
  } catch {
    return 'unreleased';
  }
}

// The mDNS names the app answers for (lib/mdns.ts) — the dev server must
// also accept them or Next blocks its own assets when the site is opened
// as http://shiba.local:3000. Mirrors advertisedHostnames(); kept inline so
// config load stays dependency-free.
const mdnsDevOrigins = (process.env.SHIBA_MDNS_HOST || 'shiba.local')
  .split(',')
  .map((p) => p.trim().toLowerCase().replace(/\.$/, ''))
  .filter(Boolean)
  .map((p) => (p.endsWith('.local') ? p : `${p}.local`));

// The studio also gets opened by its LAN IP — either this machine or another
// device on the network (npm run *:lan) — and Next 16 blocks its own /_next
// dev resources as cross-origin unless that host is allowlisted. List every
// non-internal IPv4 so opening the app by IP just works. Baked at startup; a
// restart refreshes them if the address changes.
function lanIPv4Origins(): string[] {
  const out: string[] = [];
  const configured = process.env.SHIBA_LAN_IP?.trim();
  if (configured && isIP(configured)) out.push(configured);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal && ni.address) out.push(ni.address);
    }
  }
  return out;
}

// Parsing here makes an invalid reverse-proxy origin fail at process startup,
// before Studio can accidentally serve with a partially applied boundary.
const publicDevHostname = configuredPublicOrigin()?.hostname;
const allowedDevOrigins = [...new Set([
  ...mdnsDevOrigins,
  ...lanIPv4Origins(),
  '127.0.0.1',
  ...(publicDevHostname ? [publicDevHostname] : []),
])];

const nextConfig: NextConfig = {
  allowedDevOrigins,
  outputFileTracingIncludes: {
    '/api/monaco/\\[\\.\\.\\.asset\\]': ['./node_modules/monaco-editor/min/vs/**/*'],
  },
  // Real npm packages only — never Node builtins like `child_process`.
  // Listing builtins confuses Turbopack's import map and can panic with
  // "Next.js package not found" during HMR (especially when loading Chat).
  serverExternalPackages: [
    'puppeteer',
    'puppeteer-core',
    '@puppeteer/browsers',
    'googleapis',
    'google-auth-library',
    'gaxios',
    'node-cron',
    'octokit',
    '@modelcontextprotocol/sdk',
    '@slack/web-api',
    'node-pty',
    'ws',
  ],
  env: {
    // Fallback for first paint before /api/version returns; not the source of truth.
    NEXT_PUBLIC_GIT_COMMIT: resolveGitCommit(),
  },
};

export default nextConfig;
