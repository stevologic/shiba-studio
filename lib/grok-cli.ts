import type { ChildProcess } from 'child_process';
import type { ChatStreamEvent } from './chat-types';
import { projectRoot } from './data-paths';
import { parseModelRef } from './model-providers';

const DEFAULT_TIMEOUT_MS = 300_000;

export interface GrokCliStatus {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface GrokCliRunOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  maxTurns?: number;
  systemPrompt?: string;
  timeoutMs?: number;
  outputFormat?: 'plain' | 'json' | 'streaming-json';
  signal?: AbortSignal;
}

let cachedStatus: { at: number; value: GrokCliStatus } | null = null;
const CACHE_MS = 30_000;

async function runExec(command: string, timeout = 8000): Promise<{ stdout: string; stderr: string }> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  return execAsync(command, { timeout }) as Promise<{ stdout: string; stderr: string }>;
}

async function spawnCli(
  executable: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal },
): Promise<ChildProcess> {
  const { spawn } = await import('child_process');
  return spawn(executable, args, {
    cwd: opts.cwd || projectRoot(),
    env: process.env,
    shell: false,
    windowsHide: true,
  });
}

export function clearGrokCliStatusCache(): void {
  cachedStatus = null;
  cachedModels = null;
}

export interface GrokCliModels {
  models: string[];
  defaultModel?: string;
}

let cachedModels: { at: number; value: GrokCliModels } | null = null;
const MODELS_CACHE_MS = 5 * 60_000;

/**
 * Ask the installed Grok CLI which models it supports (`grok models`).
 * The CLI ships with a small fixed list (e.g. grok-composer-2.5-fast, grok-build)
 * that differs from the cloud API catalog, so it must be discovered dynamically.
 */
export async function listGrokCliModels(force = false): Promise<GrokCliModels> {
  if (!force && cachedModels && Date.now() - cachedModels.at < MODELS_CACHE_MS) {
    return cachedModels.value;
  }
  const status = await detectGrokCli();
  if (!status.installed || !status.path) {
    const value = { models: [] };
    cachedModels = { at: Date.now(), value };
    return value;
  }
  try {
    const isWin = process.platform === 'win32';
    const quote = isWin ? `"${status.path.replace(/"/g, '\\"')}"` : `"${status.path}"`;
    const { stdout } = await runExec(`${quote} models`, 15000);
    const models: string[] = [];
    let defaultModel: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const defMatch = line.match(/^\s*Default model:\s*(\S+)/i);
      if (defMatch) defaultModel = defMatch[1];
      const itemMatch = line.match(/^\s*[*-]\s+(\S+)/);
      if (itemMatch) {
        models.push(itemMatch[1]);
        if (/\(default\)/i.test(line)) defaultModel = itemMatch[1];
      }
    }
    const value = { models, defaultModel: defaultModel || models[0] };
    cachedModels = { at: Date.now(), value };
    return value;
  } catch {
    const value = { models: [] };
    cachedModels = { at: Date.now(), value };
    return value;
  }
}

export async function detectGrokCli(force = false): Promise<GrokCliStatus> {
  if (!force && cachedStatus && Date.now() - cachedStatus.at < CACHE_MS) {
    return cachedStatus.value;
  }

  try {
    const isWin = process.platform === 'win32';
    const whichCmd = isWin ? 'where grok' : 'which grok';
    const { stdout: whichOut } = await runExec(whichCmd);
    const cliPath = whichOut.trim().split(/\r?\n/).find((l) => l.trim())?.trim();
    if (!cliPath) {
      const value = { installed: false, error: 'grok not found on PATH' };
      cachedStatus = { at: Date.now(), value };
      return value;
    }

    const quote = isWin ? `"${cliPath.replace(/"/g, '\\"')}"` : `"${cliPath}"`;
    const { stdout } = await runExec(`${quote} --version`);
    const version = stdout.trim().split(/\r?\n/)[0] || 'unknown';
    const value: GrokCliStatus = { installed: true, path: cliPath, version };
    cachedStatus = { at: Date.now(), value };
    return value;
  } catch (e: unknown) {
    const value: GrokCliStatus = {
      installed: false,
      error: e instanceof Error ? e.message : 'Grok CLI not detected',
    };
    cachedStatus = { at: Date.now(), value };
    return value;
  }
}

export function grokCliModelId(modelRef?: string): string | undefined {
  if (!modelRef?.trim()) return undefined;
  const ref = parseModelRef(modelRef);
  if (ref.provider === 'cloud') return ref.id;
  return ref.id || undefined;
}

