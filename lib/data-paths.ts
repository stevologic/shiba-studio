import path from 'path';
import * as fs from 'fs';
import os from 'os';

/** Project root — scoped for Next.js file tracing (avoids whole-repo NFT warnings). */
export function projectRoot(): string {
  return /* turbopackIgnore: true */ process.cwd();
}

let resolvedDataDir: string | null = null;

/**
 * Runtime data lives OUTSIDE the project root (~/.grokdesk/data, or
 * GROKDESK_DATA_DIR). Keeping it inside the repo made the dev file-watcher
 * rebuild + remount the app on every ledger/run/session write — the source of
 * "phantom" reloads. Legacy <project>/data is migrated automatically on first
 * access (rename when possible, copy otherwise).
 */
function defaultDataRoot(): string {
  const env = process.env.GROKDESK_DATA_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), '.grokdesk', 'data');
}

function migrateLegacyData(target: string): void {
  try {
    const legacy = path.join(/* turbopackIgnore: true */ process.cwd(), 'data');
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
  return path.join(resolvedDataDir, ...segments);
}
