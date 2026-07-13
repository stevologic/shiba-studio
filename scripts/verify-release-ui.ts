import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
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
