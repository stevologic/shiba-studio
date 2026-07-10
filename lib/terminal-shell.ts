/**
 * Resolve a real interactive shell for the host terminal.
 * Prefer a Linux/POSIX shell (WSL bash → Git Bash → $SHELL / bash)
 * so the UX is consistent across Windows, macOS, and Linux.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export type TerminalShell = {
  file: string;
  args: string[];
  label: string;
  kind: 'wsl' | 'git-bash' | 'unix' | 'powershell' | 'cmd' | 'custom';
  cwd: string;
};

const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
];

function existsExec(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  }
}

function defaultCwd(): string {
  const fromEnv = process.env.SHIBA_TERMINAL_CWD?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

function tryWslBash(): TerminalShell | null {
  if (process.platform !== 'win32') return null;
  try {
    // wsl -l -q emits UTF-16 LE on Windows.
    const raw = execFileSync('wsl.exe', ['-l', '-q'], {
      encoding: 'buffer',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }) as Buffer;
    const text = raw.toString('utf16le').replace(/\0/g, '');
    const distros = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((d) => !/docker-desktop/i.test(d) && !/docker-desktop-data/i.test(d));

    for (const distro of distros) {
      try {
        execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', 'echo ok'], {
          timeout: 6000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return {
          file: 'wsl.exe',
          args: ['-d', distro, '--', 'bash', '-l'],
          label: `WSL · ${distro}`,
          kind: 'wsl',
          cwd: defaultCwd(),
        };
      } catch {
        /* try next distro */
      }
    }
  } catch {
    /* no WSL */
  }
  return null;
}

function tryGitBash(): TerminalShell | null {
  if (process.platform !== 'win32') return null;
  for (const file of GIT_BASH_CANDIDATES) {
    if (!file || !existsExec(file)) continue;
    return {
      file,
      args: ['--login', '-i'],
      label: 'Git Bash',
      kind: 'git-bash',
      cwd: defaultCwd(),
    };
  }
  return null;
}

function tryUnixShell(): TerminalShell | null {
  if (process.platform === 'win32') return null;
  const preferred = [
    process.env.SHIBA_TERMINAL_SHELL,
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/usr/bin/zsh',
    '/usr/bin/bash',
    '/bin/sh',
  ].filter(Boolean) as string[];

  for (const file of preferred) {
    if (!existsExec(file)) continue;
    const base = path.basename(file);
    const loginArgs =
      base === 'zsh' || base === 'bash' ? ['-l'] : base === 'sh' ? [] : ['-l'];
    return {
      file,
      args: loginArgs,
      label: base,
      kind: 'unix',
      cwd: defaultCwd(),
    };
  }
  return null;
}

function windowsFallback(): TerminalShell {
  const ps = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (existsExec(ps)) {
    return {
      file: ps,
      args: ['-NoLogo', '-NoExit'],
      label: 'PowerShell',
      kind: 'powershell',
      cwd: defaultCwd(),
    };
  }
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: [],
    label: 'cmd',
    kind: 'cmd',
    cwd: defaultCwd(),
  };
}

/** Env override: SHIBA_TERMINAL_SHELL=/path/to/shell (optional SHIBA_TERMINAL_ARGS space-separated). */
function tryCustomShell(): TerminalShell | null {
  const file = process.env.SHIBA_TERMINAL_SHELL?.trim();
  if (!file) return null;
  if (process.platform !== 'win32' && !existsExec(file) && !path.isAbsolute(file)) {
    // allow bare names like "bash" on PATH
  } else if (path.isAbsolute(file) && !existsExec(file)) {
    return null;
  }
  const args = (process.env.SHIBA_TERMINAL_ARGS || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    file,
    args,
    label: path.basename(file) || 'custom',
    kind: 'custom',
    cwd: defaultCwd(),
  };
}

export function resolveTerminalShell(): TerminalShell {
  const custom = tryCustomShell();
  if (custom) return custom;

  // Linux-first preference order
  const wsl = tryWslBash();
  if (wsl) return wsl;

  const gitBash = tryGitBash();
  if (gitBash) return gitBash;

  const unix = tryUnixShell();
  if (unix) return unix;

  if (process.platform === 'win32') return windowsFallback();

  // Last resort on Unix
  return {
    file: '/bin/sh',
    args: [],
    label: 'sh',
    kind: 'unix',
    cwd: defaultCwd(),
  };
}

export function terminalShellPublicInfo(shell: TerminalShell = resolveTerminalShell()) {
  return {
    label: shell.label,
    kind: shell.kind,
    file: shell.file,
    args: shell.args,
    cwd: shell.cwd,
    platform: process.platform,
    arch: process.arch,
  };
}
