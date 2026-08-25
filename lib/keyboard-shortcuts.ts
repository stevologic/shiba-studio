export interface StudioShortcut {
  keys: string;
  macKeys?: string;
  action: string;
}

export interface StudioShortcutGroup {
  id: string;
  title: string;
  items: StudioShortcut[];
}

/** Studio-wide shortcuts shown in the `?` / Ctrl+/ overlay. */
export const STUDIO_SHORTCUTS: StudioShortcutGroup[] = [
  {
    id: 'studio',
    title: 'Studio',
    items: [
      { keys: 'Ctrl+K', macKeys: '⌘K', action: 'Command palette and global search' },
      { keys: 'Ctrl+/', macKeys: '⌘/', action: 'Keyboard shortcuts' },
      { keys: '?', action: 'Keyboard shortcuts when not typing' },
      { keys: 'Ctrl+`', macKeys: '⌘`', action: 'Toggle the host terminal' },
      { keys: 'Esc', action: 'Close the topmost dialog' },
    ],
  },
  {
    id: 'chat',
    title: 'Chat',
    items: [
      { keys: 'Ctrl+N', macKeys: '⌘N', action: 'New chat session' },
      { keys: 'Ctrl+Shift+N', macKeys: '⌘⇧N', action: 'New ephemeral chat' },
      { keys: '/', action: 'Open slash-command autocomplete' },
      { keys: 'Enter', action: 'Send or queue the composer' },
    ],
  },
  {
    id: 'code',
    title: 'Code IDE',
    items: [
      { keys: 'Ctrl+P', macKeys: '⌘P', action: 'Quick open a file' },
      { keys: 'Ctrl+S', macKeys: '⌘S', action: 'Save the active file' },
      { keys: 'Ctrl+Shift+P', macKeys: '⌘⇧P', action: 'Code command palette' },
      { keys: 'Ctrl+Shift+E', macKeys: '⌘⇧E', action: 'Show the explorer' },
      { keys: 'Ctrl+Shift+G', macKeys: '⌘⇧G', action: 'Show source control' },
      { keys: 'Ctrl+J', macKeys: '⌘J', action: 'Toggle the bottom panel' },
    ],
  },
];

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('.monaco-editor')) return true;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

export function prefersMacShortcuts(userAgent = ''): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(userAgent);
}

export function shortcutLabel(item: StudioShortcut, mac: boolean): string {
  return mac && item.macKeys ? item.macKeys : item.keys;
}
