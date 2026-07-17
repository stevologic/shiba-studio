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

/**
 * Exact public source snapshot used to verify this adapter.
 *
 * xAI's stable 0.2.103 binary was published after the public 0.2.102 source
 * snapshot, so source and release provenance stay separate here.
 */
export const GROK_BUILD_OPEN_SOURCE = {
  repository: 'https://github.com/xai-org/grok-build',
  branch: 'main',
  commit: '98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce',
  sourceRevision: '124d85bc5dc6e7805560215fcc6d5413944920e1',
  sourceVersion: '0.2.102',
  testedStableVersion: '0.2.103',
  syncedAt: '2026-07-17',
  license: 'Apache-2.0',
} as const;

export interface GrokCliCapabilities {
  headless: boolean;
  streamingJson: boolean;
  acpStdio: boolean;
  acpWebSocket: boolean;
  sessions: boolean;
  worktrees: boolean;
  toolFiltering: boolean;
  permissionRules: boolean;
  sandbox: boolean;
  mcp: boolean;
  plugins: boolean;
  selfVerification: boolean;
  bestOfN: boolean;
  structuredOutput: boolean;
}

const EMPTY_GROK_CLI_CAPABILITIES: GrokCliCapabilities = {
  headless: false,
  streamingJson: false,
  acpStdio: false,
  acpWebSocket: false,
  sessions: false,
  worktrees: false,
  toolFiltering: false,
  permissionRules: false,
  sandbox: false,
  mcp: false,
  plugins: false,
  selfVerification: false,
  bestOfN: false,
  structuredOutput: false,
};

export interface GrokCliStatus {
  installed: boolean;
  ready: boolean;
  path?: string;
  /** True only when the operator pinned the executable with SHIBA_GROK_CLI_PATH. */
  explicitlyTrusted: boolean;
  discovery: 'explicit' | 'path' | 'missing';
  version?: string;
  versionNumber?: string;
  revision?: string;
  channel?: string;
  authenticated?: boolean;
  authMode?: string;
  capabilities: GrokCliCapabilities;
  source: typeof GROK_BUILD_OPEN_SOURCE;
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
  /**
   * Current Grok Build only applies `default` and `bypassPermissions` from the
   * CLI flag. Callers must explicitly opt into unattended tool approval.
   */
  permissionMode?: 'default' | 'bypassPermissions';
  /** Repeatable documented permission rules. Deny rules win inside Grok Build. */
  allowRules?: string[];
  denyRules?: string[];
  /** Kernel-enforced Grok sandbox profile where supported by the host OS. */
  sandboxProfile?: 'off' | 'workspace' | 'devbox' | 'read-only' | 'strict' | string;
  /** Named agent/profile used by the headless harness (for example `explore`). */
  agent?: string;
  /** Current headless session and worktree controls. */
  sessionId?: string;
  resumeSessionId?: string;
  continueSession?: boolean;
  forkSession?: boolean;
  worktree?: true | string;
  worktreeRef?: string;
  /** Remove memory, subagents, web search, and ambient tool surfaces for scoped handoffs. */
  isolated?: boolean;
  /**
   * Apply the scoped headless flags without replacing the CLI home directory.
   * This preserves the operator's authenticated session while removing memory,
   * subagents, and web tools from a one-shot task.
   */
  scoped?: boolean;
  /** Per-chat automatic tool switch. False removes every CLI tool surface. */
  toolsEnabled?: boolean;
  /** Exact built-in tool clamp for a one-shot headless task. */
  allowedTools?: string[];
  /** Built-in tools (and Agent entries) removed after the allowlist. */
  disallowedTools?: string[];
  /** Additional non-secret environment entries for a scoped child process. */
  env?: Record<string, string>;
}

export function parseGrokCliVersion(text: string): {
  version?: string;
  revision?: string;
  channel?: string;
} {
  const firstLine = String(text || '').trim().split(/\r?\n/).find(Boolean) || '';
  const match = firstLine.match(
    /(?:^|\b)grok(?:\s+build)?\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*(?:\(([^)]+)\))?\s*(?:\[([^\]]+)\])?/i,
  );
  if (!match) return {};
  return {
    version: match[1],
    ...(match[2]?.trim() ? { revision: match[2].trim() } : {}),
    ...(match[3]?.trim() ? { channel: match[3].trim() } : {}),
  };
}

