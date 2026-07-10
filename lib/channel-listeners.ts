/**
 * Real-time channel listeners for Slack (@mention via Socket Mode) and
 * Discord (@mention via Gateway). Runs in the Next.js Node process
 * (instrumentation + config save hooks). On mention, routes a prompt to a
 * studio agent and posts the final answer back into the channel/thread.
 */

import WebSocket from 'ws';
import type { Agent, IntegrationCreds } from './types';
import { normalizeAgent } from './types';

export type ListenerPlatform = 'slack' | 'discord';

export interface ListenerStatus {
  platform: ListenerPlatform;
  running: boolean;
  enabled: boolean;
  detail?: string;
  lastEventAt?: string;
  lastError?: string;
  botUserId?: string;
  botName?: string;
}

interface ChannelListenersGlobals {
  __shibaChannelListeners?: {
    slack?: SlackSocketListener | null;
    discord?: DiscordGatewayListener | null;
    statuses: Record<ListenerPlatform, ListenerStatus>;
    recentEventIds: Map<string, number>;
  };
}

const g = globalThis as unknown as ChannelListenersGlobals;

function store() {
  if (!g.__shibaChannelListeners) {
    g.__shibaChannelListeners = {
      slack: null,
      discord: null,
      statuses: {
        slack: { platform: 'slack', running: false, enabled: false },
        discord: { platform: 'discord', running: false, enabled: false },
      },
      recentEventIds: new Map(),
    };
  }
  return g.__shibaChannelListeners;
}

function setStatus(platform: ListenerPlatform, patch: Partial<ListenerStatus>) {
  const s = store();
  s.statuses[platform] = { ...s.statuses[platform], platform, ...patch };
}

/** Drop duplicate Slack/Discord event deliveries within a short window. */
function claimEvent(id: string): boolean {
  const s = store();
  const now = Date.now();
  // Prune old entries
  for (const [k, t] of s.recentEventIds) {
    if (now - t > 10 * 60_000) s.recentEventIds.delete(k);
  }
  if (s.recentEventIds.has(id)) return false;
  s.recentEventIds.set(id, now);
  return true;
}

async function loadLiveCreds(): Promise<IntegrationCreds> {
  const { loadConfig } = await import('./persistence');
  const { setIntegrationCreds } = await import('./integrations');
  const cfg = await loadConfig();
  const creds = cfg.integrations || {};
  setIntegrationCreds(creds);
  return creds;
}

async function resolveMentionAgent(
  platform: ListenerPlatform,
  mentionAgentId?: string,
): Promise<Agent | null> {
  const { loadAgents } = await import('./persistence');
  const agents = (await loadAgents()).map(normalizeAgent);
  if (!agents.length) return null;
  if (mentionAgentId?.trim()) {
    const hit = agents.find((a) => a.id === mentionAgentId.trim() || a.name === mentionAgentId.trim());
    if (hit) return hit;
  }
  const scoped = agents.find((a) => {
    const integ = a.integrations;
    if (!integ) return false;
    return platform === 'slack' ? !!integ.slack : !!integ.discord;
  });
  if (scoped) return scoped;
  // Prefer a local agent for tool access when nothing is scoped.
  return agents.find((a) => (a.origin || 'local') === 'local') || agents[0] || null;
}

