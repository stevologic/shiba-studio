import { NextRequest, NextResponse } from 'next/server';
import { SKILL_PRESETS } from '@/lib/skills-catalog';
import {
  createCustomSkill,
  deleteCustomSkill,
  listCustomSkills,
  updateCustomSkill,
} from '@/lib/custom-skills';
import { audit } from '@/lib/audit-log';

export async function GET() {
  const custom = await listCustomSkills();
  return NextResponse.json({
    ok: true,
    skills: [
      ...SKILL_PRESETS.map((s) => ({ ...s, custom: false })),
      ...custom.map((s) => ({ ...s, custom: true })),
    ],
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body.action === 'create') {
      const skill = await createCustomSkill({
        name: String(body.name || ''),
        description: body.description ? String(body.description) : '',
        category: body.category,
        promptHint: body.promptHint ? String(body.promptHint) : '',
      });
      audit('skill', 'skill created', skill.name, { id: skill.id, category: skill.category });
      return NextResponse.json({ ok: true, skill });
    }

    if (body.action === 'update') {
      const skill = await updateCustomSkill(String(body.id || ''), {
        ...(body.name !== undefined ? { name: String(body.name) } : {}),
        ...(body.description !== undefined ? { description: String(body.description) } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.promptHint !== undefined ? { promptHint: String(body.promptHint) } : {}),
      });
      audit('skill', 'skill updated', skill.name, { id: skill.id });
      return NextResponse.json({ ok: true, skill });
    }

    if (body.action === 'delete') {
      await deleteCustomSkill(String(body.id || ''));
      audit('skill', 'skill deleted', String(body.id || ''));
      return NextResponse.json({ ok: true });
    }

    // Regenerate a skill's description + prompt from its title alone — the
    // model drafts what the skill should make an agent do.
    if (body.action === 'regenerate') {
      const id = String(body.id || '');
      const existing = (await listCustomSkills()).find((s) => s.id === id);
      if (!existing) return NextResponse.json({ ok: false, error: 'Custom skill not found' }, { status: 404 });

      const { loadConfig } = await import('@/lib/persistence');
      const { resolveCloudBearer } = await import('@/lib/xai-oauth');
      const { grokChat, setApiKey } = await import('@/lib/grok-client');
      const { parseModelRef } = await import('@/lib/model-providers');
      const cfg = await loadConfig();
      const auth = await resolveCloudBearer(cfg);
      if (!auth.token) return NextResponse.json({ ok: false, error: 'Cloud credentials required to generate — connect an xAI key or OAuth' }, { status: 400 });
      setApiKey(auth.token);
      const model = parseModelRef(cfg.defaultGrokModel || 'cloud:grok-4').encoded;

      const resp = await grokChat({
        model,
        messages: [
          {
            role: 'system',
            content: [
              'You write reusable AGENT SKILLS for Shiba Studio. A skill has a one-line description (what the skill makes an agent good at) and a prompt hint (2-5 imperative sentences injected into the agent\'s system prompt: how to behave, which of its tools to prefer, what the output should look like).',
              'Answer ONLY with JSON: {"description": string, "promptHint": string}. No markdown fences.',
            ].join('\n'),
          },
          { role: 'user', content: `Skill title: "${existing.name}" (category: ${existing.category}). Write the description and promptHint.` },
        ],
        temperature: 0.4,
      });
      const raw = resp.choices?.[0]?.message?.content || '';
      let parsed: { description?: string; promptHint?: string };
      try {
        parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        return NextResponse.json({ ok: false, error: 'Model returned an unparseable draft — try again' }, { status: 502 });
      }
      if (!parsed.description || !parsed.promptHint) {
        return NextResponse.json({ ok: false, error: 'Model draft was missing fields — try again' }, { status: 502 });
      }
      const skill = await updateCustomSkill(id, { description: parsed.description, promptHint: parsed.promptHint });
      audit('skill', 'skill regenerated', skill.name, { id: skill.id, model });
      return NextResponse.json({ ok: true, skill });
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Skill operation failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
