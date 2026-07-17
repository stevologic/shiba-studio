export type IdeWorkspaceOptionKind = 'default' | 'project' | 'worktree';

/**
 * A selectable IDE root. Paths are canonical for available directories and
 * absolute lexical paths for unavailable project/default folders.
 */
export interface IdeWorkspaceOption {
  /** Stable opaque value for picker selection and React keys. */
  id: string;
  kind: IdeWorkspaceOptionKind;
  label: string;
  path: string;
  available: boolean;
  isDefault?: boolean;
  projectId?: string;
  projectName?: string;
  agentId?: string;
  agentName?: string;
  /** Canonical repository/workspace from which a Git worktree was found. */
  basePath?: string;
  branch?: string;
  detail?: string;
}

export interface IdeWorkspaceOptionsResponse {
  ok: true;
  /** Canonical when available; otherwise the configured absolute path. */
  defaultWorkspace: string;
  /** Default is always present and first. Every path appears at most once. */
  options: IdeWorkspaceOption[];
  projectCount: number;
}

export interface IdeWorkspaceOptionsErrorResponse {
  ok: false;
  error: string;
}