function buildCliArgs(opts: GrokCliRunOptions): string[] {
  const args = [
    '-p', opts.prompt,
    '--output-format', opts.outputFormat || 'plain',
    '--permission-mode', 'bypassPermissions',
  ];
  if (opts.cwd) args.push('--cwd', opts.cwd);
  const model = grokCliModelId(opts.model);
  if (model) args.push('-m', model);
  if (opts.reasoningEffort) args.push('--reasoning-effort', opts.reasoningEffort);
  if (opts.maxTurns != null) args.push('--max-turns', String(opts.maxTurns));
  if (opts.systemPrompt?.trim()) args.push('--system-prompt-override', opts.systemPrompt.trim());
  return args;
}

export function buildCliPromptFromMessages(
  messages: Array<{ role: string; content: string }>,
  systemParts: string[] = [],
): string {
  const lines: string[] = [];
  if (systemParts.length) {
    lines.push(systemParts.join('\n\n'), '');
  }
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
    if (m.content?.trim()) lines.push(`${role}: ${m.content.trim()}`);
  }
  lines.push('', 'Reply as Assistant:');
  return lines.join('\n');
}

export async function runGrokCliPrompt(opts: GrokCliRunOptions): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}> {
  const status = await detectGrokCli();
  if (!status.installed) {
    return {
      ok: false,
      stdout: '',
      stderr: status.error || 'Grok CLI is not installed',
      code: 127,
    };
  }

  const args = buildCliArgs(opts);
  const executable = status.path || 'grok';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = await spawnCli(executable, args, { cwd: opts.cwd, signal: opts.signal });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: { ok: boolean; stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        ok: false,
        stdout,
        stderr: `${stderr}\n(Grok CLI timed out after ${timeoutMs}ms)`.trim(),
        code: -1,
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      finish({ ok: false, stdout, stderr: err.message, code: 1 });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        stdout,
        stderr,
        code: code ?? 1,
      });
    });

    opts.signal?.addEventListener('abort', () => {
      child.kill('SIGTERM');
      finish({ ok: false, stdout, stderr: 'Aborted', code: -1 });
    }, { once: true });
  });
}

/** Errors the installed CLI emits when it does not recognize a model id. */
function isCliModelError(stderr: string): boolean {
  return /couldn'?t set model|unknown variant|invalid model/i.test(stderr);
}

export async function* streamGrokCli(opts: GrokCliRunOptions): AsyncGenerator<ChatStreamEvent> {
  const status = await detectGrokCli();
  if (!status.installed) {
    yield {
      type: 'error',
      message: 'Grok CLI is not installed. Install: curl -fsSL https://x.ai/cli/install.sh | bash',
    };
    return;
  }

  const executable = status.path || 'grok';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Installed CLIs ship with a fixed model list — if the selected model is newer
  // than the binary, retry once with the CLI's own default model.
  const modelAttempts: Array<string | undefined> = opts.model ? [opts.model, undefined] : [undefined];

  for (let attempt = 0; attempt < modelAttempts.length; attempt++) {
    const model = modelAttempts[attempt];
    const args = buildCliArgs({ ...opts, model });
    const child = await spawnCli(executable, args, { cwd: opts.cwd, signal: opts.signal });

    let stderr = '';
    let exitCode: number | null = null;
    let gotStdout = false;
    const buffer: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;

    const wait = () => new Promise<void>((resolve) => {
      wake = resolve;
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += `\n(Grok CLI timed out after ${timeoutMs}ms)`;
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      gotStdout = true;
      buffer.push(chunk.toString());
      wake?.();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      wake?.();
    });
    child.on('error', (err) => {
      stderr += err.message;
      closed = true;
      wake?.();
    });
    child.on('close', (code) => {
      exitCode = code;
      closed = true;
      clearTimeout(timer);
      wake?.();
    });

    opts.signal?.addEventListener('abort', () => {
      child.kill('SIGTERM');
      closed = true;
      wake?.();
    }, { once: true });

    while (!closed || buffer.length) {
      if (buffer.length) {
        yield { type: 'content', delta: buffer.shift()! };
      } else if (!closed) {
        await wait();
        wake = null;
      } else {
        break;
      }
    }

    if (exitCode === 0 || gotStdout) {
      yield { type: 'done', model: `grok-cli:${model ? grokCliModelId(model) : 'default'}` };
      return;
    }

    if (attempt === 0 && model && isCliModelError(stderr)) {
      yield {
        type: 'thinking',
        delta: `Local Grok CLI (${status.version || 'installed version'}) does not support model "${grokCliModelId(model)}" — retrying with the CLI's default model.\n`,
      };
      continue;
    }

    yield { type: 'error', message: stderr.trim() || `Grok CLI exited with code ${exitCode}` };
    return;
  }
}