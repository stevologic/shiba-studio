'use client';

import React from 'react';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Settings2,
} from 'lucide-react';
import styles from '../ide-panel.module.css';

export interface IdeFileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: IdeFileNode[];
  loaded?: boolean;
  size?: number;
}

interface FileTreeProps {
  nodes: IdeFileNode[];
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  activePath: string | null;
  loadingPaths: ReadonlySet<string>;
  onToggle: (node: IdeFileNode) => void;
  onOpen: (node: IdeFileNode) => void;
  onSelect: (node: IdeFileNode) => void;
}

function findNode(nodes: IdeFileNode[], path: string): IdeFileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const child = findNode(node.children, path);
      if (child) return child;
    }
  }
  return null;
}

function FileGlyph({ node, expanded }: { node: IdeFileNode; expanded: boolean }) {
  if (node.type === 'directory') {
    return expanded
      ? <FolderOpen size={15} aria-hidden />
      : <Folder size={15} aria-hidden />;
  }

  const extension = node.name.split('.').pop()?.toLowerCase() || '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension)) {
    return <Braces size={14} aria-hidden />;
  }
  if (['json', 'jsonc'].includes(extension)) return <FileJson size={14} aria-hidden />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(extension)) {
    return <ImageIcon size={14} aria-hidden />;
  }
  if (['css', 'scss', 'less', 'html', 'vue', 'svelte', 'py', 'go', 'rs', 'java', 'rb', 'php'].includes(extension)) {
    return <FileCode2 size={14} aria-hidden />;
  }
  if (['yaml', 'yml', 'toml', 'ini', 'env'].includes(extension) || node.name.startsWith('.')) {
    return <Settings2 size={14} aria-hidden />;
  }
  return <FileText size={14} aria-hidden />;
}

function TreeLevel({
  nodes,
  depth,
  expanded,
  selectedPath,
  activePath,
  loadingPaths,
  onToggle,
  onOpen,
  onSelect,
}: FileTreeProps & { depth: number }) {
  return (
    <>
      {nodes.map((node) => {
        const isDirectory = node.type === 'directory';
        const isExpanded = isDirectory && expanded.has(node.path);
        const isSelected = selectedPath === node.path;
        const isActive = activePath === node.path;
        const isLoading = loadingPaths.has(node.path);

        const activate = () => {
          onSelect(node);
          if (isDirectory) onToggle(node);
          else onOpen(node);
        };

        return (
          <React.Fragment key={node.path}>
            <div
              className={[
                styles.treeRow,
                isSelected ? styles.treeRowSelected : '',
                isActive ? styles.treeRowActive : '',
              ].filter(Boolean).join(' ')}
              style={{ paddingInlineStart: `${8 + depth * 14}px` }}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={isDirectory ? isExpanded : undefined}
              aria-selected={isSelected}
              data-path={node.path}
              tabIndex={isSelected || (!selectedPath && depth === 0) ? 0 : -1}
              title={node.path}
              onClick={activate}
              onDoubleClick={() => {
                if (!isDirectory) onOpen(node);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  activate();
                } else if (event.key === 'ArrowRight' && isDirectory && !isExpanded) {
                  event.preventDefault();
                  onToggle(node);
                } else if (event.key === 'ArrowLeft' && isDirectory && isExpanded) {
                  event.preventDefault();
                  onToggle(node);
                }
              }}
            >
              <span className={styles.treeChevron}>
                {isDirectory
                  ? isExpanded
                    ? <ChevronDown size={13} aria-hidden />
                    : <ChevronRight size={13} aria-hidden />
                  : null}
              </span>
              <span className={styles.treeGlyph}>
                <FileGlyph node={node} expanded={isExpanded} />
              </span>
              <span className={styles.treeName}>{node.name}</span>
              {isLoading && <span className={styles.miniSpinner} aria-label="Loading folder" />}
            </div>
            {isDirectory && isExpanded && node.children && (
              <TreeLevel
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                activePath={activePath}
                loadingPaths={loadingPaths}
                onToggle={onToggle}
                onOpen={onOpen}
                onSelect={onSelect}
              />
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

export function FileTree(props: FileTreeProps) {
  return (
    <div
      className={styles.tree}
      role="tree"
      aria-label="Workspace files"
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const currentRow = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
        if (!currentRow) return;
        const rows = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'),
        );
        const currentIndex = rows.indexOf(currentRow);
        if (currentIndex < 0 || rows.length === 0) return;
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : event.key === 'ArrowDown'
              ? Math.min(rows.length - 1, currentIndex + 1)
              : Math.max(0, currentIndex - 1);
        const nextRow = rows[nextIndex];
        const nextPath = nextRow.dataset.path;
        if (!nextPath) return;
        const nextNode = findNode(props.nodes, nextPath);
        if (!nextNode) return;
        event.preventDefault();
        nextRow.focus();
        props.onSelect(nextNode);
      }}
    >
      <TreeLevel {...props} depth={0} />
    </div>
  );
}
