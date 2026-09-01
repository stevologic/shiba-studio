/**
 * Gmail payload parsing and address validation. API calls live in
 * integrations.ts so they can use request-scoped credentials.
 */
import { clipForModel } from './prompt-hygiene';

const BODY_CAP = 12_000;
const GMAIL_ID_RE = /^[a-zA-Z0-9_-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface GmailListItem {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface GmailMessage extends GmailListItem {
  cc?: string;
  body: string;
}

type GmailPart = {
  mimeType?: string | null;
  filename?: string | null;
  body?: { data?: string | null; size?: number | null } | null;
  parts?: GmailPart[] | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
};

function header(headers: Array<{ name?: string | null; value?: string | null }> | null | undefined, name: string): string {
  const needle = name.toLowerCase();
  return (headers || []).find((h) => (h.name || '').toLowerCase() === needle)?.value?.trim() || '';
}

function decodeB64Url(data?: string | null): string {
  if (!data) return '';
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function collectBodies(part: GmailPart | null | undefined, into: { plain: string; html: string }): void {
  if (!part) return;
  const mime = (part.mimeType || '').toLowerCase();
  const data = decodeB64Url(part.body?.data);
  if (data && mime === 'text/plain') into.plain += (into.plain ? '\n' : '') + data;
  if (data && mime === 'text/html') into.html += (into.html ? '\n' : '') + data;
  for (const child of part.parts || []) collectBodies(child, into);
}

export function parseGmailPayload(payload: GmailPart | null | undefined, meta?: {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[] | null;
}): GmailMessage {
  const headers = payload?.headers || [];
  const bodies = { plain: '', html: '' };
  collectBodies(payload, bodies);
  const body = clipForModel(bodies.plain.trim() || stripHtml(bodies.html), BODY_CAP);
  return {
    id: meta?.id || '',
    threadId: meta?.threadId || '',
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    cc: header(headers, 'Cc') || undefined,
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    snippet: (meta?.snippet || '').trim(),
    unread: (meta?.labelIds || []).includes('UNREAD'),
    body,
  };
}

export function assertGmailMessageId(id: string): string {
  const value = String(id || '').trim();
  if (!GMAIL_ID_RE.test(value) || value.length > 128) {
    throw new Error('Invalid Gmail message id');
  }
  return value;
}

export function parseEmailList(raw: string): string[] {
  const parts = String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  for (const addr of parts) {
    const email = addr.includes('<') ? (addr.match(/<([^>]+)>/)?.[1] || addr) : addr;
    if (!EMAIL_RE.test(email) || /[\r\n]/.test(addr) || addr.length > 320) {
      throw new Error(`Invalid email address: ${addr.slice(0, 80)}`);
    }
  }
  return parts;
}

function encodeRfc2822(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const subject = String(input.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  const body = String(input.body || '').replace(/\r?\n/g, '\r\n').slice(0, 100_000);
  const lines = [
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(', ')}`] : []),
    `Subject: ${subject}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo.replace(/[\r\n]/g, '')}`] : []),
    ...(input.references ? [`References: ${input.references.replace(/[\r\n]/g, '')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

export function encodeGmailRfc2822(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  return encodeRfc2822(input);
}

export function gmailHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | null | undefined,
  name: string,
): string {
  return header(headers, name);
}
