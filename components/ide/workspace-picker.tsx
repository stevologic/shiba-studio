'use client';

import { ChevronDown, FolderOpen } from 'lucide-react';
import type {
  IdeWorkspaceOption,
  IdeWorkspaceOptionKind,
} from '@/lib/ide-workspace-options-types';
import styles from '../ide-panel.module.css';

interface WorkspacePickerProps {
  currentPath: string;
  currentLabel: string;
  options: IdeWorkspaceOption[];
  loading: boolean;
  onSelect: (option: IdeWorkspaceOption) => void;
}

const GROUPS: Array<{
  kind: IdeWorkspaceOptionKind;
  label: string;
}> = [
  { kind: 'default', label: 'Default workspace' },
  { kind: 'project', label: 'Projects' },
  { kind: 'worktree', label: 'Git worktrees' },
];

function comparablePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

function duplicateContext(
  option: IdeWorkspaceOption,
  options: IdeWorkspaceOption[],
): string {
  const duplicateCount = options.filter((candidate) => (
    candidate.kind === option.kind
    && candidate.label === option.label
    && candidate.branch === option.branch
  )).length;
  if (duplicateCount < 2) return '';
  if (option.kind === 'worktree') {
    return [option.projectName, option.basePath].filter(Boolean).join(' · ');
  }
  return option.path;
}

function optionText(
  option: IdeWorkspaceOption,
  options: IdeWorkspaceOption[],
): string {
  const suffix = option.branch && option.branch !== option.label
    ? ` — ${option.branch}`
    : option.available
      ? ''
      : ' — unavailable';
  const context = duplicateContext(option, options);
  return `${option.label}${suffix}${context ? ` · ${context}` : ''}`;
}

export function WorkspacePicker({
  currentPath,
  currentLabel,
  options,
  loading,
  onSelect,
}: WorkspacePickerProps) {
  const exactOption = options.find((option) => option.path === currentPath);
  const currentOption = exactOption || options.find(
    (option) => comparablePath(option.path) === comparablePath(currentPath),
  );

  return (
    <label className={styles.workspacePicker} title={currentPath}>
      <FolderOpen size={13} aria-hidden />
      <select
        aria-label="Open Code workspace"
        value={currentOption?.id || ''}
        disabled={loading}
        onChange={(event) => {
          const selected = options.find((option) => option.id === event.target.value);
          if (selected?.available) onSelect(selected);
        }}
      >
        {!currentOption && (
          <option value="">{loading ? 'Loading workspaces…' : currentLabel}</option>
        )}
        {GROUPS.map((group) => {
          const groupOptions = options.filter((option) => option.kind === group.kind);
          if (groupOptions.length === 0) return null;
          return (
            <optgroup label={group.label} key={group.kind}>
              {groupOptions.map((option) => (
                <option
                  value={option.id}
                  disabled={!option.available}
                  key={option.id}
                >
                  {optionText(option, options)}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      <ChevronDown className={styles.workspacePickerChevron} size={12} aria-hidden />
    </label>
  );
}
