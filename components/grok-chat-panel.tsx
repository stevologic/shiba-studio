'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Brain, Check, ChevronDown, ChevronUp, Copy, Crosshair, Download, Eraser, GitBranch, Paperclip, Pencil, RefreshCw, RotateCcw,
  Send, Sparkles, Square, Terminal, X,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import ChatMarkdown from '@/components/chat-markdown-lazy';
import type { SubBrowserAnnotation } from '@/components/sub-browser';

const SubBrowser = dynamic(() => import('@/components/sub-browser'));

/** Slash-command catalog — drives the composer autocomplete and /help. */
const SLASH_COMMANDS: Array<{ cmd: string; insert: string; desc: string }> = [
  { cmd: '/git status', insert: '/git status', desc: 'Branch, changed files, recent commits' },
  { cmd: '/git checkout <branch>', insert: '/git checkout ', desc: 'Switch to a branch, or create it' },
  { cmd: '/git commit <message>', insert: '/git commit ', desc: 'Stage everything and commit' },
  { cmd: '/git pr <title> | <body>', insert: '/git pr ', desc: 'Push branch and open a GitHub PR' },
  { cmd: '/annotate', insert: '/annotate', desc: 'Sub-browser: highlight an element for refinement' },
  { cmd: '/search <query>', insert: '/search ', desc: 'Web search results into this chat' },
  { cmd: '/fetch <url>', insert: '/fetch ', desc: 'Read a page as text into this chat' },
  { cmd: '/remember <key> | <content>', insert: '/remember ', desc: 'Save a persistent memory' },
  { cmd: '/recall <keyword>', insert: '/recall ', desc: 'List saved memories' },
  { cmd: '/note <path> | <content>', insert: '/note ', desc: 'Create an Obsidian note' },
  { cmd: '/x <text>', insert: '/x ', desc: 'Post to X through the configured integration' },
  { cmd: '/help', insert: '/help', desc: 'Full command reference' },
];
import { confirmDialog } from '@/components/confirm-dialog';
import type { ChatAttachment, ChatMessagePayload, ReasoningEffort } from '@/lib/chat-types';
import { buildAgentChatSystem } from '@/lib/chat-skill';
import { modelDisplayName, parseModelRef, providerLabel, supportsReasoning } from '@/lib/model-providers';
import type { Agent } from '@/lib/types';
import type { Project, ProjectChatMessage } from '@/lib/project-types';
import type { ChatSession } from '@/lib/chat-session-types';
import { deriveSessionTitle } from '@/lib/chat-session-types';
import { resolveAgentAvatarPath } from '@/lib/agent-avatars';
import { v4 as uuidv4 } from 'uuid';

export type ChatTarget = 'grok' | 'all' | string;

type ModelOption = { id: string; label: string; provider?: 'cloud' | 'local'; reasoning?: boolean };

function ModelProviderBadge({ modelId, size = 'sm' }: { modelId?: string; size?: 'sm' | 'xs' }) {
  const ref = parseModelRef(modelId || '');
  const cls = size === 'xs' ? 'model-provider-badge model-provider-badge-xs' : 'model-provider-badge';
  return (
    <span
      className={`${cls} model-provider-${ref.provider}`}
      title={ref.provider === 'local' ? 'Local model on this machine — any OpenAI-compatible server' : 'xAI Grok cloud API'}
    >
      {providerLabel(ref.provider)}
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
}

type AgentPerspective = { agentId: string; name: string; content: string };

type UiMessage = ChatMessagePayload & {
  id: string;
  streaming?: boolean;
  agentId?: string;
  agentName?: string;
  perspectives?: AgentPerspective[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

function fmtTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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
    usage: m.usage,
    streaming: false,
  }));
}

