/** Shared scratch directory for goal verification scripts. */
export const GOAL_SCRATCH =
  process.env.GROK_GOAL_SCRATCH
  || process.env.GROK_OAUTH_SCRATCH
  || 'C:\\Users\\steph\\AppData\\Local\\Temp\\grok-goal-a0e62e138803\\implementer';