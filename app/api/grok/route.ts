import { NextRequest, NextResponse } from 'next/server';
import { grokChat, setApiKey, validateApiKey } from '@/lib/grok-client';
import { parseModelRef } from '@/lib/model-providers';
import { loadConfig, saveConfig } from '@/lib/persistence';
import { resolveCloudBearer } from '@/lib/xai-oauth';

export async function POST(req: NextRequest) {
  const { action, ...body } = await req.json();

  if (action === 'validate') {
    const key = body.key;
    const res = await validateApiKey(key);
    if (res.ok && key) {
      await saveConfig({ xaiApiKey: key });
    }
    return NextResponse.json(res);
  }

  if (action === 'chat') {
    const cfg = await loadConfig();
    const auth = await resolveCloudBearer(cfg);
    if (auth.token) setApiKey(auth.token);
    if (body.key) setApiKey(body.key);
    const rawModel = (body.model && String(body.model).trim()) || cfg.defaultGrokModel || 'cloud:grok-4';
    const model = parseModelRef(rawModel).encoded;
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    if (body.system) messages.push({ role: 'system', content: String(body.system) });
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      for (const m of body.messages) {
        if (!m?.content || !m?.role) continue;
        if (m.role === 'user' || m.role === 'assistant' || m.role === 'system') {
          messages.push({ role: m.role, content: String(m.content) });
        }
      }
    } else if (body.prompt) {
      messages.push({ role: 'user', content: String(body.prompt) });
    }
    if (messages.length === 0) {
      return NextResponse.json({ error: 'No messages provided' }, { status: 400 });
    }
    try {
      const resp = await grokChat({
        model,
        messages,
        temperature: 0.7,
        usageContext: { source: 'chat' },
      });
      const content = resp.choices?.[0]?.message?.content || '';
      return NextResponse.json({ content, model, provider: parseModelRef(model).provider, usage: resp.usage });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  }

  if (action === 'tool-chat') {
    const cfg = await loadConfig();
    const auth = await resolveCloudBearer(cfg);
    if (auth.token) setApiKey(auth.token);
    try {
      const resp = await grokChat({
        model: parseModelRef(body.model || cfg.defaultGrokModel || 'cloud:grok-4').encoded,
        messages: body.messages,
        tools: body.tools,
        usageContext: body.usageContext || { source: 'other' },
      });
      return NextResponse.json(resp);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
