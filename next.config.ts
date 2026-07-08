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

const nextConfig: NextConfig = {
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
