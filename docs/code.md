# Code IDE

The **Code** page turns any local workspace into a full editing surface inside Shiba Studio. It uses the same editor engine that powers VS Code, while keeping file, Git, GitHub, and terminal operations on the local Shiba Studio server.

## Open a workspace

Code starts in the default workspace from **Settings → Agent behavior & workspace**. Change that setting when you want Code and local agents to work in a different project.

The Explorer loads folders only when you expand them, so large repositories remain responsive. Common generated directories such as `.git`, `node_modules`, `.next`, `dist`, `build`, and `coverage` stay out of the tree. Dotfiles such as `.gitignore` and folders such as `.github` remain visible.

## Edit files

- Open several files in tabs and switch between them without losing undo history.
- Syntax highlighting, bracket matching, find/replace, minimap, autocomplete, and built-in JavaScript, TypeScript, JSON, CSS, and HTML diagnostics come from Monaco.
- **Ctrl/Cmd+S** saves the active file.
- Dirty tabs keep a visible marker until their contents are saved.
- The Problems panel reports real Monaco diagnostics; it does not invent sample errors.

The IDE rejects binary and oversized files for inline editing. File paths are resolved inside the selected workspace, including symlink checks, before the server reads or changes them.

## Search the repository

Open **Search** from the activity rail and enter text to search the workspace. Results include the file, line, column, and matching line. Selecting a result opens the file at that location.

## Source control

The **Source Control** activity uses the installed Git executable and returns structured repository state:

- current branch, upstream, ahead/behind counts, and remotes;
- staged, unstaged, untracked, renamed, and conflicted files;
- per-file stage, unstage, discard, and diff actions;
- staged-only commits;
- fetch, fast-forward-only pull, push, branch switch, and branch creation;
- recent commit history.

Commit messages and paths are passed to Git as argument arrays rather than shell-built commands. Discard remains a destructive action and requires confirmation in the interface.

## GitHub

For a workspace whose `origin` points to GitHub, the **GitHub** activity can show open pull requests, issues, and recent workflow runs. It can push the current branch and create a pull request, or create an issue.

Connect a GitHub personal access token under **Capabilities → GitHub**. The token remains server-side and is never returned to the Code page.

## Terminal and commands

The terminal button opens Shiba Studio’s existing persistent host terminal. It is a real `xterm.js` and `node-pty` session that survives page navigation and can also be opened with **Ctrl/Cmd+`**.

Use **Ctrl/Cmd+Shift+P** for Code commands such as saving, refreshing the tree and repository state, changing activities, and opening the terminal. The app-wide **Ctrl/Cmd+K** palette stays out of Monaco’s keyboard-chord handling while the editor has focus.

## Capability boundary

The first release provides Monaco’s browser language services, not a general language-server or debugger host. Languages outside Monaco’s built-in services receive syntax-aware editing but may not provide project-wide definitions, references, or diagnostics. Extension marketplace and multi-terminal support are future capabilities.
