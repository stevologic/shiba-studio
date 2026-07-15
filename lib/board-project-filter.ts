import type { BoardTask } from './board-types';

export const BOARD_PROJECT_FILTER_ALL = '__all_projects__' as const;
export const BOARD_PROJECT_FILTER_UNASSIGNED = '__no_project__' as const;

const BOARD_PROJECT_FILTER_PREFIX = 'project:';

export type BoardProjectFilter =
  | typeof BOARD_PROJECT_FILTER_ALL
  | typeof BOARD_PROJECT_FILTER_UNASSIGNED
  | `project:${string}`;

export function boardProjectFilterForId(projectId: string): BoardProjectFilter {
  return `${BOARD_PROJECT_FILTER_PREFIX}${projectId}`;
}

export function boardProjectIdFromFilter(filter: BoardProjectFilter): string | null {
  if (!filter.startsWith(BOARD_PROJECT_FILTER_PREFIX)) return null;
  return filter.slice(BOARD_PROJECT_FILTER_PREFIX.length).trim() || null;
}

export function boardTaskMatchesProjectFilter(
  task: Pick<BoardTask, 'projectId'>,
  filter: BoardProjectFilter,
): boolean {
  if (filter === BOARD_PROJECT_FILTER_ALL) return true;
  if (filter === BOARD_PROJECT_FILTER_UNASSIGNED) return !task.projectId;
  const projectId = boardProjectIdFromFilter(filter);
  return projectId ? task.projectId === projectId : true;
}
