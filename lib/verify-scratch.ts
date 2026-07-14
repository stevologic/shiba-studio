import os from 'node:os';
import path from 'node:path';

/** Shared scratch directory for goal verification scripts. */
export const GOAL_SCRATCH =
  process.env.GROK_GOAL_SCRATCH
  || process.env.GROK_OAUTH_SCRATCH
  || path.join(os.tmpdir(), 'shiba-studio-verify');
