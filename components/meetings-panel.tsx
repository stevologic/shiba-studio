'use client';

/**
 * Meetings (Beta) — spoken, agent-led project reviews.
 * Lobby (start/browse meetings) → live room (voice conversation + visual
 * stage) → minutes (summary, direction, decisions, todos → Board cards).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ArrowRight,
  Check,
  CheckSquare,
  ClipboardList,
  KanbanSquare,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  Pencil,
  Plus,
  Presentation,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { confirmDialog } from '@/components/confirm-dialog';
import { subscribeLiveEvents } from '@/lib/live-events';
import type { Agent } from '@/lib/types';
import type {
  LiveMeetingRecord,
  LiveMeetingTurn,
  MeetingDiagramVisual,
  MeetingVisual,
} from '@/lib/live-meeting-types';

const ChatMarkdown = dynamic(() => import('@/components/chat-markdown-lazy'));

type RoomPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface ProjectOption { id: string; name: string }

async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const data = await response.json().catch(() => ({})) as T & { ok?: boolean; error?: string };
  if (!response.ok || data.ok === false) throw new Error(data.error || 'Request failed');
  return data;
}

function meetingDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/* ── Diagram renderer: small layered DAG laid out left → right ── */

function DiagramView({ visual }: { visual: MeetingDiagramVisual }) {
  const layout = useMemo(() => {
    const nodes = visual.nodes.slice(0, 12);
    const incoming = new Map<string, number>(nodes.map((node) => [node.id, 0]));
    for (const edge of visual.edges) incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    // Longest-path layering; cycles fall back to insertion order.
    const layerOf = new Map<string, number>();
    const queue = nodes.filter((node) => !incoming.get(node.id)).map((node) => node.id);
    for (const id of queue) layerOf.set(id, 0);
    let guard = 0;
    while (queue.length && guard++ < 400) {
      const id = queue.shift()!;
      for (const edge of visual.edges.filter((candidate) => candidate.from === id)) {
        const next = Math.max(layerOf.get(edge.to) ?? 0, (layerOf.get(id) ?? 0) + 1);
        if (next !== layerOf.get(edge.to)) {
          layerOf.set(edge.to, next);
          queue.push(edge.to);
        }
      }
    }
    for (const node of nodes) if (!layerOf.has(node.id)) layerOf.set(node.id, 0);
    const layers = new Map<number, string[]>();
    for (const node of nodes) {
      const layer = layerOf.get(node.id)!;
      layers.set(layer, [...(layers.get(layer) || []), node.id]);
    }
    const boxW = 168;
    const boxH = 46;
    const gapX = 84;
    const gapY = 26;
    const positions = new Map<string, { x: number; y: number }>();
    const layerKeys = [...layers.keys()].sort((a, b) => a - b);
    const maxRows = Math.max(...layerKeys.map((key) => layers.get(key)!.length));
    const height = Math.max(1, maxRows) * (boxH + gapY) + gapY;
    for (const key of layerKeys) {
      const ids = layers.get(key)!;
      const columnHeight = ids.length * (boxH + gapY) - gapY;
      ids.forEach((id, index) => {
        positions.set(id, {
          x: gapX / 2 + key * (boxW + gapX),
          y: (height - columnHeight) / 2 + index * (boxH + gapY),
        });
      });
    }
    const width = layerKeys.length * (boxW + gapX);
    return { nodes, positions, boxW, boxH, width: Math.max(width, boxW + gapX), height };
  }, [visual]);

  return (
    <div className="overflow-auto">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="w-full"
        style={{ minWidth: Math.min(layout.width, 720), maxHeight: 460 }}
        role="img"
        aria-label={visual.title}
      >
        <defs>
          <marker id="meeting-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
          </marker>
        </defs>
        {visual.edges.map((edge, index) => {
          const from = layout.positions.get(edge.from);
          const to = layout.positions.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + layout.boxW;
          const y1 = from.y + layout.boxH / 2;
          const x2 = to.x;
          const y2 = to.y + layout.boxH / 2;
          const bend = Math.max(30, (x2 - x1) / 2);
          const path = x2 > x1
            ? `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
            : `M ${from.x + layout.boxW / 2} ${from.y + layout.boxH} C ${from.x + layout.boxW / 2} ${y1 + 70}, ${to.x + layout.boxW / 2} ${y2 + 70}, ${to.x + layout.boxW / 2} ${to.y + layout.boxH}`;
          return (
            <g key={`${edge.from}-${edge.to}-${index}`}>
              <path d={path} fill="none" stroke="var(--border-light)" strokeWidth={1.4} markerEnd="url(#meeting-arrow)" />
              {edge.label && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize={10} fill="var(--text-dim)">
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}
        {layout.nodes.map((node) => {
          const pos = layout.positions.get(node.id)!;
          return (
            <g key={node.id}>
              <rect
                x={pos.x}
                y={pos.y}
                width={layout.boxW}
                height={layout.boxH}
                rx={8}
                fill={node.emphasis ? 'var(--bg-hover)' : 'var(--bg-card)'}
                stroke={node.emphasis ? 'var(--accent-3)' : 'var(--border-light)'}
                strokeWidth={node.emphasis ? 1.6 : 1}
              />
              <text
                x={pos.x + layout.boxW / 2}
                y={pos.y + layout.boxH / 2 + 4}
                textAnchor="middle"
                fontSize={12}
                fill={node.emphasis ? 'var(--text)' : 'var(--text-muted)'}
              >
                {node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ── Annotation layer: session-local freehand markup over the stage ── */

/** One freehand stroke in coordinates normalized to the visual (0..1). */
type AnnotationStroke = Array<{ x: number; y: number }>;

function AnnotationLayer({ strokes, active, onAddStroke }: {
  strokes: AnnotationStroke[];
  active: boolean;
  onAddStroke: (stroke: AnnotationStroke) => void;
}) {
  const [draft, setDraft] = useState<AnnotationStroke | null>(null);
  const hostRef = useRef<SVGSVGElement | null>(null);

  function pointFrom(event: React.PointerEvent): { x: number; y: number } {
    const rect = hostRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  return (
    <svg
      ref={hostRef}
      className={`absolute inset-0 w-full h-full ${active ? 'cursor-crosshair' : 'pointer-events-none'}`}
      style={{ touchAction: 'none', zIndex: 5 }}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-label="Visual markup layer"
      onPointerDown={active ? (event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraft([pointFrom(event)]);
      } : undefined}
      onPointerMove={active ? (event) => {
        setDraft((current) => (current ? [...current, pointFrom(event)] : current));
      } : undefined}
      onPointerUp={active ? () => {
        setDraft((current) => {
          if (current && current.length > 1) onAddStroke(current);
          return null;
        });
      } : undefined}
    >
      {[...strokes, ...(draft ? [draft] : [])].map((stroke, index) => (
        <polyline
          key={index}
          points={stroke.map((point) => `${(point.x * 100).toFixed(2)},${(point.y * 100).toFixed(2)}`).join(' ')}
          fill="none"
          stroke="var(--fun-orange)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          opacity={0.9}
        />
      ))}
    </svg>
  );
}

/* ── Stage: whatever the agent is currently presenting ── */

function VisualStage({ visual }: { visual: MeetingVisual | null }) {
  if (!visual) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-dim">
        <Presentation size={28} strokeWidth={1.25} aria-hidden />
        <div className="text-sm">The stage is empty — the agent presents here as you talk.</div>
      </div>
    );
  }
  if (visual.kind === 'code') {
    return (
      <div>
        <div className="flex items-center justify-between gap-3 mb-2 text-xs text-dim font-mono">
          <span className="truncate">{visual.path}</span>
          <span className="flex-shrink-0">lines {visual.startLine}–{visual.endLine}</span>
        </div>
        <ChatMarkdown content={`\`\`\`${visual.language}\n${visual.code}\n\`\`\``} />
      </div>
    );
  }
  if (visual.kind === 'diagram') return <DiagramView visual={visual} />;
  if (visual.kind === 'markdown') return <ChatMarkdown content={visual.body} />;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-xs text-dim">
        <Monitor size={13} aria-hidden />
        <span className="truncate">{visual.url}</span>
      </div>
      {/* Server-captured data: URL screenshot — next/image cannot optimize it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={visual.src} alt={visual.title} className="w-full rounded border border-default" />
    </div>
  );
}

/* ── Minutes: summary, direction, decisions, todos → Board ── */

function MinutesView({ meeting, onMeetingChanged, onOpenBoard }: {
  meeting: LiveMeetingRecord;
  onMeetingChanged: (meeting: LiveMeetingRecord) => void;
  onOpenBoard?: () => void;
}) {
  const minutes = meeting.minutes;
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((minutes?.todos || []).filter((todo) => !todo.boardTaskId).map((todo) => todo.id)),
  );
  const [converting, setConverting] = useState(false);
  if (!minutes) return <div className="text-sm text-dim py-8">No minutes were produced for this meeting.</div>;
  const pending = minutes.todos.filter((todo) => !todo.boardTaskId);
  const selectedPending = pending.filter((todo) => selected.has(todo.id));
  const onBoardCount = minutes.todos.length - pending.length;

  async function sendToBoard() {
    const count = selectedPending.length;
    if (!count) return;
    const confirmed = await confirmDialog({
      title: `Create ${count} Board card(s)?`,
      message: 'Each selected todo becomes a card in the Todo column, labelled "meeting" and linked to this meeting in its description.',
      confirmLabel: 'Create cards',
    });
    if (!confirmed) return;
    setConverting(true);
    try {
      const data = await apiJson<{ meeting: LiveMeetingRecord }>(`/api/live-meetings/${encodeURIComponent(meeting.id)}/board`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ todoIds: selectedPending.map((todo) => todo.id), confirmed: true }),
      });
      onMeetingChanged(data.meeting);
      toast.success(`${count} card(s) created on the Board`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create Board cards');
    } finally {
      setConverting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grok-card p-5">
        <div className="page-section-title"><ClipboardList size={16} className="opacity-70" aria-hidden /> Meeting minutes</div>
        <div className="text-sm text-muted whitespace-pre-wrap mt-2">{minutes.summary || '(no summary)'}</div>
      </div>
      {minutes.direction && (
        <div className="grok-card p-5">
          <div className="page-section-title"><ArrowRight size={16} className="opacity-70" aria-hidden /> Direction</div>
          <div className="text-sm text-muted whitespace-pre-wrap mt-2">{minutes.direction}</div>
        </div>
      )}
      {minutes.decisions.length > 0 && (
        <div className="grok-card p-5">
          <div className="page-section-title"><Check size={16} className="opacity-70" aria-hidden /> Decisions</div>
          <ul className="mt-2 space-y-1.5">
            {minutes.decisions.map((decision, index) => (
              <li key={index} className="text-sm text-muted flex gap-2">
                <span className="text-dim flex-shrink-0">{index + 1}.</span>{decision}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grok-card p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="page-section-title"><CheckSquare size={16} className="opacity-70" aria-hidden /> Todos from this meeting</div>
            {minutes.todos.length > 0 && (
              <div className="text-xs text-dim mt-1">
                {onBoardCount === minutes.todos.length
                  ? 'Every todo is on the Board.'
                  : onBoardCount > 0
                    ? `${onBoardCount} of ${minutes.todos.length} on the Board — select the rest to send them over.`
                    : 'Select the todos that should become Board cards.'}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onOpenBoard && (
              <button type="button" className="grok-btn grok-btn-secondary" onClick={onOpenBoard}>
                <KanbanSquare size={14} aria-hidden /> Open Board
              </button>
            )}
            {pending.length > 0 && (
              <button
                type="button"
                className="grok-btn grok-btn-primary"
                onClick={() => void sendToBoard()}
                disabled={converting || selectedPending.length === 0}
                title={selectedPending.length ? 'Create Board cards from the selected todos' : 'Select at least one todo first'}
              >
                {converting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plus size={14} aria-hidden />}
                {converting
                  ? 'Creating cards…'
                  : selectedPending.length
                    ? `Add ${selectedPending.length} to Board`
                    : 'Add to Board'}
              </button>
            )}
          </div>
        </div>
        {minutes.todos.length === 0 && <div className="text-sm text-dim mt-2">Nothing was requested in this meeting.</div>}
        <ul className="mt-4 space-y-2.5">
          {minutes.todos.map((todo) => (
            <li key={todo.id} className="flex items-start gap-3">
              {todo.boardTaskId ? (
                <span
                  className="mt-0.5 flex-shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-success"
                  style={{
                    border: '1px solid color-mix(in srgb, var(--success) 45%, var(--border))',
                    background: 'color-mix(in srgb, var(--success) 12%, transparent)',
                  }}
                >
                  <Check size={11} strokeWidth={2.5} aria-hidden />
                  On Board{todo.boardTaskKey ? ` · ${todo.boardTaskKey}` : ''}
                </span>
              ) : (
                <input
                  type="checkbox"
                  className="mt-1 flex-shrink-0 accent-white"
                  checked={selected.has(todo.id)}
                  onChange={(event) => {
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.add(todo.id); else next.delete(todo.id);
                      return next;
                    });
                  }}
                  aria-label={`Include "${todo.text}"`}
                />
              )}
              <div className="min-w-0">
                <div className={`text-sm ${todo.boardTaskId ? 'text-muted' : 'text-primary'}`}>
                  {todo.text}
                  {todo.priority && <span className="ml-2 text-[10px] uppercase tracking-wide text-dim border border-default rounded px-1 py-px">{todo.priority}</span>}
                </div>
                {todo.detail && <div className="text-xs text-dim mt-0.5">{todo.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── Live room ── */

function MeetingRoom({ meeting: initial, onExit, onMeetingChanged, onOpenBoard }: {
  meeting: LiveMeetingRecord;
  onExit: () => void;
  onMeetingChanged: (meeting: LiveMeetingRecord) => void;
  onOpenBoard?: () => void;
}) {
  const [meeting, setMeeting] = useState(initial);
  const [phase, setPhase] = useState<RoomPhase>('idle');
  const [micOn, setMicOn] = useState(false);
  const [voiceOut, setVoiceOut] = useState(true);
  const [interim, setInterim] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false);
  const [stageTurnId, setStageTurnId] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [stageStrokes, setStageStrokes] = useState<Record<string, AnnotationStroke[]>>({});
  const [annotationNote, setAnnotationNote] = useState('');

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const micOnRef = useRef(false);
  const busyRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const voiceIdRef = useRef<string>('eve');

  const speechSupported = typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const visualTurns = useMemo(() => meeting.turns.filter((turn) => turn.visual), [meeting.turns]);
  const stageTurn = useMemo(() => {
    const explicit = stageTurnId ? meeting.turns.find((turn) => turn.id === stageTurnId) : null;
    return (explicit?.visual ? explicit : null) || visualTurns[visualTurns.length - 1] || null;
  }, [meeting.turns, stageTurnId, visualTurns]);
  const stageVisual = stageTurn?.visual || null;
  const currentStrokes = stageTurn ? stageStrokes[stageTurn.id] || [] : [];
  const latestSuggestions = useMemo(() => {
    for (let index = meeting.turns.length - 1; index >= 0; index--) {
      const turn = meeting.turns[index];
      if (turn.role === 'agent') return turn.suggestions || [];
    }
    return [];
  }, [meeting.turns]);
  const lastAgentTurnId = useMemo(() => {
    for (let index = meeting.turns.length - 1; index >= 0; index--) {
      if (meeting.turns[index].role === 'agent') return meeting.turns[index].id;
    }
    return null;
  }, [meeting.turns]);

  const applyMeeting = useCallback((next: LiveMeetingRecord) => {
    setMeeting(next);
    onMeetingChanged(next);
    setStageTurnId(null);
  }, [onMeetingChanged]);

  const speakDoneRef = useRef<(() => void) | null>(null);
  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    // Settle the in-flight speak() promise so a pending turn never hangs.
    speakDoneRef.current?.();
  }, []);

  const stopMic = useCallback(() => {
    micOnRef.current = false;
    setMicOn(false);
    setInterim('');
    try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
    recognitionRef.current = null;
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    stopSpeaking();
    try {
      setPhase('speaking');
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice_id: voiceIdRef.current, fast: true }),
      });
      if (!response.ok) throw new Error('Voice synthesis unavailable');
      const url = URL.createObjectURL(await response.blob());
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          URL.revokeObjectURL(url);
          if (speakDoneRef.current === done) speakDoneRef.current = null;
          resolve();
        };
        speakDoneRef.current = done;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = done;
        audio.onerror = done;
        void audio.play().catch(done);
      });
    } catch {
      /* silent fallback to text-only */
    } finally {
      audioRef.current = null;
      setPhase(micOnRef.current ? 'listening' : 'idle');
    }
  }, [stopSpeaking]);

  const sendTurn = useCallback(async (text: string | null) => {
    if (busyRef.current || meeting.status !== 'active') return;
    busyRef.current = true;
    setBusy(true);
    setPhase('thinking');
    setInterim('');
    stopSpeaking();
    try { recognitionRef.current?.abort(); } catch { /* restarting later */ }
    const trimmed = text?.trim() || null;
    if (trimmed) {
      // Optimistic echo — the server response replaces it with durable turns.
      setMeeting((previous) => ({
        ...previous,
        turns: [...previous.turns, { id: `optimistic-${Date.now()}`, role: 'creator', text: trimmed, at: new Date().toISOString() }],
      }));
      setInput('');
    }
    try {
      const data = await apiJson<{ meeting: LiveMeetingRecord }>(`/api/live-meetings/${encodeURIComponent(meeting.id)}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // stageTurnId tells the server which visual "this"/"it" refers to.
        body: JSON.stringify({ text: trimmed, stageTurnId: stageTurn?.id }),
      });
      applyMeeting(data.meeting);
      const reply = [...data.meeting.turns].reverse().find((turn) => turn.role === 'agent');
      if (reply && voiceOut) {
        await speak(reply.text);
      } else {
        setPhase(micOnRef.current ? 'listening' : 'idle');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The agent could not respond');
      setPhase(micOnRef.current ? 'listening' : 'idle');
    } finally {
      busyRef.current = false;
      setBusy(false);
      // The restart effect below resumes listening once busy flips off.
    }
  }, [meeting.id, meeting.status, voiceOut, applyMeeting, speak, stopSpeaking, stageTurn]);

  const sendTurnRef = useRef(sendTurn);
  useEffect(() => { sendTurnRef.current = sendTurn; }, [sendTurn]);

  // Bumped whenever recognition ends on its own (Chrome stops after silence);
  // the restart effect below then spins it up again while the mic stays on.
  const [recognitionEpoch, setRecognitionEpoch] = useState(0);
  const startRecognition = useCallback(() => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor || recognitionRef.current || busyRef.current) return;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = '';
      let interimText = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0]?.transcript || '';
        else interimText += result[0]?.transcript || '';
      }
      setInterim(interimText.trim());
      const spoken = finalText.trim();
      if (spoken && !busyRef.current) {
        recognitionRef.current = null;
        try { recognition.abort(); } catch { /* stopping to send */ }
        void sendTurnRef.current(spoken);
      }
    };
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        toast.error('Microphone access was blocked');
        stopMic();
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setRecognitionEpoch((epoch) => epoch + 1);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setPhase('listening');
    } catch {
      recognitionRef.current = null;
    }
  }, [stopMic]);

  // Keep listening while the mic is on: restart after a turn finishes and
  // whenever Chrome ends recognition on silence.
  useEffect(() => {
    if (!micOn || busy || recognitionRef.current) return;
    const frame = requestAnimationFrame(() => startRecognition());
    return () => cancelAnimationFrame(frame);
  }, [micOn, busy, recognitionEpoch, startRecognition]);

  function toggleMic() {
    if (micOn) {
      stopMic();
      setPhase('idle');
      return;
    }
    if (!speechSupported) {
      toast.error('Voice input needs Chrome or Edge (Web Speech API)');
      return;
    }
    micOnRef.current = true;
    setMicOn(true);
  }

  // Resolve the agent's voice once — used for every spoken reply.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/agents')
      .then((response) => response.json())
      .then((data: { agents?: Array<{ id: string; voiceId?: string }> }) => {
        if (cancelled) return;
        const agent = (data.agents || []).find((candidate) => candidate.id === initial.agentId);
        if (agent?.voiceId) voiceIdRef.current = agent.voiceId;
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [initial.agentId]);

  // Speak the opening turn when entering a fresh room with voice on.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    const opening = initial.turns.length === 1 && initial.turns[0].role === 'agent' ? initial.turns[0] : null;
    if (!opening || !voiceOut) return;
    // rAF keeps setState (speaking phase) out of the synchronous effect body.
    const frame = requestAnimationFrame(() => { void speak(opening.text); });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { stopMic(); stopSpeaking(); }, [stopMic, stopSpeaking]);

  // If we rejoined while the minutes are being written, wait for them.
  useEffect(() => {
    if (meeting.status !== 'summarizing') return;
    const timer = window.setInterval(() => {
      void apiJson<{ meeting: LiveMeetingRecord }>(`/api/live-meetings/${encodeURIComponent(meeting.id)}`)
        .then((data) => { if (data.meeting.status !== 'summarizing') applyMeeting(data.meeting); })
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [meeting.status, meeting.id, applyMeeting]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [meeting.turns.length, interim]);

  async function endMeeting() {
    const confirmed = await confirmDialog({
      title: 'End this meeting?',
      message: `${meeting.agentName} writes the minutes: summary, direction, decisions, and a todo list you can send to the Board.`,
      confirmLabel: 'End & write minutes',
    });
    if (!confirmed) return;
    stopMic();
    stopSpeaking();
    setEnding(true);
    setPhase('thinking');
    try {
      const data = await apiJson<{ meeting: LiveMeetingRecord }>(`/api/live-meetings/${encodeURIComponent(meeting.id)}/end`, { method: 'POST' });
      applyMeeting(data.meeting);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not end the meeting');
    } finally {
      setEnding(false);
      setPhase('idle');
    }
  }

  const phaseCopy: Record<RoomPhase, string> = {
    idle: micOn ? 'Listening' : 'Mic off — type or turn the mic on',
    listening: 'Listening — pause to send',
    thinking: `${meeting.agentName} is thinking…`,
    speaking: `${meeting.agentName} is speaking`,
  };

  if (meeting.status === 'ended') {
    return (
      <div className="page-content">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <div className="page-title">{meeting.title}</div>
            <div className="page-subtitle">
              Meeting with {meeting.agentName}
              {meeting.projectName ? ` · ${meeting.projectName}` : ''} · ended {meeting.endedAt ? meetingDate(meeting.endedAt) : ''}
            </div>
          </div>
          <button type="button" className="grok-btn grok-btn-ghost text-xs" onClick={onExit}>Back to meetings</button>
        </div>
        <MinutesView
          meeting={meeting}
          onMeetingChanged={(next) => { setMeeting(next); onMeetingChanged(next); }}
          onOpenBoard={onOpenBoard}
        />
      </div>
    );
  }

  if (meeting.status === 'summarizing') {
    return (
      <div className="page-content">
        <div className="grok-card p-8 mt-6 flex flex-col items-center gap-3 text-center">
          <Loader2 size={22} className="animate-spin text-dim" aria-hidden />
          <div className="text-sm text-primary">{meeting.agentName} is writing the minutes…</div>
          <div className="text-xs text-dim">Summary, direction, decisions, and the todo list from this meeting.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-content flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0">
          <div className="page-title flex items-center gap-2 truncate">
            {meeting.title}
            <span className="text-[10px] uppercase tracking-widest border border-default rounded px-1.5 py-0.5 text-dim flex-shrink-0">Beta</span>
          </div>
          <div className="text-xs text-dim flex items-center gap-2">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${phase === 'thinking' ? 'bg-[var(--warning)]' : phase === 'speaking' ? 'bg-[var(--success)]' : micOn ? 'bg-[var(--success)]' : 'bg-[var(--border-light)]'}`} aria-hidden />
            {phaseCopy[phase]}
            {meeting.error && <span className="text-error">Last turn failed — try again</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            className="grok-btn grok-btn-ghost text-xs flex items-center gap-1.5"
            onClick={() => { stopSpeaking(); setVoiceOut((value) => !value); setPhase(micOnRef.current ? 'listening' : 'idle'); }}
            title={voiceOut ? 'Mute the agent voice (text only)' : 'Speak agent replies aloud'}
          >
            {voiceOut ? <Volume2 size={13} aria-hidden /> : <VolumeX size={13} aria-hidden />}
            {voiceOut ? 'Voice on' : 'Voice off'}
          </button>
          <button
            type="button"
            className="grok-btn grok-btn-ghost text-xs flex items-center gap-1.5"
            onClick={() => void endMeeting()}
            disabled={ending || busy}
          >
            {ending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Square size={12} aria-hidden />}
            {ending ? 'Writing minutes…' : 'End meeting'}
          </button>
        </div>
      </div>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Stage */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="grok-card p-4 flex-1 overflow-auto">
            {stageVisual && (
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="text-sm text-primary font-medium">{stageVisual.title}</div>
                {meeting.status === 'active' && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {currentStrokes.length > 0 && (
                      <button
                        type="button"
                        className="grok-btn grok-btn-ghost text-xs"
                        onClick={() => {
                          if (stageTurn) setStageStrokes((previous) => ({ ...previous, [stageTurn.id]: [] }));
                          setAnnotationNote('');
                        }}
                        title="Remove every mark from this visual"
                      >
                        <Trash2 size={12} aria-hidden /> Clear
                      </button>
                    )}
                    <button
                      type="button"
                      className={`grok-btn text-xs ${annotating ? 'grok-btn-secondary' : 'grok-btn-ghost'}`}
                      onClick={() => setAnnotating((value) => !value)}
                      aria-pressed={annotating}
                      title={annotating ? 'Stop drawing' : 'Draw on this visual to point things out'}
                    >
                      <Pencil size={12} aria-hidden /> {annotating ? 'Done drawing' : 'Annotate'}
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="relative">
              <VisualStage visual={stageVisual} />
              {stageTurn && (annotating || currentStrokes.length > 0) && (
                <AnnotationLayer
                  strokes={currentStrokes}
                  active={annotating && meeting.status === 'active'}
                  onAddStroke={(stroke) => {
                    setStageStrokes((previous) => ({
                      ...previous,
                      [stageTurn.id]: [...(previous[stageTurn.id] || []), stroke],
                    }));
                  }}
                />
              )}
            </div>
          </div>
          {currentStrokes.length > 0 && meeting.status === 'active' && (
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!stageVisual) return;
                const note = annotationNote.trim();
                setAnnotating(false);
                setAnnotationNote('');
                void sendTurn(
                  `(I drew on the visual "${stageVisual.title}" to point some areas out.) ${note || 'Ask me which parts I marked if it is unclear, then address them.'}`,
                );
              }}
            >
              <Pencil size={13} className="text-warning flex-shrink-0" aria-hidden />
              <input
                className="grok-input flex-1 text-sm"
                placeholder={`Tell ${meeting.agentName} what your marks mean…`}
                value={annotationNote}
                onChange={(event) => setAnnotationNote(event.target.value)}
                disabled={busy}
              />
              <button type="submit" className="grok-btn grok-btn-secondary" disabled={busy}>
                Share markup
              </button>
            </form>
          )}
          {visualTurns.length > 1 && (
            <div className="flex gap-1.5 mt-2 overflow-x-auto pb-1" aria-label="Earlier visuals — newest first">
              {[...visualTurns].reverse().map((turn) => (
                <button
                  key={turn.id}
                  type="button"
                  className={`text-[11px] px-2 py-1 rounded border flex-shrink-0 ${turn.id === stageTurn?.id ? 'border-[var(--accent-3)] text-primary' : 'border-default text-dim hover:text-primary'}`}
                  onClick={() => setStageTurnId(turn.id)}
                  title={`Show again: ${turn.visual!.title}`}
                >
                  {stageStrokes[turn.id]?.length ? '✎ ' : ''}{turn.visual!.kind} · {turn.visual!.title.slice(0, 28)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Conversation rail */}
        <div className="w-[300px] flex-shrink-0 flex flex-col min-h-0">
          <div ref={transcriptRef} className="grok-card p-3 flex-1 overflow-y-auto space-y-3">
            {meeting.turns.map((turn: LiveMeetingTurn) => (
              <div key={turn.id}>
                <div className="text-[10px] uppercase tracking-wide text-dim mb-0.5">
                  {turn.role === 'creator' ? 'You' : meeting.agentName}
                </div>
                <div className={`text-sm whitespace-pre-wrap ${turn.role === 'creator' ? 'text-muted' : 'text-primary'}`}>
                  {turn.text}
                </div>
                {turn.id === lastAgentTurnId && phase === 'speaking' && (
                  <button
                    type="button"
                    className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-warning border rounded-full px-2 py-0.5 hover:brightness-125"
                    style={{ borderColor: 'color-mix(in srgb, var(--fun-orange) 45%, var(--border))' }}
                    onClick={stopSpeaking}
                    aria-label="Stop the voice for this reply"
                  >
                    <Square size={9} strokeWidth={2.5} aria-hidden /> Stop voice
                  </button>
                )}
                {turn.visual && (
                  <button
                    type="button"
                    className="text-[11px] text-dim hover:text-primary mt-1 flex items-center gap-1"
                    onClick={() => setStageTurnId(turn.id)}
                  >
                    <Presentation size={11} aria-hidden /> {turn.visual.title}
                  </button>
                )}
              </div>
            ))}
            {interim && <div className="text-sm text-dim italic">“{interim}”</div>}
            {busy && (
              <div className="flex items-center gap-2 text-xs text-dim">
                <Loader2 size={12} className="animate-spin" aria-hidden /> {meeting.agentName} is thinking…
              </div>
            )}
          </div>

          {latestSuggestions.length > 0 && meeting.status === 'active' && (
            <div className="flex flex-wrap gap-1.5 mt-2" aria-label="Suggested directions">
              {latestSuggestions.map((suggestion, index) => (
                <button
                  key={index}
                  type="button"
                  className="text-[11px] px-2 py-1 rounded-full border border-default text-muted hover:text-primary hover:border-[var(--border-light)]"
                  onClick={() => void sendTurn(suggestion)}
                  disabled={busy}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => { event.preventDefault(); void sendTurn(input); }}
          >
            <button
              type="button"
              onClick={toggleMic}
              className={`p-2 rounded border ${micOn ? 'border-[var(--success)] text-success' : 'border-default text-dim hover:text-primary'}`}
              title={speechSupported ? (micOn ? 'Turn the microphone off' : 'Talk to the agent') : 'Voice input needs Chrome or Edge'}
              aria-label={micOn ? 'Turn microphone off' : 'Turn microphone on'}
              aria-pressed={micOn}
            >
              {micOn ? <Mic size={15} aria-hidden /> : <MicOff size={15} aria-hidden />}
            </button>
            <input
              className="grok-input flex-1 text-sm"
              placeholder={micOn ? 'Speak, or type here…' : 'Ask about the project…'}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy}
            />
            <button type="submit" className="grok-btn grok-btn-primary p-2" disabled={busy || !input.trim()} aria-label="Send">
              <Send size={14} aria-hidden />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ── Lobby + panel shell ── */

export default function MeetingsPanel({ agents, onOpenBoard }: {
  agents: Agent[];
  onOpenBoard?: () => void;
}) {
  const [meetings, setMeetings] = useState<LiveMeetingRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [agentId, setAgentId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [focus, setFocus] = useState('');
  const [starting, setStarting] = useState(false);
  const [active, setActive] = useState<LiveMeetingRecord | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiJson<{ meetings: LiveMeetingRecord[] }>('/api/live-meetings');
      setMeetings(data.meetings);
    } catch {
      /* transient */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // Microtask deferral keeps setState out of the synchronous effect body
    // (compiler lint) yet still runs in hidden tabs, where rAF never fires
    // and timers are throttled.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      void refresh();
      void fetch('/api/projects')
        .then((response) => response.json())
        .then((data: { projects?: ProjectOption[] }) => {
          if (!cancelled) setProjects((data.projects || []).map((p) => ({ id: p.id, name: p.name })));
        })
        .catch(() => {});
    });
    const unsubscribe = subscribeLiveEvents(['meetings'], () => { void refresh(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [refresh]);

  useEffect(() => {
    if (agentId || !agents.length) return;
    let cancelled = false;
    const fallback = agents[0].id;
    void Promise.resolve().then(() => { if (!cancelled) setAgentId(fallback); });
    return () => { cancelled = true; };
  }, [agents, agentId]);

  async function startMeeting() {
    if (!agentId) {
      toast.error('Create an agent first — a meeting needs a colleague');
      return;
    }
    setStarting(true);
    try {
      const data = await apiJson<{ meeting: LiveMeetingRecord }>('/api/live-meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, projectId: projectId || null, focus }),
      });
      setFocus('');
      setActive(data.meeting);
      void refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start the meeting');
    } finally {
      setStarting(false);
    }
  }

  async function removeMeeting(meeting: LiveMeetingRecord) {
    const confirmed = await confirmDialog({
      title: `Delete "${meeting.title}"?`,
      message: 'The transcript and minutes are removed. Board cards already created from it are kept.',
      confirmLabel: 'Delete meeting',
      danger: true,
    });
    if (!confirmed) return;
    setDeleting(meeting.id);
    try {
      await apiJson(`/api/live-meetings/${encodeURIComponent(meeting.id)}`, { method: 'DELETE' });
      void refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the meeting');
    } finally {
      setDeleting(null);
    }
  }

  if (active) {
    return (
      <MeetingRoom
        key={active.id}
        meeting={active}
        onExit={() => { setActive(null); void refresh(); }}
        onMeetingChanged={(next) => setMeetings((previous) => previous.map((item) => (item.id === next.id ? next : item)))}
        onOpenBoard={onOpenBoard}
      />
    );
  }

  return (
    <div className="page-content">
      <div className="page-title flex items-center gap-2">
        Meetings
        <span className="text-[10px] uppercase tracking-widest border border-default rounded px-1.5 py-0.5 text-dim">Beta</span>
      </div>
      <div className="page-subtitle">
        Sit down with an agent like a colleague. They walk you through what they&apos;ve built — code, diagrams, live screens —
        you steer with your voice, and the meeting ends in minutes with todos you can send straight to the Board.
      </div>

      <div className="grok-card p-5 mt-4">
        <div className="page-section-title"><Presentation size={16} className="opacity-70" aria-hidden /> Start a meeting</div>
        <div className="flex items-end gap-3 flex-wrap mt-3">
          <label className="text-xs text-dim flex flex-col gap-1">
            With
            <select className="grok-select text-sm min-w-[180px]" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.length === 0 && <option value="">No agents yet</option>}
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-dim flex flex-col gap-1">
            About project
            <select className="grok-select text-sm min-w-[180px]" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Whole workspace</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-dim flex flex-col gap-1 flex-1 min-w-[220px]">
            Focus (optional)
            <input
              className="grok-input text-sm"
              placeholder="e.g. review the auth flow before launch"
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="grok-btn grok-btn-primary"
            onClick={() => void startMeeting()}
            disabled={starting || !agentId}
          >
            {starting ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Mic size={15} aria-hidden />}
            {starting ? 'Agent is preparing…' : 'Start meeting'}
          </button>
        </div>
        {starting && (
          <div className="text-xs text-dim mt-2">
            The agent is reviewing the project — board, files, and recent commits — to open the meeting.
          </div>
        )}
      </div>

      <div className="page-section-title mt-6"><ClipboardList size={16} className="opacity-70" aria-hidden /> Past meetings</div>
      {!loaded && <div className="text-sm text-dim mt-2">Loading…</div>}
      {loaded && meetings.length === 0 && (
        <div className="text-sm text-dim mt-2">No meetings yet — start your first review above.</div>
      )}
      <div className="grid gap-3 mt-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {meetings.map((meeting) => (
          <div key={meeting.id} className="grok-card p-4 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm text-primary font-medium leading-snug">{meeting.title}</div>
              <span className={`text-[10px] uppercase tracking-wide flex-shrink-0 ${meeting.status === 'active' ? 'text-success' : 'text-dim'}`}>
                {meeting.status === 'active' ? 'Live' : meeting.status === 'summarizing' ? 'Wrapping up' : 'Ended'}
              </span>
            </div>
            <div className="text-xs text-dim">
              {meeting.agentName}{meeting.projectName ? ` · ${meeting.projectName}` : ''} · {meetingDate(meeting.createdAt)}
              {' · '}{meeting.turns.length} turn(s)
              {meeting.minutes ? ` · ${meeting.minutes.todos.length} todo(s)` : ''}
            </div>
            <div className="flex items-center gap-2 mt-auto pt-1">
              <button type="button" className="grok-btn grok-btn-ghost text-xs" onClick={() => setActive(meeting)}>
                {meeting.status === 'active' ? 'Rejoin' : 'Open minutes'}
              </button>
              <button
                type="button"
                className="grok-btn grok-btn-ghost text-xs text-error ml-auto"
                onClick={() => void removeMeeting(meeting)}
                disabled={deleting === meeting.id}
                aria-label={`Delete ${meeting.title}`}
              >
                {deleting === meeting.id ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Trash2 size={12} aria-hidden />}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
