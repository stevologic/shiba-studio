export const APP_TABS = [
  'dashboard',
  'chat',
  'projects',
  'agents',
  'workspace',
  'automations',
  'integrations',
  'usage',
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