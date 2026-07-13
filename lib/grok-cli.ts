import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import type { ChatStreamEvent } from './chat-types';
import { projectRoot } from './data-paths';
import { parseModelRef } from './model-providers';
import { terminateProcessTree } from './process-control';

const DEFAULT_TIMEOUT_MS = 300_000;
const GROK_ISOLATED_HOME_PREFIX = 'shiba-grok-isolated-';
const GROK_PROMPT_FILE_PREFIX = 'shiba-grok-cli-prompt-';
const DEFAULT_TEMPORARY_RESOURCE_AGE_MS = 7 * 24 * 60 * 60_000;

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
  /** Agentic effort level (low|medium|high|xhigh|max) — CLI --effort */
  effort?: string;
  /** Append a self-verification loop (headless) — CLI --check */
  check?: boolean;
  /** Run the task N ways in parallel, keep the best (headless) — CLI --best-of-n */
  bestOfN?: number;
  /** JSON Schema string constraining output to structured JSON — CLI --json-schema */
  jsonSchema?: string;
  /** Never default to bypassPermissions; callers must opt into an allowed CLI mode. */
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'plan';
  /** Remove memory, subagents, web search, and ambient tool surfaces for scoped handoffs. */
  isolated?: boolean;
  /** Additional non-secret environment entries for a scoped child process. */
  env?: Record<string, string>;
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
  opts: { cwd?: string; signal?: AbortSignal; env?: Record<string, string>; isolated?: boolean },
): Promise<ChildProcess> {
  const { spawn } = await import('child_process');
  const safeKeys = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
  ];
  if (!opts.isolated) safeKeys.push('HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA');
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of safeKeys) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(opts.env || {})) {
    if (/^[A-Z][A-Z0-9_]{0,63}$/i.test(key) && !/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|COOKIE|AUTH)/i.test(key)) {
      env[key] = value.slice(0, 4_000);
    }
  }
  let isolatedHome: string | undefined;
  if (opts.isolated) {
    const [{ mkdtemp, rm }, os, path] = await Promise.all([
      import('fs/promises'),
      import('os'),
      import('path'),
    ]);
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), GROK_ISOLATED_HOME_PREFIX));
    env.HOME = isolatedHome;
    env.USERPROFILE = isolatedHome;
    env.LOCALAPPDATA = path.join(isolatedHome, 'local');
    env.APPDATA = path.join(isolatedHome, 'roaming');
    const child = spawn(executable, args, {
      cwd: opts.cwd || projectRoot(),
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    child.once('exit', () => { void rm(isolatedHome!, { recursive: true, force: true }); });
    child.once('error', () => { void rm(isolatedHome!, { recursive: true, force: true }); });
    return child;
  }
  return spawn(executable, args, {
    cwd: opts.cwd || projectRoot(),
    env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
}

export function clearGrokCliStatusCache(): void {
  cachedStatus = null;
  cachedModels = null;
}

export interface GrokCliTemporaryResourceReport {
  isolatedHomesRemoved: number;
  promptFilesRemoved: number;
  youngResourcesRetained: number;
  errors: string[];
}

/**
 * Reclaim crash-left CLI resources. Only direct children with the exact names
 * produced above/below are eligible, and a long age grace prevents a live CLI
 * process from losing its isolated HOME or prompt file.
 */
export async function reconcileGrokCliTemporaryResources(options: {
  nowMs?: number;
  minAgeMs?: number;
  temporaryRoot?: string;
} = {}): Promise<GrokCliTemporaryResourceReport> {
  const [{ readdir, lstat, rm }, os, path] = await Promise.all([
    import('fs/promises'),
    import('os'),
    import('path'),
  ]);
  const report: GrokCliTemporaryResourceReport = {
    isolatedHomesRemoved: 0,
    promptFilesRemoved: 0,
    youngResourcesRetained: 0,
    errors: [],
  };
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const minAgeMs = Math.max(60_000, Number(options.minAgeMs) || DEFAULT_TEMPORARY_RESOURCE_AGE_MS);
  const root = path.resolve(options.temporaryRoot || os.tmpdir());
  const homePattern = /^shiba-grok-isolated-[A-Za-z0-9]{6}$/;
  const promptPattern = /^shiba-grok-cli-prompt-\d{12,16}-[a-z0-9]{6,16}\.txt$/;
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    report.errors.push(`temporary root: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });

  for (const entry of entries) {
    const isHome = entry.isDirectory() && homePattern.test(entry.name);
    const isPrompt = entry.isFile() && promptPattern.test(entry.name);
    if (!isHome && !isPrompt) continue;
    const candidate = path.resolve(root, entry.name);
    if (path.dirname(candidate) !== root) continue;
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink() || (isHome ? !stat.isDirectory() : !stat.isFile())) continue;
      const age = nowMs - stat.mtimeMs;
      if (!Number.isFinite(age) || age < minAgeMs) {
        report.youngResourcesRetained += 1;
        continue;
      }
      await rm(candidate, { recursive: isHome, force: true });
      if (isHome) report.isolatedHomesRemoved += 1;
      else report.promptFilesRemoved += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      report.errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
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
  // Accept cloud:/cli:/grok-cli: or bare ids — CLI always wants the bare model name.
  if (ref.provider === 'cloud' || ref.provider === 'cli' || ref.provider === 'local') {
    return ref.id || undefined;
  }
  return ref.id || undefined;
}

/**
 * Windows CreateProcess caps the full command line at ~32,767 chars; cmd.exe
 * is ~8,191. Multi-turn chat histories (especially ones with embedded
 * browser-screenshot data URIs) blow past that and surface as
 * `Error: spawn ENAMETOOLONG`. Above this threshold we hand the prompt to the
 * CLI via `--prompt-file` instead of `-p`.
 */
const PROMPT_INLINE_MAX_BYTES = 4_000;

function buildCliArgsBase(opts: Omit<GrokCliRunOptions, 'prompt'>): string[] {
  const args = [
    '--output-format', opts.outputFormat || 'plain',
    '--permission-mode', opts.permissionMode || 'acceptEdits',
  ];
  if (opts.isolated) args.push('--no-memory', '--no-subagents', '--disable-web-search');
  if (opts.cwd) args.push('--cwd', opts.cwd);
  const model = grokCliModelId(opts.model);
  if (model) args.push('-m', model);
  if (opts.reasoningEffort) args.push('--reasoning-effort', opts.reasoningEffort);
  if (opts.maxTurns != null) args.push('--max-turns', String(opts.maxTurns));
  // Keep system overrides short when inlined — oversized ones also hit the
  // spawn limit. Long system context is already folded into `prompt` by the
  // stream route via buildCliPromptFromMessages.
  if (opts.systemPrompt?.trim()) {
    const sys = opts.systemPrompt.trim();
    if (Buffer.byteLength(sys, 'utf8') <= PROMPT_INLINE_MAX_BYTES) {
      args.push('--system-prompt-override', sys);
    }
  }
  if (opts.effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effort)) {
    args.push('--effort', opts.effort);
  }
  if (opts.check) args.push('--check');
  if (opts.bestOfN && opts.bestOfN >= 2) args.push('--best-of-n', String(Math.min(4, Math.floor(opts.bestOfN))));
  if (opts.jsonSchema?.trim()) args.push('--json-schema', opts.jsonSchema.trim());
  return args;
}

/** Materialize CLI args, spilling long prompts to a temp file. Caller must run cleanup(). */
async function materializeCliArgs(opts: GrokCliRunOptions): Promise<{
  args: string[];
  cleanup: () => Promise<void>;
}> {
  const base = buildCliArgsBase(opts);
  const prompt = opts.prompt || '';
  const promptBytes = Buffer.byteLength(prompt, 'utf8');

  if (promptBytes <= PROMPT_INLINE_MAX_BYTES) {
    return { args: ['-p', prompt, ...base], cleanup: async () => {} };
  }

  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const file = path.join(
    os.tmpdir(),
    `${GROK_PROMPT_FILE_PREFIX}${Date.now()}-${randomBytes(6).toString('hex')}.txt`,
  );
  await fs.writeFile(file, prompt, 'utf8');
  return {
    args: ['--prompt-file', file, ...base],
    cleanup: async () => {
      try { await fs.unlink(file); } catch { /* best-effort */ }
    },
  };
}

function friendlySpawnError(err: Error): string {
  const msg = err.message || String(err);
  if (/ENAMETOOLONG/i.test(msg)) {
    return (
      'Grok CLI prompt is too long for this OS to spawn (ENAMETOOLONG). ' +
      'Try clearing older messages with screenshots, or switch off Grok CLI mode and use the cloud API.'
    );
  }
  return msg;
}

export interface GrokCliUpdateInfo {
  ok: boolean;
  current?: string;
  latest?: string;
  updateAvailable?: boolean;
  raw?: string;
  error?: string;
}

/** `grok update --check --json` — surfaces update availability in Settings. */
export async function checkGrokCliUpdate(): Promise<GrokCliUpdateInfo> {
  const status = await detectGrokCli();
  if (!status.installed || !status.path) return { ok: false, error: 'Grok CLI not installed' };
  try {
    const isWin = process.platform === 'win32';
    const quote = isWin ? `"${status.path.replace(/"/g, '\\"')}"` : `"${status.path}"`;
    const { stdout } = await runExec(`${quote} update --check --json`, 30_000);
    try {
      const data = JSON.parse(stdout.trim());
      const current = data.currentVersion || data.current_version || data.current || status.version;
      const latest = data.latestVersion || data.latest_version || data.latest || undefined;
      return {
        ok: true,
        current,
        latest,
        updateAvailable: !!(data.updateAvailable ?? data.update_available ?? (latest && latest !== current)),
        raw: stdout.trim().slice(0, 400),
      };
    } catch {
      // Non-JSON output — pass the text through so the UI can show it.
      return { ok: true, current: status.version, raw: stdout.trim().slice(0, 400) };
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'update check failed' };
  }
}

