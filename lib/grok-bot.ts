/**
 * Pairing and auth for the Grok Bot MCP connector.
 * The raw bearer is shown once; only a domain-separated SHA-256 hash is stored.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { audit } from './audit-log';
import { isLoopbackHostname } from './companion-auth';
import { loadConfig, saveConfig } from './persistence';
import { configuredPublicOrigin } from './public-origin';
import type { AppConfig } from './types';
import type { GrokBotPublicStatus, GrokBotSetup } from './grok-bot-types';

export type { GrokBotPublicStatus, GrokBotSetup } from './grok-bot-types';

export const GROK_BOT_TOKEN_PREFIX = 'shiba_grokbot_';
export const GROK_BOT_CHAT_SESSION_ID = 'grok-bot';
export const GROK_BOT_CHAT_TITLE = 'Grok Bot';
export const GROK_BOT_SERVER_LABEL = 'shiba-studio';

const TOKEN_BODY_RE = /^[A-Za-z0-9_-]{32,}$/;
const LAST_USED_MIN_INTERVAL_MS = 60_000;

export class GrokBotError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = 'GrokBotError';
    this.status = status;
  }
}

export interface IssuedGrokBotToken {
  token: string;
  prefix: string;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function tokenHash(token: string): string {
  return createHash('sha256').update(`shiba-grok-bot\0${token}`, 'utf8').digest('hex');
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

export function parseGrokBotBearer(authorization: string | null | undefined): string | null {
  const match = /^Bearer\s+(shiba_grokbot_[A-Za-z0-9_-]{32,})$/i.exec(String(authorization || '').trim());
  return match ? match[1] : null;
}

export function requireLocalGrokBotAdmin(request: Request): void {
  const url = new URL(request.url);
  if (!isLoopbackHostname(url.hostname)) {
    throw new GrokBotError('Grok Bot administration is available only on localhost', 403);
  }
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) throw new Error('not loopback');
    } catch {
      throw new GrokBotError('Grok Bot administration requires a localhost origin', 403);
    }
  }
}

export function publicGrokBotBaseUrl(request?: Request): string {
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

function loopbackMcpUrl(request?: Request): string {
  if (request) {
    try {
      const url = new URL(request.url);
      if (isLoopbackHostname(url.hostname)) {
        return `${url.origin.replace(/\/$/, '')}/api/grok-bot/mcp`;
      }
    } catch { /* fall through */ }
  }
  return 'http://127.0.0.1:3000/api/grok-bot/mcp';
}

function mcpPath(origin: string): string {
  const base = origin.replace(/\/$/, '');
  return base ? `${base}/api/grok-bot/mcp` : '';
}

function publicStatusFromConfig(cfg: AppConfig, request?: Request): GrokBotPublicStatus {
  const grokBot = cfg.grokBot;
  const publicOrigin = publicGrokBotBaseUrl(request);
  return {
    enabled: grokBot?.enabled === true,
    hasToken: !!grokBot?.tokenHash,
    tokenPrefix: grokBot?.tokenPrefix || '',
    createdAt: grokBot?.createdAt || '',
    lastUsedAt: grokBot?.lastUsedAt || '',
    publicOrigin,
    mcpUrl: mcpPath(publicOrigin),
    loopbackMcpUrl: loopbackMcpUrl(request),
    reachableFromXai: /^https:\/\//i.test(publicOrigin),
  };
}

export async function getGrokBotStatus(request?: Request): Promise<GrokBotPublicStatus> {
  return publicStatusFromConfig(await loadConfig(), request);
}

