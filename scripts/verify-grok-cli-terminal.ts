/**
 * Drive the shipped interactive Grok-in-PTY helpers (no live PTY, no grok login).
 */
import './verify-isolate';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildInteractiveGrokCliCommand,
  grokCliInstallHint,
  parseInteractiveGrokCliInvocation,
  pathForShell,
  quoteShellArg,
  resolveGrokCliTerminalIntent,
} from '../lib/grok-cli-terminal';
import { parseSlashCommand } from '../lib/chat-commands';

function main() {
  assert.equal(quoteShellArg(`C:\\Program Files\\grok.exe`, 'powershell'), `'C:\\Program Files\\grok.exe'`);
  assert.equal(quoteShellArg(`it's`, 'powershell'), `'it''s'`);
  assert.match(quoteShellArg(`/tmp/o's`, 'unix'), /'\\''/);

  assert.equal(pathForShell('C:\\Users\\a\\grok.exe', 'wsl'), '/mnt/c/Users/a/grok.exe');
  assert.equal(pathForShell('D:\\bin\\grok.exe', 'git-bash'), '/d/bin/grok.exe');
  assert.equal(pathForShell('C:\\Users\\a\\grok.exe', 'powershell'), 'C:\\Users\\a\\grok.exe');

  assert.equal(resolveGrokCliTerminalIntent({ installed: false, ready: false }, 'auto'), 'missing');
  assert.equal(resolveGrokCliTerminalIntent({ installed: true, ready: false }, 'auto'), 'login');
  assert.equal(resolveGrokCliTerminalIntent({ installed: true, ready: true }, 'auto'), 'agent');
  assert.equal(resolveGrokCliTerminalIntent({ installed: true, ready: true }, 'login'), 'login');

  assert.equal(parseInteractiveGrokCliInvocation('grok'), 'agent');
  assert.equal(parseInteractiveGrokCliInvocation('grok.exe'), 'agent');
  assert.equal(parseInteractiveGrokCliInvocation('C:\\\\Tools\\\\grok.exe login'), 'login');
  assert.equal(parseInteractiveGrokCliInvocation('grok login'), 'login');
  assert.equal(parseInteractiveGrokCliInvocation('echo grok'), null);
  assert.equal(parseInteractiveGrokCliInvocation('grok -p "hi"'), null);
  assert.equal(parseInteractiveGrokCliInvocation('grok --prompt-file x.txt'), null);
  assert.equal(parseInteractiveGrokCliInvocation('grok models'), null);
  assert.equal(parseInteractiveGrokCliInvocation('grok --version'), null);

  const ps = buildInteractiveGrokCliCommand({
    cliPath: 'C:\\Tools\\grok.exe',
    launch: 'agent',
    kind: 'powershell',
    cwd: 'C:\\proj',
  });
  assert.match(ps, /Set-Location -LiteralPath 'C:\\proj'/);
  assert.match(ps, /& 'C:\\Tools\\grok.exe' --no-auto-update/);
  assert.doesNotMatch(ps, /XAI_API_KEY/);
  assert.doesNotMatch(ps, /(^|\s)-p(\s|$)/);

  const login = buildInteractiveGrokCliCommand({
    cliPath: 'C:\\Tools\\grok.exe',
    launch: 'login',
    kind: 'powershell',
  });
  assert.match(login, /--no-auto-update login/);

  const bash = buildInteractiveGrokCliCommand({
    cliPath: 'C:\\Tools\\grok.exe',
    launch: 'agent',
    kind: 'git-bash',
    cwd: 'C:\\proj',
  });
  assert.match(bash, /cd '\/c\/proj' && '\/c\/Tools\/grok.exe' --no-auto-update/);

  assert.match(grokCliInstallHint('win32'), /install\.ps1/);
  assert.match(grokCliInstallHint('linux'), /install\.sh/);

  assert.equal(parseSlashCommand('/grok')?.name, 'grok');
  assert.equal(parseSlashCommand('/cli login')?.name, 'grok');
  assert.equal(parseSlashCommand('/cli login')?.args, 'login');

  const route = readFileSync(new URL('../app/api/terminal/route.ts', import.meta.url), 'utf8');
  assert.match(route, /action === 'grok'/);
  assert.match(route, /launchGrokCliInPty/);

  const term = readFileSync(new URL('../lib/terminal-server.ts', import.meta.url), 'utf8');
  assert.match(term, /parseInteractiveGrokCliInvocation/);
  assert.match(term, /launchGrokCliInPty/);

  const ui = readFileSync(new URL('../components/studio-terminal.tsx', import.meta.url), 'utf8');
  assert.match(ui, /openGrokCliInTerminal/);
  assert.match(ui, /export function StudioTerminalViewport/);
  assert.match(ui, /windowsPty/);
  const ide = readFileSync(new URL('../components/ide-panel.tsx', import.meta.url), 'utf8');
  assert.match(ide, /StudioTerminalViewport/);
  assert.match(ide, /bottomPanel === 'terminal'/);
  const store = readFileSync(new URL('../lib/terminal-ui-store.ts', import.meta.url), 'utf8');
  assert.match(store, /TerminalDock/);
  assert.match(store, /openIdeTerminal/);

  console.log('PASS: interactive Grok CLI terminal launch helpers');
}

main();