function stripBotMention(text: string, botUserId?: string): string {
  let t = text || '';
  if (botUserId) {
    t = t.replace(new RegExp(`<@!?${botUserId}>`, 'g'), ' ');
  }
  // Slack / Discord generic mention leftovers
  t = t.replace(/<@!?[A-Z0-9]+>/gi, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

async function runAgentReply(opts: {
  platform: ListenerPlatform;
  agent: Agent;
  userText: string;
  channelLabel: string;
  authorLabel: string;
}): Promise<string> {
  const { runAgentOnce } = await import('./agent-runtime');
  const { audit } = await import('./audit-log');
  const prompt = [
    `You were @mentioned on ${opts.platform === 'slack' ? 'Slack' : 'Discord'} and should reply helpfully in character.`,
    `Channel: ${opts.channelLabel}`,
    `From: ${opts.authorLabel}`,
    '',
    'Message:',
    opts.userText || '(empty mention)',
    '',
    'Write a concise reply suitable for a chat channel. Do not wrap the answer in quotes. Avoid markdown headings unless useful. Keep it under ~1500 characters when possible.',
  ].join('\n');

  audit(
    'integration',
    `${opts.platform} mention → agent`,
    `${opts.agent.name}: ${opts.userText.slice(0, 120)}`,
    { agentId: opts.agent.id },
  );

  const run = await runAgentOnce(opts.agent, prompt, {
    scheduled: true,
    scheduleInstructions: `${opts.platform} @mention from ${opts.authorLabel}`,
  });

  const out = (run.finalOutput || '').trim();
  if (!out) {
    if (run.status === 'error') {
      return `Sorry — I hit an error handling that mention (${run.trace?.find((t) => t.type === 'error')?.content?.slice(0, 200) || 'unknown'}).`;
    }
    return 'I received your mention but had nothing to say.';
  }
  // Channel limits: Discord 2000, Slack soft ~4000 — keep a safe shared cap.
  return out.length > 1900 ? `${out.slice(0, 1890)}…` : out;
}

// ── Slack Socket Mode ───────────────────────────────────────────────────────

class SlackSocketListener {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private botUserId: string | null = null;
  private botName: string | null = null;

  constructor(
    private botToken: string,
    private appToken: string,
    private mentionAgentId?: string,
  ) {}

  async start() {
    this.stopped = false;
    setStatus('slack', { enabled: true, running: false, detail: 'Connecting…', lastError: undefined });
    try {
      await this.resolveBotIdentity();
      await this.connect();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Slack listen failed';
      setStatus('slack', { running: false, enabled: true, lastError: msg, detail: 'Failed to connect' });
      this.scheduleReconnect();
    }
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
    setStatus('slack', { running: false, enabled: false, detail: 'Stopped' });
  }

  private async resolveBotIdentity() {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Slack auth.test failed');
    this.botUserId = data.user_id || null;
    this.botName = data.user || data.team || null;
    setStatus('slack', {
      botUserId: this.botUserId || undefined,
      botName: this.botName || undefined,
    });
  }

  private async connect() {
    if (this.stopped) return;
    const res = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });
    const data = await res.json();
    if (!data.ok || !data.url) {
      throw new Error(
        data.error === 'invalid_auth'
          ? 'Invalid Slack app-level token (need xapp-… with connections:write for Socket Mode)'
          : (data.error || 'apps.connections.open failed — enable Socket Mode on your Slack app'),
      );
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(data.url as string);
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        setStatus('slack', {
          running: true,
          enabled: true,
          detail: this.botName ? `Listening as @${this.botName}` : 'Listening for @mentions',
          lastError: undefined,
        });
        if (!settled) { settled = true; resolve(); }
      });

      ws.on('message', (raw) => {
        void this.onMessage(String(raw));
      });

      ws.on('error', (err) => {
        setStatus('slack', { lastError: err.message, running: false });
        if (!settled) { settled = true; reject(err); }
      });

      ws.on('close', () => {
        this.ws = null;
        setStatus('slack', { running: false, detail: this.stopped ? 'Stopped' : 'Disconnected — reconnecting…' });
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((e) => {
        setStatus('slack', { lastError: e instanceof Error ? e.message : 'reconnect failed' });
        this.scheduleReconnect();
      });
    }, 5_000);
  }

  private async onMessage(raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Socket Mode envelopes must be acknowledged.
    if (typeof msg.envelope_id === 'string' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    }

    if (msg.type === 'hello') return;

    if (msg.type === 'disconnect') {
      try { this.ws?.close(); } catch { /* */ }
      return;
    }

    if (msg.type !== 'events_api') return;
    const payload = msg.payload as Record<string, unknown> | undefined;
    const event = payload?.event as Record<string, unknown> | undefined;
    if (!event || event.type !== 'app_mention') return;
    if (event.bot_id || event.subtype === 'bot_message') return;

    const eventId = String(payload?.event_id || event.client_msg_id || event.ts || '');
    if (eventId && !claimEvent(`slack:${eventId}`)) return;

    const channel = String(event.channel || '');
    const user = String(event.user || 'someone');
    const text = stripBotMention(String(event.text || ''), this.botUserId || undefined);
    const threadTs = String(event.thread_ts || event.ts || '');

    setStatus('slack', { lastEventAt: new Date().toISOString() });

    try {
      const agent = await resolveMentionAgent('slack', this.mentionAgentId);
      if (!agent) {
        await this.post(channel, 'No Shiba agent is available to answer yet — create one in the studio.', threadTs);
        return;
      }
      const reply = await runAgentReply({
        platform: 'slack',
        agent,
        userText: text,
        channelLabel: channel,
        authorLabel: user,
      });
      await this.post(channel, reply, threadTs);
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : 'mention handler failed';
      setStatus('slack', { lastError: err });
      try {
        await this.post(channel, `Sorry — failed to handle that mention: ${err.slice(0, 200)}`, threadTs);
      } catch { /* */ }
    }
  }

  private async post(channel: string, text: string, threadTs?: string) {
    const body: Record<string, string> = {
      channel,
      text: text.slice(0, 3900),
    };
    if (threadTs) body.thread_ts = threadTs;
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'chat.postMessage failed');
  }
}

