// Global per-tool enable/disable (Capabilities → Tools toggles).
// Disabled tools are stripped from model tool lists and blocked at execution.

export function getDisabledToolSet(disabledTools?: string[] | null): Set<string> {
  return new Set((disabledTools || []).map((n) => String(n).trim()).filter(Boolean));
}

export function isToolDisabled(
  name: string,
  disabledTools?: string[] | Set<string> | null,
): boolean {
  if (!disabledTools) return false;
  if (disabledTools instanceof Set) return disabledTools.has(name);
  return disabledTools.includes(name);
}

/**
 * Remove disabled tools from a Grok tool definition list. ALWAYS returns a new
 * array — callers that mutate the input in place (`tools.length = 0; push(...)`)
 * would otherwise empty their own result when we returned the same reference.
 */
export function filterToolsByDisabled<T extends { function: { name: string } }>(
  tools: T[],
  disabledTools?: string[] | Set<string> | null,
): T[] {
  if (!disabledTools || (Array.isArray(disabledTools) ? disabledTools.length === 0 : disabledTools.size === 0)) {
    return [...tools];
  }
  const set = disabledTools instanceof Set ? disabledTools : getDisabledToolSet(disabledTools);
  if (set.size === 0) return [...tools];
  return tools.filter((t) => !set.has(t.function.name));
}

/** Enable or disable one tool; returns the next disabledTools array (sorted). */
export function setToolDisabled(
  disabledTools: string[] | undefined,
  toolName: string,
  enabled: boolean,
): string[] {
  const set = getDisabledToolSet(disabledTools);
  const name = String(toolName || '').trim();
  if (!name) return [...set].sort();
  if (enabled) set.delete(name);
  else set.add(name);
  return [...set].sort();
}
