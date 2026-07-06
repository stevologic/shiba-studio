import type { AgentRun, TraceStep } from './types';

export type AgentStreamEvent =
  | { type: 'trace'; step: TraceStep }
  | { type: 'approval_required'; approvalId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'run'; run: AgentRun }
  | { type: 'error'; message: string };

export function encodeAgentSseEvent(event: AgentStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}