/**
 * CLI is text-only. Inline `data:image/...;base64,...` blobs (browser screenshots
 * appended by the agent tool loop) are useless there and routinely push the
 * prompt past Windows spawn limits. Replace them with short placeholders.
 */
export function sanitizeCliPromptContent(content: string): string {
  if (!content) return '';
  return content
    .replace(/!\[[^\]]*\]\(\s*data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+\)/gi, '![image omitted]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{80,}/gi, '[image data omitted]');
}

export function buildCliPromptFromMessages(
  messages: Array<{ role: string; content: string }>,
  systemParts: string[] = [],
): string {
  const lines: string[] = [];
  if (systemParts.length) {
    const system = sanitizeCliPromptContent(systemParts.join('\n\n'));
    if (system.trim()) lines.push(system, '');
  }
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
    const text = sanitizeCliPromptContent(m.content || '').trim();
    if (text) lines.push(`${role}: ${text}`);
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
  if (opts.signal?.aborted) {
    return { ok: false, stdout: '', stderr: 'Aborted', code: -1 };
  }
  const status = await detectGrokCli();
  if (!status.installed) {
    return {
      ok: false,
      stdout: '',
      stderr: status.error || 'Grok CLI is not installed',
      code: 127,
    };
  }

  const { args, cleanup } = await materializeCliArgs({
    ...opts,
    prompt: sanitizeCliPromptContent(opts.prompt),
  });
  const executable = status.path || 'grok';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = await spawnCli(executable, args, { cwd: opts.cwd, signal: opts.signal, env: opts.env, isolated: opts.isolated });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopping = false;
    let onAbort = () => {};

    const finish = (result: { ok: boolean; stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      void cleanup().finally(() => resolve(result));
    };

    const stop = (result: { ok: boolean; stdout: string; stderr: string; code: number }) => {
      if (settled || stopping) return;
      stopping = true;
      void terminateProcessTree(child).finally(() => finish(result));
    };

    const timer = setTimeout(() => {
      stop({
        ok: false,
        stdout,
        stderr: `${stderr}\n(Grok CLI timed out after ${timeoutMs}ms)`.trim(),
        code: -1,
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      if (!stopping) finish({ ok: false, stdout, stderr: friendlySpawnError(err), code: 1 });
    });
    child.on('close', (code) => {
      if (stopping) return;
      finish({
        ok: code === 0,
        stdout,
        stderr,
        code: code ?? 1,
      });
    });

    onAbort = () => {
      stop({ ok: false, stdout, stderr: 'Aborted', code: -1 });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
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
  // Sanitize once — stream retries only change the model, not the body.
  const safePrompt = sanitizeCliPromptContent(opts.prompt);
  // Installed CLIs ship with a fixed model list — if the selected model is newer
  // than the binary, retry once with the CLI's own default model.
  const modelAttempts: Array<string | undefined> = opts.model ? [opts.model, undefined] : [undefined];

  for (let attempt = 0; attempt < modelAttempts.length; attempt++) {
    const model = modelAttempts[attempt];
    const { args, cleanup } = await materializeCliArgs({ ...opts, model, prompt: safePrompt });
    const child = await spawnCli(executable, args, { cwd: opts.cwd, signal: opts.signal, env: opts.env, isolated: opts.isolated });

    let stderr = '';
    let exitCode: number | null = null;
    let gotStdout = false;
    const buffer: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let stopping: Promise<void> | null = null;

    const wait = () => new Promise<void>((resolve) => {
      wake = resolve;
    });

    const stopChild = () => {
      if (!stopping) {
        stopping = terminateProcessTree(child).finally(() => {
          closed = true;
          wake?.();
        });
      }
      return stopping;
    };

    const timer = setTimeout(() => {
      stderr += `\n(Grok CLI timed out after ${timeoutMs}ms)`;
      void stopChild();
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
      stderr += friendlySpawnError(err);
      closed = true;
      wake?.();
    });
    child.on('close', (code) => {
      exitCode = code;
      closed = true;
      clearTimeout(timer);
      wake?.();
    });

    const onAbort = () => {
      closed = true;
      wake?.();
      void stopChild();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    try {
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
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) await stopChild();
      else if (stopping) await stopping;
      await cleanup();
    }

    if (exitCode === 0 || gotStdout) {
      // Prefer cli: so the model badge shows "CLI" (legacy grok-cli: still parses).
      const bare = model ? grokCliModelId(model) : 'default';
      yield { type: 'done', model: `cli:${bare || 'default'}` };
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
