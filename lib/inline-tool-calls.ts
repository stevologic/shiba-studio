// Robustness for small local models (llama.cpp / Ollama / LM Studio): many of
// them don't emit OpenAI-style structured `tool_calls`, they print the call as
// TEXT in the message content. Without this, the runtime treats that JSON blob
// as the final answer, the tool never runs, and the user gets garbage. This
// recovers a structured call from content — but only when the parsed name
// matches a tool the agent actually has, so genuine prose answers that happen
// to contain JSON are never hijacked.

import type { GrokToolCall } from './grok-client';
import { v4 as uuidv4 } from 'uuid';

/** Pull the first balanced {...} JSON object out of arbitrary text. */
function firstJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Normalize the many inline shapes to { name, args }. */
function extractNameAndArgs(obj: unknown): { name: string; args: Record<string, unknown> } | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  // Shapes: {name, arguments|args|parameters}, {tool:{name,args}},
  // {function:{name, arguments}}, {tool_call:{...}}, {action, action_input}.
  const nested =
    (o.tool as Record<string, unknown> | undefined)
    || (o.function as Record<string, unknown> | undefined)
    || (o.tool_call as Record<string, unknown> | undefined)
    || o;

  const rawName = nested.name ?? nested.tool ?? o.action ?? o.name;
  if (typeof rawName !== 'string' || !rawName.trim()) return null;

  let rawArgs: unknown =
    nested.arguments ?? nested.args ?? nested.parameters ?? nested.input ?? o.action_input ?? o.arguments ?? o.args ?? {};
  if (typeof rawArgs === 'string') {
    try { rawArgs = JSON.parse(rawArgs); } catch { rawArgs = { raw: rawArgs }; }
  }
  const args = (rawArgs && typeof rawArgs === 'object') ? rawArgs as Record<string, unknown> : {};
  return { name: rawName.trim(), args };
}

/**
 * Try to recover a structured tool call from assistant CONTENT that carried no
 * structured tool_calls. Returns a synthetic GrokToolCall only when the name
 * matches one of `availableToolNames`; otherwise null (treat content as prose).
 */
export function parseInlineToolCall(
  content: string,
  availableToolNames: Set<string>,
): GrokToolCall | null {
  if (!content || !content.includes('{')) return null;

  // Strip ```json fences and <tool_call> wrappers some models add.
  const cleaned = content
    .replace(/```(?:json|tool_call)?/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .trim();

  const obj = firstJsonObject(cleaned);
  const parsed = extractNameAndArgs(obj);
  if (!parsed) return null;
  if (!availableToolNames.has(parsed.name)) return null;

  return {
    id: `inline_${uuidv4()}`,
    type: 'function',
    function: { name: parsed.name, arguments: JSON.stringify(parsed.args) },
  };
}
