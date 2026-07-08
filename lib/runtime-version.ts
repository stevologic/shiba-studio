/**
 * Live identity of the code currently running this Node process.
 * Prefer this over NEXT_PUBLIC_GIT_COMMIT (baked at config load / build).
 */

import { execSync } from 'child_process';
import { projectRoot } from './data-paths';
import pkg from '../package.json';

export interface RuntimeVersion {
  /** package.json version */
  version: string;
  /** Short commit SHA of HEAD in the running tree */
  commit: string;
  /** Full 40-char SHA when available */
  commitFull: string | null;
  /** True when the working tree has uncommitted changes */
  dirty: boolean;
  /** ISO timestamp when this snapshot was taken */
  checkedAt: string;
  /** Absolute path of the project root this process is serving */
  root: string;
  /** How commit was resolved */
  source: 'env' | 'git' | 'unknown';
}

let cache: { at: number; value: RuntimeVersion } | null = null;
/** Short TTL so UI stays fresh after local commits without hammering git. */
const CACHE_MS = 5_000;

function runGit(args: string, cwd: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4_000,
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function getRuntimeVersion(force = false): RuntimeVersion {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.value;
  }

  const root = projectRoot();
  const envCommit = (process.env.SHIBA_GIT_COMMIT || process.env.NEXT_PUBLIC_GIT_COMMIT || '').trim();

  let commit = 'unreleased';
  let commitFull: string | null = null;
  let dirty = false;
  let source: RuntimeVersion['source'] = 'unknown';

  // Always prefer live git from the process cwd/project root — that's the code
  // Node is actually loading from during `next dev` and local runs.
  const short = runGit('rev-parse --short HEAD', root);
  const full = runGit('rev-parse HEAD', root);
  if (short) {
    commit = short;
    commitFull = full;
    source = 'git';
    // porcelain empty = clean
    const status = runGit('status --porcelain', root);
    dirty = status !== null && status.length > 0;
  } else if (envCommit) {
    commit = envCommit.replace(/^['"]|['"]$/g, '');
    source = 'env';
  }

  const value: RuntimeVersion = {
    version: (pkg as { version?: string }).version || '0.0.0',
    commit,
    commitFull,
    dirty,
    checkedAt: new Date().toISOString(),
    root,
    source,
  };
  cache = { at: Date.now(), value };
  return value;
}

export function clearRuntimeVersionCache() {
  cache = null;
}
