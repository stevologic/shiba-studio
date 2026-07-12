'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Brain, Check, ChevronDown, ChevronUp, Copy, Crosshair, Download, Eraser, FileText, FolderGit2, GitBranch, Mic, MicOff,
  Paperclip, Pencil, RefreshCw, RotateCcw, Send, Sparkles, Square, Terminal, Volume2, VolumeX, X, Zap,
} from 'lucide-react';
import {
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_VOICE,
  GROK_TTS_SPEEDS,
  GROK_TTS_VOICES,
  clampTtsSpeed,
  splitSpeechChunks,
  takeNextUtterance,
  textForSpeech,
} from '@/lib/xai-tts';
import dynamic from 'next/dynamic';
import { toast } from '@/lib/toast';
import ChatMarkdown from '@/components/chat-markdown-lazy';
import { confirmDialog } from '@/components/confirm-dialog';
import type { SubBrowserAnnotation } from '@/components/sub-browser';
import type { ChatAttachment, ChatFileRef, ChatMessagePayload, ReasoningEffort } from '@/lib/chat-types';
import { buildAgentChatSystem } from '@/lib/chat-skill';
import { encodeModelRef, modelDisplayName, parseModelRef, providerLabel, providerTitle, supportsReasoning } from '@/lib/model-providers';
import type { Agent } from '@/lib/types';
import type { Project, ProjectChatMessage } from '@/lib/project-types';
import type { ChatSession } from '@/lib/chat-session-types';
import { deriveSessionTitle } from '@/lib/chat-session-types';
import { resolveAgentAvatarPath } from '@/lib/agent-avatars';
import {
  getVoiceAgentUiState,
  patchVoiceAgentUi,
  persistVoiceSessionBinding,
  registerVoiceAgentHandlers,
  setVoiceAgentActive,
  setVoiceAgentMinimized,
  shouldRestoreVoiceForSession,
} from '@/lib/voice-agent-ui-store';
import {
  pickNextVoiceGroupAgent,
  VOICE_GROUP_AGENT_SILENCE_MS,
  VOICE_GROUP_MAX_CHAIN,
} from '@/lib/voice-group-chat';
import { startVoiceVad, type VoiceVadHandle } from '@/lib/voice-vad';
import {
  abortLiveChatRun,
  beginLiveChatRun,
  finishLiveChatRun,
  getLiveChatRun,
  subscribeLiveChatSession,
  updateLiveChatRun,
  type LiveChatUiMessage,
} from '@/lib/chat-live-runs';
import { getStickyChatTarget, setStickyChatTarget } from '@/lib/chat-target-store';
import { v4 as uuidv4 } from 'uuid';
import { createPortal } from 'react-dom';

const SubBrowser = dynamic(() => import('@/components/sub-browser'));
const WorkspacePicker = dynamic(() => import('@/components/workspace-picker'));
/** Slash-command catalog — drives the composer autocomplete and /help. */
const SLASH_COMMANDS: Array<{ cmd: string; insert: string; desc: string }> = [
  { cmd: '/git status', insert: '/git status', desc: 'Branch, changed files, recent commits' },
  { cmd: '/git checkout <branch>', insert: '/git checkout ', desc: 'Switch to a branch, or create it' },
  { cmd: '/git commit <message>', insert: '/git commit ', desc: 'Stage everything and commit' },
  { cmd: '/git pr <title> | <body>', insert: '/git pr ', desc: 'Push branch and open a GitHub PR' },
  { cmd: '/annotate', insert: '/annotate', desc: 'Sub-browser: highlight an element for refinement' },
  { cmd: '/workspace <path>', insert: '/workspace ', desc: 'Bind this chat to a folder (blank opens the picker)' },
  { cmd: '/search <query>', insert: '/search ', desc: 'Web search results into this chat' },
  { cmd: '/fetch <url>', insert: '/fetch ', desc: 'Read a page as text into this chat' },
  { cmd: '/remember <key> | <content>', insert: '/remember ', desc: 'Save a persistent memory' },
  { cmd: '/recall <keyword>', insert: '/recall ', desc: 'List saved memories' },
  { cmd: '/note <path> | <content>', insert: '/note ', desc: 'Create an Obsidian note' },
  { cmd: '/x <text>', insert: '/x ', desc: 'Post to X through the configured integration' },
  { cmd: '/help', insert: '/help', desc: 'Full command reference' },
];

export type ChatTarget = 'grok' | 'all' | string;

type ModelOption = { id: string; label: string; provider?: 'cloud' | 'local' | 'cli'; reasoning?: boolean };

function ModelProviderBadge({ modelId, size = 'sm' }: { modelId?: string; size?: 'sm' | 'xs' }) {
  const ref = parseModelRef(modelId || '');
  const cls = size === 'xs' ? 'model-provider-badge model-provider-badge-xs' : 'model-provider-badge';
  // Cloud models pinned to a credential show that source; cloud / local / CLI
  // keep their provider label.
  const text = ref.authSource === 'oauth' ? 'OAuth' : ref.authSource === 'token' ? 'Token' : providerLabel(ref.provider);
  const title = providerTitle(ref.provider, ref.authSource);
  return (
    <span className={`${cls} model-provider-${ref.provider}`} title={title}>
      {text}
    </span>
  );
}

interface GrokChatPanelProps {
  chatModel: string;
  onChatModelChange: (model: string) => void;
  availableModels: ModelOption[];
  modelsLoading: boolean;
  modelsError: string | null;
  onRefreshModels: () => void;
  agents: Agent[];
  project?: Project | null;
  onProjectUpdated?: () => void;
  session?: ChatSession | null;
  onSessionUpdated?: () => void;
  projects?: Project[];
  onProjectLinkChange?: (projectId: string | null) => void;
  /** Settings default workspace — picker opens here when chat has no binding. */
  defaultWorkspace?: string;
}

type AgentPerspective = { agentId: string; name: string; content: string };

type UiMessage = ChatMessagePayload & {
  id: string;
  streaming?: boolean;
  agentId?: string;
  agentName?: string;
  perspectives?: AgentPerspective[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Files written during this turn (fs_write) — linked under the response. */
  files?: ChatFileRef[];
};

function fmtTokenCount(n: number | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

function projectMessagesToUi(messages: ProjectChatMessage[]): UiMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    attachments: m.attachments,
    model: m.model,
    agentId: m.agentId,
    agentName: m.agentName,
    perspectives: m.perspectives,
    files: m.files,
    usage: m.usage,
    // Preserve in-progress assistant turns after leave/return or reload.
    streaming: !!m.streaming,
  }));
}

function uiToProjectMessages(messages: UiMessage[]): ProjectChatMessage[] {
  return messages
    .filter((m) => m.id !== 'welcome' && (m.role === 'user' || m.role === 'assistant'))
    .filter((m) => m.streaming || (m.content && m.content.trim()) || m.attachments?.length)
    .map((m) => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content || '',
      thinking: m.thinking,
      attachments: m.attachments,
      model: m.model,
      agentId: m.agentId,
      agentName: m.agentName,
      perspectives: m.perspectives,
      files: m.files,
      usage: m.usage,
      streaming: !!m.streaming,
      createdAt: new Date().toISOString(),
    }));
}

function toLiveMessages(messages: UiMessage[]): LiveChatUiMessage[] {
  return messages
    .filter((m) => m.id !== 'welcome')
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      attachments: m.attachments,
      model: m.model,
      agentId: m.agentId,
      agentName: m.agentName,
      perspectives: m.perspectives,
      files: m.files,
      usage: m.usage,
      streaming: m.streaming,
    }));
}

function initialMessages(project: Project | null | undefined, target: ChatTarget, agents: Agent[]): UiMessage[] {
  if (project?.messages?.length) return projectMessagesToUi(project.messages);
  if (project) {
    return [{
      id: 'welcome',
      role: 'assistant',
      content: `Project "${project.name}" — ${project.files.length} uploaded file(s) are carried into every message in this chat.`,
    }];
  }
  return [welcomeForTarget(target, agents)];
}

function resetChatMessages(project: Project | null | undefined, target: ChatTarget, agents: Agent[]): UiMessage[] {
  if (project) {
    return [{
      id: 'welcome',
      role: 'assistant',
      content: `Project "${project.name}" — ${project.files.length} uploaded file(s) are carried into every message in this chat.`,
    }];
  }
  return [welcomeForTarget(target, agents)];
}

function welcomeForTarget(target: ChatTarget, agents: Agent[]): UiMessage {
  if (target === 'all') {
    const names = agents.map((a) => a.name).join(', ') || 'your agents';
    return {
      id: 'welcome',
      role: 'assistant',
      content: `Multi-agent mode: I'll consult ${names}, then synthesize one unified answer for you.`,
    };
  }
  if (target !== 'grok') {
    const agent = agents.find((a) => a.id === target);
    if (agent) {
      const skill = agent.chatSkill?.trim();
      return {
        id: 'welcome',
        role: 'assistant',
        agentId: agent.id,
        agentName: agent.name,
        content: skill
          ? `You're chatting with ${agent.name}. Skill: ${skill.slice(0, 160)}${skill.length > 160 ? '…' : ''}`
          : `You're chatting with ${agent.name}. Configure a Skill in the agent settings to shape their personality.`,
      };
    }
  }
  return {
    id: 'welcome',
    role: 'assistant',
    content: 'Hello! I am Grok. Workspace global uploads are included in every reply. Pick an agent above to chat in their voice, or use All agents for a synthesized panel discussion.',
  };
}

function fileToAttachment(file: File, uploaded: {
  kind: 'image' | 'file';
  name: string;
  mimeType: string;
  dataUrl?: string;
  fileId?: string;
  size?: number;
  textContent?: string;
}): ChatAttachment {
  return {
    id: uuidv4(),
    kind: uploaded.kind,
    name: uploaded.name,
    mimeType: uploaded.mimeType,
    dataUrl: uploaded.dataUrl,
    fileId: uploaded.fileId,
    textContent: uploaded.textContent,
    size: uploaded.size,
  };
}

function sessionToInitialState(
  session: ChatSession | null | undefined,
  project: Project | null | undefined,
  agents: Agent[],
  /** Sticky agent picker — never taken from session.chatTarget on switch. */
  stickyTarget: ChatTarget = 'grok',
) {
  // Agent/target is sticky across chat sessions (picker + send). Session disk
  // still records chatTarget when a turn is sent, but opening another chat
  // must not flip the dropdown.
  const target = stickyTarget;
  // Multi-agent mode never routes through the local CLI — clamp at the source
  // so every state-set path (init + session sync) holds the invariant.
  const useGrokCli = !!session?.useGrokCli && target !== 'all';
  if (session?.messages?.length) {
    return {
      target,
      messages: projectMessagesToUi(session.messages),
      useGrokCli,
      cliModel: session.cliModel || '',
      reasoningEffort: session.reasoningEffort || 'low' as ReasoningEffort,
      workspaceDir: session.workspaceDir || null,
    };
  }
  return {
    target,
    messages: initialMessages(project, target, agents),
    useGrokCli,
    cliModel: session?.cliModel || '',
    reasoningEffort: (session?.reasoningEffort || 'low') as ReasoningEffort,
    workspaceDir: session?.workspaceDir || null,
  };
}

