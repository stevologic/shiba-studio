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
  serverExternalPackages: ['child_process'],
  env: {
    NEXT_PUBLIC_GIT_COMMIT: resolveGitCommit(),
  },
};

export default nextConfig;
