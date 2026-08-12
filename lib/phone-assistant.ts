/**
 * Pairing and auth for the Grok phone-number assistant.
 * The raw bearer is shown once; only a domain-separated SHA-256 hash is stored.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { audit } from './audit-log';
import { isLoopbackHostname } from './companion-auth';
import { loadConfig, saveConfig } from './persistence';
import { configuredPublicOrigin } from './public-origin';
import type { AppConfig } from './types';
import type { PhoneAssistantPublicStatus, PhoneAssistantSetup } from './phone-assistant-types';

export type { PhoneAssistantPublicStatus, PhoneAssistantSetup } from './phone-assistant-types';

export const PHONE_TOKEN_PREFIX = 'shiba_phone_';
export const PHONE_CHAT_SESSION_ID = 'phone-assistant';
export const PHONE_CHAT_TITLE = 'Phone assistant';

const TOKEN_BODY_RE = /^[A-Za-z0-9_-]{32,}$/;
const LAST_USED_MIN_INTERVAL_MS = 60_000;

export class PhoneAssistantError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = 'PhoneAssistantError';
    this.status = status;
  }
}

export interface IssuedPhoneToken {
  token: string;
  prefix: string;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function tokenHash(token: string): string {
  return createHash('sha256').update(`shiba-phone-assistant\0${token}`, 'utf8').digest('hex');
}

function equalHex(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function parsePhoneBearer(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(shiba_phone_[A-Za-z0-9_-]{32,})$/i.exec(String(authorization || '').trim());
  return match ? match[1] : null;
}

export function requireLocalPhoneAdmin(request: Request): void {
  const url = new URL(request.url);
  if (!isLoopbackHostname(url.hostname)) {
    throw new PhoneAssistantError('Phone assistant administration is available only on localhost', 403);
  }
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) throw new Error('not loopback');
    } catch {
      throw new PhoneAssistantError('Phone assistant administration requires a localhost origin', 403);
    }
  }
}

export function publicPhoneBaseUrl(request?: Request): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured.origin;
  if (request) {
    try {
      const url = new URL(request.url);
      if (isLoopbackHostname(url.hostname)) return url.origin;
    } catch { /* fall through */ }
  }
  return '';
}

function phonePaths(base: string): Pick<PhoneAssistantPublicStatus, 'mcpUrl' | 'commandUrl' | 'incomingUrl'> {
  const origin = base.replace(/\/$/, '');
  return {
    mcpUrl: origin ? `${origin}/api/phone/mcp` : '',
    commandUrl: origin ? `${origin}/api/phone/command` : '',
    incomingUrl: origin ? `${origin}/api/phone/incoming` : '',
  };
}

function publicStatusFromConfig(cfg: AppConfig, request?: Request): PhoneAssistantPublicStatus {
  const phone = cfg.phoneAssistant;
  const publicOrigin = publicPhoneBaseUrl(request);
  return {
    enabled: phone?.enabled === true,
    hasToken: !!phone?.tokenHash,
    tokenPrefix: phone?.tokenPrefix || '',
    createdAt: phone?.createdAt || '',
    lastUsedAt: phone?.lastUsedAt || '',
    phoneNumber: phone?.phoneNumber || '',
    hasWebhookSecret: !!phone?.webhookSecret?.trim(),
    allowedCallers: Array.isArray(phone?.allowedCallers) ? phone.allowedCallers.filter(Boolean) : [],
    publicOrigin,
    ...phonePaths(publicOrigin),
    voiceBuilderUrl: 'https://console.x.ai',
    reachableFromXai: /^https:\/\//i.test(publicOrigin),
  };
}

export async function getPhoneAssistantStatus(request?: Request): Promise<PhoneAssistantPublicStatus> {
  return publicStatusFromConfig(await loadConfig(), request);
}

export function buildPhoneAssistantSetup(status: PhoneAssistantPublicStatus, tokenHint = '<paste the token generated in Settings>'): PhoneAssistantSetup {
  const mcpUrl = status.mcpUrl || 'https://YOUR-PUBLIC-ORIGIN/api/phone/mcp';
  return {
    instructions: [
      'You are the Shiba Studio phone assistant. The caller is the studio owner.',
      'When they dictate work, call dictate_command with their exact request.',
      'Use create_task for a Board card, start_work for a longer agent job, list_board to read the board, and git or memory tools when they ask.',
      'Confirm what you did in one short spoken sentence. Do not invent results — only report the tool output.',
    ].join(' '),
    mcp: {
      type: 'mcp',
      server_url: mcpUrl,
      server_label: 'shiba-studio',
      server_description: 'Shiba Studio spoken commands: board, git, memory, search, and durable work.',
      authorization: `Bearer ${tokenHint}`,
    },
    functionTool: {
      type: 'function',
      name: 'dictate_command',
      description: 'Execute a spoken Shiba Studio command (slash command or natural language).',
      parameters: {
        type: 'object',
        properties: {
          utterance: { type: 'string', description: 'Exactly what the caller asked Shiba to do.' },
        },
        required: ['utterance'],
      },
    },
  };
}

async function writePhoneAssistant(patch: Partial<NonNullable<AppConfig['phoneAssistant']>>): Promise<AppConfig> {
  const current = await loadConfig();
  const next = {
    ...(current.phoneAssistant || { enabled: false }),
    ...patch,
  };
  return saveConfig({ phoneAssistant: next });
}

export async function setPhoneAssistantEnabled(enabled: boolean): Promise<PhoneAssistantPublicStatus> {
  const cfg = await writePhoneAssistant({ enabled });
  audit('auth', enabled ? 'phone assistant enabled' : 'phone assistant disabled', undefined, { phoneAssistant: enabled });
  return publicStatusFromConfig(cfg);
}