export default function GrokChatPanel({
  chatModel,
  onChatModelChange,
  availableModels,
  modelsLoading,
  modelsError,
  onRefreshModels,
  agents,
  project = null,
  onProjectUpdated,
  session = null,
  onSessionUpdated,
  projects = [],
  onProjectLinkChange,
  defaultWorkspace = '',
}: GrokChatPanelProps) {
  const isSessionMode = !!session && !onProjectUpdated;
  // Sticky agent for session chats — survives remount when switching sessions.
  // Project/direct mode still uses local init only.
  const init = sessionToInitialState(
    session,
    project,
    agents,
    isSessionMode ? (getStickyChatTarget() as ChatTarget) : ((session?.chatTarget || 'grok') as ChatTarget),
  );
  const [chatTarget, setChatTarget] = useState<ChatTarget>(init.target);
  const [messages, setMessages] = useState<UiMessage[]>(init.messages);
  // Drafts survive tab switches and reloads (C6). Scoped per session/project;
  // the panel remounts per session via its key prop, so lazy init is enough.
  const draftKey = `shiba-draft:${session?.id || project?.id || 'direct'}`;
  // SSR-safe empty default — draft is restored from localStorage after mount
  // (reading storage in useState causes React hydration mismatches).
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(init.reasoningEffort);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; name: string } | null>(null);
  const [showSubBrowser, setShowSubBrowser] = useState(false);
  // Chat workspace: folder this conversation reads/writes/analyzes (fs tools
  // + /git). Persisted on the session so it survives reloads.
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(init.workspaceDir);
  // In-chat file viewer: opened from the "files created" chips under a response.
  const [chatFileView, setChatFileView] = useState<{
    file: ChatFileRef;
    loading: boolean;
    binary?: boolean;
    content?: string;
    size?: number;
    error?: string;
  } | null>(null);

  async function openChatFile(file: ChatFileRef) {
    setChatFileView({ file, loading: true });
    try {
      // Relative tool paths resolve against the chat workspace when one is
      // bound; otherwise the server resolves them against the default workspace.
      const isAbs = /^([a-zA-Z]:[\\/]|[\\/])/.test(file.path);
      const readPath = !isAbs && workspaceDir
        ? `${workspaceDir.replace(/[\\/]+$/, '')}/${file.path}`
        : file.path;
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'read', path: readPath }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setChatFileView({
        file,
        loading: false,
        binary: !!data.binary,
        content: String(data.content ?? ''),
        size: Number(data.size) || 0,
      });
    } catch (e: unknown) {
      setChatFileView({
        file,
        loading: false,
        error: e instanceof Error ? e.message : 'Could not read the file',
      });
    }
  }
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);

  // Slash-command completion — filtered while the command token is typed.
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashToken = input.trimStart();
  const slashMatches = slashToken.startsWith('/') && !slashToken.includes('\n')
    ? SLASH_COMMANDS.filter((c) => c.cmd.toLowerCase().startsWith(slashToken.toLowerCase()))
    : [];
  const slashMenuOpen = !streaming && !slashDismissed && slashMatches.length > 0;
  const slashSelected = Math.min(slashIdx, Math.max(0, slashMatches.length - 1));

  function acceptSlash(c: { insert: string }) {
    setInput(c.insert);
    setSlashIdx(0);
    textareaRef.current?.focus();
  }
  const [grokCliInstalled, setGrokCliInstalled] = useState(false);
  const [grokCliVersion, setGrokCliVersion] = useState<string | null>(null);
  const [useGrokCli, setUseGrokCli] = useState(init.useGrokCli);
  const [cliModels, setCliModels] = useState<string[]>([]);
  const [cliDefaultModel, setCliDefaultModel] = useState<string | null>(null);
  const [cliModel, setCliModel] = useState<string>(init.cliModel);
  const [cliModelsLoading, setCliModelsLoading] = useState(true);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  // Speech-to-text (Web Speech API) — Chrome/Edge; graceful no-op elsewhere.
  // Hands-free "Grok voice": when auto-speak is on, mic starts automatically,
  // end-of-utterance silence auto-sends, then mic reopens after the reply.
  const [dictating, setDictating] = useState(false);
  const [dictationInterim, setDictationInterim] = useState('');
  const [dictationSupported, setDictationSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const dictationBaseRef = useRef('');
  const dictationFinalRef = useRef('');
  const dictationInterimRef = useRef('');
  /** Pause after last speech activity before auto-sending (hands-free). Keep snappy. */
  /** Pause after user speech before auto-send. */
  const VOICE_SILENCE_MS = 700;
  /** Mute window after TTS so room reverb / speaker ring isn't transcribed as the next user turn. */
  const VOICE_ECHO_MUTE_MS = 1100;
  /**
   * FALLBACK interrupt trigger only (no acoustic VAD available): sustained
   * transcribed words for this long cut Grok off. The primary trigger is the
   * echo-cancelled energy VAD (lib/voice-vad.ts), which reacts in ~250ms.
   */
  const BARGE_IN_HOLD_MS = 700;
  /** If word activity gaps longer than this, restart the fallback hold. */
  const BARGE_IN_GAP_RESET_MS = 900;
  /**
   * After a soft interrupt, wait this long for real user words.
   * Silence / noise → resume the paused reply from where it left off.
   */
  const FALSE_BARGE_IN_RESUME_MS = 2200;
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingFromVoiceRef = useRef(false);
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { dictationInterimRef.current = dictationInterim; }, [dictationInterim]);

  // Assistant voice (xAI TTS) — speak replies aloud with a selectable Grok voice.
  type TtsVoiceOpt = { id: string; name: string; description?: string };
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceOpt[]>(GROK_TTS_VOICES);
  // Defaults match SSR; restore prefs in useEffect to avoid hydration drift.
  const [ttsVoice, setTtsVoice] = useState<string>(DEFAULT_TTS_VOICE);
  const [ttsSpeed, setTtsSpeed] = useState<number>(DEFAULT_TTS_SPEED);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [ttsLoadingId, setTtsLoadingId] = useState<string | null>(null);
  /** Last user phrase sent via voice (shown in Jarvis HUD). */
  const [voiceLastHeard, setVoiceLastHeard] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoSpeakRef = useRef(autoSpeak);
  const ttsVoiceRef = useRef(ttsVoice);
  const ttsSpeedRef = useRef(ttsSpeed);
  /** Effective voice for playback: agent default when set, else app picker. */
  const speakVoiceRef = useRef(ttsVoice);
  const streamingRef = useRef(streaming);
  const startDictationRef = useRef<() => void>(() => {});
  const sendChatRef = useRef<() => void>(() => {});
  // Progressive TTS: speak first sentence while the model is still streaming.
  const voiceStreamBufRef = useRef('');
  const voiceSpokenLenRef = useRef(0);
  const voiceMsgIdRef = useRef<string | null>(null);
  const ttsQueueRef = useRef<string[]>([]);
  /** Chunk currently playing (re-queued on soft barge-in so we can resume). */
  const currentTtsChunkRef = useRef<string | null>(null);
  const ttsPlayingRef = useRef(false);
  const ttsFetchGenRef = useRef(0);
  /** Hard barge-in confirmed — skip residual TTS for an aborted turn. */
  const voiceBargeInRef = useRef(false);
  /**
   * Soft interrupt pending: TTS paused, waiting to see if the user actually said
   * something. Noise/silence → resume speech from ttsResumeRef.
   */
  const softBargeInPendingRef = useRef(false);
  const softBargeInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsResumeRef = useRef<{
    msgId: string;
    queue: string[];
    spokenLen: number;
    streamBuf: string;
  } | null>(null);
  /** Earliest time barge-in is accepted (avoids TTS echo right after audio starts). */
  const bargeInReadyAtRef = useRef(0);
  /**
   * Drop speech-recognition results until this timestamp.
   * Used after TTS ends (echo tail) — not during TTS barge-in monitoring.
   */
  const voiceIgnoreUntilRef = useRef(0);
  /** When continuous word-bearing speech for barge-in first started (0 = idle). */
  const bargeInSpeechStartedAtRef = useRef(0);
  /** Last time we saw word content while the assistant was busy. */
  const bargeInLastWordAtRef = useRef(0);
  const interruptVoiceRef = useRef<() => void>(() => {});
  const confirmRealBargeInRef = useRef<() => void>(() => {});
  const resumeAfterFalseBargeInRef = useRef<() => void>(() => {});
  /** Acoustic barge-in detector (echo-cancelled mic energy) — the primary trigger. */
  const voiceVadRef = useRef<VoiceVadHandle | null>(null);
  /** True while the VAD runs — the transcript trigger then only confirms. */
  const vadActiveRef = useRef(false);
  // Multi-agent voice group: round-robin agent turns when chatTarget === 'all'.
  const voiceGroupCursorRef = useRef(0);
  const voiceGroupLastAgentIdRef = useRef<string | null>(null);
  const voiceGroupChainRef = useRef(0);
  const voiceGroupSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceGroupBusyRef = useRef(false);
  const messagesRef = useRef<UiMessage[]>([]);
  const chatTargetRef = useRef(chatTarget);
  const agentsRef = useRef(agents);
  /** Restore speakVoiceRef after an agent-specific TTS turn. */
  const speakVoiceRestoreRef = useRef<string | null>(null);
  useEffect(() => { autoSpeakRef.current = autoSpeak; }, [autoSpeak]);
  useEffect(() => { ttsVoiceRef.current = ttsVoice; }, [ttsVoice]);
  useEffect(() => { ttsSpeedRef.current = ttsSpeed; }, [ttsSpeed]);
  useEffect(() => { streamingRef.current = streaming; }, [streaming]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { chatTargetRef.current = chatTarget; }, [chatTarget]);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  // Client-only restore of composer draft + voice prefs (must not run during SSR).
  // Voice only restores for the same session it was started on — switching chats ends it.
  useEffect(() => {
    try {
      const draft = window.localStorage.getItem(draftKey);
      if (draft) setInput(draft);
    } catch { /* private mode */ }
    void (async () => {
      try {
        let voice = window.localStorage.getItem('shiba-tts-voice') || '';
        let speedRaw = window.localStorage.getItem('shiba-tts-speed') || '';
        // Fall back to studio Settings defaults when no session override.
        if (!voice || !speedRaw) {
          try {
            const cfgRes = await fetch('/api/config');
            const cfg = await cfgRes.json();
            if (!voice) {
              voice = String(cfg?.defaultTtsVoice || '').trim().toLowerCase();
              if (voice) {
                try { window.localStorage.setItem('shiba-tts-voice', voice); } catch { /* */ }
              }
            }
            if (!speedRaw && cfg?.defaultTtsSpeed != null) {
              speedRaw = String(cfg.defaultTtsSpeed);
              try { window.localStorage.setItem('shiba-tts-speed', speedRaw); } catch { /* */ }
            }
          } catch { /* ignore */ }
        }
        if (voice) {
          setTtsVoice(voice);
          ttsVoiceRef.current = voice;
          speakVoiceRef.current = voice;
        }
        if (speedRaw) {
          const speed = clampTtsSpeed(speedRaw);
          setTtsSpeed(speed);
          ttsSpeedRef.current = speed;
          patchVoiceAgentUi({ speechSpeed: speed });
        }
      } catch { /* private mode */ }
    })();
    try {
      const sessionId = session?.id || null;
      if (shouldRestoreVoiceForSession(sessionId)) {
        setAutoSpeak(true);
        autoSpeakRef.current = true;
        setVoiceAgentActive(true, sessionId);
      }
    } catch { /* private mode */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draftKey is stable per mount (panel keyed by session)
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Keep the transcript pinned to the latest message unless the user scrolls up. */
  const stickToBottomRef = useRef(true);
  const chatModelRef = useRef(chatModel);
  useEffect(() => { chatModelRef.current = chatModel; }, [chatModel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setDictationSupported(!!SR);
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const clearVoiceGroupSilenceTimer = useCallback(() => {
    if (voiceGroupSilenceTimerRef.current) {
      clearTimeout(voiceGroupSilenceTimerRef.current);
      voiceGroupSilenceTimerRef.current = null;
    }
  }, []);

  const isVoiceGroupMode = useCallback(() => {
    return (
      autoSpeakRef.current
      && chatTargetRef.current === 'all'
      && agentsRef.current.length >= 2
    );
  }, []);

  const stopDictation = useCallback((opts?: { clearTimers?: boolean }) => {
    if (opts?.clearTimers !== false) clearSilenceTimer();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    try { rec?.stop(); } catch { /* already stopped */ }
    try { rec?.abort(); } catch { /* ignore */ }
    setDictating(false);
    setDictationInterim('');
  }, [clearSilenceTimer]);

  /** Build the committed transcript currently in the composer for voice auto-send. */
  const voiceCommittedText = useCallback(() => {
    const base = dictationBaseRef.current.replace(/\s+$/, '');
    const finals = dictationFinalRef.current.trim();
    if (base && finals) return `${base} ${finals}`.trim();
    if (finals) return finals;
    return (inputRef.current || '').trim();
  }, []);

  const scheduleVoiceAutoSend = useCallback(() => {
    clearSilenceTimer();
    clearVoiceGroupSilenceTimer();
    // Only auto-send in hands-free Grok voice mode (auto-speak on).
    if (!autoSpeakRef.current) return;
    if (Date.now() < voiceIgnoreUntilRef.current) return;
    // Soft barge-in must be confirmed as real speech before we send.
    if (softBargeInPendingRef.current) {
      const candidate = (dictationFinalRef.current || '').trim();
      let meaningful = false;
      try {
        const words = candidate.split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));
        meaningful = words.length >= 2 || candidate.replace(/\s+/g, '').length >= 12;
      } catch {
        meaningful = candidate.replace(/[^a-zA-Z0-9]/g, '').length >= 12;
      }
      if (!meaningful) return;
      confirmRealBargeInRef.current();
    }
    // Don't auto-send while Grok is still generating/speaking (unless barge-in already cut it).
    if (
      streamingRef.current
      || sendingFromVoiceRef.current
      || ttsPlayingRef.current
      || ttsQueueRef.current.length > 0
      || voiceGroupBusyRef.current
    ) return;
    silenceTimerRef.current = setTimeout(() => {
      silenceTimerRef.current = null;
      if (
        !autoSpeakRef.current
        || streamingRef.current
        || sendingFromVoiceRef.current
        || ttsPlayingRef.current
        || ttsQueueRef.current.length > 0
        || voiceGroupBusyRef.current
        || Date.now() < voiceIgnoreUntilRef.current
      ) return;
      const text = voiceCommittedText();
      if (!text) return;
      // Ensure React state matches what we're about to send.
      setInput(text);
      inputRef.current = text;
      setVoiceLastHeard(text.length > 120 ? `${text.slice(0, 120)}…` : text);
      sendingFromVoiceRef.current = true;
      stopDictation();
      // Send ASAP (no artificial delay).
      queueMicrotask(() => {
        try {
          sendChatRef.current();
        } finally {
          window.setTimeout(() => { sendingFromVoiceRef.current = false; }, 500);
        }
      });
    }, VOICE_SILENCE_MS);
  }, [clearSilenceTimer, clearVoiceGroupSilenceTimer, stopDictation, voiceCommittedText]);

  /** True while Grok is generating or speaking — user speech can barge in. */
  const isAssistantVoiceBusy = useCallback(() => {
    // Soft-paused: treat as not busy so we can confirm real words vs noise.
    if (softBargeInPendingRef.current) return false;
    return (
      streamingRef.current
      || ttsPlayingRef.current
      || ttsQueueRef.current.length > 0
    );
  }, []);

  const startDictation = useCallback((opts?: {
    quiet?: boolean;
    /** Empty the composer (default for hands-free turns). */
    fresh?: boolean;
    /** Keep current composer text as the dictation base (barge-in mid-phrase). */
    preserveInput?: boolean;
  }) => {
    if (typeof window === 'undefined') return;
    // Manual dictation never runs over an active stream.
    if (streamingRef.current && !autoSpeakRef.current) return;
    // After TTS ends, stay deaf for the echo window (barge-in during TTS is separate).
    if (
      autoSpeakRef.current
      && Date.now() < voiceIgnoreUntilRef.current
      && !(ttsPlayingRef.current || ttsQueueRef.current.length > 0)
    ) {
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      if (!opts?.quiet) toast.error('Dictation is not supported in this browser — try Chrome or Edge.');
      return;
    }
    // Already listening
    if (recognitionRef.current) return;

    try {
      clearSilenceTimer();
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';

      // Hands-free turns start from an empty composer; manual dictate can append.
      // Barge-in reopen can preserve partial text already in the input.
      const wipeComposer = opts?.preserveInput
        ? false
        : (opts?.fresh === true || (!!autoSpeakRef.current && opts?.fresh !== false));
      const existing = wipeComposer ? '' : inputRef.current.trimEnd();
      dictationBaseRef.current = existing ? `${existing.replace(/\s+$/, '')} ` : '';
      dictationFinalRef.current = '';
      setDictationInterim('');
      if (wipeComposer && autoSpeakRef.current) setInput('');

      rec.onresult = (event: SpeechRecognitionEvent) => {
        let interim = '';
        let newlyFinal = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i][0]?.transcript || '';
          if (event.results[i].isFinal) newlyFinal += piece;
          else interim += piece;
        }
        const finalChunk = newlyFinal.replace(/\s+/g, ' ').trim();
        const interimBit = interim.trim();
        const ttsOn = ttsPlayingRef.current || ttsQueueRef.current.length > 0;
        const busy = isAssistantVoiceBusy() || voiceGroupBusyRef.current;

        // Post-TTS echo tail only (not while Grok is still speaking).
        if (
          autoSpeakRef.current
          && !ttsOn
          && Date.now() < voiceIgnoreUntilRef.current
        ) {
          return;
        }

        // While Grok is thinking or speaking: listen for barge-in only — never type
        // into the composer. Require ~2s of continuous words before cutting him off.
        if (autoSpeakRef.current && busy) {
          const ready = Date.now() >= bargeInReadyAtRef.current;
          const spoken = `${finalChunk} ${interimBit}`.trim();
          let hasWords = false;
          try {
            hasWords = /[\p{L}\p{N}]{2,}/u.test(spoken);
          } catch {
            hasWords = /[A-Za-z0-9]{2,}/.test(spoken);
          }
          const now = Date.now();
          if (!ready) {
            bargeInSpeechStartedAtRef.current = 0;
            bargeInLastWordAtRef.current = 0;
            return;
          }
          if (hasWords) {
            bargeInLastWordAtRef.current = now;
            if (!bargeInSpeechStartedAtRef.current) {
              bargeInSpeechStartedAtRef.current = now;
            }
          } else if (
            bargeInLastWordAtRef.current
            && now - bargeInLastWordAtRef.current > BARGE_IN_GAP_RESET_MS
          ) {
            bargeInSpeechStartedAtRef.current = 0;
            bargeInLastWordAtRef.current = 0;
          }
          const heldMs = bargeInSpeechStartedAtRef.current
            ? now - bargeInSpeechStartedAtRef.current
            : 0;
          // With the acoustic VAD running, transcription never triggers the
          // interrupt (it only confirms after the soft pause) — otherwise TTS
          // echo transcribed as words would chop the assistant's own speech.
          const shouldInterrupt = !vadActiveRef.current && hasWords && heldMs >= BARGE_IN_HOLD_MS;
          if (shouldInterrupt) {
            bargeInSpeechStartedAtRef.current = 0;
            bargeInLastWordAtRef.current = 0;
            dictationBaseRef.current = '';
            dictationFinalRef.current = '';
            setDictationInterim('');
            setInput('');
            inputRef.current = '';
            clearSilenceTimer();
            interruptVoiceRef.current();
          }
          return;
        }

        // Listening path: commit finals only when the assistant is not speaking.
        if (finalChunk) {
          dictationFinalRef.current = dictationFinalRef.current
            ? `${dictationFinalRef.current} ${finalChunk}`
            : finalChunk;
        }
        const base = dictationBaseRef.current;
        const finals = dictationFinalRef.current;
        let next = base;
        if (finals) next = next ? `${next.replace(/\s+$/, '')} ${finals}` : finals;
        if (interimBit) next = next ? `${next.replace(/\s+$/, '')} ${interimBit}` : interimBit;
        setInput(next);
        setDictationInterim(interimBit);

        // Soft barge-in confirmation: real words cancel resume; noise does not.
        if (autoSpeakRef.current && softBargeInPendingRef.current) {
          const candidate = (finals || finalChunk || '').trim();
          let meaningful = false;
          try {
            const words = candidate.split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));
            meaningful = words.length >= 2 || candidate.replace(/\s+/g, '').length >= 12;
          } catch {
            meaningful = candidate.replace(/[^a-zA-Z0-9]/g, '').length >= 12;
          }
          if (meaningful) {
            confirmRealBargeInRef.current();
            clearSilenceTimer();
            if (dictationFinalRef.current.trim()) scheduleVoiceAutoSend();
            return;
          }
          // Still waiting — do not auto-send scraps; timer may resume speech.
          clearSilenceTimer();
          return;
        }

        clearSilenceTimer();
        if (autoSpeakRef.current && dictationFinalRef.current.trim() && !isAssistantVoiceBusy()) {
          scheduleVoiceAutoSend();
        }
      };

      rec.onerror = (event: SpeechRecognitionErrorEvent) => {
        if (event.error === 'aborted') return;
        if (event.error === 'no-speech') {
          // Keep listening in hands-free mode — just another quiet moment.
          if (autoSpeakRef.current && recognitionRef.current === rec) return;
          return;
        }
        if (event.error === 'not-allowed') {
          toast.error('Microphone permission denied — allow mic access for Grok voice.');
          autoSpeakRef.current = false;
          setAutoSpeak(false);
          try { window.localStorage.setItem('shiba-tts-auto', '0'); } catch { /* */ }
        } else if (event.error === 'network') {
          toast.error('Dictation needs a network connection for speech recognition.');
        } else {
          toast.error(`Dictation error: ${event.error}`);
        }
        stopDictation();
      };

      rec.onend = () => {
        if (recognitionRef.current !== rec) return;
        // Browser ended the session (common after a pause).
        // Keep listening during busy assistant turns so barge-in stays armed.
        if (autoSpeakRef.current && !sendingFromVoiceRef.current) {
          if (
            !streamingRef.current
            && !ttsPlayingRef.current
            && ttsQueueRef.current.length === 0
            && !voiceGroupBusyRef.current
            && Date.now() >= voiceIgnoreUntilRef.current
          ) {
            // Hands-free: only send user finals — never residual speaker text.
            const text = voiceCommittedText();
            if (text && dictationFinalRef.current.trim()) {
              clearSilenceTimer();
              setInput(text);
              inputRef.current = text;
              sendingFromVoiceRef.current = true;
              recognitionRef.current = null;
              setDictating(false);
              setDictationInterim('');
              window.setTimeout(() => {
                try { sendChatRef.current(); } finally {
                  window.setTimeout(() => { sendingFromVoiceRef.current = false; }, 800);
                }
              }, 40);
              return;
            }
          }
          // Don't restart mid-TTS mute window or while assistant audio is still active.
          if (
            Date.now() < voiceIgnoreUntilRef.current
            || ttsPlayingRef.current
            || ttsQueueRef.current.length > 0
          ) {
            recognitionRef.current = null;
            setDictating(false);
            return;
          }
          try {
            rec.start();
            return;
          } catch {
            recognitionRef.current = null;
            setDictating(false);
            if (autoSpeakRef.current) {
              window.setTimeout(() => startDictationRef.current(), 300);
            }
            return;
          }
        }
        // Manual dictation: keep continuous listening until the user hits the mic again.
        if (!autoSpeakRef.current && recognitionRef.current === rec) {
          try {
            rec.start();
            return;
          } catch { /* fall through */ }
        }
        recognitionRef.current = null;
        setDictating(false);
        setDictationInterim('');
      };

      recognitionRef.current = rec;
      rec.start();
      setDictating(true);
      textareaRef.current?.focus();
      // Voice/mic state is visible in the HUD — no toast popups.
    } catch (e: unknown) {
      if (!opts?.quiet) toast.error(e instanceof Error ? e.message : 'Could not start dictation');
      stopDictation();
    }
  }, [clearSilenceTimer, isAssistantVoiceBusy, scheduleVoiceAutoSend, stopDictation, voiceCommittedText]);

  useEffect(() => { startDictationRef.current = () => startDictation({ quiet: true, fresh: true }); }, [startDictation]);

  function toggleDictation() {
    if (dictating) {
      stopDictation();
      return;
    }
    // Manual mic without full voice mode — still listen; user can send with Enter.
    startDictation({ quiet: false, fresh: false });
  }

  useEffect(() => {
    if (streaming && dictating && !autoSpeakRef.current) stopDictation();
  }, [streaming, dictating, stopDictation]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/tts');
        const data = await res.json();
        if (data.ok && Array.isArray(data.voices) && data.voices.length) {
          setTtsVoices(data.voices);
          if (!data.voices.some((v: TtsVoiceOpt) => v.id === ttsVoiceRef.current)) {
            const def = data.defaultVoice || data.voices[0].id;
            setTtsVoice(def);
            try { window.localStorage.setItem('shiba-tts-voice', def); } catch { /* private mode */ }
          }
        }
      } catch {
        /* built-in voice list remains */
      }
    })();
  }, []);

  /** Wipe any transcript that may have been speaker-echo so it cannot auto-send. */
  const clearVoiceTranscript = useCallback(() => {
    clearSilenceTimer();
    dictationBaseRef.current = '';
    dictationFinalRef.current = '';
    setDictationInterim('');
    setInput('');
    inputRef.current = '';
  }, [clearSilenceTimer]);

  /**
   * Prepare barge-in monitoring while Grok speaks: wipe composer echo state,
   * arm the acoustic VAD gate, keep mic armed for confirmation words.
   */
  const armBargeInForTts = useCallback(() => {
    clearSilenceTimer();
    clearVoiceTranscript();
    bargeInSpeechStartedAtRef.current = 0;
    bargeInLastWordAtRef.current = 0;
    // Brief onset grace: the echo canceller needs a moment to converge on a
    // fresh TTS chunk before mic energy is trustworthy.
    bargeInReadyAtRef.current = Date.now() + 400;
    // Do not set voiceIgnoreUntil here — we need recognition events for barge-in.
    voiceIgnoreUntilRef.current = 0;
    if (!recognitionRef.current && autoSpeakRef.current) {
      window.setTimeout(() => {
        if (!autoSpeakRef.current) return;
        if (!ttsPlayingRef.current && ttsQueueRef.current.length === 0) return;
        if (recognitionRef.current) return;
        startDictation({ quiet: true, fresh: true });
      }, 40);
    }
  }, [clearSilenceTimer, clearVoiceTranscript, startDictation]);

  /**
   * After TTS (or barge-in), hard-reset the mic so recognition buffers full of
   * Grok's audio cannot fire a new user turn.
   */
  const resumeListeningAfterVoice = useCallback(() => {
    if (!autoSpeakRef.current || streamingRef.current) return;
    if (ttsPlayingRef.current || ttsQueueRef.current.length > 0) return;
    clearVoiceTranscript();
    voiceIgnoreUntilRef.current = Date.now() + VOICE_ECHO_MUTE_MS;
    bargeInReadyAtRef.current = Date.now() + VOICE_ECHO_MUTE_MS;
    // Kill any residual recognition session so the browser drops partial results.
    if (recognitionRef.current) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec.stop(); } catch { /* ignore */ }
      try { rec.abort(); } catch { /* ignore */ }
      setDictating(false);
    }
    window.setTimeout(() => {
      if (!autoSpeakRef.current || streamingRef.current) return;
      if (ttsPlayingRef.current || ttsQueueRef.current.length > 0) return;
      if (recognitionRef.current) return;
      if (Date.now() < voiceIgnoreUntilRef.current - 40) return;
      startDictation({ quiet: true, fresh: true });
    }, VOICE_ECHO_MUTE_MS);
  }, [clearVoiceTranscript, startDictation]);

  const stopSpeaking = useCallback(() => {
    ttsFetchGenRef.current += 1;
    ttsQueueRef.current = [];
    currentTtsChunkRef.current = null;
    ttsPlayingRef.current = false;
    try {
      audioRef.current?.pause();
      if (audioRef.current?.src?.startsWith('blob:')) URL.revokeObjectURL(audioRef.current.src);
    } catch { /* ignore */ }
    audioRef.current = null;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    setSpeakingMsgId(null);
    setTtsLoadingId(null);
  }, []);

  const clearSoftBargeInTimer = useCallback(() => {
    if (softBargeInTimerRef.current) {
      clearTimeout(softBargeInTimerRef.current);
      softBargeInTimerRef.current = null;
    }
  }, []);

  /** Snapshot remaining speech so a false barge-in can pick up where it left off. */
  function snapshotTtsForResume() {
    const remaining = [...ttsQueueRef.current];
    if (currentTtsChunkRef.current) {
      remaining.unshift(currentTtsChunkRef.current);
    }
    const msgId = voiceMsgIdRef.current || '';
    // Prefer rebuilding from stream buffer when queue is empty but text remains.
    ttsResumeRef.current = {
      msgId,
      queue: remaining,
      spokenLen: voiceSpokenLenRef.current,
      streamBuf: voiceStreamBufRef.current,
    };
  }

  /**
   * Soft interrupt: pause TTS, keep the reply, listen briefly.
   * Real user words → hard barge-in. Silence/noise → resume speech.
   */
  const interruptVoiceForBargeIn = useCallback(() => {
    if (!autoSpeakRef.current) return;
    if (softBargeInPendingRef.current) return;
    if (!isAssistantVoiceBusy() && !voiceGroupBusyRef.current) return;

    const wasSpeaking = ttsPlayingRef.current || ttsQueueRef.current.length > 0 || !!currentTtsChunkRef.current;
    snapshotTtsForResume();

    softBargeInPendingRef.current = true;
    // Do not set voiceBargeInRef yet — stream may still finish / TTS may resume.
    bargeInReadyAtRef.current = Number.MAX_SAFE_INTEGER;
    clearVoiceGroupSilenceTimer();
    voiceGroupChainRef.current = 0;
    // Pause audio only — do not wipe stream buffers (needed to resume).
    ttsFetchGenRef.current += 1;
    ttsPlayingRef.current = false;
    ttsQueueRef.current = [];
    currentTtsChunkRef.current = null;
    try {
      audioRef.current?.pause();
      if (audioRef.current?.src?.startsWith('blob:')) URL.revokeObjectURL(audioRef.current.src);
    } catch { /* ignore */ }
    audioRef.current = null;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    setTtsLoadingId(null);
    // Keep speakingMsgId for resume continuity when possible.
    if (!wasSpeaking) setSpeakingMsgId(null);

    clearVoiceTranscript();
    bargeInSpeechStartedAtRef.current = 0;
    bargeInLastWordAtRef.current = 0;
    voiceIgnoreUntilRef.current = Date.now() + Math.min(VOICE_ECHO_MUTE_MS, 500);
    bargeInReadyAtRef.current = Date.now() + 400;

    if (recognitionRef.current) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec.stop(); } catch { /* ignore */ }
      try { rec.abort(); } catch { /* ignore */ }
      setDictating(false);
    }

    clearSoftBargeInTimer();
    softBargeInTimerRef.current = setTimeout(() => {
      softBargeInTimerRef.current = null;
      resumeAfterFalseBargeInRef.current();
    }, FALSE_BARGE_IN_RESUME_MS);

    window.setTimeout(() => {
      if (!autoSpeakRef.current) return;
      startDictation({ quiet: true, fresh: true });
    }, 280);
  }, [clearSoftBargeInTimer, clearVoiceGroupSilenceTimer, clearVoiceTranscript, isAssistantVoiceBusy, startDictation]);

  /** User really said something after soft interrupt — abandon paused speech. */
  const confirmRealBargeIn = useCallback(() => {
    if (!softBargeInPendingRef.current && !ttsResumeRef.current) return;
    clearSoftBargeInTimer();
    softBargeInPendingRef.current = false;
    ttsResumeRef.current = null;
    voiceBargeInRef.current = true;
    voiceStreamBufRef.current = '';
    voiceSpokenLenRef.current = 0;
    voiceMsgIdRef.current = null;
    ttsQueueRef.current = [];
    currentTtsChunkRef.current = null;
    setSpeakingMsgId(null);
    if (streamingRef.current) {
      try {
        abortRef.current?.abort();
      } catch { /* ignore */ }
    }
    if (speakVoiceRestoreRef.current) {
      speakVoiceRef.current = speakVoiceRestoreRef.current;
      speakVoiceRestoreRef.current = null;
    }
  }, [clearSoftBargeInTimer]);

  /** Soft interrupt was noise — continue the paused reply. */
  const resumeAfterFalseBargeIn = useCallback(() => {
    if (!softBargeInPendingRef.current) return;
    if (!autoSpeakRef.current) {
      softBargeInPendingRef.current = false;
      ttsResumeRef.current = null;
      return;
    }
    // Real words already in the composer → treat as a real interrupt instead.
    const pending = (dictationFinalRef.current || inputRef.current || '').trim();
    if (pending.length >= 8) {
      confirmRealBargeIn();
      return;
    }

    clearSoftBargeInTimer();
    softBargeInPendingRef.current = false;
    voiceBargeInRef.current = false;
    clearVoiceTranscript();

    const snap = ttsResumeRef.current;
    ttsResumeRef.current = null;
    if (!snap) {
      if (!streamingRef.current) resumeListeningAfterVoice();
      return;
    }

    voiceMsgIdRef.current = snap.msgId || voiceMsgIdRef.current;
    voiceSpokenLenRef.current = snap.spokenLen;
    voiceStreamBufRef.current = snap.streamBuf;

    let queue = snap.queue.filter(Boolean);
    if (!queue.length && snap.streamBuf) {
      const speakable = textForSpeech(snap.streamBuf);
      const rest = speakable.slice(snap.spokenLen).trim();
      if (rest) queue = splitSpeechChunks(rest, 240);
    }
    // Also pull any unsent tail from the live message if stream finished while paused.
    if (!queue.length && snap.msgId) {
      const msg = messagesRef.current.find((m) => m.id === snap.msgId);
      if (msg?.content && !msg.streaming) {
        const speakable = textForSpeech(msg.content);
        const rest = speakable.slice(snap.spokenLen).trim();
        if (rest) {
          queue = splitSpeechChunks(rest, 240);
          voiceSpokenLenRef.current = speakable.length;
        }
      }
    }

    if (queue.length && snap.msgId) {
      ttsQueueRef.current = queue;
      void pumpTtsQueue(snap.msgId);
      return;
    }

    // Nothing left to say (or still streaming — deltas will re-enqueue).
    if (!streamingRef.current) resumeListeningAfterVoice();
  }, [clearSoftBargeInTimer, clearVoiceTranscript, confirmRealBargeIn, resumeListeningAfterVoice]);

  useEffect(() => {
    interruptVoiceRef.current = interruptVoiceForBargeIn;
  }, [interruptVoiceForBargeIn]);
  useEffect(() => {
    confirmRealBargeInRef.current = confirmRealBargeIn;
  }, [confirmRealBargeIn]);
  useEffect(() => {
    resumeAfterFalseBargeInRef.current = resumeAfterFalseBargeIn;
  }, [resumeAfterFalseBargeIn]);

  // Stop mic + TTS when this chat panel unmounts (session switch). Navigation
  // keep-alive avoids unmounting while voice is still active on another tab.
  useEffect(() => () => {
    clearSoftBargeInTimer();
    softBargeInPendingRef.current = false;
    ttsResumeRef.current = null;
    stopDictation();
    stopSpeaking();
    voiceVadRef.current?.stop();
    voiceVadRef.current = null;
    vadActiveRef.current = false;
  }, [clearSoftBargeInTimer, stopDictation, stopSpeaking]);

  // Acoustic barge-in detector rides voice mode (covers the toggle AND the
  // session-restore path). Speech onset while the assistant is talking or
  // thinking soft-pauses it within ~250ms — the recognizer then confirms real
  // words (hard barge-in) or the reply resumes where it left off.
  useEffect(() => {
    if (!autoSpeak) return;
    let cancelled = false;
    void (async () => {
      const handle = await startVoiceVad({
        onSpeechStart: () => {
          if (!autoSpeakRef.current) return;
          if (softBargeInPendingRef.current) return;
          if (Date.now() < bargeInReadyAtRef.current) return;
          if (!(isAssistantVoiceBusy() || voiceGroupBusyRef.current)) return;
          interruptVoiceRef.current();
        },
      });
      if (cancelled) {
        handle?.stop();
        return;
      }
      voiceVadRef.current = handle;
      vadActiveRef.current = !!handle;
    })();
    return () => {
      cancelled = true;
      voiceVadRef.current?.stop();
      voiceVadRef.current = null;
      vadActiveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs + stable callback; lifecycle keyed to voice mode
  }, [autoSpeak]);

  function persistTtsVoice(id: string) {
    const next = id.trim().toLowerCase() || DEFAULT_TTS_VOICE;
    setTtsVoice(next);
    ttsVoiceRef.current = next;
    speakVoiceRef.current = next;
    try { window.localStorage.setItem('shiba-tts-voice', next); } catch { /* private mode */ }
  }

  function persistTtsSpeed(raw: string | number, opts?: { quiet?: boolean }) {
    const next = clampTtsSpeed(raw);
    setTtsSpeed(next);
    ttsSpeedRef.current = next;
    try { window.localStorage.setItem('shiba-tts-speed', String(next)); } catch { /* private mode */ }
    patchVoiceAgentUi({ speechSpeed: next });
    // Speed is shown on the voice HUD chip — no toast.
  }

  function persistAutoSpeak(on: boolean) {
    setAutoSpeak(on);
    autoSpeakRef.current = on;
    const sessionId = session?.id || null;
    persistVoiceSessionBinding(on, sessionId);
    if (on) {
      setVoiceAgentActive(true, sessionId);
      // Hands-free Grok voice: mic on immediately.
      stopSpeaking();
      startDictation({ quiet: false, fresh: true });
    } else {
      clearVoiceGroupSilenceTimer();
      voiceGroupChainRef.current = 0;
      voiceGroupBusyRef.current = false;
      setVoiceAgentActive(false);
      setVoiceAgentMinimized(false);
      stopDictation();
      stopSpeaking();
    }
  }

  /** Browser SpeechSynthesis fallback when xAI TTS is unavailable. */
  function speakWithBrowser(text: string, msgId: string) {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      toast.error('Speech is not available in this browser.');
      resumeListeningAfterVoice();
      return;
    }
    armBargeInForTts();
    ttsPlayingRef.current = true;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language || 'en-US';
    // Prefer a local voice whose name vaguely matches the selected Grok voice.
    const voices = window.speechSynthesis.getVoices();
    const want = speakVoiceRef.current.toLowerCase();
    const match = voices.find((v) => v.name.toLowerCase().includes(want))
      || voices.find((v) => v.lang.startsWith('en'))
      || voices[0];
    if (match) u.voice = match;
    // Web Speech rate is roughly 0.1–10; map our 0.7–1.5 onto that scale.
    u.rate = clampTtsSpeed(ttsSpeedRef.current);
    u.onend = () => {
      ttsPlayingRef.current = false;
      setSpeakingMsgId(null);
      resumeListeningAfterVoice();
    };
    u.onerror = () => {
      ttsPlayingRef.current = false;
      setSpeakingMsgId(null);
      resumeListeningAfterVoice();
    };
    setSpeakingMsgId(msgId);
    window.speechSynthesis.speak(u);
  }

  /** Fetch one short TTS chunk (low-latency settings for voice agent). */
  async function fetchTtsBlob(text: string, gen: number): Promise<Blob | null> {
    if (!text.trim() || gen !== ttsFetchGenRef.current) return null;
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        preprocessed: true,
        voice_id: speakVoiceRef.current || ttsVoiceRef.current,
        language: 'en',
        speed: clampTtsSpeed(ttsSpeedRef.current),
        fast: true,
      }),
    });
    if (gen !== ttsFetchGenRef.current) return null;
    if (!res.ok) {
      if (res.status === 401) {
        // Signal caller to fall back to browser TTS for the whole remaining text.
        throw Object.assign(new Error('auth'), { status: 401 });
      }
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `TTS failed (${res.status})`);
    }
    return res.blob();
  }

  /** Play queued TTS chunks; fetch next while current plays. */
  async function pumpTtsQueue(msgId: string) {
    if (ttsPlayingRef.current) return;
    if (softBargeInPendingRef.current) return;
    ttsPlayingRef.current = true;
    // Keep mic open for barge-in; require ~2s of words before cutting speech.
    armBargeInForTts();
    const gen = ttsFetchGenRef.current;
    setSpeakingMsgId(msgId);
    setTtsLoadingId(msgId);

    try {
      while (ttsQueueRef.current.length > 0 && gen === ttsFetchGenRef.current) {
        if (softBargeInPendingRef.current) break;
        const chunk = ttsQueueRef.current.shift()!;
        currentTtsChunkRef.current = chunk;
        // Prefetch next while we synthesize current when possible
        const nextPrefetch = ttsQueueRef.current[0]
          ? fetchTtsBlob(ttsQueueRef.current[0], gen).catch(() => null)
          : null;

        let blob: Blob | null;
        try {
          blob = await fetchTtsBlob(chunk, gen);
        } catch (e: unknown) {
          if ((e as { status?: number })?.status === 401) {
            toast.message('Using browser voice — connect xAI for Grok voices.');
            const rest = [chunk, ...ttsQueueRef.current].join(' ');
            ttsQueueRef.current = [];
            currentTtsChunkRef.current = null;
            ttsPlayingRef.current = false;
            speakWithBrowser(rest, msgId);
            return;
          }
          throw e;
        }
        if (!blob || gen !== ttsFetchGenRef.current) break;

        // Re-arm barge-in hold each chunk (don't accumulate hold across chunk edges).
        bargeInSpeechStartedAtRef.current = 0;
        bargeInLastWordAtRef.current = 0;
        bargeInReadyAtRef.current = Date.now() + 500;
        const url = URL.createObjectURL(blob);
        await new Promise<void>((resolve, reject) => {
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => {
            URL.revokeObjectURL(url);
            if (audioRef.current === audio) audioRef.current = null;
            if (currentTtsChunkRef.current === chunk) currentTtsChunkRef.current = null;
            resolve();
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            if (currentTtsChunkRef.current === chunk) currentTtsChunkRef.current = null;
            reject(new Error('Audio playback failed'));
          };
          void audio.play().catch(reject);
        });

        if (nextPrefetch) void nextPrefetch;
      }
    } catch (e: unknown) {
      if (gen === ttsFetchGenRef.current) {
        toast.error(e instanceof Error ? e.message : 'Speech failed');
      }
    } finally {
      if (gen === ttsFetchGenRef.current) {
        ttsPlayingRef.current = false;
        setTtsLoadingId(null);
        if (softBargeInPendingRef.current) {
          // Soft interrupt owns resume — do not clear speaking state here.
          return;
        }
        if (ttsQueueRef.current.length === 0) {
          currentTtsChunkRef.current = null;
          setSpeakingMsgId(null);
          if (speakVoiceRestoreRef.current) {
            speakVoiceRef.current = speakVoiceRestoreRef.current;
            speakVoiceRestoreRef.current = null;
          }
          if (!streamingRef.current) {
            resumeListeningAfterVoice();
            if (isVoiceGroupMode() && !voiceBargeInRef.current) {
              scheduleVoiceGroupContinuation();
            }
          }
        } else {
          void pumpTtsQueue(msgId);
        }
      }
    }
  }

  function enqueueTtsChunks(msgId: string, chunks: string[]) {
    const cleaned = chunks.map((c) => c.trim()).filter(Boolean);
    if (!cleaned.length) return;
    // While waiting to confirm a soft barge-in, only buffer text — don't play yet.
    if (softBargeInPendingRef.current) {
      voiceMsgIdRef.current = msgId;
      ttsQueueRef.current.push(...cleaned);
      return;
    }
    if (autoSpeakRef.current) {
      armBargeInForTts();
    } else {
      stopDictation();
    }
    voiceMsgIdRef.current = msgId;
    ttsQueueRef.current.push(...cleaned);
    void pumpTtsQueue(msgId);
  }

  /** Reset progressive voice state for a new assistant turn. */
  function beginVoiceStream(msgId: string) {
    voiceMsgIdRef.current = msgId;
    voiceStreamBufRef.current = '';
    voiceSpokenLenRef.current = 0;
    // Don't cancel in-flight speech from a previous turn until first new chunk.
  }

  /**
   * Called on every content delta in voice mode: start speaking the first
   * complete sentence ASAP (don't wait for the full reply).
   */
  function onVoiceStreamDelta(msgId: string, delta: string) {
    if (!autoSpeakRef.current || !delta) return;
    if (voiceMsgIdRef.current !== msgId) beginVoiceStream(msgId);
    voiceStreamBufRef.current += delta;
    // Soft barge-in: keep buffering text so we can resume speaking, but don't play yet.
    if (softBargeInPendingRef.current) return;
    const speakable = textForSpeech(voiceStreamBufRef.current);
    let unsent = speakable.slice(voiceSpokenLenRef.current);
    // Emit complete utterances as soon as they form (first one uses a lower bar for TTFA).
    let emitted = 0;
    while (emitted < 3) {
      const isFirst = voiceSpokenLenRef.current === 0;
      const piece = takeNextUtterance(unsent, {
        minChars: isFirst ? 28 : 40,
        maxChars: isFirst ? 160 : 260,
        allowPartial: false,
      });
      if (!piece) break;
      const idx = unsent.indexOf(piece);
      unsent = idx >= 0 ? unsent.slice(idx + piece.length).replace(/^\s+/, '') : unsent.slice(piece.length);
      voiceSpokenLenRef.current = speakable.length - unsent.length;
      enqueueTtsChunks(msgId, [piece]);
      emitted += 1;
    }
  }

  /** After stream ends: speak whatever hasn't been spoken yet. */
  function finishVoiceStream(msgId: string, fullContent: string) {
    if (!autoSpeakRef.current) return;
    // Hard barge-in confirmed — do not speak the aborted reply's remainder.
    if (voiceBargeInRef.current) {
      voiceBargeInRef.current = false;
      if (!recognitionRef.current) resumeListeningAfterVoice();
      return;
    }
    // Soft barge-in still pending: stash remaining text into resume snapshot.
    if (softBargeInPendingRef.current) {
      voiceMsgIdRef.current = msgId;
      voiceStreamBufRef.current = fullContent || voiceStreamBufRef.current;
      const speakable = textForSpeech(voiceStreamBufRef.current);
      const rest = speakable.slice(voiceSpokenLenRef.current).trim();
      const queue = rest ? splitSpeechChunks(rest, 240) : [];
      ttsResumeRef.current = {
        msgId,
        queue: [
          ...(ttsResumeRef.current?.queue || []),
          ...queue,
        ],
        spokenLen: voiceSpokenLenRef.current,
        streamBuf: voiceStreamBufRef.current,
      };
      if (rest) voiceSpokenLenRef.current = speakable.length;
      return;
    }
    const speakable = textForSpeech(fullContent || '');
    if (!speakable) {
      if (!ttsPlayingRef.current && ttsQueueRef.current.length === 0) resumeListeningAfterVoice();
      return;
    }
    // If progressive path never started (no sentence yet), speak whole reply in chunks.
    if (voiceMsgIdRef.current !== msgId || voiceSpokenLenRef.current === 0) {
      stopSpeaking();
      beginVoiceStream(msgId);
      const chunks = splitSpeechChunks(speakable, 240);
      voiceSpokenLenRef.current = speakable.length;
      enqueueTtsChunks(msgId, chunks);
      return;
    }
    const rest = speakable.slice(voiceSpokenLenRef.current).trim();
    if (rest) {
      voiceSpokenLenRef.current = speakable.length;
      const chunks = splitSpeechChunks(rest, 260);
      enqueueTtsChunks(msgId, chunks);
    } else if (!ttsPlayingRef.current && ttsQueueRef.current.length === 0) {
      resumeListeningAfterVoice();
    }
  }

  async function speakMessage(msg: { id: string; content?: string }) {
    // Manual Speak button — full reply, chunked for faster first audio.
    const spoken = textForSpeech(msg.content || '');
    if (!spoken) {
      toast.error('Nothing to speak in this message.');
      return;
    }
    if (speakingMsgId === msg.id && ttsPlayingRef.current) {
      stopSpeaking();
      return;
    }
    stopSpeaking();
    stopDictation();
    beginVoiceStream(msg.id);
    voiceSpokenLenRef.current = spoken.length;
    enqueueTtsChunks(msg.id, splitSpeechChunks(spoken, 240));
  }

  // When streaming ends in voice mode, flush remaining unspoken text.
  const prevStreamingRef = useRef(streaming);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (!wasStreaming || streaming) return;
    if (!autoSpeakRef.current) return;
    if (voiceBargeInRef.current) {
      // Barge-in aborted the turn — stay in listen mode, no residual TTS.
      voiceBargeInRef.current = false;
      if (!recognitionRef.current) resumeListeningAfterVoice();
      return;
    }
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.id !== 'welcome' && m.content);
    if (last) {
      finishVoiceStream(last.id, last.content);
    } else {
      resumeListeningAfterVoice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, messages]);

  // When Grok voice is on (including after localStorage restore), open the mic.
  useEffect(() => {
    if (!autoSpeak || !dictationSupported) return;
    const t = window.setTimeout(() => {
      if (autoSpeakRef.current && !streamingRef.current) {
        startDictation({ quiet: true, fresh: true });
      }
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSpeak, dictationSupported]);

  // Esc exits Jarvis voice mode.
  useEffect(() => {
    if (!autoSpeak) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        persistAutoSpeak(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSpeak]);

  const voicePhase: 'idle' | 'listening' | 'thinking' | 'speaking' = !autoSpeak
    ? 'idle'
    : (speakingMsgId || ttsLoadingId)
      ? 'speaking'
      : streaming
        ? 'thinking'
        : dictating
          ? 'listening'
          : 'idle';

  // Keep shell aware of voice so chat stays mounted while browsing other pages.
  useEffect(() => {
    if (autoSpeak) {
      setVoiceAgentActive(true, session?.id || null);
    } else {
      setVoiceAgentActive(false);
      setVoiceAgentMinimized(false);
    }
  }, [autoSpeak, session?.id]);

  useEffect(() => {
    return registerVoiceAgentHandlers({
      onClose: () => {
        persistAutoSpeak(false);
      },
      onToggleMic: () => {
        if (recognitionRef.current) stopDictation();
        else startDictation({ quiet: true, fresh: true });
      },
      onSetSpeechSpeed: (speed) => {
        persistTtsSpeed(speed, { quiet: true });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDictation, stopDictation]);

  // On unmount (chat switch / new chat key change): end voice for this session.
  // Navigation off Chat does not unmount while voice is active (shell keep-alive).
  useEffect(() => {
    const sid = session?.id || null;
    return () => {
      try {
        if (shouldRestoreVoiceForSession(sid)) {
          persistVoiceSessionBinding(false, null);
        }
      } catch { /* ignore */ }
      const cur = getVoiceAgentUiState();
      if (cur.active && cur.boundSessionId === sid) {
        setVoiceAgentActive(false);
      }
    };
  }, [session?.id]);

  // "Jump to latest" when the reader scrolls away from the tail.
  const [awayFromLatest, setAwayFromLatest] = useState(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) {
      // Direct scrollTop is more reliable than scrollIntoView during rapid stream updates.
      if (smooth) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    } else {
      bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
    }
  }, []);

  // Pin to the latest bubble on every message/stream update while stick is on.
  // Use rAF so layout has applied the new content height first.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const id = requestAnimationFrame(() => {
      if (stickToBottomRef.current) scrollToBottom(false);
    });
    return () => cancelAnimationFrame(id);
  }, [messages, streaming, scrollToBottom]);

  // When a stream starts, re-pin so the user always sees the new reply.
  useEffect(() => {
    if (!streaming) return;
    stickToBottomRef.current = true;
    setAwayFromLatest(false);
    scrollToBottom(false);
  }, [streaming, scrollToBottom]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Non-session (project / direct) streams die with the panel. Session turns
  // keep running in the live-run registry so you can leave Chat and come back.
  useEffect(() => {
    const ref = abortRef;
    const sessionId = session?.id;
    return () => {
      if (sessionId && getLiveChatRun(sessionId)?.streaming) return;
      ref.current?.abort();
    };
  }, [session?.id]);

  // Reattach to a background session turn (or hydrate live messages) when this
  // panel mounts / the session key changes.
  useEffect(() => {
    if (!session?.id) return;
    const sid = session.id;
    const applyLive = () => {
      const live = getLiveChatRun(sid);
      if (!live) return;
      const ui = live.messages.map((m) => ({ ...m, streaming: !!m.streaming })) as UiMessage[];
      setMessages(ui);
      messagesRef.current = ui;
      setStreaming(live.streaming);
      if (live.streaming) {
        abortRef.current = live.abort;
        const last = ui[ui.length - 1];
        if (last?.streaming) {
          setExpandedThinking((prev) => ({ ...prev, [last.id]: true }));
        }
      }
    };
    applyLive();
    return subscribeLiveChatSession(sid, applyLive);
  }, [session?.id]);

  // Keep the composer ready to type — on mount and whenever a stream finishes.
  useEffect(() => {
    if (!streaming && !editingMsgId) textareaRef.current?.focus();
  }, [streaming, editingMsgId]);

  // Persist the draft (debounced); cleared automatically when input empties on send.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        if (input) window.localStorage.setItem(draftKey, input);
        else window.localStorage.removeItem(draftKey);
      } catch {
        /* storage full/unavailable — drafts are best-effort */
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [input, draftKey]);

  const onMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = dist < 120;
    stickToBottomRef.current = nearBottom;
    setAwayFromLatest(!nearBottom);
  }, []);

  /** Export the conversation as Markdown — roles, models, reasoning, tokens (C4). */
  function exportChatMarkdown() {
    const real = messages.filter((m) => m.id !== 'welcome' && m.content);
    if (!real.length) return;
    const title = session?.title || project?.name || 'Grok Chat';
    const lines: string[] = [
      `# ${title}`,
      '',
      `_Exported ${new Date().toLocaleString()} from Shiba Studio_`,
      '',
    ];
    for (const m of real) {
      const who = m.role === 'user' ? 'You' : (m.agentName || 'Grok');
      const model = m.model ? ` · ${modelDisplayName(m.model)}` : '';
      lines.push(`## ${who}${model}`, '');
      if (m.thinking?.trim()) {
        lines.push('<details><summary>Reasoning</summary>', '', m.thinking.trim(), '', '</details>', '');
      }
      lines.push(m.content, '');
      if (m.usage) {
        lines.push(`_${m.usage.promptTokens.toLocaleString()} in · ${m.usage.completionTokens.toLocaleString()} out tokens_`, '');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'grok-chat'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success('Chat exported as Markdown');
  }

  // Resync messages from disk when the session snapshot changes.
  // Never re-apply chatTarget/agent from the session — sticky picker owns that.
  // Live background turns win over disk snapshots until they finish.
  const sessionSyncKeyRef = useRef<string | null>(session ? `${session.id}:${session.updatedAt}` : null);
  const sessionIdOnlyRef = useRef<string | null>(session?.id ?? null);
  useEffect(() => {
    if (!session || streaming) return;
    if (getLiveChatRun(session.id)?.streaming) return;
    const syncKey = `${session.id}:${session.updatedAt}`;
    if (sessionSyncKeyRef.current === syncKey) return;
    sessionSyncKeyRef.current = syncKey;

    const sessionIdChanged = sessionIdOnlyRef.current !== session.id;
    sessionIdOnlyRef.current = session.id;

    // Keep the sticky agent; only session-local prefs rehydrate on switch.
    const next = sessionToInitialState(
      session,
      project,
      agents,
      getStickyChatTarget() as ChatTarget,
    );
    if (sessionIdChanged) {
      // Workspace / reasoning / CLI are per-session; agent picker is not.
      setUseGrokCli(next.useGrokCli);
      setReasoningEffort(next.reasoningEffort);
      setWorkspaceDir(next.workspaceDir);
      // Re-bind local state to sticky on remount paths (key=session.id).
      setChatTarget(next.target);
    }
    setMessages(next.messages);
    setExpandedThinking({});
    // Disk said a turn was still running but nothing is live (reload mid-turn).
    if (session.running || next.messages.some((m) => m.streaming)) {
      setMessages((msgs) =>
        msgs.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      );
      // Quiet patch — must not cascade into nav-stats / full-list reloads.
      void patchSession({
        running: false,
        messages: uiToProjectMessages(
          next.messages.map((m) => ({ ...m, streaming: false })),
        ),
      }, { notify: false });
    }
  }, [session, project, agents, streaming]);

  // Same guard for non-session (direct / project) mode: only reset when the
  // conversation scope really changes, never mid-stream.
  const scopeKeyRef = useRef<string>(`${chatTarget}:${project?.id || ''}`);
  useEffect(() => {
    if (session || streaming) return;
    const scopeKey = `${chatTarget}:${project?.id || ''}`;
    if (scopeKeyRef.current === scopeKey) return;
    scopeKeyRef.current = scopeKey;
    setMessages(initialMessages(project, chatTarget, agents));
    setExpandedThinking({});
  }, [chatTarget, project, session, agents, streaming]);

  async function patchSession(patch: Record<string, unknown>, opts?: { notify?: boolean }) {
    if (!session) return;
    try {
      await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: session.id, patch }),
      });
      // Default: refresh this session row only. Callers that don't need a
      // rail refresh (e.g. clearing a stale running flag) can pass notify:false.
      if (opts?.notify !== false) onSessionUpdated?.();
    } catch {
      /* ignore */
    }
  }

  async function persistSessionMessages(msgs: UiMessage[], opts?: { running?: boolean }) {
    if (!session) return;
    const saved = uiToProjectMessages(msgs);
    const wasUntitled = !session.title || session.title === 'New chat';
    const running = opts?.running ?? saved.some((m) => m.streaming);
    await patchSession({
      messages: saved,
      running,
      title: deriveSessionTitle(saved, session.title),
    });
    // First exchange of a fresh chat → have a low-end model write a real
    // title (server picks a fast/cheap model; falls back to the default).
    // Background turns also auto-title via finishLiveChatRun.
    const userCount = saved.filter((m) => m.role === 'user').length;
    if (
      wasUntitled
      && userCount === 1
      && saved.some((m) => m.role === 'assistant' && !m.streaming)
      && !getLiveChatRun(session.id)?.streaming
    ) {
      try {
        await fetch('/api/chat-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'autotitle', id: session.id }),
        });
        onSessionUpdated?.();
      } catch {
        /* derived title stays */
      }
    }
  }

  /**
   * Synchronous message updates for stream deltas. Uses the live-run snapshot
   * (or messagesRef) as source of truth so chunks stay ordered under React
   * batching and keep applying after this panel unmounts.
   */
  function mapMessages(updater: (msgs: UiMessage[]) => UiMessage[], opts?: { streaming?: boolean; persist?: boolean }) {
    const live = session?.id ? getLiveChatRun(session.id) : undefined;
    const current: UiMessage[] = live?.messages?.length
      ? (live.messages as UiMessage[])
      : (messagesRef.current.length ? messagesRef.current : []);
    const next = updater(current);
    messagesRef.current = next.filter((m) => m.id !== 'welcome');
    if (session?.id && (getLiveChatRun(session.id) || opts?.streaming)) {
      updateLiveChatRun(session.id, toLiveMessages(next), {
        streaming: opts?.streaming,
        persist: opts?.persist,
      });
    }
    setMessages(next);
  }

  /**
   * User explicitly picked Grok / an agent / All in the chat chrome.
   * Updates the sticky global picker immediately; session.chatTarget is only
   * written when a turn is actually sent.
   */
  function updateChatTarget(next: ChatTarget) {
    setChatTarget(next);
    if (isSessionMode) setStickyChatTarget(next);
    if (next === 'all') setUseGrokCli(false);
    // Seed TTS voice only on explicit agent pick (not on session select/remount).
    if (next !== 'grok' && next !== 'all') {
      const agent = agents.find((a) => a.id === next);
      const voice = agent?.voiceId?.trim().toLowerCase() || '';
      if (voice) {
        setTtsVoice(voice);
        ttsVoiceRef.current = voice;
        speakVoiceRef.current = voice;
        try { window.localStorage.setItem('shiba-tts-voice', voice); } catch { /* private mode */ }
      }
    }
  }

  function updateReasoningEffort(next: ReasoningEffort) {
    setReasoningEffort(next);
    if (isSessionMode) void patchSession({ reasoningEffort: next });
  }

  function updateWorkspaceDir(next: string | null) {
    setWorkspaceDir(next);
    if (isSessionMode) void patchSession({ workspaceDir: next });
    if (next) {
      toast.success(`Chat bound to ${next} — file reads/writes and /git run there now`);
    }
  }

  function updateUseGrokCli(next: boolean) {
    setUseGrokCli(next);
    let nextCliModel = cliModel;
    if (next && (!nextCliModel || !cliModels.includes(nextCliModel))) {
      nextCliModel = cliDefaultModel || cliModels[0] || '';
      setCliModel(nextCliModel);
    }
    if (isSessionMode) void patchSession({ useGrokCli: next, cliModel: nextCliModel || undefined });
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/grok-cli/status');
        const data = await res.json();
        setGrokCliInstalled(!!data.installed);
        setGrokCliVersion(data.version || null);
        const models: string[] = Array.isArray(data.models) ? data.models : [];
        setCliModels(models);
        setCliDefaultModel(data.defaultModel || null);
        setCliModel((cur) => (cur && models.includes(cur) ? cur : (data.defaultModel || models[0] || '')));
        if (!data.installed) setUseGrokCli(false);
      } catch {
        setGrokCliInstalled(false);
        setUseGrokCli(false);
      }
      setCliModelsLoading(false);
    })();
  }, []);

  function updateCliModel(next: string) {
    setCliModel(next);
    if (isSessionMode) void patchSession({ cliModel: next });
  }

  async function persistProjectChat(msgs: UiMessage[]) {
    if (!project) return;
    try {
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'saveMessages',
          id: project.id,
          messages: uiToProjectMessages(msgs),
        }),
      });
      onProjectUpdated?.();
    } catch {
      /* ignore */
    }
  }

  const selectedAgent = chatTarget !== 'grok' && chatTarget !== 'all'
    ? agents.find((a) => a.id === chatTarget)
    : undefined;

  /** Agent's configured default (if any) — applied only when user picks the agent. */
  const agentDefaultVoiceId = selectedAgent?.voiceId?.trim().toLowerCase() || '';
  // Chat picker is always the live choice; agent default is not auto-applied on chat select.
  const effectiveTtsVoice = ttsVoice;
  const effectiveVoiceLabel =
    ttsVoices.find((v) => v.id === effectiveTtsVoice)?.name || effectiveTtsVoice;

  useEffect(() => {
    speakVoiceRef.current = effectiveTtsVoice;
  }, [effectiveTtsVoice]);

  // Sync HUD phase/caption after voice label is available.
  useEffect(() => {
    if (!autoSpeak) return;
    const groupMode = chatTarget === 'all' && agents.length >= 2;
    patchVoiceAgentUi({
      phase: voicePhase,
      // During group turns, agent name is patched separately while speaking.
      voiceName: groupMode && voicePhase === 'speaking'
        ? (getVoiceAgentUiState().voiceName || effectiveVoiceLabel)
        : groupMode
          ? 'Group'
          : effectiveVoiceLabel,
      interim: dictationInterim,
      lastHeard: voiceLastHeard,
      micActive: dictating,
      groupMode,
      speechSpeed: clampTtsSpeed(ttsSpeed),
    });
  }, [autoSpeak, voicePhase, effectiveVoiceLabel, dictationInterim, voiceLastHeard, dictating, chatTarget, agents.length, ttsSpeed]);

  const supportsMultimodal = chatTarget !== 'all';

  /** Sub-browser hands back an annotated element — prefill the composer with
   *  the refinement prompt and attach the highlighted screenshot. */
  function handleAnnotation(annotation: SubBrowserAnnotation) {
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${annotation.promptBlock}` : annotation.promptBlock));
    if (supportsMultimodal && !useGrokCli) {
      let host = 'page';
      try { host = new URL(annotation.pageUrl).host || 'page'; } catch { /* keep default */ }
      setPendingAttachments((prev) => [
        ...prev,
        {
          id: uuidv4(),
          kind: 'image',
          name: `annotation-${host}.png`,
          mimeType: 'image/png',
          dataUrl: annotation.screenshotDataUrl,
        },
      ]);
    }
    textareaRef.current?.focus();
    toast.success('Annotation added to the composer — edit or send.');
  }
  const hasChatHistory = messages.some((m) => m.id !== 'welcome');

  /** Live catalog flag when available; id heuristic for saved/fallback models. */
  const modelSupportsReasoning = useCallback((modelRef: string): boolean => {
    if (parseModelRef(modelRef).provider !== 'cloud') return false;
    const found = availableModels.find((m) => m.id === modelRef);
    if (found?.reasoning !== undefined) return found.reasoning;
    return supportsReasoning(modelRef);
  }, [availableModels]);

  const chatSuggestions = project
    ? [
        `Summarize the files in "${project.name}"`,
        'What should we build next in this project?',
        'Find risks or gaps in the current project files',
        'Draft a README for this project',
      ]
    : selectedAgent
      ? [
          `What can you help me with, ${selectedAgent.name}?`,
          'Summarize your capabilities and available tools',
          'Propose three tasks you could automate for me',
          'What context do you currently have access to?',
        ]
      : [
          'Summarize the files in my global uploads',
          'Draft a step-by-step plan to ship a small web app',
          'Compare my local and cloud agents and when to use each',
          'Write a shell one-liner to find the largest files in a folder',
        ];

  async function clearChatContext() {
    if (!hasChatHistory && !pendingAttachments.length && !input.trim()) return;
    const scope = project ? `project "${project.name}"` : 'this chat';
    const ok = await confirmDialog({
      title: `Clear ${scope} history?`,
      message: 'Workspace global uploads and project files still apply to new messages.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;

    abortRef.current?.abort();
    setStreaming(false);
    setInput('');
    setPendingAttachments([]);
    setExpandedThinking({});
    const reset = resetChatMessages(project, chatTarget, agents);
    setMessages(reset);
    if (isSessionMode) {
      await persistSessionMessages(reset);
    } else if (project) {
      try {
        await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'saveMessages', id: project.id, messages: [] }),
        });
        onProjectUpdated?.();
      } catch {
        /* ignore */
      }
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list) {
        if (project) {
          const pfd = new FormData();
          pfd.append('projectId', project.id);
          pfd.append('files', file);
          const pres = await fetch('/api/projects/upload', { method: 'POST', body: pfd });
          const pdata = await pres.json();
          if (pdata.error) throw new Error(pdata.error);
          onProjectUpdated?.();
        }
        const fd = new FormData();
        fd.append('file', file);
        fd.append('model', chatModelRef.current);
        const res = await fetch('/api/chat/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const att = fileToAttachment(file, data.attachment);
        setPendingAttachments((prev) => [...prev, att]);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Upload failed';
      toast.error(msg);
    }
    setUploading(false);
  }

  function removeAttachment(id: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function toggleThinking(id: string) {
    setExpandedThinking((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function consumeStream(
    res: Response,
    assistantId: string,
    onPerspective?: (p: AgentPerspective) => void,
  ) {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response stream');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        for (const line of part.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          let event: {
            type: string;
            delta?: string;
            message?: string;
            model?: string;
            agentId?: string;
            name?: string;
            content?: string;
            usage?: Record<string, unknown>;
            file?: ChatFileRef;
          };
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          if (event.type === 'thinking' && event.delta) {
            mapMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId ? { ...m, thinking: (m.thinking || '') + event.delta } : m,
              ),
              { streaming: true },
            );
          } else if (event.type === 'agent-perspective' && event.agentId && event.name && event.content) {
            const perspective = { agentId: event.agentId, name: event.name, content: event.content };
            onPerspective?.(perspective);
            mapMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId
                  ? { ...m, perspectives: [...(m.perspectives || []), perspective] }
                  : m,
              ),
              { streaming: true },
            );
          } else if (event.type === 'file-created' && event.file?.path) {
            const file = event.file;
            mapMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      files: (m.files || []).some((f) => f.path === file.path)
                        ? m.files
                        : [...(m.files || []), file],
                    }
                  : m,
              ),
              { streaming: true },
            );
          } else if (event.type === 'content' && event.delta) {
            mapMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + event.delta } : m,
              ),
              { streaming: true },
            );
            // Voice agent: start TTS on the first complete sentence while still streaming.
            if (autoSpeakRef.current) onVoiceStreamDelta(assistantId, event.delta);
          } else if (event.type === 'usage' && event.usage) {
            const u = event.usage;
            const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
            const completionTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
            const totalTokens = Number(u.total_tokens ?? promptTokens + completionTokens) || 0;
            if (totalTokens > 0) {
              mapMessages((msgs) =>
                msgs.map((m) =>
                  m.id === assistantId ? { ...m, usage: { promptTokens, completionTokens, totalTokens } } : m,
                ),
                { streaming: true, persist: false },
              );
            }
          } else if (event.type === 'error') {
            throw new Error(event.message || 'Stream error');
          } else if (event.type === 'done' && event.model) {
            mapMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId ? { ...m, model: event.model, streaming: false } : m,
              ),
              { streaming: true },
            );
          }
        }
      }
    }

    mapMessages(
      (msgs) => msgs.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
      { streaming: false },
    );
  }

  function stopStreaming() {
    if (session?.id) abortLiveChatRun(session.id);
    abortRef.current?.abort();
  }

  function scheduleVoiceGroupContinuation() {
    clearVoiceGroupSilenceTimer();
    if (!isVoiceGroupMode()) return;
    if (voiceGroupChainRef.current >= VOICE_GROUP_MAX_CHAIN) {
      voiceGroupChainRef.current = 0;
      return;
    }
    voiceGroupSilenceTimerRef.current = setTimeout(() => {
      voiceGroupSilenceTimerRef.current = null;
      if (!isVoiceGroupMode()) return;
      if (streamingRef.current || voiceGroupBusyRef.current) return;
      // User started talking — don't talk over them.
      if (dictationFinalRef.current.trim() || (inputRef.current || '').trim()) return;
      if (recognitionRef.current && dictationInterimRef.current.trim()) return;
      const history = messagesRef.current.filter((m) => m.id !== 'welcome');
      if (!history.length) return;
      void runVoiceGroupAgentTurn(history, { continuation: true });
    }, VOICE_GROUP_AGENT_SILENCE_MS);
  }

  /**
   * One agent speaks in the multi-agent voice circle (persona + skills).
   * Used after the user talks, and again on silence to keep the group going.
   */
  async function runVoiceGroupAgentTurn(
    history: UiMessage[],
    opts?: { continuation?: boolean },
  ) {
    if (voiceGroupBusyRef.current || streamingRef.current) return;
    const pool = agentsRef.current; // all agents welcome
    if (pool.length < 1) return;

    const pick = pickNextVoiceGroupAgent(
      pool,
      voiceGroupLastAgentIdRef.current,
      voiceGroupCursorRef.current,
    );
    if (!pick) return;
    voiceGroupCursorRef.current = pick.nextCursor;
    voiceGroupLastAgentIdRef.current = pick.agent.id;
    voiceGroupBusyRef.current = true;
    clearVoiceGroupSilenceTimer();

    const assistantId = uuidv4();
    const agent = pick.agent;
    const useModel = agent.model || chatModelRef.current;

    const placeholder: UiMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      thinking: '',
      streaming: true,
      model: useModel,
      agentId: agent.id,
      agentName: agent.name,
    };

    setMessages([...history, placeholder]);
    messagesRef.current = [...history, placeholder];
    setStreaming(true);
    patchVoiceAgentUi({
      phase: 'thinking',
      voiceName: agent.name,
      lastHeard: opts?.continuation
        ? `${agent.name} is jumping in…`
        : voiceLastHeard,
    });

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch('/api/grok/voice-group-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: agent.id,
          participantIds: pool.map((a) => a.id),
          continuation: !!opts?.continuation,
          model: useModel,
          messages: history.map((m) => ({
            role: m.role,
            content: m.content,
            agentId: m.agentId,
            agentName: m.agentName,
          })),
        }),
        signal: ac.signal,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Agent turn failed');
      }
      const content = String(data.content || '').trim();
      const nextMsg: UiMessage = {
        ...placeholder,
        content,
        streaming: false,
        agentId: data.agent?.id || agent.id,
        agentName: data.agent?.name || agent.name,
        model: data.agent?.model || useModel,
      };
      setMessages((msgs) => {
        const updated = msgs.map((m) => (m.id === assistantId ? nextMsg : m));
        messagesRef.current = updated.filter((m) => m.id !== 'welcome');
        return updated;
      });

      if (autoSpeakRef.current && content) {
        // Always use the chat voice dropdown (seeded from agent default on switch).
        // Do not re-force agent.voiceId here — user may have overridden it.
        speakVoiceRef.current = ttsVoiceRef.current;
        patchVoiceAgentUi({ phase: 'speaking', voiceName: nextMsg.agentName || agent.name });
        voiceGroupChainRef.current = opts?.continuation
          ? voiceGroupChainRef.current + 1
          : 1;
        enqueueTtsChunks(assistantId, splitSpeechChunks(content, 200));
      } else if (autoSpeakRef.current) {
        resumeListeningAfterVoice();
        scheduleVoiceGroupContinuation();
      }
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      const msg = e instanceof Error ? e.message : 'Agent turn failed';
      setMessages((msgs) =>
        msgs.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: aborted ? (m.content || '') : (m.content || `Error: ${msg}`),
                streaming: false,
              }
            : m,
        ),
      );
      if (!aborted && autoSpeakRef.current) {
        resumeListeningAfterVoice();
      }
    } finally {
      setStreaming(false);
      voiceGroupBusyRef.current = false;
      if (isSessionMode) {
        setMessages((msgs) => {
          void persistSessionMessages(msgs);
          return msgs;
        });
      }
    }
  }

  async function runAssistantTurn(history: UiMessage[]) {
    // Voice + All agents → live multi-agent group discussion (not a single summary).
    if (autoSpeakRef.current && chatTarget === 'all' && agents.length >= 2) {
      voiceGroupChainRef.current = 0;
      clearVoiceGroupSilenceTimer();
      await runVoiceGroupAgentTurn(history, { continuation: false });
      return;
    }

    const assistantId = uuidv4();
    const isMulti = chatTarget === 'all';
    const useCli = useGrokCli && grokCliInstalled && !isMulti;
    const useModel = useCli
      ? encodeModelRef('cli', cliModel || cliDefaultModel || cliModels[0] || 'default')
      : (selectedAgent?.model || chatModelRef.current);
    const assistantPlaceholder: UiMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      thinking: '',
      streaming: true,
      model: useModel,
      agentId: selectedAgent?.id,
      agentName: chatTarget === 'all' ? 'All agents' : selectedAgent?.name,
      perspectives: chatTarget === 'all' ? [] : undefined,
    };

    const turnMessages = [...history, assistantPlaceholder];
    messagesRef.current = turnMessages.filter((m) => m.id !== 'welcome');
    setMessages(turnMessages);
    setStreaming(true);
    setExpandedThinking((prev) => ({ ...prev, [assistantId]: true }));

    // Persist the agent/target binding only when a turn is actually used — not
    // when browsing sessions or flipping the dropdown alone. Skip onSessionUpdated
    // here so we don't re-hydrate the panel mid-send (finish path refreshes later).
    if (isSessionMode && session) {
      void fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id: session.id,
          patch: {
            chatTarget,
            useGrokCli,
            cliModel: useCli ? (cliModel || cliDefaultModel || undefined) : undefined,
            chatModel: useModel,
          },
        }),
      }).catch(() => { /* ignore */ });
    }

    // Voice mode: reset progressive TTS so we can speak mid-stream.
    // Keep (or reopen) the mic so the user can interrupt by speaking.
    if (autoSpeakRef.current) {
      voiceBargeInRef.current = false;
      stopSpeaking();
      beginVoiceStream(assistantId);
      // Thinking has no TTS yet — allow immediate barge-in.
      bargeInReadyAtRef.current = Date.now();
      if (!recognitionRef.current) {
        window.setTimeout(() => {
          if (autoSpeakRef.current && !recognitionRef.current) {
            startDictation({ quiet: true, fresh: true });
          }
        }, 60);
      }
    }

    // Session turns: register a background live-run so leave/return keeps the
    // stream alive. Non-session turns still abort with the panel.
    let ac: AbortController;
    if (isSessionMode && session) {
      ac = beginLiveChatRun(session.id, toLiveMessages(turnMessages));
    } else {
      abortRef.current?.abort();
      ac = new AbortController();
    }
    abortRef.current = ac;

    const payloadMessages = history.map((m) => ({
      role: m.role,
      content: m.content,
      attachments: m.attachments,
      thinking: m.thinking,
    }));

    let turnError: string | undefined;
    try {
      const endpoint = useCli
        ? '/api/grok-cli/stream'
        : isMulti
          ? '/api/grok/multi-agent-stream'
          : '/api/grok/stream';
      const body: Record<string, unknown> = {
        model: useModel,
        messages: payloadMessages,
        // Lets the server post background-task results back into this session.
        sessionId: session?.id,
        // Only send reasoning effort to models that accept it (CLI keeps its
        // own flag handling; non-reasoning API models get no arg at all).
        reasoningEffort: useCli
          ? reasoningEffort
          : (modelSupportsReasoning(useModel) ? reasoningEffort : undefined),
      };
      if (!isMulti && selectedAgent) {
        body.system = buildAgentChatSystem(selectedAgent);
        // Server injects live integration context (Obsidian vault, GitHub repos…)
        body.agentId = selectedAgent.id;
      }
      // Bound workspace (chat folder or project path) → server enables coding tools.
      // CLI path also gets cwd so Grok CLI edits the same tree.
      const effectiveWorkspace =
        workspaceDir?.trim() || project?.workspacePath?.trim() || '';
      if (!isMulti && effectiveWorkspace) {
        body.workspaceDir = effectiveWorkspace;
      }

      if (project) {
        const ctxRes = await fetch(`/api/projects/context?id=${encodeURIComponent(project.id)}`);
        const ctxData = await ctxRes.json();
        if (ctxData.ok && ctxData.context) {
          body.projectContext = ctxData.context;
        }
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      await consumeStream(res, assistantId);
    } catch (e: unknown) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      const msg = e instanceof Error ? e.message : 'Request failed';
      if (!aborted) turnError = msg;
      mapMessages(
        (msgs) =>
          msgs.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: aborted ? m.content : m.content || `Error: ${msg}`,
                  streaming: false,
                }
              : m,
          ),
        { streaming: false },
      );
    }

    setStreaming(false);
    setExpandedThinking((prev) => ({ ...prev, [assistantId]: false }));

    const finalMsgs = (session?.id && getLiveChatRun(session.id)?.messages?.length)
      ? (getLiveChatRun(session.id)!.messages as UiMessage[])
      : messagesRef.current;

    if (isSessionMode && session) {
      await finishLiveChatRun(session.id, toLiveMessages(finalMsgs), { error: turnError });
      onSessionUpdated?.();
    } else if (project) {
      setMessages((msgs) => {
        void persistProjectChat(msgs);
        return msgs;
      });
    }
  }

  /**
   * Slash commands — deterministic actions issued right from the chat while
   * you work: git operations against the linked workspace and Obsidian notes.
   */
  async function runSlashCommand(text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return false;

    const appendExchange = (result: string) => {
      const userMsg: UiMessage = { id: uuidv4(), role: 'user', content: trimmed };
      const resultMsg: UiMessage = { id: uuidv4(), role: 'assistant', content: result };
      setMessages((prev) => {
        const next = [...prev.filter((m) => m.id !== 'welcome'), userMsg, resultMsg];
        if (isSessionMode) void persistSessionMessages(next);
        else if (project) void persistProjectChat(next);
        return next;
      });
    };

    const HELP = [
      '## Chat commands',
      '',
      '### 🌿 Git — act on your repository while you work',
      '| Command | What it does |',
      '| --- | --- |',
      '| `/git status` | Branch, changed files, and recent commits |',
      '| `/git checkout <branch>` | Switch to a branch, or create it from HEAD |',
      '| `/git commit <message>` | Stage everything and commit |',
      '| `/git pr <title> \\| <body>` | Push the branch and open a GitHub pull request |',
      '',
      '### 🔍 Research — pull the web into this conversation',
      '| Command | What it does |',
      '| --- | --- |',
      '| `/search <query>` | Web search (DuckDuckGo, no API key) — top results with links |',
      '| `/fetch <url>` | Read a page as clean text so we can discuss it |',
      '',
      '### 🎯 Annotation — refine code visually',
      '| Command | What it does |',
      '| --- | --- |',
      '| `/annotate [url]` | Open the sub-browser: load your app, click an element, send it here for refinement |',
      '',
      '### 📁 Workspace — give this chat a folder',
      '| Command | What it does |',
      '| --- | --- |',
      '| `/workspace` | Open the folder picker — bind this chat to a repo/folder |',
      '| `/workspace <path>` | Bind directly to a path |',
      '| `/workspace off` | Detach the folder from this chat |',
      '',
      '### 🧠 Memory & notes',
      '| Command | What it does |',
      '| --- | --- |',
      '| `/remember <key> \\| <content>` | Save a fact that persists across every chat |',
      '| `/recall [keyword]` | List saved memories (optionally filtered) |',
      '| `/note <path> \\| <content>` | Create an Obsidian note in your vault |',
      '| `/x <text>` | Post to X via the integration (agents can too, with the X scope) |',
      '',
      `_Git and file tools run against ${workspaceDir ? `the chat workspace \`${workspaceDir}\`` : project?.name ? `the "${project.name}" project workspace` : 'the default workspace'}; PRs use your GitHub token from Capabilities. Type \`/\` any time to see the command bar._`,
    ].join('\n');

    if (trimmed === '/help' || trimmed === '/' || trimmed === '/commands') {
      appendExchange(HELP);
      setInput('');
      return true;
    }

    if (trimmed.startsWith('/annotate')) {
      setInput('');
      setShowSubBrowser(true);
      return true;
    }

    if (trimmed === '/workspace' || trimmed.startsWith('/workspace ')) {
      const arg = trimmed.slice('/workspace'.length).trim();
      setInput('');
      if (!arg) {
        setShowWorkspacePicker(true);
        return true;
      }
      if (arg === 'off' || arg === 'clear' || arg === 'none') {
        updateWorkspaceDir(null);
        appendExchange('📁 Workspace detached — this chat no longer has folder access.');
        return true;
      }
      // Validate the typed path server-side before binding.
      const res = await fetch(`/api/fs/browse?dir=${encodeURIComponent(arg)}`)
        .then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      if (res.ok) {
        updateWorkspaceDir(res.path);
        appendExchange(`📁 Chat workspace set to \`${res.path}\`${res.isRepo ? ' (git repository)' : ''} — I can now read, write, and search files there, and \`/git\` commands run against it.`);
      } else {
        appendExchange(`⚠️ ${res.error || `Could not open ${arg}`}`);
      }
      return true;
    }

    if (trimmed.startsWith('/search')) {
      const query = trimmed.slice(7).trim();
      setInput('');
      if (!query) { appendExchange('Usage: `/search <query>` — e.g. `/search css container queries`'); return true; }
      const res = await fetch('/api/chat-tools', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'search', query }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      appendExchange(res.ok
        ? [`🔍 **Web results for "${query}":**`, '', ...res.results.map((x: { title: string; url: string; snippet: string }, i: number) =>
            `${i + 1}. [${x.title || x.url}](${x.url})${x.snippet ? `\n   ${x.snippet.slice(0, 180)}` : ''}`)].join('\n')
        : `⚠️ ${res.error || 'Search failed'}`);
      return true;
    }

    if (trimmed.startsWith('/fetch')) {
      const url = trimmed.slice(6).trim();
      setInput('');
      if (!url) { appendExchange('Usage: `/fetch <url>` — reads the page as text into this conversation.'); return true; }
      const res = await fetch('/api/chat-tools', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fetch', url }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      appendExchange(res.ok
        ? [`📄 **Fetched ${res.page.url}**${res.page.title ? ` — ${res.page.title}` : ''}`, '', res.page.text.slice(0, 4000), '', '_Page content is now part of this conversation — ask me anything about it._'].join('\n')
        : `⚠️ ${res.error || 'Fetch failed'}`);
      return true;
    }

    if (trimmed.startsWith('/remember')) {
      const rest = trimmed.slice(9).trim();
      const [key, ...contentParts] = rest.split('|');
      const content = contentParts.join('|').trim();
      setInput('');
      if (!key?.trim() || !content) { appendExchange('Usage: `/remember <key> | <content>` — e.g. `/remember deploy-cmd | npm run deploy:prod`'); return true; }
      const res = await fetch('/api/chat-tools', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remember', key: key.trim(), content }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      appendExchange(res.ok ? `🧠 Remembered \`${res.entry.key}\` — recall it any time with \`/recall\`.` : `⚠️ ${res.error || 'Save failed'}`);
      return true;
    }

    if (trimmed.startsWith('/recall')) {
      const query = trimmed.slice(7).trim();
      setInput('');
      const res = await fetch('/api/chat-tools', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recall', query: query || undefined }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      appendExchange(res.ok
        ? (res.entries.length
            ? [`🧠 **Memories${query ? ` matching "${query}"` : ''}:**`, '', ...res.entries.map((e2: { key: string; content: string }) => `- **${e2.key}** — ${e2.content.slice(0, 200)}`)].join('\n')
            : `No memories${query ? ` matching "${query}"` : ''} yet — save one with \`/remember <key> | <content>\`.`)
        : `⚠️ ${res.error || 'Recall failed'}`);
      return true;
    }

    if (trimmed === '/x' || trimmed.startsWith('/x ')) {
      const text = trimmed.slice(2).trim();
      setInput('');
      if (!text) { appendExchange('Usage: `/x <text>` — posts to X via the integration on the Capabilities page (max 280 chars).'); return true; }
      const res = await fetch('/api/chat-tools', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'post_x', text }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      appendExchange(res.ok
        ? `📣 Posted to X${res.url ? `: [view the post](${res.url})` : ''}.`
        : `⚠️ ${res.error || 'X post failed'}`);
      return true;
    }

    if (trimmed.startsWith('/note')) {
      const rest = trimmed.slice(5).trim();
      const [path, ...contentParts] = rest.split('|');
      const content = contentParts.join('|').trim();
      setInput('');
      const res = await fetch('/api/obsidian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: (path || '').trim(), content }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      appendExchange(res.ok
        ? `📝 Obsidian note created: \`${res.path}\``
        : `⚠️ ${res.error || 'Note creation failed'}`);
      return true;
    }

    if (trimmed.startsWith('/git')) {
      const rest = trimmed.slice(4).trim();
      const [sub, ...args] = rest.split(/\s+/);
      const argText = args.join(' ');
      const workspacePath = workspaceDir?.trim() || project?.workspacePath?.trim() || undefined;
      let payload: Record<string, string | undefined> | null = null;
      if (sub === 'status') payload = { action: 'status' };
      else if (sub === 'checkout' && args[0]) payload = { action: 'checkout', branch: args[0] };
      else if (sub === 'commit' && argText) payload = { action: 'commit', message: argText };
      else if (sub === 'pr' && argText) {
        const [title, ...bodyParts] = argText.split('|');
        payload = { action: 'pr', title: title.trim(), body: bodyParts.join('|').trim() || undefined };
      }
      if (!payload) {
        appendExchange(HELP);
        setInput('');
        return true;
      }
      setInput('');
      const res = await fetch('/api/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, workspacePath }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
      appendExchange(res.ok ? res.result : `⚠️ ${res.error || 'git action failed'}`);
      return true;
    }

    return false;
  }

  async function sendChat() {
    // Prefer live composer ref so voice auto-send isn't racing a stale state close.
    const text = (inputRef.current || input).trim();
    const liveBusy = !!(session?.id && getLiveChatRun(session.id)?.streaming);
    if ((!text && pendingAttachments.length === 0) || streaming || liveBusy) {
      sendingFromVoiceRef.current = false;
      return;
    }
    // Always follow the new reply as it streams (user can scroll up to unpin).
    stickToBottomRef.current = true;
    setAwayFromLatest(false);
    scrollToBottom(false);
    stopDictation();

    // Slash commands always win over a normal send — attachments stay pending
    // in the composer for the next real message.
    if (text.startsWith('/')) {
      const handled = await runSlashCommand(text);
      sendingFromVoiceRef.current = false;
      if (handled) {
        if (autoSpeakRef.current) resumeListeningAfterVoice();
        return;
      }
    }

    if (chatTarget === 'all' && pendingAttachments.length > 0) {
      toast.error('Multi-agent mode does not support file attachments yet — send text only.');
      sendingFromVoiceRef.current = false;
      return;
    }
    if (useGrokCli && pendingAttachments.length > 0) {
      toast.error('Grok CLI mode is text-only — remove attachments or switch back to API chat.');
      sendingFromVoiceRef.current = false;
      return;
    }

    const userMsg: UiMessage = {
      id: uuidv4(),
      role: 'user',
      content: text || '(see attachments)',
      attachments: pendingAttachments.length ? [...pendingAttachments] : undefined,
    };

    const history = [...messages.filter((m) => m.id !== 'welcome'), userMsg];
    setInput('');
    inputRef.current = '';
    setPendingAttachments([]);
    sendingFromVoiceRef.current = false;
    // User contribution resets the agent free-talk chain.
    clearVoiceGroupSilenceTimer();
    voiceGroupChainRef.current = 0;
    messagesRef.current = history;
    await runAssistantTurn(history);
  }
  sendChatRef.current = () => { void sendChat(); };

  function regenerateLast() {
    if (streaming) return;
    const filtered = messages.filter((m) => m.id !== 'welcome');
    let lastUserIdx = -1;
    for (let i = filtered.length - 1; i >= 0; i--) {
      if (filtered[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;
    void runAssistantTurn(filtered.slice(0, lastUserIdx + 1));
  }

  function startEditMessage(m: UiMessage) {
    if (streaming) return;
    setEditingMsgId(m.id);
    setEditingText(m.content);
  }

  function cancelEditMessage() {
    setEditingMsgId(null);
    setEditingText('');
  }

  function saveEditAndResend() {
    const text = editingText.trim();
    if (!text || !editingMsgId || streaming) return;
    const filtered = messages.filter((m) => m.id !== 'welcome');
    const idx = filtered.findIndex((m) => m.id === editingMsgId);
    if (idx < 0) return;
    const edited: UiMessage = { ...filtered[idx], content: text };
    setEditingMsgId(null);
    setEditingText('');
    void runAssistantTurn([...filtered.slice(0, idx), edited]);
  }

  async function copyMessage(m: UiMessage) {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopiedMsgId(m.id);
      setTimeout(() => setCopiedMsgId((id) => (id === m.id ? null : id)), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length) {
      e.preventDefault();
      uploadFiles(imageFiles);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  }

  function renderAttachments(attachments: ChatAttachment[], compact = false) {
    const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl);
    const files = attachments.filter((a) => !(a.kind === 'image' && a.dataUrl));
    return (
      <div className={`chat-attachments ${compact ? 'chat-attachments-compact' : ''}`}>
        {/* Images display directly in the conversation — click to view full size */}
        {images.length > 0 && (
          <div className="chat-inline-images">
            {images.map((att) => (
              <button
                key={att.id}
                type="button"
                className="chat-inline-image-wrap"
                onClick={() => setLightboxImage({ src: att.dataUrl!, name: att.name })}
                title={`${att.name} — click to view full size`}
              >
                <img src={att.dataUrl} alt={att.name} className="chat-inline-image" />
              </button>
            ))}
          </div>
        )}
        {files.map((att) => (
          <div key={att.id} className="chat-attachment-chip">
            <Paperclip size={14} className="opacity-60" />
            <span className="chat-attachment-name">{att.name}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`grok-chat-panel flex flex-col flex-1 min-h-0 w-full min-w-0 ${project && onProjectUpdated ? 'grok-chat-panel-embedded h-[min(520px,calc(100vh-420px))]' : ''}`}>
      <div className="grok-chat-topbar flex items-center gap-3 mb-3 flex-wrap w-full">
        {!project && !session && (
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-muted" />
            <span>Direct Grok Chat</span>
          </div>
        )}
        {isSessionMode && onProjectLinkChange && (
          <select
            value={session?.projectId || ''}
            onChange={(e) => onProjectLinkChange(e.target.value || null)}
            className="grok-select min-w-[140px] text-xs"
            title="Link a project for extra file context"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        <select
          value={chatTarget}
          onChange={(e) => updateChatTarget(e.target.value as ChatTarget)}
          className="grok-select min-w-[160px] text-xs"
          title={
            autoSpeak && agents.length >= 2
              ? 'With Grok Voice on, “All agents” is a live multi-agent voice circle — they keep talking if you go quiet'
              : 'Chat as Grok, a specific agent, or all agents'
          }
        >
          <option value="grok">Grok (default)</option>
          {agents.length > 0 && (
            <optgroup label="Agents">
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </optgroup>
          )}
          <option value="all" disabled={agents.length === 0}>
            {autoSpeak && agents.length >= 2
              ? 'All agents — voice group chat'
              : 'All agents — summarize'}
          </option>
        </select>
        <button
          type="button"
          onClick={() => setShowWorkspacePicker(true)}
          className={`grok-btn grok-btn-ghost text-xs py-1 ${workspaceDir ? 'workspace-chip-active' : ''}`}
          title={workspaceDir
            ? `Chat workspace: ${workspaceDir}\nFile reads/writes, analysis, and /git commands run in this folder — click to change or detach`
            : 'Bind this chat to a folder (e.g. a cloned GitHub repo) so Grok can read, write, search, and run /git commands there'}
        >
          <FolderGit2 size={14} />
          {workspaceDir ? (workspaceDir.split(/[\\/]/).filter(Boolean).pop() || workspaceDir) : 'Workspace'}
        </button>
        <button
          type="button"
          onClick={exportChatMarkdown}
          disabled={!hasChatHistory}
          className="grok-btn grok-btn-ghost text-xs py-1 ml-auto"
          title="Download this conversation as Markdown (includes reasoning and token counts)"
        >
          <Download size={14} />
          Export
        </button>
        <button
          type="button"
          onClick={clearChatContext}
          disabled={streaming || (!hasChatHistory && !pendingAttachments.length && !input.trim())}
          className="grok-btn grok-btn-ghost text-xs py-1"
          title="Clear chat history (workspace and project uploads stay in context)"
        >
          <Eraser size={14} />
          Clear chat
        </button>
      </div>

      <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} onScroll={onMessagesScroll} className="grok-chat-messages flex-1 grok-card overflow-auto p-5 space-y-4 text-[15px] leading-relaxed bg-elev">
        {messages.map((m, idx) => {
          // Fresh default chats get the hero below instead of a canned bubble;
          // agent/all targets keep their welcome line (it carries real info).
          if (m.id === 'welcome' && chatTarget === 'grok' && !hasChatHistory && !streaming) return null;
          const isUser = m.role === 'user';
          const showThinking = !isUser && (m.thinking || (m.streaming && !m.content));
          const thinkingOpen = expandedThinking[m.id] ?? m.streaming;
          const isLastAssistant =
            !isUser && m.id !== 'welcome' && !messages.slice(idx + 1).some((n) => n.role === 'assistant');

          return (
            <div
              key={m.id}
              className={`grok-chat-bubble ${isUser ? 'grok-chat-bubble-user' : 'grok-chat-bubble-assistant'}`}
            >
              <div className="grok-chat-bubble-header">
                {!isUser && m.agentId && (
                  // Always render the agent's alien for agent responses — fall
                  // back to the id-derived avatar so it survives the agents
                  // list loading late or the agent being deleted since.
                  <img
                    src={resolveAgentAvatarPath(agents.find((a) => a.id === m.agentId) || { id: m.agentId })}
                    alt={m.agentName ? `${m.agentName} avatar` : 'Agent avatar'}
                    className="agent-avatar-xs"
                    width={20}
                    height={20}
                  />
                )}
                <span className="grok-chat-role">
                  {isUser ? 'YOU' : (m.agentName || 'GROK').toUpperCase()}
                </span>
                {!isUser && m.model && (
                  <span className="grok-chat-model-meta">
                    <ModelProviderBadge modelId={m.model} size="xs" />
                    {modelDisplayName(m.model)}
                  </span>
                )}
                {!isUser && !m.streaming && m.usage && (
                  <span
                    className="grok-chat-token-meta"
                    title={`${Number(m.usage.promptTokens || 0).toLocaleString()} in · ${Number(m.usage.completionTokens || 0).toLocaleString()} out`}
                  >
                    {fmtTokenCount(m.usage.totalTokens)} tok
                  </span>
                )}
                {m.streaming && (
                  <span className="grok-chat-streaming-dot" aria-label="Streaming" />
                )}
              </div>

              {showThinking && (
                <div className="grok-chat-thinking">
                  <button
                    type="button"
                    className="grok-chat-thinking-toggle"
                    onClick={() => toggleThinking(m.id)}
                  >
                    <Brain size={14} />
                    <span>{m.streaming && !m.thinking ? 'Thinking…' : 'Reasoning'}</span>
                    {thinkingOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {thinkingOpen && (
                    <div className="grok-chat-thinking-body">
                      {m.thinking || (m.streaming ? 'Working through the problem…' : '')}
                      {m.streaming && m.thinking && <span className="grok-chat-cursor" />}
                    </div>
                  )}
                </div>
              )}

              {m.attachments?.length ? renderAttachments(m.attachments) : null}

              {m.perspectives && m.perspectives.length > 0 && (
                <div className="grok-chat-perspectives">
                  <div className="text-[10px] font-semibold text-dim mb-1 uppercase tracking-wide">Agent perspectives</div>
                  {m.perspectives.map((p) => (
                    <details key={p.agentId} className="grok-chat-perspective-item" open={m.streaming && !m.content}>
                      <summary className="text-xs font-medium cursor-pointer">{p.name}</summary>
                      <div className="text-xs text-dim mt-1 whitespace-pre-wrap">{p.content}</div>
                    </details>
                  ))}
                </div>
              )}

              {isUser && editingMsgId === m.id ? (
                <div className="grok-chat-edit">
                  <textarea
                    className="grok-input grok-chat-edit-textarea"
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        saveEditAndResend();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEditMessage();
                      }
                    }}
                    autoFocus
                    rows={2}
                  />
                  <div className="grok-chat-edit-actions">
                    <button type="button" className="grok-btn grok-btn-ghost text-xs py-1" onClick={cancelEditMessage}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="grok-btn grok-btn-primary text-xs py-1"
                      onClick={saveEditAndResend}
                      disabled={!editingText.trim()}
                    >
                      <Send size={12} /> Save &amp; resend
                    </button>
                  </div>
                </div>
              ) : m.content ? (
                isUser ? (
                  <div className="grok-chat-content whitespace-pre-wrap">{m.content}</div>
                ) : (
                  <div className="grok-chat-content">
                    <ChatMarkdown content={m.content} />
                    {m.streaming && <span className="grok-chat-cursor" />}
                    {!!m.files?.length && (
                      <div className="chat-file-row" aria-label="Files created this turn">
                        {m.files.map((f) => (
                          <button
                            key={f.path}
                            type="button"
                            className="chat-file-chip"
                            title={`View ${f.path}`}
                            onClick={() => void openChatFile(f)}
                          >
                            <FileText size={12} /> {f.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              ) : null}

              {isUser && editingMsgId !== m.id ? (
                <div className="grok-chat-msg-actions">
                  <button
                    type="button"
                    className="grok-chat-msg-action"
                    onClick={() => startEditMessage(m)}
                    disabled={streaming}
                    title="Edit and resend — replies below will be regenerated"
                  >
                    <Pencil size={13} />
                    Edit
                  </button>
                  <button
                    type="button"
                    className="grok-chat-msg-action"
                    onClick={() => copyMessage(m)}
                    title="Copy message"
                  >
                    {copiedMsgId === m.id ? <Check size={13} /> : <Copy size={13} />}
                    {copiedMsgId === m.id ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ) : null}

              {!isUser && !m.streaming && m.id !== 'welcome' && m.content ? (
                <div className="grok-chat-msg-actions">
                  <button
                    type="button"
                    className={`grok-chat-msg-action ${speakingMsgId === m.id ? 'grok-chat-msg-action-speaking' : ''}`}
                    onClick={() => void speakMessage(m)}
                    disabled={ttsLoadingId === m.id}
                    title={speakingMsgId === m.id ? 'Stop speaking' : `Speak this reply (${effectiveVoiceLabel})`}
                  >
                    {ttsLoadingId === m.id
                      ? <RefreshCw size={13} className="animate-spin" />
                      : speakingMsgId === m.id
                        ? <VolumeX size={13} />
                        : <Volume2 size={13} />}
                    {speakingMsgId === m.id ? 'Stop' : ttsLoadingId === m.id ? 'Loading…' : 'Speak'}
                  </button>
                  <button
                    type="button"
                    className="grok-chat-msg-action"
                    onClick={() => copyMessage(m)}
                    title="Copy message"
                  >
                    {copiedMsgId === m.id ? <Check size={13} /> : <Copy size={13} />}
                    {copiedMsgId === m.id ? 'Copied' : 'Copy'}
                  </button>
                  {isLastAssistant && (
                    <button
                      type="button"
                      className="grok-chat-msg-action"
                      onClick={regenerateLast}
                      disabled={streaming}
                      title="Regenerate this response"
                    >
                      <RotateCcw size={13} />
                      Regenerate
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        {!hasChatHistory && !streaming && chatTarget === 'grok' && (
          <div className="chat-empty-hero">
            {/* Compact Jarvis mark — same visual language as Grok Voice HUD */}
            <div className="chat-empty-jarvis" aria-hidden>
              <div className="chat-empty-jarvis-ring chat-empty-jarvis-ring-outer" />
              <div className="chat-empty-jarvis-ring chat-empty-jarvis-ring-mid" />
              <div className="chat-empty-jarvis-ticks">
                {Array.from({ length: 16 }).map((_, i) => (
                  <span
                    key={i}
                    className="chat-empty-jarvis-tick"
                    style={{ transform: `rotate(${i * 22.5}deg) translateY(-34px)` }}
                  />
                ))}
              </div>
              <div className="chat-empty-jarvis-core">
                <div className="chat-empty-jarvis-glow" />
                <div className="chat-empty-jarvis-face">
                  <Zap size={22} strokeWidth={1.75} />
                </div>
              </div>
            </div>
            <div className="chat-empty-title">Ask Grok anything</div>
            <div className="chat-empty-sub">
              Multimodal chat on cloud or local models — your uploads, projects, and integrations ride along as context.
            </div>
          </div>
        )}
        {!hasChatHistory && !streaming && (
          <div className="chat-suggestions" aria-label="Suggested prompts">
            {chatSuggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="chat-suggestion-chip"
                onClick={() => {
                  setInput(s);
                  textareaRef.current?.focus();
                }}
              >
                <Sparkles size={13} className="chat-suggestion-icon" />
                <span>{s}</span>
              </button>
            ))}
          </div>
        )}
        <div ref={bottomRef} className="grok-chat-scroll-anchor" aria-hidden />
      </div>
      {awayFromLatest && (
        <button
          type="button"
          className="chat-jump-latest"
          onClick={() => {
            stickToBottomRef.current = true;
            setAwayFromLatest(false);
            scrollToBottom(false);
          }}
          title="Scroll to the newest message"
        >
          <ChevronDown size={14} />
          {streaming ? 'Streaming below — jump to latest' : 'Jump to latest'}
        </button>
      )}
      </div>

      {pendingAttachments.length > 0 && (
        <div className="grok-chat-pending-attachments mt-2 px-1">
          {pendingAttachments.map((att) => (
            <div key={att.id} className="chat-attachment-chip chat-attachment-pending">
              {att.kind === 'image' && att.dataUrl ? (
                <img src={att.dataUrl} alt={att.name} className="chat-attachment-thumb" />
              ) : (
                <Paperclip size={14} />
              )}
              <span className="chat-attachment-name">{att.name}</span>
              <button type="button" className="chat-attachment-remove" onClick={() => removeAttachment(att.id)}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {slashMenuOpen && (
        <div className="chat-slash-menu" role="listbox" aria-label="Slash commands">
          {slashMatches.map((c, i) => (
            <button
              key={c.cmd}
              type="button"
              role="option"
              aria-selected={i === slashSelected}
              className={`chat-slash-item ${i === slashSelected ? 'chat-slash-item-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); acceptSlash(c); }}
              onMouseEnter={() => setSlashIdx(i)}
            >
              <GitBranch size={11} className="shrink-0 opacity-40" />
              <code className="chat-slash-cmd">{c.cmd}</code>
              <span className="chat-slash-desc">{c.desc}</span>
            </button>
          ))}
          <div className="chat-slash-footer">↑↓ navigate · Tab or Enter to complete · Esc to dismiss</div>
        </div>
      )}

      <div
        className={`grok-chat-composer mt-3 ${dragOver ? 'grok-chat-composer-drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {useGrokCli && grokCliInstalled && (
          <div className="grok-chat-composer-multimodal-hint">
            <Terminal size={12} className="opacity-70" />
            <span>Routing through local Grok CLI{grokCliVersion ? ` · ${grokCliVersion}` : ''}</span>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx"
          className="hidden"
          aria-label="Attach images or files to this chat"
          onChange={(e) => e.target.files && uploadFiles(e.target.files)}
        />
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            if (dictating) stopDictation();
            setInput(e.target.value);
            setSlashDismissed(false);
          }}
          onKeyDown={(e) => {
            if (slashMenuOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashMatches.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
              if (e.key === 'Escape') { setSlashDismissed(true); return; }
              const sel = slashMatches[slashSelected];
              if (e.key === 'Tab' && sel) { e.preventDefault(); acceptSlash(sel); return; }
              if (e.key === 'Enter' && !e.shiftKey && sel
                  && slashToken !== sel.insert.trimEnd()
                  && !slashToken.startsWith(sel.insert)) {
                // Enter completes the command; a fully typed command sends as usual.
                e.preventDefault();
                acceptSlash(sel);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              stopDictation();
              void sendChat();
            }
          }}
          onPaste={onPaste}
          rows={1}
          className={`grok-input grok-chat-textarea grok-chat-textarea-lead ${dictating ? 'grok-chat-textarea-dictating' : ''}`}
          placeholder={
            dictating
              ? (autoSpeak
                ? (dictationInterim
                  ? `Grok voice… “${dictationInterim}” — pause to send`
                  : 'Grok voice listening — speak, then pause to send…')
                : (dictationInterim ? `Listening… “${dictationInterim}”` : 'Listening — speak now…'))
              : autoSpeak
                ? 'Grok voice on — waiting for reply / speaking…'
                : project
                  ? 'Ask about this project — uploads are carried into context…'
                  : 'Ask Grok anything — Shift+Enter for a new line, drop or paste files…'
          }
        />
        <button
          type="button"
          className={`grok-btn grok-chat-attach-btn ${dictating ? 'grok-chat-dictate-active' : 'grok-btn-ghost'}`}
          onClick={toggleDictation}
          disabled={streaming || !dictationSupported || autoSpeak}
          title={
            !dictationSupported
              ? 'Dictation needs Chrome or Edge (Web Speech API)'
              : autoSpeak
                ? 'Mic is managed by Grok voice (auto on/off) — toggle the speaker button to exit'
                : dictating
                  ? 'Stop dictation'
                  : 'Dictate — speak your message into the composer'
          }
          aria-pressed={dictating}
          aria-label={dictating ? 'Stop dictation' : 'Start dictation'}
        >
          {dictating ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
        <select
          className="grok-select grok-chat-composer-voice"
          value={effectiveTtsVoice}
          onChange={(e) => persistTtsVoice(e.target.value)}
          disabled={streaming}
          title={
            selectedAgent && agentDefaultVoiceId
              ? `Voice for spoken replies — ${selectedAgent.name}'s default is ${
                  ttsVoices.find((v) => v.id === agentDefaultVoiceId)?.name || agentDefaultVoiceId
                } (you can override here)`
              : 'Grok voice used when speaking assistant replies'
          }
          aria-label="Assistant voice"
        >
          {/* Keep a missing/custom id visible even if not in the live catalog */}
          {effectiveTtsVoice
            && !ttsVoices.some((v) => v.id === effectiveTtsVoice)
            && (
              <option value={effectiveTtsVoice}>
                {effectiveTtsVoice}
                {agentDefaultVoiceId === effectiveTtsVoice ? ' (agent default)' : ''}
              </option>
            )}
          {ttsVoices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}{v.description ? ` — ${v.description}` : ''}
              {agentDefaultVoiceId === v.id ? ' · agent default' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`grok-btn grok-chat-attach-btn grok-voice-toggle ${autoSpeak ? 'grok-btn-primary grok-voice-toggle-on' : 'grok-btn-ghost'}`}
          onClick={() => {
            const next = !autoSpeak;
            persistAutoSpeak(next);
            // HUD shows voice/voice/speed — no success toast popup.
          }}
          disabled={streaming && !autoSpeak}
          title={autoSpeak
            ? `Grok Voice on (${effectiveVoiceLabel}, ${clampTtsSpeed(ttsSpeed)}×) — change speed on the voice HUD`
            : 'Grok Voice agent — hands-free: mic on, pause to send, spoken replies'}
          aria-label={autoSpeak ? 'Turn off Grok Voice agent' : 'Turn on Grok Voice agent'}
          aria-pressed={autoSpeak}
        >
          <Zap size={16} className="grok-voice-toggle-icon" strokeWidth={2} />
        </button>
        <button
          type="button"
          className="grok-btn grok-btn-ghost grok-chat-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || streaming || !supportsMultimodal || useGrokCli}
          title={!supportsMultimodal || useGrokCli ? 'This mode is text-only' : 'Attach images or files — or drop / paste them'}
        >
          {uploading ? <RefreshCw size={16} className="animate-spin" /> : <Paperclip size={16} />}
        </button>
        <button
          type="button"
          className="grok-btn grok-btn-ghost grok-chat-attach-btn"
          onClick={() => setShowSubBrowser(true)}
          disabled={streaming}
          title="Annotate a page — load the app you're building, highlight an element, and send it here for code refinement (/annotate)"
        >
          <Crosshair size={16} />
        </button>
        {useGrokCli && grokCliInstalled ? (
          <select
            value={cliModel}
            onChange={(e) => { if (e.target.value) updateCliModel(e.target.value); }}
            className="grok-select grok-chat-composer-model"
            disabled={streaming || cliModels.length === 0}
            title="Grok CLI model — detected from `grok models` on this machine"
          >
            {cliModels.length === 0 ? (
              <option value={cliModel}>{cliModelsLoading ? 'Detecting CLI models…' : 'No CLI models'}</option>
            ) : (
              <optgroup label="CLI — Grok CLI">
                {cliModels.map((m) => (
                  <option key={m} value={m}>[CLI] {m}{m === cliDefaultModel ? ' (default)' : ''}</option>
                ))}
              </optgroup>
            )}
          </select>
        ) : (
          <select
            value={chatModel}
            onChange={(e) => { if (e.target.value) onChatModelChange(e.target.value); }}
            className="grok-select grok-chat-composer-model"
            disabled={streaming || (modelsLoading && availableModels.length === 0)}
            title="Model for this chat"
          >
            {availableModels.length === 0 ? (
              <option value={chatModel}>{modelsLoading ? 'Loading…' : 'No models'}</option>
            ) : (
              <>
                {availableModels.filter((m) => m.provider === 'cloud').length > 0 && (
                  <optgroup label="Cloud — xAI">
                    {availableModels.filter((m) => m.provider === 'cloud').map((m) => (
                      <option key={m.id} value={m.id}>{modelDisplayName(m.id)}</option>
                    ))}
                  </optgroup>
                )}
                {availableModels.filter((m) => m.provider === 'local').length > 0 && (
                  <optgroup label="Local">
                    {availableModels.filter((m) => m.provider === 'local').map((m) => (
                      <option key={m.id} value={m.id}>{modelDisplayName(m.id)}</option>
                    ))}
                  </optgroup>
                )}
                {availableModels.filter((m) => m.provider === 'cli').length > 0 && (
                  <optgroup label="CLI — Grok CLI">
                    {availableModels.filter((m) => m.provider === 'cli').map((m) => (
                      <option key={m.id} value={m.id}>{modelDisplayName(m.id)}</option>
                    ))}
                  </optgroup>
                )}
                {!availableModels.some((m) => m.id === chatModel) && (
                  <option value={chatModel}>{modelDisplayName(chatModel)} (saved)</option>
                )}
              </>
            )}
          </select>
        )}
        {((useGrokCli && grokCliInstalled && cliModelsLoading) || (!useGrokCli && modelsLoading && availableModels.length === 0)) && (
          <span className="data-spinner" aria-label="Loading models" />
        )}
        {!useGrokCli && !modelsLoading && availableModels.length === 0 && (
          <button
            type="button"
            onClick={onRefreshModels}
            className="grok-btn grok-btn-ghost grok-chat-attach-btn"
            title={modelsError || 'Retry loading models'}
          >
            <RefreshCw size={14} />
          </button>
        )}
        {!useGrokCli && modelSupportsReasoning(chatModel) && (
          <select
            value={reasoningEffort}
            onChange={(e) => updateReasoningEffort(e.target.value as ReasoningEffort)}
            className="grok-select grok-chat-composer-reasoning"
            disabled={streaming}
            title="Reasoning effort for this chat"
          >
            <option value="none">Reasoning off</option>
            <option value="low">Reasoning low</option>
            <option value="medium">Reasoning med</option>
            <option value="high">Reasoning high</option>
          </select>
        )}
        {grokCliInstalled && chatTarget !== 'all' && (
          <button
            type="button"
            onClick={() => updateUseGrokCli(!useGrokCli)}
            className={`grok-btn grok-chat-attach-btn ${useGrokCli ? 'grok-btn-primary' : 'grok-btn-ghost'}`}
            disabled={streaming}
            title={useGrokCli
              ? `Using local Grok CLI${grokCliVersion ? ` (${grokCliVersion})` : ''} — click for cloud API`
              : 'Route through the local Grok CLI instead of the cloud API'}
          >
            <Terminal size={15} />
          </button>
        )}
        {streaming ? (
          <button
            type="button"
            onClick={stopStreaming}
            className="grok-btn grok-btn-secondary ml-auto"
            title="Stop generating"
          >
            <Square size={14} />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={sendChat}
            disabled={uploading || (!input.trim() && pendingAttachments.length === 0)}
            className="grok-btn grok-btn-primary ml-auto"
          >
            <Send size={15} />
            Send
          </button>
        )}
      </div>

      <div className="text-[10px] text-center text-dim mt-1">
        {dictating ? (
          <span className="grok-chat-dictate-status">
            <span className="grok-chat-dictate-dot" aria-hidden />
            Listening… click the mic again when you&apos;re done
            {dictationInterim ? ` · “${dictationInterim.slice(0, 48)}${dictationInterim.length > 48 ? '…' : ''}”` : ''}
          </span>
        ) : useGrokCli && grokCliInstalled
          ? `CLI mode — Grok CLI on this machine${grokCliVersion ? ` (${grokCliVersion})` : ''} · global uploads still included as context`
          : isSessionMode && project
          ? `Session chat · global uploads + ${project.files.length} linked project file(s) in context`
          : isSessionMode
          ? 'Each session keeps its own agent, model, and history · global workspace uploads included'
          : project
          ? `Global workspace uploads + ${project.files.length} project file(s) included in every reply · chat history saved to this project`
          : chatTarget === 'all'
            ? 'All agents answer in parallel, then Grok synthesizes a unified summary · global workspace uploads included'
            : selectedAgent
              ? `Chatting as ${selectedAgent.name}${selectedAgent.chatSkill ? ' · Skill active' : ' · add a Skill in agent settings'} · global uploads included`
              : parseModelRef(chatModel).provider === 'local'
                ? 'Local model — served from this machine · global workspace uploads included'
                : parseModelRef(chatModel).provider === 'cli'
                  ? 'CLI — Grok CLI agentic model on this machine · global workspace uploads included'
                  : 'Cloud Grok — streaming, reasoning, images & files · global workspace uploads included · mic to dictate'}
      </div>

      {showSubBrowser && (
        <SubBrowser
          open={showSubBrowser}
          onClose={() => setShowSubBrowser(false)}
          onAnnotate={handleAnnotation}
          initialUrl={undefined}
        />
      )}

      {showWorkspacePicker && (
        <WorkspacePicker
          open={showWorkspacePicker}
          value={workspaceDir}
          defaultPath={defaultWorkspace || project?.workspacePath || null}
          onClose={() => setShowWorkspacePicker(false)}
          onSelect={updateWorkspaceDir}
        />
      )}

      {/* Voice HUD is rendered by VoiceAgentHost in the root layout */}

      {/* Full-size image viewer for inline chat images */}
      {lightboxImage && (
        <div className="chat-lightbox" onClick={() => setLightboxImage(null)} role="dialog" aria-label={lightboxImage.name}>
          <img src={lightboxImage.src} alt={lightboxImage.name} className="chat-lightbox-img" onClick={(e) => e.stopPropagation()} />
          <div className="chat-lightbox-caption">{lightboxImage.name} — click anywhere to close</div>
        </div>
      )}

      {/* In-chat file viewer — files an agent wrote this conversation.
          Portaled to <body>: ancestor stacking contexts (session rail, chat
          column) must never paint over it. */}
      {chatFileView && typeof document !== 'undefined' && createPortal(
        <div className="chat-file-view-overlay" onClick={() => setChatFileView(null)} role="presentation">
          <div
            className="chat-file-view-modal"
            role="dialog"
            aria-label={`File ${chatFileView.file.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chat-file-view-head">
              <FileText size={15} className="opacity-70 shrink-0" />
              <span className="chat-file-view-name" title={chatFileView.file.path}>{chatFileView.file.path}</span>
              {chatFileView.size != null && !chatFileView.loading && !chatFileView.error && (
                <span className="chat-file-view-size">{(chatFileView.size / 1024).toFixed(1)} KB</span>
              )}
              <button
                type="button"
                className="grok-btn grok-btn-ghost p-1 ml-auto"
                title="Close"
                aria-label="Close file viewer"
                onClick={() => setChatFileView(null)}
              >
                <X size={15} />
              </button>
            </div>
            <div className="chat-file-view-body">
              {chatFileView.loading && <div className="text-sm text-dim py-6 text-center">Reading the file…</div>}
              {!chatFileView.loading && chatFileView.error && (
                <div className="text-sm text-dim py-6 text-center">{chatFileView.error}</div>
              )}
              {!chatFileView.loading && !chatFileView.error && chatFileView.binary && (
                <div className="text-sm text-dim py-6 text-center">
                  This is a binary file — no text preview.
                </div>
              )}
              {!chatFileView.loading && !chatFileView.error && !chatFileView.binary && (() => {
                const name = chatFileView.file.name;
                const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
                const body = chatFileView.content || '';
                // Markdown renders as markdown; everything else as a highlighted
                // code fence (4 backticks so embedded ``` in the file survive).
                const rendered = ext === 'md' || ext === 'markdown'
                  ? body
                  : `\`\`\`\`${ext}\n${body}\n\`\`\`\``;
                return <ChatMarkdown content={rendered} />;
              })()}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}