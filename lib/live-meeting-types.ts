/**
 * Live Meetings (Beta) — a spoken, agent-led project review.
 * The creator (director) and one agent (senior engineer) talk through the
 * project; the agent presents visuals and the meeting ends in minutes with
 * todos that convert to Board cards only after explicit confirmation.
 */

export type LiveMeetingStatus = 'active' | 'summarizing' | 'ended';

/** A code excerpt read server-side from the real workspace file — never model-invented. */
export interface MeetingCodeVisual {
  kind: 'code';
  title: string;
  /** Workspace-relative path the excerpt was read from. */
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  code: string;
}

export interface MeetingDiagramNode {
  id: string;
  label: string;
  /** Highlighted nodes render with the accent tone. */
  emphasis?: boolean;
}

export interface MeetingDiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface MeetingDiagramVisual {
  kind: 'diagram';
  title: string;
  nodes: MeetingDiagramNode[];
  edges: MeetingDiagramEdge[];
}

export interface MeetingMarkdownVisual {
  kind: 'markdown';
  title: string;
  body: string;
}

/** A live capture of a running app URL, taken server-side with the studio browser. */
export interface MeetingScreenshotVisual {
  kind: 'screenshot';
  title: string;
  url: string;
  /** data: image URL of the captured viewport. */
  src: string;
}

export type MeetingVisual =
  | MeetingCodeVisual
  | MeetingDiagramVisual
  | MeetingMarkdownVisual
  | MeetingScreenshotVisual;

export interface LiveMeetingTurn {
  id: string;
  role: 'creator' | 'agent';
  /** Spoken text (voice-friendly, no markdown on agent turns). */
  text: string;
  at: string;
  /** Visual the agent put on the meeting stage with this turn. */
  visual?: MeetingVisual;
  /** AI steering — short directions the creator can take next. */
  suggestions?: string[];
}

export interface LiveMeetingTodo {
  id: string;
  text: string;
  detail?: string;
  priority?: 'low' | 'medium' | 'high';
  /** Who the work was explicitly assigned to in the meeting (agent name). */
  owner?: string;
  /** Set once converted — Board card id/key for the created card. */
  boardTaskId?: string;
  boardTaskKey?: string;
}

export interface LiveMeetingMinutes {
  summary: string;
  /** Direction agreed in the meeting — where the project goes next. */
  direction: string;
  decisions: string[];
  todos: LiveMeetingTodo[];
}

export interface LiveMeetingRecord {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  projectId: string | null;
  projectName: string;
  /** Optional creator-provided focus for the session. */
  focus: string;
  status: LiveMeetingStatus;
  turns: LiveMeetingTurn[];
  minutes: LiveMeetingMinutes | null;
  error?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export const LIVE_MEETING_MAX_TURNS = 400;
export const LIVE_MEETING_MAX_TODOS = 50;

/**
 * SSE events for `POST /api/live-meetings/:id/turn/stream`.
 * Mirrors the chat multi-agent stream shape (data: JSON\n\n) so the room can
 * show progressive spoken text and start TTS before the full JSON turn settles.
 */
export type LiveMeetingStreamEvent =
  | { type: 'status'; phase: 'thinking' | 'settling' }
  | { type: 'say'; delta: string; text: string }
  | { type: 'meeting'; meeting: LiveMeetingRecord }
  | { type: 'error'; message: string }
  | { type: 'done' };

export function encodeLiveMeetingSseEvent(event: LiveMeetingStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