export function detectGrokCliCapabilities(
  rootHelp: string,
  agentHelp = '',
): GrokCliCapabilities {
  const root = String(rootHelp || '');
  const agent = String(agentHelp || '');
  const has = (haystack: string, value: string) => haystack.includes(value);
  return {
    headless: (has(root, '--single') || has(root, '--prompt-file')) && has(root, '--output-format'),
    streamingJson: /streaming-json/i.test(root),
    acpStdio: /\bstdio\b/i.test(agent),
    acpWebSocket: /\bserve\b/i.test(agent) && /\bheadless\b/i.test(agent),
    sessions: has(root, '--session-id') && has(root, '--resume'),
    worktrees: has(root, '--worktree'),
    toolFiltering: has(root, '--tools') && has(root, '--disallowed-tools'),
    permissionRules: has(root, '--permission-mode') && has(root, '--allow') && has(root, '--deny'),
    sandbox: has(root, '--sandbox'),
    mcp: /^\s*mcp\s+/im.test(root),
    plugins: /^\s*plugin\s+/im.test(root),
    selfVerification: has(root, '--check'),
    bestOfN: has(root, '--best-of-n'),
    structuredOutput: has(root, '--json-schema'),
  };
}

/** CLI flags that make `/tools off` a real boundary instead of prompt advice. */
export function grokCliToolControlArgs(
  opts: Pick<
    GrokCliRunOptions,
    'toolsEnabled' | 'isolated' | 'scoped' | 'allowedTools' | 'disallowedTools'
  >,
): string[] {
  if (opts.toolsEnabled === false) {
    // The CLI rejects an empty --tools value. Its documented order applies the
    // denylist after the allowlist, so allowing then removing one known tool
    // produces a valid, genuinely empty built-in tool set.
    return [
      '--tools', 'read_file',
      '--disallowed-tools', 'read_file',
      '--no-memory', '--no-subagents', '--disable-web-search',
      // Permission denies are a second boundary for MCP/plugin surfaces that
      // are not part of the built-in allowlist in some CLI versions.
      '--deny', 'Bash', '--deny', 'Edit', '--deny', 'Write', '--deny', 'Read',
      '--deny', 'Grep', '--deny', 'WebFetch', '--deny', 'MCPTool',
    ];
  }
  const args: string[] = [];
  const cleanToolList = (values: string[] | undefined) => [...new Set(
    (values || [])
      .map((value) => String(value || '').trim())
      .filter((value) => /^[A-Za-z0-9:_-]{1,100}(?:\([A-Za-z0-9:_ -]{1,100}\))?$/.test(value)),
  )].slice(0, 100);
  const allowed = cleanToolList(opts.allowedTools);
  const disallowed = cleanToolList(opts.disallowedTools);
  if (allowed.length) args.push('--tools', allowed.join(','));
  if (disallowed.length) args.push('--disallowed-tools', disallowed.join(','));
  if (opts.isolated || opts.scoped) {
    args.push('--no-memory', '--no-subagents', '--disable-web-search');
  }
  return args;
}

let cachedStatus: { at: number; value: GrokCliStatus } | null = null;
const CACHE_MS = 30_000;

interface GrokCliExecResult {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
}

export function buildGrokCliEnvironment(opts: {
  isolated?: boolean;
  env?: Record<string, string>;
  forwardApiKey?: boolean;
} = {}): NodeJS.ProcessEnv {
  const safeKeys = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ];
  if (!opts.isolated) {
    safeKeys.push(
      'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
      // GROK_HOME contains CLI-owned config. Never forward XAI_API_KEY merely
      // because an executable named `grok` appeared on PATH.
      'GROK_HOME',
    );
    if (opts.forwardApiKey) safeKeys.push('XAI_API_KEY');
  }
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    GROK_DISABLE_AUTOUPDATER: '1',
  };
  for (const key of safeKeys) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(opts.env || {})) {
    if (
      /^[A-Z][A-Z0-9_]{0,63}$/i.test(key)
      && !/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|COOKIE|AUTH)/i.test(key)
    ) {
      env[key] = value.slice(0, 4_000);
    }
  }
  return env;
}

