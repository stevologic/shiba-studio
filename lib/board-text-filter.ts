// Board text/ID search — filters cards by SHIB key or free text.
// Pure helpers so the Kanban UI and verify scripts share one matching rule.

import type { BoardTask } from './board-types';

/** Fields the Board search box matches against. */
export type BoardSearchableTask = Pick<BoardTask, 'key' | 'title' | 'description' | 'labels'>;

/** Normalize a search query: trim + case-fold. Empty means "no filter". */
export function normalizeBoardSearchQuery(query: string): string {
  return String(query || '').trim().toLowerCase();
}

/**
 * True when the card matches the Board search box.
 * Empty / whitespace-only query matches every card.
 * Non-empty queries match case-insensitively against:
 *   - SHIB key (e.g. "SHIB-69", "shib-69", "69")
 *   - title, description, and labels
 */
export function boardTaskMatchesTextFilter(
  task: BoardSearchableTask,
  query: string,
): boolean {
  const q = normalizeBoardSearchQuery(query);
  if (!q) return true;

  const key = String(task.key || '').toLowerCase();
  if (key.includes(q)) return true;

  // Bare numeric fragments still hit SHIB keys: "69" → SHIB-69
  const keyDigits = key.replace(/^shib-/, '');
  const queryDigits = q.replace(/^shib[-\s]?/, '');
  if (queryDigits && keyDigits.includes(queryDigits) && /^\d+$/.test(queryDigits)) {
    return true;
  }

  const title = String(task.title || '').toLowerCase();
  if (title.includes(q)) return true;

  const description = String(task.description || '').toLowerCase();
  if (description.includes(q)) return true;

  const labels = Array.isArray(task.labels) ? task.labels : [];
  for (const label of labels) {
    if (String(label || '').toLowerCase().includes(q)) return true;
  }

  return false;
}