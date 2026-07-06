let interAgentBus: Array<{ to: string; from: string; msg: string; ts: string }> = [];

export function postToAgentInbox(toAgentId: string, fromAgentId: string, message: string) {
  interAgentBus.push({ to: toAgentId, from: fromAgentId, msg: message, ts: new Date().toISOString() });
  if (interAgentBus.length > 80) interAgentBus.shift();
}

export function drainInbox(agentId: string): string[] {
  const mine = interAgentBus.filter((m) => m.to === agentId);
  interAgentBus = interAgentBus.filter((m) => m.to !== agentId);
  return mine.map((m) => `[peer ${m.from} @ ${m.ts}] ${m.msg}`);
}