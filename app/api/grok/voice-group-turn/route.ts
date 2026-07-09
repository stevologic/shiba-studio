import { NextRequest, NextResponse } from 'next/server';
import { setApiKey, grokChat } from '@/lib/grok-client';
import { parseModelRef } from '@/lib/model-providers';
import { loadAgents, loadConfig } from '@/lib/persistence';
import { normalizeAgent } from '@/lib/types';
import { resolveCloudBearer } from '@/lib/xai-oauth';
import {
  buildVoiceGroupAgentSystem,
  formatVoiceGroupHistory,
  type VoiceGroupHistoryItem,
} from '@/lib/voice-group-chat';
import { textForSpeech } from '@/lib/xai-tts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/grok/voice-group-turn
 * One short in-character agent turn for multi-agent voice group chat.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const cfg = await loadConfig();
    const auth = await resolveCloudBearer(cfg);
    if (auth.token) setApiKey(auth.token);
    if (body.key) setApiKey(body.key);

    const agentId = String(body.agentId || '').trim();
    if (!agentId) {
      return NextResponse.json({ ok: false, error: 'agentId required' }, { status: 400 });
    }

    const agents = (await loadAgents()).map(normalizeAgent);
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) {
      return NextResponse.json({ ok: false, error: 'Agent not found' }, { status: 404 });
    }

    const participantIds: string[] = Array.isArray(body.participantIds)
      ? body.participantIds.map((id: unknown) => String(id))
      : agents.map((a) => a.id);
    const peers = agents
      .filter((a) => participantIds.includes(a.id) && a.id !== agent.id)
      .map((a) => ({ id: a.id, name: a.name }));

    const history = (Array.isArray(body.messages) ? body.messages : []) as VoiceGroupHistoryItem[];
    const continuation = body.continuation === true || body.continuation === 1;
    const formatted = formatVoiceGroupHistory(history, 18);

    if (!formatted.length && !continuation) {
      return NextResponse.json({ ok: false, error: 'No conversation yet' }, { status: 400 });
    }

    const rawModel =
      (typeof body.model === 'string' && body.model.trim())
      || agent.model
      || cfg.defaultGrokModel
      || 'cloud:grok-4';
    const model = parseModelRef(rawModel).encoded;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: buildVoiceGroupAgentSystem(agent, peers, { continuation }),
      },
      ...formatted,
    ];

    if (continuation) {
      messages.push({
        role: 'user',
        content:
          '(Host is quiet for a moment. In one short spoken turn, continue the group discussion in character.)',
      });
    }

    const resp = await grokChat({
      model,
      messages,
      max_tokens: 280,
      temperature: 0.85,
      usageContext: { source: 'chat', sourceId: `voice-group:${agent.id}` },
    });

    let content = resp.choices?.[0]?.message?.content?.trim() || '';
    // Strip accidental "Name:" prefix / markdown for speech
    const nameRe = new RegExp(`^${agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i');
    content = content.replace(nameRe, '').trim();
    content = textForSpeech(content, 600);

    if (!content) {
      return NextResponse.json({ ok: false, error: 'Empty agent reply' }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      content,
      agent: {
        id: agent.id,
        name: agent.name,
        voiceId: agent.voiceId || null,
        avatar: agent.avatar || null,
        model,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Voice group turn failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