export function buildGrokBotSetup(
  status: GrokBotPublicStatus,
  tokenHint = '<paste the token generated in Settings>',
): GrokBotSetup {
  const desktopUrl = status.loopbackMcpUrl || 'http://127.0.0.1:3000/api/grok-bot/mcp';
  const cloudUrl = status.reachableFromXai ? status.mcpUrl : desktopUrl;
  const authorization = `Bearer ${tokenHint}`;
  return {
    instructions: [
      'You are connected to this operator\'s local Shiba Studio over MCP.',
      'Use studio_status, list_board, list_agents, list_tasks, and list_attention to see work.',
      'Use create_board_card to file a Board ticket and start_work to dispatch a durable Studio task.',
      'Use get_task to read one task. Do not invent results — only report tool output.',
      'Approvals stay in Studio; list_attention tells you when the operator must click Approve.',
    ].join(' '),
    mcp: {
      type: 'mcp',
      server_url: cloudUrl,
      server_label: GROK_BOT_SERVER_LABEL,
      server_description: 'Shiba Studio control plane: board, agents, durable tasks, and attention.',
      authorization,
    },
    plugin: {
      name: 'Shiba Studio',
      url: desktopUrl,
      headers: { Authorization: authorization },
    },
    grokCliCommand: `grok mcp add --transport http shiba-studio ${desktopUrl} --header "Authorization: ${authorization}"`,
    notes: [
      'Grok Bot on this machine: Settings → Plugins → custom MCP. Paste the loopback URL and Authorization header.',
      'Grok Build CLI: run the grok mcp add command (stdio is not required; this connector is Streamable HTTP).',
      'grok.com connectors and xAI Remote MCP tools need an https SHIBA_PUBLIC_ORIGIN; localhost is not reachable from xAI.',
    ],
  };
}

async function writeGrokBot(patch: Partial<NonNullable<AppConfig['grokBot']>>): Promise<AppConfig> {
  const current = await loadConfig();
  const next = {
    ...(current.grokBot || { enabled: false }),
    ...patch,
  };
  return saveConfig({ grokBot: next });
}

export async function setGrokBotEnabled(enabled: boolean): Promise<GrokBotPublicStatus> {
  const cfg = await writeGrokBot({ enabled });
  audit('auth', enabled ? 'grok bot connector enabled' : 'grok bot connector disabled', undefined, { grokBot: enabled });
  return publicStatusFromConfig(cfg);
}

export async function rotateGrokBotToken(): Promise<{ status: GrokBotPublicStatus; issued: IssuedGrokBotToken }> {
  const token = `${GROK_BOT_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  const createdAt = nowIso();
  const prefix = token.slice(0, 20);
  const cfg = await writeGrokBot({
    enabled: true,
    tokenHash: tokenHash(token),
    tokenPrefix: prefix,
    createdAt,
  });
  audit('auth', 'grok bot connector token rotated', prefix);
  return { status: publicStatusFromConfig(cfg), issued: { token, prefix, createdAt } };
}

export async function revokeGrokBotToken(): Promise<GrokBotPublicStatus> {
  const cfg = await writeGrokBot({
    enabled: false,
    tokenHash: '',
    tokenPrefix: '',
    createdAt: '',
  });
  audit('auth', 'grok bot connector token revoked');
  return publicStatusFromConfig(cfg);
}

export async function authenticateGrokBotRequest(request: Request): Promise<{ tokenPrefix: string }> {
  const cfg = await loadConfig();
  const grokBot = cfg.grokBot;
  if (grokBot?.enabled !== true) {
    throw new GrokBotError('Grok Bot connector is disabled. Enable it in Settings.', 403);
  }
  if (!grokBot.tokenHash) {
    throw new GrokBotError('No Grok Bot connector token has been generated.', 401);
  }
  const token = parseGrokBotBearer(request.headers.get('authorization'));
  if (!token || !TOKEN_BODY_RE.test(token.slice(GROK_BOT_TOKEN_PREFIX.length))) {
    throw new GrokBotError('A shiba_grokbot_ bearer token is required.', 401);
  }
  if (!equalHex(tokenHash(token), grokBot.tokenHash)) {
    throw new GrokBotError('Grok Bot connector token is not valid.', 401);
  }
  const last = grokBot.lastUsedAt ? Date.parse(grokBot.lastUsedAt) : 0;
  if (!Number.isFinite(last) || Date.now() - last > LAST_USED_MIN_INTERVAL_MS) {
    void writeGrokBot({ lastUsedAt: nowIso() }).catch(() => {});
  }
  return { tokenPrefix: grokBot.tokenPrefix || token.slice(0, 20) };
}
