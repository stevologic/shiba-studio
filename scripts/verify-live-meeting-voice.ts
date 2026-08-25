import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-live-meeting-voice-'));
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '77'.repeat(32);

  const persistence = await import('../lib/persistence');
  const oauth = await import('../lib/xai-oauth');
  const grokVoice = await import('../lib/grok-voice');
  const voice = await import('../lib/live-meeting-voice');
  const liveMeetings = await import('../lib/live-meetings');
  const route = await import('../app/api/live-meetings/[id]/voice-session/route');

  try {
    assert.equal(grokVoice.GROK_VOICE_MODEL, 'grok-voice-think-fast-2.0');
    assert.equal(grokVoice.GROK_VOICE_MODEL_ALIAS, 'grok-voice-latest');
    assert.equal(grokVoice.GROK_VOICE_SAMPLE_RATE, 24_000);
    assert.match(grokVoice.grokVoiceRealtimeUrl(), /model=grok-voice-think-fast-2\.0/);
    assert.equal(grokVoice.grokVoiceBrowserProtocol('ek_test'), 'xai-client-secret.ek_test');

    const nested = voice.parseRealtimeClientSecret({
      client_secret: { value: 'ek_nested', expires_at: 1_800_000_000 },
    });
    assert.equal(nested.token, 'ek_nested');
    assert.equal(nested.expiresAt, 1_800_000_000_000);

    const flat = voice.parseRealtimeClientSecret({ value: 'ek_flat', expires_at: 1_900_000_000_000 });
    assert.equal(flat.token, 'ek_flat');
    assert.equal(flat.expiresAt, 1_900_000_000_000);

    assert.throws(
      () => voice.parseRealtimeClientSecret({}),
      /ephemeral voice token/,
    );

    const instructions = voice.buildLiveMeetingVoiceInstructions({
      agentName: 'Review engineer',
      projectName: 'Launch',
      focus: 'auth flow',
    });
    for (const heading of [
      '## Role & Persona',
      '## Objective',
      '## Conversation Flow',
      '## Guardrails & Escalation',
      '## Voice & Communication Style',
      '## CRITICAL INSTRUCTIONS',
    ]) {
      assert(instructions.includes(heading), `voice prompt includes ${heading}`);
    }
    assert(instructions.includes('Review engineer'));
    assert(instructions.includes('auth flow'));
    assert(instructions.includes('force_message'));
    assert.match(instructions, /^## Role & Persona/m);

    const meeting = {
      id: 'mtg-voice',
      title: 'Launch review',
      agentId: 'agent-reviewer',
      agentName: 'Review engineer',
      projectId: null,
      projectName: 'Launch',
      focus: 'auth flow',
      status: 'active' as const,
      turns: [],
      minutes: null,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const keyterms = voice.liveMeetingVoiceKeyterms(meeting);
    assert(keyterms.includes('Board'));
    assert(keyterms.includes('Review engineer'));

    const session = voice.buildLiveMeetingVoiceSessionConfig({
      voice: 'Eve',
      instructions,
      keyterms,
    });
    assert.equal(session.voice, 'eve');
    assert.equal(session.turn_detection.type, 'server_vad');
    assert.equal(session.turn_detection.create_response, false);
    assert.equal(session.audio.input.format.rate, 24_000);
    assert.equal(session.audio.output.format.type, 'audio/pcm');

    await persistence.saveConfig({ xaiApiKey: 'xai-voice-verifier-key', cloudAuthMode: 'api_key' });
    const secretsCalls: string[] = [];
    oauth.setTokenFetcher(async (input, init) => {
      const url = String(input);
      secretsCalls.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer xai-voice-verifier-key');
      assert(!JSON.stringify(init?.body || '').includes('xai-voice-verifier-key'));
      if (url.endsWith('/realtime/client_secrets')) {
        return new Response(JSON.stringify({
          value: 'ek_minted_token',
          expires_at: 1_800_000_000,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected cloud URL ${url}`);
    });

    const minted = await voice.mintLiveMeetingVoiceSession({ meeting, voice: 'ara' });
    assert.equal(minted.model, 'grok-voice-think-fast-2.0');
    assert.equal(minted.token, 'ek_minted_token');
    assert.equal(minted.voice, 'ara');
    assert.match(minted.url, /grok-voice-think-fast-2\.0/);
    assert.equal(secretsCalls.length, 1);

    liveMeetings.ensureLiveMeetingSchema();
    const { getDb } = await import('../lib/db');
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO live_meetings (
        id, title, agentId, agentName, projectId, projectName, focus, status,
        pendingTurn, turns, minutes, brief, workspacePath, version, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'active', 0, '[]', NULL, '', '', 1, ?, ?)
    `).run(meeting.id, meeting.title, meeting.agentId, meeting.agentName, meeting.projectName, meeting.focus, now, now);

    const missing = await route.POST(new Request('http://localhost:3000/api/live-meetings/nope/voice-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }), { params: Promise.resolve({ id: 'nope' }) });
    assert.equal(missing.status, 404);

    const created = await route.POST(new Request('http://localhost:3000/api/live-meetings/mtg-voice/voice-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: 'leo' }),
    }), { params: Promise.resolve({ id: 'mtg-voice' }) });
    assert.equal(created.status, 200);
    const body = await created.json() as {
      ok: boolean;
      available: boolean;
      token: string;
      model: string;
      session: { voice: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.available, true);
    assert.equal(body.token, 'ek_minted_token');
    assert.equal(body.model, 'grok-voice-think-fast-2.0');
    assert.equal(body.session.voice, 'leo');
    assert.equal(JSON.stringify(body).includes('xai-voice-verifier-key'), false, 'voice session never returns the cloud API key');

    oauth.setTokenFetcher(null);
    await persistence.saveConfig({ xaiApiKey: '', cloudAuthMode: 'api_key' });
    const unavailable = await route.GET(new Request('http://localhost:3000/api/live-meetings/mtg-voice/voice-session'), {
      params: Promise.resolve({ id: 'mtg-voice' }),
    });
    const availability = await unavailable.json() as { available: boolean; model: string };
    assert.equal(availability.available, false);
    assert.equal(availability.model, 'grok-voice-think-fast-2.0');

    const panel = await fs.readFile(path.resolve(__dirname, '../components/meetings-panel.tsx'), 'utf8');
    assert(panel.includes('LiveMeetingVoiceClient'));
    assert(panel.includes('force_message') || panel.includes('speak('));
    assert(!panel.includes('Meetings (Beta)'));
    assert(!panel.includes('>Beta</span>'));

    const docs = await fs.readFile(path.resolve(__dirname, '../docs/meetings.md'), 'utf8');
    assert.match(docs, /^# Meetings/m);
    assert(!docs.startsWith('# Meetings (Beta)'));
    assert(docs.includes('grok-voice-think-fast-2.0'));

    console.log('verify-live-meeting-voice: OK');
  } finally {
    oauth.setTokenFetcher(null);
  }
}

main().catch((error) => {
  console.error('verify-live-meeting-voice: FAILED');
  console.error(error);
  process.exit(1);
});
