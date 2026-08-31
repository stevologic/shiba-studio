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

/** Generated Grok Imagine portraits live under /api/agent-avatars/<uuid>. */
export const IMAGINE_AVATAR_PREFIX = 'imagine:';
const IMAGINE_FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseImagineAvatarId(avatarId?: string | null): string | null {
  const raw = String(avatarId || '').trim();
  if (!raw.startsWith(IMAGINE_AVATAR_PREFIX)) return null;
  const fileId = raw.slice(IMAGINE_AVATAR_PREFIX.length).trim().toLowerCase();
  if (!IMAGINE_FILE_ID_RE.test(fileId)) return null;
  return fileId;
}

export function imagineAvatarRef(fileId: string): string {
  const id = String(fileId || '').trim().toLowerCase();
  if (!IMAGINE_FILE_ID_RE.test(id)) throw new Error('Invalid Imagine avatar id');
  return `${IMAGINE_AVATAR_PREFIX}${id}`;
}

export function isImagineAvatarId(id?: string | null): boolean {
  return parseImagineAvatarId(id) != null;
}

export function isValidAvatarId(id: string): boolean {
  return byId.has(id) || isImagineAvatarId(id);
}

export function getAvatarPath(avatarId?: string): string {
  const imagineId = parseImagineAvatarId(avatarId);
  if (imagineId) return `/api/agent-avatars/${imagineId}`;
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