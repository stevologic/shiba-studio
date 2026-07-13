import path from 'path';
import os from 'os';

const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fs: typeof import('fs') = builtinFs;

/** Project root — scoped for Next.js file tracing (avoids whole-repo NFT warnings). */
export function projectRoot(): string {
  // INIT_CWD is set by npm and PWD by POSIX shells. Avoid a bare process.cwd()
  // here: Next's file tracer interprets it as "bundle the entire repository".
  return path.resolve(/* turbopackIgnore: true */
    process.env.SHIBA_PROJECT_ROOT?.trim()
    || process.env.INIT_CWD?.trim()
    || process.env.PWD?.trim()
    || '.',
  );
}

let resolvedHome: string | null = null;
let resolvedDataDir: string | null = null;

/**
 * Shiba Studio's home directory (~/.shiba-studio) — machine key, config, and
 * all runtime data. Installs created before the rebrand lived in ~/.grokdesk;
 * that directory is renamed wholesale on first access so existing credentials
 * and history keep working.
 */
export function shibaHome(): string {
  if (resolvedHome) return resolvedHome;
  const home = path.join(os.homedir(), '.shiba-studio');
  const legacy = path.join(os.homedir(), '.grokdesk');
  if (!fs.existsSync(home) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, home);
    } catch {
      // Open handles (e.g. an old server still running) — keep using the
      // legacy directory this session; migration retries on the next boot.
      resolvedHome = legacy;
      return legacy;
    }
  }
  resolvedHome = home;
  return home;
}

/**
 * Runtime data lives OUTSIDE the project root (~/.shiba-studio/data, or
 * SHIBA_DATA_DIR). Keeping it inside the repo made the dev file-watcher
 * rebuild + remount the app on every ledger/run/session write — the source of
 * "phantom" reloads. Legacy <project>/data is migrated automatically on first
 * access (rename when possible, copy otherwise).
 */
function defaultDataRoot(): string {
  const env = (process.env.SHIBA_DATA_DIR || process.env.GROKDESK_DATA_DIR)?.trim();
  if (env) return path.resolve(/* turbopackIgnore: true */ env);
  return path.join(shibaHome(), 'data');
}

function migrateLegacyData(target: string): void {
  try {
    const legacy = path.join(projectRoot(), 'data');
    if (path.resolve(legacy) === path.resolve(target)) return;
    if (!fs.existsSync(legacy)) return;
    const targetPopulated = fs.existsSync(target) && fs.readdirSync(target).length > 0;
    if (targetPopulated) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(legacy, target);
    } catch {
      // Open handles / cross-device — fall back to a one-time copy.
      fs.cpSync(legacy, target, { recursive: true });
    }
  } catch {
    /* migration is best-effort; a fresh data dir is created below */
  }
}

/** App persistence directory (see note above — lives outside the repo). */
export function dataDir(...segments: string[]): string {
  if (!resolvedDataDir) {
    const target = defaultDataRoot();
    migrateLegacyData(target);
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch {
      /* creation races are fine */
    }
    resolvedDataDir = target;
  }
  return path.join(/* turbopackIgnore: true */ resolvedDataDir, ...segments);
}
