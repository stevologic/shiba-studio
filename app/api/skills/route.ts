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

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Skill operation failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
