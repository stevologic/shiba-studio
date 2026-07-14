/** Parse the user-facing `/tools on|off` argument without coercing typos. */
export function parseChatToolsSetting(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on') return true;
  if (normalized === 'off') return false;
  return null;
}

/**
 * An explicit request value wins so a just-issued command takes effect before
 * its session patch is reloaded. Older sessions have no stored field and stay
 * enabled for backwards compatibility.
 */
export function resolveChatToolsEnabled(requested: unknown, persisted?: boolean): boolean {
  if (typeof requested === 'boolean') return requested;
  return persisted !== false;
}

/** Attachments use the plain vision stream; otherwise the per-chat switch wins. */
export function shouldUseChatTools(toolsEnabled: boolean, hasAttachments: boolean): boolean {
  return toolsEnabled && !hasAttachments;
}
