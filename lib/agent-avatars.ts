/** Alien avatar catalog — 50 generated SVGs in public/avatars/ */

export const ALIEN_AVATAR_COUNT = 50;

export interface AlienAvatar {
  id: string;
  path: string;
  label: string;
}

export const ALIEN_AVATARS: AlienAvatar[] = Array.from({ length: ALIEN_AVATAR_COUNT }, (_, i) => {
  const num = String(i + 1).padStart(2, '0');
  return {
    id: `alien-${num}`,
    path: `/avatars/alien-${num}.svg`,
    label: `Alien ${i + 1}`,
  };
});

const byId = new Map(ALIEN_AVATARS.map((a) => [a.id, a]));

export function isValidAvatarId(id: string): boolean {
  return byId.has(id);
}

export function getAvatarPath(avatarId?: string): string {
  if (avatarId && byId.has(avatarId)) return byId.get(avatarId)!.path;
  return ALIEN_AVATARS[0].path;
}

/** Stable default avatar from agent id for legacy agents without avatar field */
export function defaultAvatarIdForAgent(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash + agentId.charCodeAt(i) * (i + 1)) % ALIEN_AVATAR_COUNT;
  }
  return ALIEN_AVATARS[hash].id;
}

export function resolveAgentAvatar(agent: { id: string; avatar?: string }): string {
  if (agent.avatar && isValidAvatarId(agent.avatar)) return agent.avatar;
  return defaultAvatarIdForAgent(agent.id);
}

export function resolveAgentAvatarPath(agent: { id: string; avatar?: string }): string {
  return getAvatarPath(resolveAgentAvatar(agent));
}

/** Shown in run logs when the run's agent has since been deleted. */
export const MISSING_AGENT_AVATAR_PATH = '/avatars/ufo.svg';