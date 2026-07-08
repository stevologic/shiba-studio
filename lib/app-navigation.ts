export const APP_TABS = [
  'dashboard',
  'chat',
  'projects',
  'agents',
  'workspace',
  'automations',
  'integrations',
  'usage',
  'logs',
  'settings',
] as const;

export type AppTab = (typeof APP_TABS)[number];

export function isAppTab(value: string | undefined): value is AppTab {
  return !!value && (APP_TABS as readonly string[]).includes(value);
}

export function tabToPath(tab: AppTab): string {
  return tab === 'dashboard' ? '/' : `/${tab}`;
}

export function chatSessionPath(sessionId: string): string {
  return `/chat/${sessionId}`;
}

/** Remembered so opening the Chat tab can skip the bare `/chat` hop (which
 *  remounts the catch-all page and re-fetched sessions). */
const LAST_CHAT_SESSION_KEY = 'shiba-last-chat';

export function readLastChatSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const id = window.localStorage.getItem(LAST_CHAT_SESSION_KEY)?.trim();
    return id || null;
  } catch {
    return null;
  }
}

export function writeLastChatSessionId(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_CHAT_SESSION_KEY, sessionId);
  } catch {
    /* private mode */
  }
}

export function pathToTab(pathname: string): AppTab {
  const segments = pathname.replace(/\/$/, '').split('/').filter(Boolean);
  const first = segments[0];
  if (!first) return 'dashboard';
  return isAppTab(first) ? first : 'dashboard';
}

export function pathToChatSessionId(pathname: string): string | null {
  const segments = pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (segments[0] === 'chat' && segments[1]) return segments[1];
  return null;
}

/** True for `/`, `/chat`, `/chat/:id`, etc. — false for unknown nested paths. */
export function isKnownAppPath(pathname: string): boolean {
  const segments = pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.length === 1) return isAppTab(segments[0]);
  if (segments.length === 2 && segments[0] === 'chat') return true;
  return false;
}