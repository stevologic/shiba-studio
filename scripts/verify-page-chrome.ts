/**
 * Structural verification: primary app surfaces use shared page chrome classes
 * defined in globals.css and constants from shipped lib/theme.ts.
 *
 * Does not re-implement styling — reads the real source + theme module.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  PAGE_CHROME,
  PRIMARY_PAGE_SURFACES,
  THEME_COLORS,
  isNearBlack,
  usesRetiredAccent,
} from '../lib/theme';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';

const ROOT = path.resolve(__dirname, '..');

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

/** Surfaces → source files that must contain page-title (or documented exception). */
const SURFACE_SOURCES: Record<(typeof PRIMARY_PAGE_SURFACES)[number], string[]> = {
  chat: ['components/chat-sessions-panel.tsx'],
  projects: ['components/projects-panel.tsx'],
  board: ['components/kanban-board.tsx'],
  agents: ['components/shiba-studio.tsx'],
  workspace: ['components/workspace-page.tsx'],
  automations: ['components/shiba-studio.tsx'],
  integrations: ['components/shiba-studio.tsx'],
  usage: ['components/usage-dashboard.tsx'],
  logs: ['components/logs-panel.tsx'],
  settings: ['components/shiba-studio.tsx'],
};

const FEATURE_GUARDS: Array<{ file: string; mustInclude: string; label: string }> = [
  { file: 'components/chat-sessions-panel.tsx', mustInclude: 'chat-session-rail', label: 'chat session rail' },
  { file: 'components/chat-sessions-panel.tsx', mustInclude: 'GrokChatPanel', label: 'Grok chat panel mount' },
  { file: 'components/workspace-page.tsx', mustInclude: 'ws-panel-scroll', label: 'workspace list-level scroll' },
  { file: 'components/workspace-page.tsx', mustInclude: 'ws-explorer', label: 'workspace explorer' },
  { file: 'components/workspace-page.tsx', mustInclude: "view === 'uploads'", label: 'workspace uploads view' },
  { file: 'components/workspace-page.tsx', mustInclude: "view === 'worktrees'", label: 'workspace worktrees view' },
  { file: 'components/shiba-studio.tsx', mustInclude: 'openCreateAgent', label: 'agent create' },
  { file: 'components/shiba-studio.tsx', mustInclude: 'syncCloudAgents', label: 'cloud agent sync' },
  { file: 'components/usage-dashboard.tsx', mustInclude: 'XaiAccountSection', label: 'usage xAI account section' },
  { file: 'components/logs-panel.tsx', mustInclude: "exportLogs('csv')", label: 'logs CSV export' },
  { file: 'components/logs-panel.tsx', mustInclude: 'logs-search-input', label: 'logs search' },
  { file: 'components/shiba-studio.tsx', mustInclude: 'saveApiKey', label: 'settings API key form' },
  { file: 'components/projects-panel.tsx', mustInclude: 'createProject', label: 'project create' },
];

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });
  const lines: string[] = [
    `PAGE_CHROME_VERIFY ${new Date().toISOString()}`,
    `PAGE_CHROME=${JSON.stringify(PAGE_CHROME)}`,
    '',
  ];

  console.log('=== PAGE CHROME (shipped lib/theme.ts + sources) ===');

  // Theme tokens still monochrome
  assert(isNearBlack(THEME_COLORS.bg), 'bg near-black');
  assert(isNearBlack(THEME_COLORS.bgCard), 'bgCard near-black');
  assert(!usesRetiredAccent(THEME_COLORS.accent), 'accent not retired blue/violet');
  lines.push('OK theme tokens monochrome');

  const css = await read('app/globals.css');
  assert(css.includes(`.${PAGE_CHROME.title}`), `globals.css defines .${PAGE_CHROME.title}`);
  assert(css.includes(`.${PAGE_CHROME.subtitle}`), `globals.css defines .${PAGE_CHROME.subtitle}`);
  assert(css.includes(`.${PAGE_CHROME.sectionTitle}`), `globals.css defines .${PAGE_CHROME.sectionTitle}`);
  // Title uses theme text token (block may span lines — use [\s\S])
  assert(
    /page-title\s*\{[\s\S]*?color:\s*var\(--text\)/.test(css),
    'page-title color uses var(--text)',
  );
  assert(
    /page-subtitle\s*\{[\s\S]*?color:\s*var\(--text-muted\)/.test(css),
    'page-subtitle color uses var(--text-muted)',
  );
  lines.push('OK page chrome CSS present and token-backed');
  console.log('  OK CSS page-title / page-subtitle token-backed');

  for (const surface of PRIMARY_PAGE_SURFACES) {
    const files = SURFACE_SOURCES[surface];
    let found = false;
    for (const file of files) {
      const src = await read(file);
      if (src.includes(PAGE_CHROME.title) || src.includes(`className="${PAGE_CHROME.title}"`) || src.includes(`'${PAGE_CHROME.title}'`) || src.includes(`"${PAGE_CHROME.title}"`) || new RegExp(`className=["'\`][^"'\`]*\\b${PAGE_CHROME.title}\\b`).test(src) || src.includes(`className="${PAGE_CHROME.title}`) || src.includes(`page-title`)) {
        // Accept literal class usage of PAGE_CHROME.title value
        if (src.includes(PAGE_CHROME.title)) found = true;
      }
    }
    assert(found, `${surface} sources must use class "${PAGE_CHROME.title}"`);
    lines.push(`OK ${surface} uses ${PAGE_CHROME.title}`);
    console.log(`  OK ${surface}: ${PAGE_CHROME.title}`);
  }

  // Subtitle on a few key pages
  for (const file of [
    'components/usage-dashboard.tsx',
    'components/logs-panel.tsx',
    'components/projects-panel.tsx',
    'components/chat-sessions-panel.tsx',
  ]) {
    const src = await read(file);
    assert(src.includes(PAGE_CHROME.subtitle), `${file} uses ${PAGE_CHROME.subtitle}`);
  }
  lines.push('OK key panels use page-subtitle');

  // Feature guards — no theming pass deleted controls
  for (const g of FEATURE_GUARDS) {
    const src = await read(g.file);
    assert(src.includes(g.mustInclude), `feature preserved: ${g.label} (${g.file})`);
    lines.push(`OK feature: ${g.label}`);
  }
  console.log(`  OK ${FEATURE_GUARDS.length} feature guards`);

  // Layout preserves
  const wsCss = css;
  assert(wsCss.includes('.ws-panel-scroll'), 'workspace list scroll class');
  assert(wsCss.includes('.chat-sessions-page'), 'chat page shell');
  assert(
    /chat-sessions-page\s*\{[\s\S]*?height:\s*calc\(100vh/.test(wsCss)
      || /chat-sessions-page[\s\S]{0,200}height:\s*calc/.test(wsCss),
    'chat sessions page keeps fill-height',
  );
  lines.push('OK workspace scroll + chat height CSS retained');

  const out = path.join(SCRATCH, 'page-chrome-verify.log');
  await fs.writeFile(out, lines.join('\n') + '\n=== PASSED ===\n', 'utf8');
  console.log(`=== PAGE CHROME PASSED ===\n  wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
