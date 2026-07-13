// Regression guards for two tool-dispatch bugs found in the 2026-07-10 audit:
//
//  1. filterToolsByDisabled returned the SAME array reference when no tools
//     were disabled (the common case); the runtime then did
//     `tools.length = 0; tools.push(...enabledTools)`, emptying its own result.
//     Result: the model was sent an EMPTY tool list on every run — agents
//     couldn't call tools at all.
//
//  2. Small local models (llama.cpp / Ollama) print the tool call as TEXT
//     instead of using structured tool_calls; the runtime treated that JSON
//     blob as the final answer. parseInlineToolCall now recovers it.

import * as path from 'path';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
import { getToolDefinitions } from '../lib/agent-runtime';
import { filterToolsByDisabled } from '../lib/disabled-tools';
import { parseInlineToolCall } from '../lib/inline-tool-calls';
import { assertTaskShellCommand } from '../lib/task-workspace-policy';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else console.log(`ok: ${msg}`);
}

async function main() {
  // --- Bug 1: filter must never alias the input (in-place mutation safe) ---
  const tools = getToolDefinitions(
    { github: false, slack: false, googledrive: false, discord: false, x: false, obsidian: false, vercel: false, netlify: false } as never,
    false,
  );
  assert(tools.length > 10, `local agent has a full tool list (${tools.length})`);

  const enabled = filterToolsByDisabled(tools, []);
  assert(enabled !== tools, 'filterToolsByDisabled returns a NEW array when nothing is disabled');
  const before = enabled.length;
  tools.length = 0; // simulate the runtime's in-place reset
  assert(enabled.length === before, 'emptying the input does not empty the filtered result');
  assert(enabled.some((t) => t.function.name === 'fs_list'), 'filtered tools still include fs_list after input reset');

  // filter with a disabled tool still drops it
  const tools2 = getToolDefinitions(
    { github: false, slack: false, googledrive: false, discord: false, x: false, obsidian: false, vercel: false, netlify: false } as never,
    false,
  );
  const minusList = filterToolsByDisabled(tools2, ['fs_list']);
  assert(!minusList.some((t) => t.function.name === 'fs_list'), 'disabled tool is removed');
  assert(minusList.length === tools2.length - 1, 'exactly one tool removed');

  // --- Bug 2: inline tool-call recovery, gated on a real tool name ---
  const names = new Set(tools2.map((t) => t.function.name));
  const cases: Array<[string, string | null]> = [
    ['```json\n{ "tool": { "name": "fs_list", "args": {} } }\n```', 'fs_list'],
    ['{"name":"fs_read","arguments":{"path":"package.json"}}', 'fs_read'],
    ['<tool_call>{"name":"fs_list","arguments":{}}</tool_call>', 'fs_list'],
    ['{"action":"shell_exec","action_input":{"command":"ls"}}', 'shell_exec'],
    ['The project is shiba-studio, version 0.2.0.', null], // pure prose
    ['Here is some config {"name":"Bob","age":3}.', null],  // unknown tool name
  ];
  for (const [content, expect] of cases) {
    const got = parseInlineToolCall(content, names)?.function.name ?? null;
    assert(got === expect, `inline recovery: ${JSON.stringify(content).slice(0, 48)} → ${got}`);
  }

  // Recovered args survive round-trip
  const recovered = parseInlineToolCall('{"name":"fs_read","arguments":{"path":"a.txt"}}', names);
  assert(!!recovered && JSON.parse(recovered.function.arguments).path === 'a.txt', 'recovered args parse back correctly');

  assert(assertTaskShellCommand('npm test') === 'npm test', 'contained shell validation preserves a normal verification command');
  for (const unsafe of ['git status ../other', 'git status child/../../other', 'git status $HOME/file', 'git reset --hard', 'cmd /c dir', 'node -e "require(\\"fs\\")"', 'npm test && whoami', 'git status C:\\\\Users']) {
    let blocked = false;
    try { assertTaskShellCommand(unsafe); } catch { blocked = true; }
    assert(blocked, `task shell validation blocks escape class: ${unsafe}`);
  }

  const fs = await import('fs/promises');
  await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await fs.writeFile(
    path.join(SCRATCH, 'tool-dispatch-verify.log'),
    `tools=${tools2.length} failures=${failures}\n`,
  );

  if (failures) { console.error(`\n${failures} tool-dispatch checks FAILED`); process.exit(1); }
  console.log('\nALL TOOL-DISPATCH CHECKS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('verify-tool-dispatch crashed', e); process.exit(1); });