async function runFile(
  executable: string,
  args: string[],
  timeout = 8_000,
  env = buildGrokCliEnvironment(),
): Promise<GrokCliExecResult> {
  const { execFile } = await import('child_process');
  return new Promise((resolve) => {
    try {
      execFile(
        executable,
        args,
        {
          timeout,
          windowsHide: true,
          shell: false,
          env,
          maxBuffer: 2 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const numericCode = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
            ? Number((error as NodeJS.ErrnoException).code)
            : error ? 1 : 0;
          resolve({
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            code: numericCode,
            ...(error ? { error: error.message } : {}),
          });
        },
      );
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        code: 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function spawnCli(
  executable: string,
  args: string[],
  opts: {
    cwd?: string;
    signal?: AbortSignal;
    env?: Record<string, string>;
    isolated?: boolean;
    forwardApiKey?: boolean;
  },
): Promise<ChildProcess> {
  const { spawn } = await import('child_process');
  const env = buildGrokCliEnvironment(opts);
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
  authenticated?: boolean;
  authMode?: string;
  error?: string;
}

let cachedModels: { at: number; value: GrokCliModels } | null = null;
const MODELS_CACHE_MS = 5 * 60_000;

export function parseGrokCliModelsOutput(
  stdout: string,
  stderr = '',
  exitCode = 0,
): GrokCliModels {
  const models: string[] = [];
  let defaultModel: string | undefined;
  const output = `${stdout || ''}\n${stderr || ''}`.trim();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const defMatch = line.match(/^\s*Default model:\s*(\S+)/i);
    if (defMatch) defaultModel = defMatch[1];
    const itemMatch = line.match(/^\s*[*-]\s+([^\s(]+)/);
    if (itemMatch) {
      models.push(itemMatch[1]);
      if (/\(default\)/i.test(line)) defaultModel = itemMatch[1];
    }
  }
  if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);

  const loggedIn = output.match(
    /\b(?:you are\s+)?logged in with\s+([^\r\n]+?)(?:\.\s*)?(?:\r?\n|$)/i,
  );
  const advertisedAuth = output.match(/^\s*Authentication:\s*([^\r\n]+)/im);
  const apiKey = /\b(?:using|authenticated (?:with|via))\s+(?:an?\s+)?(?:xai\s+)?api key\b/i.test(output);
  const authFailure = /\b(?:not authenticated|authentication required|please (?:log in|sign in)|no (?:valid )?credentials?)\b/i.test(output);
  const authenticated = authFailure
    ? false
    : loggedIn || apiKey || models.length > 0
      ? true
      : undefined;
  const authMode = loggedIn?.[1]?.trim() || advertisedAuth?.[1]?.trim() || (apiKey ? 'api-key' : undefined);
  const uniqueModels = [...new Set(models)];
  const commandError = exitCode === 0
    ? undefined
    : (String(stderr || '').trim() || `grok models exited with code ${exitCode}`);
  return {
    models: uniqueModels,
    ...(defaultModel ? { defaultModel } : uniqueModels[0] ? { defaultModel: uniqueModels[0] } : {}),
    ...(authenticated !== undefined ? { authenticated } : {}),
    ...(authMode ? { authMode } : {}),
    ...(commandError ? { error: commandError } : {}),
  };
}

export function isGrokCliReady(input: {
  versionExitCode: number;
  modelsExitCode: number;
  capabilities: GrokCliCapabilities;
  modelProbe: GrokCliModels;
}): boolean {
  return input.versionExitCode === 0
    && input.modelsExitCode === 0
    && !input.modelProbe.error
    && input.capabilities.headless
    && input.capabilities.streamingJson
    && input.modelProbe.authenticated === true
    && input.modelProbe.models.length > 0;
}

/**
 * Ask the installed Grok CLI which models it supports (`grok models`).
 * The catalog differs from the cloud API and doubles as the documented soft
 * authentication/readiness probe, so it must be discovered dynamically.
 */
export async function listGrokCliModels(force = false): Promise<GrokCliModels> {
  if (!force && cachedModels && Date.now() - cachedModels.at < MODELS_CACHE_MS) {
    return cachedModels.value;
  }
  const status = await detectGrokCli(force);
  if (!status.installed || !status.path) {
    const value: GrokCliModels = {
      models: [],
      authenticated: false,
      error: status.error || 'Grok CLI not installed',
    };
    cachedModels = { at: Date.now(), value };
    return value;
  }
  if (cachedModels) return cachedModels.value;
  const result = await runFile(
    status.path,
    ['models'],
    15_000,
    buildGrokCliEnvironment({ forwardApiKey: status.explicitlyTrusted }),
  );
  const value = parseGrokCliModelsOutput(result.stdout, result.stderr, result.code);
  cachedModels = { at: Date.now(), value };
  return value;
}

export async function detectGrokCli(force = false): Promise<GrokCliStatus> {
  if (!force && cachedStatus && Date.now() - cachedStatus.at < CACHE_MS) {
    return cachedStatus.value;
  }

  const configuredPath = String(process.env.SHIBA_GROK_CLI_PATH || '').trim();
  let cliPath: string | undefined;
  let discovery: GrokCliStatus['discovery'] = 'missing';
  let locateError = '';
  if (configuredPath) {
    const [path, fs, constants] = await Promise.all([
      import('path'),
      import('fs/promises'),
      import('fs').then((module) => module.constants),
    ]);
    if (path.isAbsolute(configuredPath)) {
      try {
        if (process.platform === 'win32' && path.extname(configuredPath).toLowerCase() !== '.exe') {
          throw new Error('Windows Grok Build paths must point to a .exe file');
        }
        const file = await fs.stat(configuredPath);
        if (!file.isFile()) throw new Error('path is not a file');
        await fs.access(configuredPath, constants.X_OK);
        cliPath = configuredPath;
        discovery = 'explicit';
      } catch (error) {
        locateError = `SHIBA_GROK_CLI_PATH is not an executable file: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    } else {
      locateError = 'SHIBA_GROK_CLI_PATH must be an absolute path';
    }
  } else {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const located = await runFile(locator, ['grok']);
    cliPath = located.stdout.trim().split(/\r?\n/).find((line) => line.trim())?.trim();
    if (cliPath && located.code === 0) discovery = 'path';
    else locateError = located.error || located.stderr.trim() || 'grok not found on PATH';
  }
  const explicitlyTrusted = discovery === 'explicit';
  if (!cliPath) {
    const value: GrokCliStatus = {
      installed: false,
      ready: false,
      explicitlyTrusted: false,
      discovery,
      capabilities: { ...EMPTY_GROK_CLI_CAPABILITIES },
      source: GROK_BUILD_OPEN_SOURCE,
      error: locateError || 'grok not found on PATH',
    };
    cachedStatus = { at: Date.now(), value };
    cachedModels = null;
    return value;
  }

  const [versionResult, helpResult, agentHelpResult, modelResult] = await Promise.all([
    runFile(cliPath, ['--version']),
    runFile(cliPath, ['--help']),
    runFile(cliPath, ['agent', '--help']),
    runFile(
      cliPath,
      ['models'],
      15_000,
      buildGrokCliEnvironment({ forwardApiKey: explicitlyTrusted }),
    ),
  ]);
  const versionLine = versionResult.stdout.trim().split(/\r?\n/).find(Boolean) || '';
  const parsedVersion = parseGrokCliVersion(versionLine);
  const capabilities = detectGrokCliCapabilities(helpResult.stdout, agentHelpResult.stdout);
  const modelProbe = parseGrokCliModelsOutput(modelResult.stdout, modelResult.stderr, modelResult.code);
  cachedModels = { at: Date.now(), value: modelProbe };

  if (explicitlyTrusted && versionResult.code !== 0) {
    const value: GrokCliStatus = {
      installed: false,
      ready: false,
      path: cliPath,
      explicitlyTrusted: true,
      discovery,
      capabilities: { ...EMPTY_GROK_CLI_CAPABILITIES },
      source: GROK_BUILD_OPEN_SOURCE,
      error: versionResult.error || versionResult.stderr.trim() || 'Configured Grok CLI is not executable',
    };
    cachedStatus = { at: Date.now(), value };
    cachedModels = null;
    return value;
  }

  const contractReady = capabilities.headless && capabilities.streamingJson;
  const authenticated = modelProbe.authenticated;
  const ready = isGrokCliReady({
    versionExitCode: versionResult.code,
    modelsExitCode: modelResult.code,
    capabilities,
    modelProbe,
  });
  let error: string | undefined;
  if (versionResult.code !== 0) {
    error = versionResult.error || versionResult.stderr.trim() || 'grok --version failed';
  } else if (!contractReady) {
    error = 'Installed Grok CLI does not expose the required headless streaming contract';
  } else if (modelResult.code !== 0 || modelProbe.error) {
    error = modelProbe.error || `grok models exited with code ${modelResult.code}`;
  } else if (authenticated === false) {
    error = 'Grok CLI authentication required; run `grok login`';
  } else if (modelProbe.models.length === 0) {
    error = 'Grok CLI reported no available models';
  }
  const value: GrokCliStatus = {
    installed: true,
    ready,
    path: cliPath,
    explicitlyTrusted,
    discovery,
    version: versionLine || parsedVersion.version || 'unknown',
    ...(parsedVersion.version ? { versionNumber: parsedVersion.version } : {}),
    ...(parsedVersion.revision ? { revision: parsedVersion.revision } : {}),
    ...(parsedVersion.channel ? { channel: parsedVersion.channel } : {}),
    ...(authenticated !== undefined ? { authenticated } : {}),
    ...(modelProbe.authMode ? { authMode: modelProbe.authMode } : {}),
    capabilities,
    source: GROK_BUILD_OPEN_SOURCE,
    ...(error ? { error } : {}),
  };
  cachedStatus = { at: Date.now(), value };
  return value;
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

export function buildGrokCliArgsBase(opts: Omit<GrokCliRunOptions, 'prompt'>): string[] {
  const args = [
    '--output-format', opts.outputFormat || 'plain',
    '--permission-mode', opts.permissionMode || 'default',
    '--no-auto-update',
  ];
  args.push(...grokCliToolControlArgs(opts));
  if (opts.cwd) args.push('--cwd', opts.cwd);
  if (opts.agent?.trim()) args.push('--agent', opts.agent.trim());
  const model = grokCliModelId(opts.model);
  if (model) args.push('-m', model);
  if (opts.reasoningEffort) args.push('--reasoning-effort', opts.reasoningEffort);
  if (!opts.reasoningEffort && opts.effort?.trim()) args.push('--effort', opts.effort.trim());
  if (opts.maxTurns != null && Number.isFinite(opts.maxTurns)) {
    args.push('--max-turns', String(Math.max(1, Math.min(10_000, Math.floor(opts.maxTurns)))));
  }
  // Keep system overrides short when inlined — oversized ones also hit the
  // spawn limit. Long system context is already folded into `prompt` by the
  // stream route via buildCliPromptFromMessages.
  if (opts.systemPrompt?.trim()) {
    const sys = opts.systemPrompt.trim();
    if (Buffer.byteLength(sys, 'utf8') <= PROMPT_INLINE_MAX_BYTES) {
      args.push('--system-prompt-override', sys);
    }
  }
  for (const rule of (opts.allowRules || []).slice(0, 100)) {
    const value = String(rule || '').trim();
    if (value) args.push('--allow', value);
  }
  for (const rule of (opts.denyRules || []).slice(0, 100)) {
    const value = String(rule || '').trim();
    if (value) args.push('--deny', value);
  }
  if (opts.sandboxProfile?.trim()) args.push('--sandbox', opts.sandboxProfile.trim());
  if (opts.sessionId?.trim()) args.push('--session-id', opts.sessionId.trim());
  if (opts.resumeSessionId?.trim()) args.push('--resume', opts.resumeSessionId.trim());
  if (opts.continueSession) args.push('--continue');
  if (opts.forkSession) args.push('--fork-session');
  if (opts.worktree === true) args.push('--worktree');
  else if (typeof opts.worktree === 'string' && opts.worktree.trim()) {
    args.push(`--worktree=${opts.worktree.trim()}`);
  }
  if (opts.worktreeRef?.trim() && opts.worktree) args.push('--worktree-ref', opts.worktreeRef.trim());
  if (opts.check) args.push('--check');
  if (opts.bestOfN && opts.bestOfN >= 2) args.push('--best-of-n', String(Math.min(4, Math.floor(opts.bestOfN))));
  if (opts.jsonSchema?.trim()) args.push('--json-schema', opts.jsonSchema.trim());
  return args;
}

/** Materialize CLI args, spilling long prompts to a temp file. Caller must run cleanup(). */
export async function materializeGrokCliArgs(opts: GrokCliRunOptions): Promise<{
  args: string[];
  cleanup: () => Promise<void>;
  promptFile?: string;
}> {
  const base = buildGrokCliArgsBase(opts);
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
    promptFile: file,
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
    const { stdout, stderr, code, error } = await runFile(
      status.path,
      ['update', '--check', '--json'],
      30_000,
    );
    if (code !== 0) throw new Error(stderr.trim() || error || `update check exited with code ${code}`);
    try {
      const data = JSON.parse(stdout.trim());
      const current = data.currentVersion || data.current_version || data.current || status.versionNumber || status.version;
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
  if (!status.installed || !status.ready) {
    return {
      ok: false,
      stdout: '',
      stderr: status.error || 'Grok CLI is not ready',
      code: status.installed ? 126 : 127,
    };
  }

  const { args, cleanup } = await materializeGrokCliArgs({
    ...opts,
    prompt: sanitizeCliPromptContent(opts.prompt),
  });
  const executable = status.path || 'grok';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = await spawnCli(executable, args, {
    cwd: opts.cwd,
    signal: opts.signal,
    env: opts.env,
    isolated: opts.isolated,
    forwardApiKey: status.explicitlyTrusted,
  });

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

export interface ParsedGrokCliStreamLine {
  events: ChatStreamEvent[];
  terminal?: 'end' | 'error';
  malformed?: boolean;
}

function grokStreamText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return String((value as { text: string }).text);
  }
  return '';
}

/**
 * Map one official `--output-format streaming-json` NDJSON record into Shiba's
 * SSE chat envelope. Unknown records are ignored because xAI documents this
 * event set as non-exhaustive.
 */
export function parseGrokCliStreamLine(line: string): ParsedGrokCliStreamLine {
  const trimmed = String(line || '').trim();
  if (!trimmed) return { events: [] };
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { events: [] };
    record = parsed as Record<string, unknown>;
  } catch {
    return { events: [], malformed: true };
  }

  const type = String(record.type || '');
  if (type === 'text') {
    const delta = grokStreamText(record.data ?? record.text ?? record.content);
    return { events: delta ? [{ type: 'content', delta }] : [] };
  }
  if (type === 'thought') {
    const delta = grokStreamText(record.data ?? record.text ?? record.content);
    return { events: delta ? [{ type: 'thinking', delta }] : [] };
  }

  const usage: Record<string, unknown> = record.usage
    && typeof record.usage === 'object'
    && !Array.isArray(record.usage)
    ? { ...(record.usage as Record<string, unknown>) }
    : {};
  for (const key of [
    'num_turns', 'modelUsage', 'total_cost_usd', 'total_cost_usd_ticks',
    'cost_is_partial', 'usage_is_incomplete', 'sessionId', 'requestId', 'stopReason',
  ]) {
    if (record[key] !== undefined) usage[key] = record[key];
  }
  const usageEvents: ChatStreamEvent[] = Object.keys(usage).length
    ? [{ type: 'usage', usage }]
    : [];

  if (type === 'end') {
    const modelUsage = record.modelUsage && typeof record.modelUsage === 'object'
      ? Object.keys(record.modelUsage as Record<string, unknown>)[0]
      : undefined;
    const bareModel = String(record.model || modelUsage || 'default').replace(/^(?:cli|grok-cli):/i, '');
    return {
      events: [...usageEvents, { type: 'done', model: `cli:${bareModel || 'default'}` }],
      terminal: 'end',
    };
  }
  if (type === 'error') {
    return {
      events: [
        ...usageEvents,
        {
          type: 'error',
          message: String(record.message || record.error || 'Grok CLI reported an error'),
        },
      ],
      terminal: 'error',
    };
  }
  if (type === 'max_turns_reached') {
    return {
      events: [{ type: 'thinking', delta: 'Grok CLI reached its configured turn limit.\n' }],
    };
  }
  return { events: [] };
}

export async function* streamGrokCli(opts: GrokCliRunOptions): AsyncGenerator<ChatStreamEvent> {
  const status = await detectGrokCli();
  if (!status.installed || !status.ready) {
    yield {
      type: 'error',
      message: status.error || (
        status.installed
          ? 'Grok CLI is installed but not ready. Run `grok login`, then verify with `grok models`.'
          : 'Grok CLI is not installed. See Settings for the Windows and macOS/Linux install commands.'
      ),
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
    const { args, cleanup } = await materializeGrokCliArgs({
      ...opts,
      model,
      prompt: safePrompt,
      outputFormat: 'streaming-json',
    });
    const child = await spawnCli(executable, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      env: opts.env,
      isolated: opts.isolated,
      forwardApiKey: status.explicitlyTrusted,
    });

    let stderr = '';
    let exitCode: number | null = null;
    let spawnError = '';
    let timedOut = false;
    let aborted = false;
    let terminal: 'end' | 'error' | undefined;
    let malformedLines = 0;
    let lineRemainder = '';
    const chunks: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let stopping: Promise<void> | null = null;

    const notify = () => {
      const resolve = wake;
      wake = null;
      resolve?.();
    };
    const wait = () => {
      if (closed || chunks.length) return Promise.resolve();
      return new Promise<void>((resolve) => { wake = resolve; });
    };

    const stopChild = () => {
      if (!stopping) {
        stopping = terminateProcessTree(child).finally(() => {
          closed = true;
          notify();
        });
      }
      return stopping;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\n(Grok CLI timed out after ${timeoutMs}ms)`;
      void stopChild();
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      chunks.push(String(chunk));
      notify();
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += String(chunk);
      notify();
    });
    child.on('error', (err) => {
      spawnError = friendlySpawnError(err);
      stderr += spawnError;
      closed = true;
      notify();
    });
    child.on('close', (code) => {
      exitCode = code;
      closed = true;
      clearTimeout(timer);
      notify();
    });

    const onAbort = () => {
      aborted = true;
      void stopChild();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    try {
      while (!closed || chunks.length) {
        if (!chunks.length) {
          await wait();
          continue;
        }
        lineRemainder += chunks.shift()!;
        const lines = lineRemainder.split(/\r?\n/);
        lineRemainder = lines.pop() || '';
        for (const line of lines) {
          const parsed = parseGrokCliStreamLine(line);
          if (parsed.malformed) {
            malformedLines += 1;
            continue;
          }
          if (parsed.terminal) terminal = parsed.terminal;
          for (const event of parsed.events) {
            if (event.type === 'error') stderr += `${stderr ? '\n' : ''}${event.message}`;
            yield event;
          }
        }
      }
      if (lineRemainder.trim()) {
        const parsed = parseGrokCliStreamLine(lineRemainder);
        if (parsed.malformed) malformedLines += 1;
        if (parsed.terminal) terminal = parsed.terminal;
        for (const event of parsed.events) {
          if (event.type === 'error') stderr += `${stderr ? '\n' : ''}${event.message}`;
          yield event;
        }
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) await stopChild();
      else if (stopping) await stopping;
      await cleanup();
    }

    if (aborted) return;
    if (timedOut) {
      yield { type: 'error', message: stderr.trim() || `Grok CLI timed out after ${timeoutMs}ms` };
      return;
    }
    if (exitCode === 0) {
      // A current CLI sends `end`; retain a graceful fallback for older builds
      // whose help advertised streaming JSON but omitted the terminal record.
      if (terminal === 'error' || terminal === 'end') return;
      const bare = model ? grokCliModelId(model) : 'default';
      yield { type: 'done', model: `cli:${bare || 'default'}` };
      return;
    }

    if (attempt === 0 && model && terminal !== 'error' && isCliModelError(stderr)) {
      yield {
        type: 'thinking',
        delta: `Local Grok CLI (${status.version || 'installed version'}) does not support model "${grokCliModelId(model)}" — retrying with the CLI's default model.\n`,
      };
      continue;
    }

    if (terminal !== 'error') {
      const malformedHint = malformedLines
        ? ` (${malformedLines} malformed streaming record${malformedLines === 1 ? '' : 's'})`
        : '';
      yield {
        type: 'error',
        message: stderr.trim() || spawnError || `Grok CLI exited with code ${exitCode}${malformedHint}`,
      };
    }
    return;
  }
}