// ── Discord Gateway ─────────────────────────────────────────────────────────

/** GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT | DIRECT_MESSAGES */
const DISCORD_INTENTS = 1 | 512 | 32768 | 4096;
const DISCORD_API = 'https://discord.com/api/v10';

class DiscordGatewayListener {
  private ws: WebSocket | null = null;
  private stopped = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private botUserId: string | null = null;
  private botName: string | null = null;
  private resumeUrl: string | null = null;

  constructor(
    private token: string,
    private mentionAgentId?: string,
  ) {}

  private authHeader() {
    const t = this.token.trim().replace(/^Bot\s+/i, '');
    return { Authorization: `Bot ${t}`, 'Content-Type': 'application/json' };
  }

  async start() {
    this.stopped = false;
    setStatus('discord', { enabled: true, running: false, detail: 'Connecting…', lastError: undefined });
    try {
      await this.resolveBotIdentity();
      await this.connect();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Discord listen failed';
      setStatus('discord', { running: false, enabled: true, lastError: msg, detail: 'Failed to connect' });
      this.scheduleReconnect();
    }
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
    setStatus('discord', { running: false, enabled: false, detail: 'Stopped' });
  }

  private async resolveBotIdentity() {
    const res = await fetch(`${DISCORD_API}/users/@me`, { headers: this.authHeader() });
    if (!res.ok) throw new Error(`Discord auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    this.botUserId = data.id || null;
    this.botName = data.username || null;
    setStatus('discord', {
      botUserId: this.botUserId || undefined,
      botName: this.botName || undefined,
    });
  }

  private async connect() {
    if (this.stopped) return;
    const res = await fetch(`${DISCORD_API}/gateway/bot`, { headers: this.authHeader() });
    if (!res.ok) throw new Error(`Discord gateway/bot ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const url = `${String(data.url).replace(/\/$/, '')}/?v=10&encoding=json`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        /* wait for HELLO */
      });

      ws.on('message', (raw) => {
        void this.onMessage(String(raw), () => {
          if (!settled) { settled = true; resolve(); }
        });
      });

      ws.on('error', (err) => {
        setStatus('discord', { lastError: err.message, running: false });
        if (!settled) { settled = true; reject(err); }
      });

