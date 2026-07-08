import type { NextConfig } from 'next';
import { execSync } from 'child_process';

// Resolved once when the server/build starts, so the sidebar can show exactly
// which commit of the source is running. Falls back for non-git installs
// (release tarballs) to an env override or "unreleased".
function resolveGitCommit(): string {
  if (process.env.SHIBA_GIT_COMMIT) return process.env.SHIBA_GIT_COMMIT;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || 'unreleased';
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
  ],
  env: {
    NEXT_PUBLIC_GIT_COMMIT: resolveGitCommit(),
  },
};

export default nextConfig;
