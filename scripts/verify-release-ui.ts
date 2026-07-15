import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { createClientId, type ClientRandomSource } from '../lib/client-id';
import {
  listBrowserEphemeralSessions,
  registerBrowserEphemeralSession,
  unregisterBrowserEphemeralSession,
} from '../lib/ephemeral-chat-lifecycle';
import {
  invokeVoiceAgentRepeatLast,
  invokeVoiceAgentStopResponse,
  registerVoiceAgentHandlers,
} from '../lib/voice-agent-ui-store';

const root = path.resolve(__dirname, '..');

async function source(file: string): Promise<string> {
  return fs.readFile(path.join(root, file), 'utf8');
}

async function sourceFilesUnder(directory: string): Promise<Array<{ file: string; value: string }>> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(fullPath);
    if (!entry.isFile() || !/\.[jt]sx?$/.test(entry.name)) return [];
    return [{
      file: path.relative(root, fullPath).replaceAll('\\', '/'),
      value: await fs.readFile(fullPath, 'utf8'),
    }];
  }));
  return nested.flat();
}

function buttonContaining(value: string, marker: string): string {
  const markerIndex = value.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Expected button marker: ${marker}`);
  const start = value.lastIndexOf('<button', markerIndex);
  const end = value.indexOf('</button>', markerIndex);
  assert.ok(start >= 0 && end > markerIndex, `Expected button containing: ${marker}`);
  return value.slice(start, end + '</button>'.length);
}

async function main() {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    passed++;
  };

  let randomSeed = 0;
  const insecureContextCrypto = {
    getRandomValues(array: Uint8Array) {
      randomSeed += 1;
      for (let index = 0; index < array.length; index++) array[index] = (randomSeed * 31 + index * 17) & 0xff;
      return array;
    },
  } satisfies ClientRandomSource;
  const firstClientId = createClientId(insecureContextCrypto);
  const secondClientId = createClientId(insecureContextCrypto);
  check(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(firstClientId)
      && firstClientId !== secondClientId,
    'client IDs remain valid and unique when randomUUID is unavailable on an HTTP mDNS origin',
  );
  const clientSources = (await Promise.all(
    ['app', 'components', 'lib'].map((directory) => sourceFilesUnder(path.join(root, directory))),
  )).flat().filter(({ value }) => /^\s*['"]use client['"];?/m.test(value));
  const unsafeClientIds = clientSources.filter(({ value }) => /\bcrypto\.randomUUID\s*\(/.test(value));
  check(
    unsafeClientIds.length === 0,
    `client components avoid secure-context-only crypto.randomUUID (${unsafeClientIds.map(({ file }) => file).join(', ')})`,
  );

  const artifactPreview = await source('components/artifact-preview.tsx');
  const artifactStudio = await source('components/artifact-studio-panel.tsx');
  check((artifactPreview.match(/visualVerificationEligible: false/g) || []).length === 2, 'PPTX and XLSX previews are structural-only');
  check(artifactStudio.includes('renderReport.visualVerificationEligible === false'), 'structural previews cannot enable passed visual evidence');

  registerBrowserEphemeralSession('created-here');
  check(listBrowserEphemeralSessions().includes('created-here'), 'browser-created ephemeral sessions are registered');
  unregisterBrowserEphemeralSession('created-here');
  check(!listBrowserEphemeralSessions().includes('created-here'), 'ephemeral cleanup ownership can be released without touching other sessions');
  const ephemeralLifecycle = await source('lib/ephemeral-chat-lifecycle.ts');
  check(ephemeralLifecycle.includes("window.addEventListener('pagehide'") && ephemeralLifecycle.includes('browserLifecycleSessionIds'), 'ephemeral cleanup survives client-side chat unmounts for this page lifecycle');

  const companion = await source('components/companion-app.tsx');
  check(companion.includes('refreshAbortRef.current?.abort()') && companion.includes('sequence !== refreshSequenceRef.current'), 'companion polling aborts and rejects stale refreshes');
  check(companion.includes('const cancelTask = async') && companion.includes("confirmLabel: 'Cancel task'"), 'mobile task cancellation requires confirmation');

  const qr = await QRCode.toDataURL('https://shiba.example/companion?pair=test&code=123456', { width: 120 });
  check(qr.startsWith('data:image/png;base64,'), 'pairing QR dependency produces a local image');
  const companionAdmin = await source('components/companion-admin.tsx');
  check(companionAdmin.includes('pairingQr') && companionAdmin.includes('QR code containing the one-time Shiba Companion pairing URL'), 'companion admin renders an accessible pairing QR');

  const harness = await source('components/harness-grant-panel.tsx');
  const team = await source('components/task-team-panel.tsx');
  check([artifactStudio, harness, team].every((value) => value.includes('catch((loadError)')), 'task-detail subpanels surface initial load failures');

  const taskDetail = await source('components/task-detail-page.tsx');
  const taskPromptStart = taskDetail.indexOf('function ExpandableTaskPrompt(');
  const taskPromptEnd = taskDetail.indexOf('export function TaskDetailPage', taskPromptStart);
  const taskPrompt = taskPromptStart >= 0 && taskPromptEnd > taskPromptStart
    ? taskDetail.slice(taskPromptStart, taskPromptEnd)
    : '';
  check(
    taskDetail.includes('const TASK_PROMPT_PREVIEW_CHARACTERS = 300;')
      && taskPrompt.includes('const characters = Array.from(prompt);')
      && taskPrompt.includes('characters.slice(0, TASK_PROMPT_PREVIEW_CHARACTERS)')
      && taskPrompt.includes('aria-expanded={expanded}')
      && taskPrompt.includes('aria-controls={promptId}')
      && taskPrompt.includes("expanded ? 'Show less' : 'Show full prompt'")
      && taskDetail.includes('<ExpandableTaskPrompt key={task.id} prompt={task.description} />'),
    'Task details truncate long prompts by Unicode character count and expose an accessible expand/collapse control',
  );

  const packs = await source('components/capability-packs-panel.tsx');
  check(packs.includes("archived: false") && packs.includes('ArchiveRestore'), 'archived capability packs have a restore path');

  const studio = await source('components/shiba-studio.tsx');
  const primaryNav = studio.match(/\/\* Main menu[\s\S]*?\]\s+as const\)\.map\(item => \{/)?.[0] || '';
  check(
    primaryNav.includes("label: 'Dashboard'")
      && primaryNav.includes("label: 'Automations'")
      && !primaryNav.includes("label: 'Dispatch'")
      && !primaryNav.includes("label: 'Routines'")
      && !primaryNav.includes("label: 'Meetings'")
      && !primaryNav.includes("label: 'Doctor'"),
    'primary navigation exposes Dashboard and Automations without retired surfaces',
  );
  const navigation = await source('lib/app-navigation.ts');
  const appTabs = navigation.match(/export const APP_TABS = \[[\s\S]*?\] as const;/)?.[0] || '';
  check(
    navigation.includes("return tab === 'dashboard' ? '/' : `/${tab}`;")
      && !navigation.includes("if (tab === 'automations') return '/routines'"),
    'Automations uses its canonical /automations path',
  );
  check(
    !appTabs.includes("'meetings'") && !appTabs.includes("'doctor'"),
    'retired Meetings and Doctor routes are absent from the app route contract',
  );
  check(
    !studio.includes('MeetingCapturePanel') && !studio.includes('DoctorPage'),
    'retired Meetings and Doctor panels are not mounted by the app shell',
  );

  const automations = await source('components/routines-panel.tsx');
  const automationCardStart = automations.indexOf('function RoutineCard(');
  const automationCardEnd = automations.indexOf('export function RoutinesPanel', automationCardStart);
  const automationCard = automationCardStart >= 0 && automationCardEnd > automationCardStart
    ? automations.slice(automationCardStart, automationCardEnd)
    : '';
  check(
    automationCard.includes('agent: Agent | undefined')
      && automationCard.includes('src={agent ? resolveAgentAvatarPath(agent) : MISSING_AGENT_AVATAR_PATH}')
      && automationCard.includes('className="agent-avatar-xs shrink-0"')
      && automationCard.includes('width={20}')
      && automationCard.includes('height={20}')
      && automationCard.includes('Assigned to')
      && automationCard.includes('const agentName = agent?.name || routine.agentId;')
      && automationCard.includes('{agentName}'),
    'Automation summary cards show the assigned agent identity and small avatar, including a deleted-agent fallback',
  );
  check(
    automations.includes('const agent = agents.find((candidate) => candidate.id === routine.agentId);')
      && automations.includes('<RoutineCard routine={routine} agent={agent}'),
    'Automation summaries resolve and pass their assigned Agent to the card',
  );
  const automationHeaderStart = automations.indexOf('<header className="page-head-row mb-0">');
  const automationHeaderEnd = automations.indexOf('</header>', automationHeaderStart);
  const automationHeader = automationHeaderStart >= 0 && automationHeaderEnd > automationHeaderStart
    ? automations.slice(automationHeaderStart, automationHeaderEnd)
    : '';
  const importAutomationButton = buttonContaining(automationHeader, 'Import automation');
  const newAutomationButton = buttonContaining(automationHeader, 'New automation');
  check(
    automationHeader.indexOf('Import automation') < automationHeader.indexOf('New automation')
      && importAutomationButton.includes('type="button"')
      && importAutomationButton.includes('importFileRef.current?.click()')
      && importAutomationButton.includes('disabled={importing}')
      && newAutomationButton.includes('type="button"'),
    'Import automation is an adjacent, keyboard-operable action before New automation',
  );
  check(
    automationHeader.includes('ref={importFileRef}')
      && automationHeader.includes('type="file"')
      && automationHeader.includes('accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"')
      && automationHeader.includes('aria-label="Choose an exported automation JSON or YAML file"')
      && automationHeader.includes("event.target.value = ''")
      && !automationHeader.includes(' multiple'),
    'Automation import uses an accessible single-file JSON/YAML picker that can retry the same file',
  );
  const importRoutineStart = automations.indexOf('async function importRoutine(file: File)');
  const importRoutineEnd = automations.indexOf('function editRoutine(', importRoutineStart);
  const importRoutine = importRoutineStart >= 0 && importRoutineEnd > importRoutineStart
    ? automations.slice(importRoutineStart, importRoutineEnd)
    : '';
  check(
    importRoutine.includes("fetch('/api/routines/import', { method: 'POST', body })")
      && importRoutine.includes('setEditor({')
      && importRoutine.includes('initial: draft')
      && importRoutine.includes("draft = { ...draft, agentId: '' }")
      && importRoutine.includes('setImporting(false)'),
    'Automation import previews a validated draft, requires reassignment for a missing owner, and releases its busy state',
  );

  const filesPanel = await source('components/files-panel.tsx');
  const servedFiles = await source('lib/serve-file.ts');
  check(
    filesPanel.includes('aria-label="File breadcrumb"')
      && filesPanel.includes('aria-label="Files explorer"')
      && filesPanel.includes('aria-label="File preview"'),
    'Files page exposes stable explorer, breadcrumb, and preview regions',
  );
  check(
    servedFiles.includes("'.svg': 'text/plain; charset=utf-8'")
      && !filesPanel.includes('role="tree"')
      && !filesPanel.includes('role="treeitem"'),
    'Files treats agent-authored SVG as source text and uses native list navigation semantics',
  );

  const voiceOverlay = await source('components/voice-agent-overlay.tsx');
  const voiceStore = await source('lib/voice-agent-ui-store.ts');
  const voiceHost = await source('components/voice-agent-host.tsx');
  const voiceDock = await source('components/voice-agent-nav-dock.tsx');
  const overlayRepeat = buttonContaining(voiceOverlay, 'Repeat last reply');
  const overlayStop = buttonContaining(voiceOverlay, 'Stop response');
  const dockRepeat = buttonContaining(voiceDock, 'aria-label="Repeat last reply"');
  const dockStop = buttonContaining(voiceDock, 'aria-label="Stop response"');
  check(
    voiceOverlay.includes('canRepeat?: boolean')
      && voiceOverlay.includes('canStop?: boolean')
      && voiceOverlay.includes('onRepeatLast?: () => void')
      && voiceOverlay.includes('onStopResponse?: () => void'),
    'voice HUD exposes explicit repeat and stop contracts',
  );
  check(
    overlayRepeat.includes('aria-label="Repeat last reply"')
      && overlayRepeat.includes('disabled=')
      && overlayRepeat.includes('Repeat last reply'),
    'expanded voice HUD repeat control is named and natively disabled when unavailable',
  );
  check(
    overlayStop.includes('aria-label="Stop response"')
      && overlayStop.includes('disabled=')
      && overlayStop.includes('Stop response'),
    'expanded voice HUD stop control is named and natively disabled when unavailable',
  );
  check(
    voiceStore.includes('canRepeat: boolean')
      && voiceStore.includes('invokeVoiceAgentRepeatLast')
      && voiceStore.includes('invokeVoiceAgentStopResponse'),
    'voice UI store carries repeat availability and repeat/stop invokers',
  );
  check(
    voiceHost.includes('canRepeat={ui.canRepeat}')
      && voiceHost.includes("canStop={ui.phase === 'thinking' || ui.phase === 'speaking'}")
      && voiceHost.includes('invokeVoiceAgentRepeatLast()')
      && voiceHost.includes('invokeVoiceAgentStopResponse()'),
    'root voice host wires repeat and stop controls to the bound chat engine',
  );
  check(
    dockRepeat.includes('disabled=')
      && dockStop.includes('disabled=')
      && voiceDock.includes('invokeVoiceAgentRepeatLast()')
      && voiceDock.includes('invokeVoiceAgentStopResponse()'),
    'minimized voice dock keeps accessible repeat and stop controls with disabled states',
  );
  let repeatCalls = 0;
  let stopCalls = 0;
  const unregisterVoiceHandlers = registerVoiceAgentHandlers({
    onClose: () => undefined,
    onToggleMic: () => undefined,
    onRepeatLast: () => { repeatCalls++; },
    onStopResponse: () => { stopCalls++; },
  });
  invokeVoiceAgentRepeatLast();
  invokeVoiceAgentStopResponse();
  check(repeatCalls === 1 && stopCalls === 1, 'voice repeat and stop invokers call the bound engine exactly once');
  unregisterVoiceHandlers();
  invokeVoiceAgentRepeatLast();
  invokeVoiceAgentStopResponse();
  check(repeatCalls === 1 && stopCalls === 1, 'unregistered voice handlers cannot receive later repeat or stop actions');

  console.log(`${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