      ws.on('close', () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.ws = null;
        setStatus('discord', { running: false, detail: this.stopped ? 'Stopped' : 'Disconnected — reconnecting…' });
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((e) => {
        setStatus('discord', { lastError: e instanceof Error ? e.message : 'reconnect failed' });
        this.scheduleReconnect();
      });
    }, 5_000);
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private startHeartbeat(ms: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: 1, d: this.sequence });
    }, ms);
  }

  private async onMessage(raw: string, onReady?: () => void) {
    let msg: { op: number; d?: unknown; s?: number | null; t?: string | null };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.s === 'number') this.sequence = msg.s;

    // Hello
    if (msg.op === 10) {
      const d = msg.d as { heartbeat_interval: number };
      this.startHeartbeat(d.heartbeat_interval);
      if (this.sessionId && this.resumeUrl) {
        this.send({
          op: 6,
          d: {
            token: this.token.trim().replace(/^Bot\s+/i, ''),
            session_id: this.sessionId,
            seq: this.sequence,
          },
        });
      } else {
        this.send({
          op: 2,
          d: {
            token: this.token.trim().replace(/^Bot\s+/i, ''),
            intents: DISCORD_INTENTS,
            properties: {
              os: process.platform,
              browser: 'shiba-studio',
              device: 'shiba-studio',
            },
          },
        });
      }
      return;
    }

    // Heartbeat ACK
    if (msg.op === 11) return;

    // Reconnect / invalid session
    if (msg.op === 7) {
      try { this.ws?.close(); } catch { /* */ }
      return;
    }
    if (msg.op === 9) {
      this.sessionId = null;
      try { this.ws?.close(); } catch { /* */ }
      return;
    }

    // Dispatch
    if (msg.op !== 0) return;
    const t = msg.t;
    const d = msg.d as Record<string, unknown>;

    if (t === 'READY') {
      this.sessionId = String(d.session_id || '');
      const user = d.user as { id?: string; username?: string } | undefined;
      if (user?.id) this.botUserId = user.id;
      if (user?.username) this.botName = user.username;
      setStatus('discord', {
        running: true,
        enabled: true,
        detail: this.botName ? `Listening as @${this.botName}` : 'Listening for @mentions',
        botUserId: this.botUserId || undefined,
        botName: this.botName || undefined,
        lastError: undefined,
      });
      onReady?.();
      return;
    }

    if (t === 'RESUMED') {
      setStatus('discord', { running: true, enabled: true, detail: 'Resumed gateway session' });
      onReady?.();
      return;
    }

    if (t !== 'MESSAGE_CREATE') return;
    if (d.author && (d.author as { bot?: boolean }).bot) return;
    if (!this.botUserId) return;

    const mentions = (d.mentions as Array<{ id: string }> | undefined) || [];
    const content = String(d.content || '');
    const mentioned =
      mentions.some((m) => m.id === this.botUserId)
      || content.includes(`<@${this.botUserId}>`)
      || content.includes(`<@!${this.botUserId}>`);
    if (!mentioned) return;

    const messageId = String(d.id || '');
    if (messageId && !claimEvent(`discord:${messageId}`)) return;

    const channelId = String(d.channel_id || '');
    const author = d.author as { id?: string; username?: string; global_name?: string } | undefined;
    const authorLabel = author?.global_name || author?.username || author?.id || 'someone';
    const text = stripBotMention(content, this.botUserId);

    setStatus('discord', { lastEventAt: new Date().toISOString() });

    try {
      // Typing indicator (best-effort)
      void fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
        method: 'POST',
        headers: this.authHeader(),
      }).catch(() => {});

      const agent = await resolveMentionAgent('discord', this.mentionAgentId);
      if (!agent) {
        await this.post(channelId, 'No Shiba agent is available to answer yet — create one in the studio.', messageId);
        return;
      }
      const reply = await runAgentReply({
        platform: 'discord',
        agent,
        userText: text,
        channelLabel: channelId,
        authorLabel,
      });
      await this.post(channelId, reply, messageId);
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : 'mention handler failed';
      setStatus('discord', { lastError: err });
      try {
        await this.post(channelId, `Sorry — failed to handle that mention: ${err.slice(0, 200)}`, messageId);
      } catch { /* */ }
    }
  }

  private async post(channelId: string, content: string, replyToMessageId?: string) {
    const body: Record<string, unknown> = {
      content: content.slice(0, 2000),
    };
    if (replyToMessageId) {
      body.message_reference = {
        message_id: replyToMessageId,
        fail_if_not_exists: false,
      };
    }
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: this.authHeader(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Discord post ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getChannelListenerStatuses(): Record<ListenerPlatform, ListenerStatus> {
  const s = store().statuses;
  return {
    slack: { ...s.slack },
    discord: { ...s.discord },
  };
}

export async function stopChannelListeners() {
  const s = store();
  s.slack?.stop();
  s.discord?.stop();
  s.slack = null;
  s.discord = null;
}

/**
 * Start or restart listeners from current encrypted config.
 * Safe to call repeatedly (e.g. after saving credentials).
 */
export async function syncChannelListeners(): Promise<Record<ListenerPlatform, ListenerStatus>> {
  const creds = await loadLiveCreds();
  const s = store();

  // Slack
  const slack = creds.slack;
  const slackWant =
    !!slack?.listenEnabled
    && !!slack?.token?.trim()
    && !!slack?.appToken?.trim();
  if (!slackWant) {
    s.slack?.stop();
    s.slack = null;
    setStatus('slack', {
      running: false,
      enabled: !!slack?.listenEnabled,
      detail: slack?.listenEnabled
        ? (!slack?.appToken?.trim()
          ? 'Needs app-level token (xapp-…) for Socket Mode'
          : !slack?.token?.trim()
            ? 'Needs bot token'
            : 'Stopped')
        : 'Listening off',
    });
  } else {
    s.slack?.stop();
    const listener = new SlackSocketListener(
      slack!.token!.trim(),
      slack!.appToken!.trim(),
      slack!.mentionAgentId,
    );
    s.slack = listener;
    void listener.start();
  }

  // Discord
  const discord = creds.discord;
  const discordWant = !!discord?.listenEnabled && !!discord?.token?.trim();
  if (!discordWant) {
    s.discord?.stop();
    s.discord = null;
    setStatus('discord', {
      running: false,
      enabled: !!discord?.listenEnabled,
      detail: discord?.listenEnabled
        ? (!discord?.token?.trim() ? 'Needs bot token' : 'Stopped')
        : 'Listening off',
    });
  } else {
    s.discord?.stop();
    const listener = new DiscordGatewayListener(
      discord!.token!.trim(),
      discord!.mentionAgentId,
    );
    s.discord = listener;
    void listener.start();
  }

  return getChannelListenerStatuses();
}