export async function updatePhoneAssistantSettings(input: {
  phoneNumber?: string;
  webhookSecret?: string;
  allowedCallers?: string[];
}): Promise<PhoneAssistantPublicStatus> {
  const patch: NonNullable<AppConfig['phoneAssistant']> = { enabled: (await loadConfig()).phoneAssistant?.enabled === true };
  if (input.phoneNumber !== undefined) {
    const value = String(input.phoneNumber || '').trim();
    if (value && !/^\+?[0-9().\-\s]{7,20}$/.test(value)) {
      throw new PhoneAssistantError('Phone number must be a short E.164-style value', 400);
    }
    patch.phoneNumber = value;
  }
  if (input.webhookSecret !== undefined) {
    patch.webhookSecret = String(input.webhookSecret || '').trim();
  }
  if (input.allowedCallers !== undefined) {
    if (!Array.isArray(input.allowedCallers)) {
      throw new PhoneAssistantError('allowedCallers must be an array of phone numbers', 400);
    }
    patch.allowedCallers = input.allowedCallers.map((value) => String(value || '').trim()).filter(Boolean);
  }
  const cfg = await writePhoneAssistant(patch);
  audit('config', 'phone assistant settings updated', Object.keys(input).join(', '));
  return publicStatusFromConfig(cfg);
}

export async function rotatePhoneToken(): Promise<{ status: PhoneAssistantPublicStatus; issued: IssuedPhoneToken }> {
  const token = `${PHONE_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  const createdAt = nowIso();
  const prefix = token.slice(0, 18);
  const cfg = await writePhoneAssistant({
    enabled: true,
    tokenHash: tokenHash(token),
    tokenPrefix: prefix,
    createdAt,
  });
  audit('auth', 'phone assistant token rotated', prefix);
  return { status: publicStatusFromConfig(cfg), issued: { token, prefix, createdAt } };
}

export async function revokePhoneToken(): Promise<PhoneAssistantPublicStatus> {
  const cfg = await writePhoneAssistant({
    enabled: false,
    tokenHash: '',
    tokenPrefix: '',
    createdAt: '',
  });
  audit('auth', 'phone assistant token revoked');
  return publicStatusFromConfig(cfg);
}

export async function authenticatePhoneRequest(request: Request): Promise<{ tokenPrefix: string }> {
  const cfg = await loadConfig();
  const phone = cfg.phoneAssistant;
  if (phone?.enabled !== true) {
    throw new PhoneAssistantError('Phone assistant is disabled. Enable it in Settings.', 403);
  }
  if (!phone.tokenHash) {
    throw new PhoneAssistantError('No phone assistant token has been generated.', 401);
  }
  const token = parsePhoneBearer(request.headers.get('authorization'));
  if (!token || !TOKEN_BODY_RE.test(token.slice(PHONE_TOKEN_PREFIX.length))) {
    throw new PhoneAssistantError('A shiba_phone_ bearer token is required.', 401);
  }
  if (!equalHex(tokenHash(token), phone.tokenHash)) {
    throw new PhoneAssistantError('Phone assistant token is not valid.', 401);
  }
  const last = phone.lastUsedAt ? Date.parse(phone.lastUsedAt) : 0;
  if (!Number.isFinite(last) || Date.now() - last > LAST_USED_MIN_INTERVAL_MS) {
    void writePhoneAssistant({ lastUsedAt: nowIso() }).catch(() => {});
  }
  return { tokenPrefix: phone.tokenPrefix || token.slice(0, 18) };
}

/** Standard Webhooks (webhook-id / webhook-timestamp / webhook-signature). */
export function verifyStandardWebhookSignature(input: {
  secret: string;
  id: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  nowMs?: number;
}): void {
  const secret = input.secret.trim();
  if (!secret) throw new PhoneAssistantError('Incoming-call webhook secret is not configured', 401);
  const id = String(input.id || '').trim();
  const timestamp = String(input.timestamp || '').trim();
  const signatureHeader = String(input.signature || '').trim();
  if (!id || !timestamp || !signatureHeader) {
    throw new PhoneAssistantError('Missing webhook signature headers', 401);
  }
  const ts = Number(timestamp);
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) {
    throw new PhoneAssistantError('Webhook timestamp is stale or invalid', 401);
  }
  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
  const signed = `${id}.${timestamp}.${input.rawBody}`;
  const expected = createHmac('sha256', secretBytes).update(signed).digest('base64');
  const candidates = signatureHeader.split(/\s+/).flatMap((part) => {
    const [, value] = part.split(',', 2);
    return value ? [value] : [part];
  });
  const matched = candidates.some((candidate) => {
    try {
      const left = Buffer.from(candidate);
      const right = Buffer.from(expected);
      return left.length === right.length && timingSafeEqual(left, right);
    } catch {
      return false;
    }
  });
  if (!matched) throw new PhoneAssistantError('Webhook signature is not valid', 401);
}

export async function loadPhoneWebhookSecret(): Promise<string> {
  return String((await loadConfig()).phoneAssistant?.webhookSecret || '').trim();
}

export function normalizePhoneNumber(value: string): string {
  return String(value || '').replace(/[^\d+]/g, '');
}

export function callerAllowed(fromHeader: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const incoming = normalizePhoneNumber(fromHeader);
  if (!incoming) return false;
  return allowed.some((entry) => {
    const allowedNumber = normalizePhoneNumber(entry);
    return !!allowedNumber && (incoming.endsWith(allowedNumber.replace(/^\+/, '')) || allowedNumber.endsWith(incoming.replace(/^\+/, '')));
  });
}
