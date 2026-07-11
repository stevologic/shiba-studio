import type { NextConfig } from 'next';
import { execSync } from 'child_process';

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
const mdnsDevOrigins = (process.env.SHIBA_MDNS_HOST || 'shiba.local,shib.local')
  .split(',')
  .map((p) => p.trim().toLowerCase().replace(/\.$/, ''))
  .filter(Boolean)
  .map((p) => (p.endsWith('.local') ? p : `${p}.local`));

const nextConfig: NextConfig = {
  allowedDevOrigins: mdnsDevOrigins,
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