function uiToProjectMessages(messages: UiMessage[]): ProjectChatMessage[] {
  return messages
    .filter((m) => m.id !== 'welcome' && !m.streaming && m.content)
    .map((m) => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      thinking: m.thinking,
      attachments: m.attachments,
      model: m.model,
      agentId: m.agentId,
      agentName: m.agentName,
      perspectives: m.perspectives,
      usage: m.usage,
      createdAt: new Date().toISOString(),
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
) {
  const target = (session?.chatTarget || 'grok') as ChatTarget;
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
    };
  }
  return {
    target,
    messages: initialMessages(project, target, agents),
    useGrokCli,
    cliModel: session?.cliModel || '',
    reasoningEffort: (session?.reasoningEffort || 'low') as ReasoningEffort,
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
}: GrokChatPanelProps) {
  const isSessionMode = !!session && !onProjectUpdated;
  const init = sessionToInitialState(session, project, agents);
  const [chatTarget, setChatTarget] = useState<ChatTarget>(init.target);
  const [messages, setMessages] = useState<UiMessage[]>(init.messages);
  // Drafts survive tab switches and reloads (C6). Scoped per session/project;
  // the panel remounts per session via its key prop, so lazy init is enough.
  const draftKey = `grokdesk-draft:${session?.id || project?.id || 'direct'}`;
  const [input, setInput] = useState(() =>
    (typeof window !== 'undefined' ? window.localStorage.getItem(draftKey) || '' : ''),
  );
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(init.reasoningEffort);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; name: string } | null>(null);
  const [showSubBrowser, setShowSubBrowser] = useState(false);

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

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatModelRef = useRef(chatModel);
  useEffect(() => { chatModelRef.current = chatModel; }, [chatModel]);

  const scrollToBottom = useCallback((smooth = true) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
  }, []);

  // Stick to the bottom while streaming, but respect the user scrolling up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Cancel any in-flight stream when this panel unmounts (e.g. session switch).
  useEffect(() => {
    const ref = abortRef;
    return () => ref.current?.abort();
  }, []);

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

  // "Jump to latest" appears when the reader scrolls away from the tail (C5).
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const onMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAwayFromLatest(el.scrollHeight - el.scrollTop - el.clientHeight > 220);
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

  // Resync from the stored session only when the session itself actually changes.
  // Guarded by a key so unrelated re-renders (e.g. the 22s agents poll upstream
  // producing a new array identity) can never clobber an in-progress conversation.
  const sessionSyncKeyRef = useRef<string | null>(session ? `${session.id}:${session.updatedAt}` : null);
  useEffect(() => {
    if (!session || streaming) return;
    const syncKey = `${session.id}:${session.updatedAt}`;
    if (sessionSyncKeyRef.current === syncKey) return;
    sessionSyncKeyRef.current = syncKey;
    const next = sessionToInitialState(session, project, agents);
    setChatTarget(next.target);
    setMessages(next.messages);
    setUseGrokCli(next.useGrokCli);
    setReasoningEffort(next.reasoningEffort);
    setExpandedThinking({});
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

  async function patchSession(patch: Record<string, unknown>) {
    if (!session) return;
    try {
      await fetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: session.id, patch }),
      });
      onSessionUpdated?.();
    } catch {
      /* ignore */
    }
  }

  async function persistSessionMessages(msgs: UiMessage[]) {
    if (!session) return;
    const saved = uiToProjectMessages(msgs);
    const wasUntitled = !session.title || session.title === 'New chat';
    await patchSession({
      messages: saved,
      title: deriveSessionTitle(saved, session.title),
    });
    // First exchange of a fresh chat → have a low-end model write a real
    // title (server picks a fast/cheap model; falls back to the default).
    const userCount = saved.filter((m) => m.role === 'user').length;
    if (wasUntitled && userCount === 1 && saved.some((m) => m.role === 'assistant')) {
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

  function updateChatTarget(next: ChatTarget) {
    setChatTarget(next);
    if (next === 'all') setUseGrokCli(false);
    if (isSessionMode) void patchSession({ chatTarget: next });
  }

  function updateReasoningEffort(next: ReasoningEffort) {
    setReasoningEffort(next);
    if (isSessionMode) void patchSession({ reasoningEffort: next });
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
          };
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          if (event.type === 'thinking' && event.delta) {
            setMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId ? { ...m, thinking: (m.thinking || '') + event.delta } : m,
              ),
            );
          } else if (event.type === 'agent-perspective' && event.agentId && event.name && event.content) {
            const perspective = { agentId: event.agentId, name: event.name, content: event.content };
            onPerspective?.(perspective);
            setMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId
                  ? { ...m, perspectives: [...(m.perspectives || []), perspective] }
                  : m,
              ),
            );
          } else if (event.type === 'content' && event.delta) {
            setMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + event.delta } : m,
              ),
            );
          } else if (event.type === 'usage' && event.usage) {
            const u = event.usage;
            const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
            const completionTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
            const totalTokens = Number(u.total_tokens ?? promptTokens + completionTokens) || 0;
            if (totalTokens > 0) {
              setMessages((msgs) =>
                msgs.map((m) =>
                  m.id === assistantId ? { ...m, usage: { promptTokens, completionTokens, totalTokens } } : m,
                ),
              );
            }
          } else if (event.type === 'error') {
            throw new Error(event.message || 'Stream error');
          } else if (event.type === 'done' && event.model) {
            setMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId ? { ...m, model: event.model, streaming: false } : m,
              ),
            );
          }
        }
      }
    }

    setMessages((msgs) =>
      msgs.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
    );
  }

  function stopStreaming() {
    abortRef.current?.abort();
  }

  async function runAssistantTurn(history: UiMessage[]) {
    const assistantId = uuidv4();
    const isMulti = chatTarget === 'all';
    const useCli = useGrokCli && grokCliInstalled && !isMulti;
    const useModel = useCli
      ? (cliModel || cliDefaultModel || cliModels[0] || '')
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

    setMessages([...history, assistantPlaceholder]);
    setStreaming(true);
    setExpandedThinking((prev) => ({ ...prev, [assistantId]: true }));

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const payloadMessages = history.map((m) => ({
      role: m.role,
      content: m.content,
      attachments: m.attachments,
      thinking: m.thinking,
    }));

    try {
      const endpoint = useCli
        ? '/api/grok-cli/stream'
        : isMulti
          ? '/api/grok/multi-agent-stream'
          : '/api/grok/stream';
      const body: Record<string, unknown> = {
        model: useModel,
        messages: payloadMessages,
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
      setMessages((msgs) =>
        msgs.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: aborted ? m.content : m.content || `Error: ${msg}`,
                streaming: false,
              }
            : m,
        ),
      );
    }

    setStreaming(false);
    setExpandedThinking((prev) => ({ ...prev, [assistantId]: false }));
    if (isSessionMode) {
      setMessages((msgs) => {
        void persistSessionMessages(msgs);
        return msgs;
      });
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
      '### 🧠 Memory & notes',
      '| Command | What it does |',
      '| --- | --- |',
      '| `/remember <key> \\| <content>` | Save a fact that persists across every chat |',
      '| `/recall [keyword]` | List saved memories (optionally filtered) |',
      '| `/note <path> \\| <content>` | Create an Obsidian note in your vault |',
      '| `/x <text>` | Post to X via the integration (agents can too, with the X scope) |',
      '',
      `_Git runs against ${project?.name ? `the "${project.name}" project workspace` : 'the default workspace'}; PRs use your GitHub token from Capabilities. Type \`/\` any time to see the command bar._`,
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
      const workspacePath = project?.workspacePath?.trim() || undefined;
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
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || streaming) return;

    // Slash commands always win over a normal send — attachments stay pending
    // in the composer for the next real message.
    if (text.startsWith('/')) {
      const handled = await runSlashCommand(text);
      if (handled) return;
    }

    if (chatTarget === 'all' && pendingAttachments.length > 0) {
      toast.error('Multi-agent mode does not support file attachments yet — send text only.');
      return;
    }
    if (useGrokCli && pendingAttachments.length > 0) {
      toast.error('Grok CLI mode is text-only — remove attachments or switch back to API chat.');
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
    setPendingAttachments([]);
    await runAssistantTurn(history);
  }

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
    <div className={`grok-chat-panel mx-auto flex flex-col flex-1 min-h-0 ${project && onProjectUpdated ? 'grok-chat-panel-embedded max-w-none h-[min(520px,calc(100vh-420px))]' : 'max-w-none'}`}>
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
          title="Chat as Grok, a specific agent, or all agents"
        >
          <option value="grok">Grok (default)</option>
          {agents.length > 0 && (
            <optgroup label="Agents">
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </optgroup>
          )}
          <option value="all" disabled={agents.length === 0}>All agents — summarize</option>
        </select>
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
                {!isUser && m.agentId && agents.find((a) => a.id === m.agentId) && (
                  <img
                    src={resolveAgentAvatarPath(agents.find((a) => a.id === m.agentId)!)}
                    alt=""
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
                    title={`${m.usage.promptTokens.toLocaleString()} in · ${m.usage.completionTokens.toLocaleString()} out`}
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
            <div className="chat-empty-orb" aria-hidden>
              <Sparkles size={22} />
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
            scrollToBottom();
            setAwayFromLatest(false);
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
          onChange={(e) => e.target.files && uploadFiles(e.target.files)}
        />
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); setSlashDismissed(false); }}
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
              void sendChat();
            }
          }}
          onPaste={onPaste}
          rows={1}
          className="grok-input grok-chat-textarea grok-chat-textarea-lead"
          placeholder={project ? 'Ask about this project — uploads are carried into context…' : 'Ask Grok anything — Shift+Enter for a new line, drop or paste files…'}
        />
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
              <optgroup label="Grok CLI — this machine">
                {cliModels.map((m) => (
                  <option key={m} value={m}>{m}{m === cliDefaultModel ? ' (default)' : ''}</option>
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
        {useGrokCli && grokCliInstalled
          ? `Grok Build CLI on this machine${grokCliVersion ? ` (${grokCliVersion})` : ''} · global uploads still included as context`
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
                : 'Cloud Grok — streaming, reasoning, images & files · global workspace uploads included'}
      </div>

      {showSubBrowser && (
        <SubBrowser
          open={showSubBrowser}
          onClose={() => setShowSubBrowser(false)}
          onAnnotate={handleAnnotation}
          initialUrl={undefined}
        />
      )}

      {/* Full-size image viewer for inline chat images */}
      {lightboxImage && (
        <div className="chat-lightbox" onClick={() => setLightboxImage(null)} role="dialog" aria-label={lightboxImage.name}>
          <img src={lightboxImage.src} alt={lightboxImage.name} className="chat-lightbox-img" onClick={(e) => e.stopPropagation()} />
          <div className="chat-lightbox-caption">{lightboxImage.name} — click anywhere to close</div>
        </div>
      )}
    </div>
  );
}