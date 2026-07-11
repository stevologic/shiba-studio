// Import this FIRST in any verify script that writes state (agents, runs,
// schedules, memories). Under `npm test`, verify-all.ts already points
// SHIBA_DATA_DIR at a scratch dir — but a DIRECT `npx tsx scripts/verify-X.ts`
// used to write test agents and runs into the user's real ~/.shiba-studio
// store (and its scheduler then fired orphan runs for the deleted test
// agent). Import order = execution order, so this runs before any lib module
// captures the data dir.

import * as os from 'os';
import * as path from 'path';

if (!process.env.SHIBA_DATA_DIR) {
  process.env.SHIBA_DATA_DIR = path.join(
    os.tmpdir(),
    `shiba-verify-isolated-${process.pid}-${Date.now()}`,
  );
  console.log(`[verify-isolate] direct invocation — data dir sandboxed to ${process.env.SHIBA_DATA_DIR}`);
}

export {};
