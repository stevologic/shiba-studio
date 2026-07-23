/**
 * Normalize transport / provider failures into short chat-safe text.
 * Raw HTML proxy pages, multi-KB JSON dumps, and AbortSignal noise all
 * read as "gibberish" in the bubble — collapse them here.
 */
export function formatUserFacingStreamError(raw: unknown, opts?: { toolsUsed?: string[] }): string {
  const tools = opts?.toolsUsed?.length
    ? ` (tools used: ${[...new Set(opts.toolsUsed)].slice(0, 8).join(', ')})`
    : '';

  let msg = '';
  if (raw instanceof Error) msg = raw.message || raw.name || '';
  else if (typeof raw === 'string') msg = raw;
  else if (raw != null) {
    try {
      msg = JSON.stringify(raw);
    } catch {
      msg = String(raw);
    }
  }

  msg = msg.replace(/\r\n/g, '\n').trim();
  if (!msg) return `I could not finish that reply${tools}. Please try again.`;

  // HTML / proxy error pages (gateway timeouts, nginx 502, etc.)
  if (/<!DOCTYPE\s+html|<html[\s>]|<\/html>/i.test(msg) || /<head[\s>][\s\S]*<body/i.test(msg)) {
    const status = msg.match(/\b(504|502|503|408|500)\b/)?.[1];
    if (status === '504' || status === '408' || /gateway time-?out|timed?\s*out/i.test(msg)) {
      return `The reply timed out before it finished${tools}. Try a shorter ask, or send “continue”.`;
    }
    if (status === '502' || status === '503') {
      return `The model gateway was temporarily unavailable (${status})${tools}. Please try again in a moment.`;
    }
    return `The stream was interrupted by an upstream error page${tools}. Please try again.`;
  }

  // Abort / timeout family (fetch AbortSignal.timeout, DOMException, undici)
  if (
    (raw instanceof Error && (raw.name === 'TimeoutError' || raw.name === 'AbortError'))
    || /timed?\s*out|TimeoutError|aborted due to timeout|The operation was aborted|deadline|ETIMEDOUT/i.test(msg)
  ) {
    // User-initiated stop should not look like a failure dump.
    if (/cancelled by the user|Run cancelled|The user aborted a request|request was aborted/i.test(msg)
      && !/timeout/i.test(msg)) {
      return '';
    }
    return `The model call timed out before finishing${tools}. I stopped cleanly — send “continue” or try again with a narrower ask.`;
  }

  // Strip obvious JSON/API dumps to a short lead-in
  if (msg.length > 280 || (msg.startsWith('{') && msg.includes('"error"'))) {
    const statusMatch = msg.match(/\b(?:error|status)\s*[:\s]*(\d{3})\b/i)
      || msg.match(/\b([45]\d{2})\b/);
    const status = statusMatch?.[1];
    const lead = msg
      .replace(/\{[\s\S]*$/, '')
      .replace(/\n+/g, ' ')
      .trim()
      .slice(0, 160);
    if (status && /^(?:4|5)\d{2}$/.test(status)) {
      return `${lead || 'Model request failed'} (HTTP ${status})${tools}.`.replace(/\s+/g, ' ').trim();
    }
    const compact = (lead || msg.slice(0, 160)).replace(/\s+/g, ' ').trim();
    return `${compact}${msg.length > compact.length ? '…' : ''}${tools}`;
  }

  if (msg.length > 320) {
    return `${msg.slice(0, 300).trim()}…${tools}`;
  }

  return tools ? `${msg}${tools}` : msg;
}

export function isAbortLikeError(raw: unknown): boolean {
  if (raw instanceof Error && (raw.name === 'AbortError' || raw.name === 'TimeoutError')) return true;
  const msg = raw instanceof Error ? raw.message : String(raw || '');
  return /The operation was aborted|The user aborted a request|request was aborted|Run cancelled/i.test(msg)
    && !/timeout/i.test(msg);
}
