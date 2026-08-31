/**
 * Interactive Grok Build in the Studio Terminal PTY.
 *
 * Headless `-p` stays the chat/agent harness. Sign-in and the official TUI
 * need a real terminal — so Shiba types the detected binary into the shared
 * host PTY instead of asking the operator to leave the app.
 */
import type { TerminalShell } from './terminal-shell';
import type { GrokCliStatus } from './grok-cli';

export type GrokCliTerminalIntent = 'auto' | 'agent' | 'login';
export type GrokCliTerminalLaunch = 'agent' | 'login';

const HEADLESS_FLAG_RE = /(?:^|\s)(-p|--prompt(?:-file)?|--single|--output-format|--json-schema)\b/i;
const META_CMD_RE = /(?:^|\s)(models|--help|-h|--version)(?:\s|$)/i;

export function quoteShellArg(value: string, kind: TerminalShell['kind']): string {
  const raw = String(value || '');
  if (kind === 'powershell' || kind === 'cmd') {
    return `'${raw.replace(/'/g, "''")}'`;
  }
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

/** Convert a Windows path so Git Bash / WSL can execute it. */
export function pathForShell(absPath: string, kind: TerminalShell['kind']): string {
  const value = String(absPath || '');
  const win = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!win) return value;
  const drive = win[1].toLowerCase();
  const rest = win[2].replace(/\\/g, '/');
  if (kind === 'wsl') return `/mnt/${drive}/${rest}`;
  if (kind === 'git-bash') return `/${drive}/${rest}`;
  return value;
}

export function resolveGrokCliTerminalIntent(
  status: Pick<GrokCliStatus, 'installed' | 'ready'>,
  requested: GrokCliTerminalIntent = 'auto',
): GrokCliTerminalLaunch | 'missing' {
  if (!status.installed) return 'missing';
  if (requested === 'login') return 'login';
  if (requested === 'agent') return 'agent';
  return status.ready ? 'agent' : 'login';
}

/**
 * Detect an operator/agent asking the shared PTY to start interactive Grok
 * (bare `grok` / `grok login`), not a headless one-shot.
 */
export function parseInteractiveGrokCliInvocation(command: string): GrokCliTerminalLaunch | null {
  const raw = String(command || '').trim();
  if (!raw || HEADLESS_FLAG_RE.test(raw) || META_CMD_RE.test(raw)) return null;
  const first = raw.replace(/^["']/, '').split(/[\s"']+/).find(Boolean) || '';
  const base = first.replace(/\\/g, '/').split('/').pop() || '';
  if (!/^grok(?:\.exe)?$/i.test(base)) return null;
  return /\blogin\b/i.test(raw) ? 'login' : 'agent';
}

export function grokCliInstallHint(platform = process.platform): string {
  return platform === 'win32'
    ? 'irm https://x.ai/cli/install.ps1 | iex'
    : 'curl -fsSL https://x.ai/cli/install.sh | bash';
}

export function buildInteractiveGrokCliCommand(input: {
  cliPath: string;
  launch: GrokCliTerminalLaunch;
  kind: TerminalShell['kind'];
  cwd?: string;
}): string {
  const exe = quoteShellArg(pathForShell(input.cliPath, input.kind), input.kind);
  const args = ['--no-auto-update'];
  if (input.launch === 'login') args.push('login');
  const invoke = input.kind === 'powershell' ? `& ${exe} ${args.join(' ')}` : `${exe} ${args.join(' ')}`;
  const cwd = input.cwd?.trim();
  if (!cwd) return invoke;
  const dir = quoteShellArg(pathForShell(cwd, input.kind), input.kind);
  if (input.kind === 'powershell') return `Set-Location -LiteralPath ${dir}; ${invoke}`;
  if (input.kind === 'cmd') return `cd /d ${dir} && ${invoke}`;
  return `cd ${dir} && ${invoke}`;
}
