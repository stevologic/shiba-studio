import * as fs from 'fs/promises';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
const LOG = path.join(SCRATCH, 'competitor-features.log');

async function log(msg: string) {
  await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
  await fs.appendFile(LOG, msg + '\n');
  console.log(msg);
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function read(rel: string) {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  await fs.writeFile(LOG, `verify-competitor-features ${new Date().toISOString()}\n`);

  // Command palette
  const palette = await read('components/command-palette.tsx');
  assert(palette.includes('CommandPaletteItem'), 'command palette types');
  assert(palette.includes('Command palette search'), 'command palette a11y');

  const desk = await read('components/shiba-studio.tsx');
  assert(desk.includes('CommandPalette'), 'shiba-studio imports command palette');
  assert(desk.includes('showCommandPalette'), 'shiba-studio palette state');
  assert(desk.includes("e.key.toLowerCase() === 'k'"), 'shiba-studio Ctrl+K handler');
  assert(desk.includes('/api/execute/stream'), 'shiba-studio uses streaming execute');
  assert(desk.includes('WorkspaceDiffPanel'), 'shiba-studio diff panel');

  // Streaming API
  const streamRoute = await read('app/api/execute/stream/route.ts');
  assert(streamRoute.includes('runAgentStream'), 'execute stream route');
  assert(streamRoute.includes('text/event-stream'), 'SSE content type');

  const runtime = await read('lib/agent-runtime.ts');
  assert(runtime.includes('runAgentStream'), 'agent run stream export');
  assert(runtime.includes('agentRunGenerator'), 'agent run generator');

  const streamTypes = await read('lib/agent-stream-types.ts');
  assert(streamTypes.includes("type: 'trace'"), 'agent stream trace event');

  // Diff review
  const diffLib = await read('lib/workspace-diff.ts');
  assert(diffLib.includes('getWorkspaceDiff'), 'workspace diff helper');
  assert(diffLib.includes('discardWorkspacePaths'), 'workspace discard helper');

  const diffRoute = await read('app/api/workspace/diff/route.ts');
  assert(diffRoute.includes("body.action !== 'discard'") || diffRoute.includes("'discard'"), 'diff discard action');

  const diffPanel = await read('components/workspace-diff-panel.tsx');
  assert(diffPanel.includes('/api/workspace/diff'), 'diff panel API calls');

  // The one-off research/ notes were removed at release cleanup; the shipped
  // docs are the durable record that these features exist.
  const chatDocs = await read('docs/chat.md');
  assert(chatDocs.includes('/annotate'), 'docs cover annotation');
  assert(chatDocs.includes('/workspace'), 'docs cover chat workspaces');

  await log('PASS: all competitor feature structural checks');
  process.exit(0);
}

main().catch(async (e) => {
  await log(`FAIL: ${e.message || e}`);
  process.exit(1);
});