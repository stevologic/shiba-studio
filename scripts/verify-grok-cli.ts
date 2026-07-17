/**
 * Contract checks for Shiba Studio's Grok Build CLI adapter.
 *
 * These fixtures intentionally exercise parsing and argument construction
 * without requiring a locally installed `grok` binary or a network call.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  GROK_BUILD_OPEN_SOURCE,
  buildGrokCliEnvironment,
  buildGrokCliArgsBase,
  clearGrokCliStatusCache,
  detectGrokCli,
  detectGrokCliCapabilities,
  grokCliToolControlArgs,
  isGrokCliReady,
  materializeGrokCliArgs,
  parseGrokCliModelsOutput,
  parseGrokCliStreamLine,
  parseGrokCliVersion,
} from '../lib/grok-cli';

let failures = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (condition) {
    console.log(`ok: ${message}`);
    return;
  }
  console.error(`FAIL: ${message}`);
  failures += 1;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  // The adapter's audited source contract must be reproducible rather than a
  // floating "latest" reference.
  assert(
    GROK_BUILD_OPEN_SOURCE.repository === 'https://github.com/xai-org/grok-build',
    'open-source provenance pins the audited repository',
  );
  assert(GROK_BUILD_OPEN_SOURCE.branch === 'main', 'open-source provenance pins the source branch');
  assert(
    GROK_BUILD_OPEN_SOURCE.commit === '98c3b2438aa922fbbe6178a5c0a4c48f85edc8ce',
    'open-source provenance pins the full source commit',
  );
  assert(
    GROK_BUILD_OPEN_SOURCE.sourceRevision === '124d85bc5dc6e7805560215fcc6d5413944920e1',
    'open-source provenance pins the source revision',
  );
  assert(
    GROK_BUILD_OPEN_SOURCE.sourceVersion === '0.2.102'
      && GROK_BUILD_OPEN_SOURCE.testedStableVersion === '0.2.103',
    'provenance distinguishes source fixtures from the tested Grok Build release',
  );
  assert(
    GROK_BUILD_OPEN_SOURCE.syncedAt === '2026-07-17',
    'open-source provenance records the synchronization date',
  );
  assert(
    GROK_BUILD_OPEN_SOURCE.license === 'Apache-2.0',
    'open-source provenance records the source license',
  );

  const parsedVersion = parseGrokCliVersion(
    'Grok Build 0.2.103 (124d85bc5dc6e7805560215fcc6d5413944920e1) [stable]',
  );
  assert(parsedVersion.version === '0.2.103', 'version parser extracts the semantic CLI version');
  assert(
    parsedVersion.revision === '124d85bc5dc6e7805560215fcc6d5413944920e1',
    'version parser extracts the source revision',
  );
  assert(parsedVersion.channel === 'stable', 'version parser extracts the release channel');

  const parsedModels = parseGrokCliModelsOutput([
    'Authentication: OAuth',
    'Default model: grok-build',
    'Available models:',
    '* grok-build (default)',
    '- grok-composer-2.5-fast',
  ].join('\n'), '', 0);
  assert(
    parsedModels.models.includes('grok-build')
      && parsedModels.models.includes('grok-composer-2.5-fast'),
    'models parser extracts every advertised model',
  );
  assert(parsedModels.defaultModel === 'grok-build', 'models parser extracts the default model');
  assert(parsedModels.authenticated === true, 'models parser recognizes authenticated output');
  assert(
    /oauth/i.test(parsedModels.authMode || ''),
    'models parser preserves the advertised authentication mode',
  );

  const authFailure = parseGrokCliModelsOutput(
    '',
    'Not authenticated. Run `grok login` to continue.',
    1,
  );
  assert(authFailure.authenticated === false, 'models parser recognizes an unauthenticated CLI');
  assert(
    /not authenticated|grok login/i.test(authFailure.error || ''),
    'models parser returns an actionable authentication error',
  );

  const rootHelp = `
Usage: grok [options] [command]
  -p, --prompt <prompt>
  -m, --model <model>
  --cwd <path>
  --output-format <plain|json|streaming-json>
  --permission-mode <mode>
  --no-auto-update
  --max-turns <number>
  --reasoning-effort <level>
  --effort <level>
  --check
  --best-of-n <number>
  --json-schema <schema>
  --prompt-file <path>
  --session-id <id>
  --resume <id>
  --worktree
  --tools <tools>
  --disallowed-tools <tools>
  --no-memory
  --no-subagents
  --disable-web-search
  --sandbox <profile>
  --allow <permission>
  --deny <permission>
Commands:
  agent
  mcp
  plugin
`;
  const agentHelp = `
Usage: grok agent <command>
Commands:
  stdio    Run the Agent Client Protocol harness over stdio
  serve    Run the headless Agent Client Protocol WebSocket harness
`;
  const detectedCapabilities = detectGrokCliCapabilities(
    rootHelp,
    agentHelp,
  );
  const capabilities = detectedCapabilities as unknown as Record<string, boolean>;
  for (const capability of [
    'headless',
    'streamingJson',
    'acpStdio',
    'acpWebSocket',
    'sessions',
    'worktrees',
    'toolFiltering',
    'permissionRules',
    'sandbox',
    'mcp',
    'plugins',
    'selfVerification',
    'bestOfN',
    'structuredOutput',
  ]) {
    assert(
      capabilities[capability] === true,
      `capability probe detects ${capability} from root + agent help`,
    );
  }

  const schema = '{"type":"object","required":["summary"]}';
  const baseArgs = buildGrokCliArgsBase({
    cwd: 'C:\\workspace\\shiba',
    model: 'cli:grok-build',
    outputFormat: 'streaming-json',
    maxTurns: 17,
    effort: 'high',
    check: true,
    bestOfN: 3,
    jsonSchema: schema,
  });
  assert(baseArgs.includes('--no-auto-update'), 'headless argv disables implicit CLI updates');
  assert(
    valueAfter(baseArgs, '--permission-mode') === 'default',
    'headless argv defaults to the reviewable default permission mode',
  );
  assert(valueAfter(baseArgs, '--cwd') === 'C:\\workspace\\shiba', 'headless argv preserves cwd');
  assert(valueAfter(baseArgs, '-m') === 'grok-build', 'headless argv normalizes the CLI model id');
  assert(valueAfter(baseArgs, '--max-turns') === '17', 'headless argv caps agent turns');
  assert(valueAfter(baseArgs, '--effort') === 'high', 'headless argv preserves agentic effort');
  assert(baseArgs.includes('--check'), 'headless argv enables the verification harness');
  assert(valueAfter(baseArgs, '--best-of-n') === '3', 'headless argv preserves best-of-N');
  assert(valueAfter(baseArgs, '--json-schema') === schema, 'headless argv preserves JSON schema');
  const automationArgs = buildGrokCliArgsBase({ permissionMode: 'bypassPermissions' });
  assert(
    valueAfter(automationArgs, '--permission-mode') === 'bypassPermissions',
    'unattended callers can explicitly opt into Grok Build automation approval',
  );

  const previousApiKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test-placeholder';
  try {
    const pathDiscoveredEnv = buildGrokCliEnvironment({ forwardApiKey: false });
    assert(
      pathDiscoveredEnv.XAI_API_KEY === undefined,
      'PATH-discovered executables never receive the ambient xAI API key',
    );
    const explicitlyTrustedEnv = buildGrokCliEnvironment({ forwardApiKey: true });
    assert(
      explicitlyTrustedEnv.XAI_API_KEY === 'xai-test-placeholder',
      'an explicitly trusted CLI path may receive the documented xAI API key',
    );
  } finally {
    if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousApiKey;
  }

  const previousCliPath = process.env.SHIBA_GROK_CLI_PATH;
  process.env.SHIBA_GROK_CLI_PATH = path.join(
    os.tmpdir(),
    `shiba-missing-grok-${process.pid}-${Date.now()}`,
    process.platform === 'win32' ? 'grok.exe' : 'grok',
  );
  clearGrokCliStatusCache();
  try {
    const staleExplicitPath = await detectGrokCli(true);
    assert(
      !staleExplicitPath.installed
        && staleExplicitPath.discovery === 'missing'
        && /not an executable file/i.test(staleExplicitPath.error || ''),
      'a stale explicit CLI path is rejected before status reports it installed',
    );
  } finally {
    if (previousCliPath === undefined) delete process.env.SHIBA_GROK_CLI_PATH;
    else process.env.SHIBA_GROK_CLI_PATH = previousCliPath;
    clearGrokCliStatusCache();
  }

  const fakeCliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-fake-grok-'));
  const fakeCliPath = path.join(fakeCliDir, process.platform === 'win32' ? 'grok.txt' : 'grok');
  await fs.writeFile(fakeCliPath, 'this is not an executable', 'utf8');
  process.env.SHIBA_GROK_CLI_PATH = fakeCliPath;
  clearGrokCliStatusCache();
  try {
    const nonExecutablePath = await detectGrokCli(true);
    assert(
      !nonExecutablePath.installed && /not an executable|must point to a \.exe/i.test(
        nonExecutablePath.error || '',
      ),
      'an existing non-executable configured path is not reported as installed',
    );
  } finally {
    if (previousCliPath === undefined) delete process.env.SHIBA_GROK_CLI_PATH;
    else process.env.SHIBA_GROK_CLI_PATH = previousCliPath;
    clearGrokCliStatusCache();
    await fs.rm(fakeCliDir, { recursive: true, force: true });
  }

  assert(
    isGrokCliReady({
      versionExitCode: 0,
      modelsExitCode: 0,
      capabilities: detectedCapabilities,
      modelProbe: parsedModels,
    }),
    'readiness requires a successful version, capability, auth, and model probe',
  );
  assert(
    !isGrokCliReady({
      versionExitCode: 0,
      modelsExitCode: 1,
      capabilities: detectedCapabilities,
      modelProbe: {
        ...parsedModels,
        error: 'grok models failed after printing cached models',
      },
    }),
    'a nonzero models probe cannot be marked ready from stale model output',
  );

  const toolsOffArgs = grokCliToolControlArgs({ toolsEnabled: false, isolated: false });
  assert(
    valueAfter(toolsOffArgs, '--tools') === 'read_file'
      && valueAfter(toolsOffArgs, '--disallowed-tools') === 'read_file',
    'tools-off argv creates an empty built-in allowlist',
  );
  for (const flag of ['--no-memory', '--no-subagents', '--disable-web-search']) {
    assert(toolsOffArgs.includes(flag), `tools-off argv includes ${flag}`);
  }
  for (const denied of ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'WebFetch', 'MCPTool']) {
    assert(
      toolsOffArgs.some((value, index) => value === denied && toolsOffArgs[index - 1] === '--deny'),
      `tools-off argv fail-closes ${denied}`,
    );
  }

  const longPrompt = 'long prompt line\n'.repeat(400);
  const materialized = await materializeGrokCliArgs({ prompt: longPrompt });
  const promptFile = materialized.promptFile
    || valueAfter(materialized.args, '--prompt-file');
  assert(!!promptFile, 'long prompts materialize through --prompt-file');
  assert(
    promptFile ? await fs.readFile(promptFile, 'utf8') === longPrompt : false,
    'materialized prompt file contains the complete prompt',
  );
  await materialized.cleanup();
  const promptStillExists = promptFile
    ? await fs.access(promptFile).then(() => true, () => false)
    : true;
  assert(!promptStillExists, 'materialized prompt cleanup removes the temporary file');

  const text = parseGrokCliStreamLine('{"type":"text","text":"Hello from Grok"}');
  assert(
    text.events.some((event) => event.type === 'content' && event.delta === 'Hello from Grok'),
    'NDJSON text events become content deltas',
  );

  const thought = parseGrokCliStreamLine('{"type":"thought","text":"Checking the repository"}');
  assert(
    thought.events.some(
      (event) => event.type === 'thinking' && event.delta === 'Checking the repository',
    ),
    'NDJSON thought events become thinking deltas',
  );

  const end = parseGrokCliStreamLine(
    '{"type":"end","model":"grok-build","usage":{"input_tokens":21,"output_tokens":8,"total_tokens":29}}',
  );
  const usageEvent = end.events.find((event) => event.type === 'usage');
  assert(end.terminal === 'end', 'NDJSON end event marks the stream terminal');
  assert(
    usageEvent?.type === 'usage'
      && Number(usageEvent.usage.input_tokens) === 21
      && Number(usageEvent.usage.output_tokens) === 8,
    'NDJSON end event preserves usage accounting',
  );
  assert(
    end.events.some((event) => event.type === 'done' && event.model === 'cli:grok-build'),
    'NDJSON end event completes the selected CLI model',
  );

  const error = parseGrokCliStreamLine('{"type":"error","message":"authentication expired"}');
  assert(error.terminal === 'error', 'NDJSON error event marks the stream terminal');
  assert(
    error.events.some(
      (event) => event.type === 'error' && /authentication expired/i.test(event.message),
    ),
    'NDJSON error event preserves the actionable message',
  );

  const unknown = parseGrokCliStreamLine('{"type":"future_event","payload":{"safe":true}}');
  assert(
    unknown.events.length === 0 && !unknown.terminal && !unknown.malformed,
    'unknown NDJSON events are ignored without failing the stream',
  );

  const malformed = parseGrokCliStreamLine('{"type":"text","text":');
  assert(
    malformed.events.length === 0 && malformed.malformed === true,
    'malformed NDJSON is tolerated and explicitly identified',
  );

  if (failures > 0) {
    console.error(`\n${failures} Grok CLI contract checks FAILED`);
    process.exit(1);
  }
  console.log('\nALL GROK CLI CONTRACT CHECKS PASSED');
}

main().catch((error) => {
  console.error('verify-grok-cli crashed', error);
  process.exit(1);
});
