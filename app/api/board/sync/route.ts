import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit } from '@/lib/audit-log';
import {
  discoverBoardSyncTargets,
  getBoardSyncOverview,
  resolveBoardSyncTarget,
  syncBoard,
} from '@/lib/board-sync';
import { loadConfig, updateIntegrationConfig } from '@/lib/persistence';

export const runtime = 'nodejs';

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('discover'),
    provider: z.enum(['linear', 'jira']),
  }),
  z.object({
    action: z.literal('sync'),
    provider: z.enum(['linear', 'jira']),
    targetId: z.string().trim().min(1).max(200),
    direction: z.enum(['pull', 'push', 'bidirectional']),
    mode: z.enum(['tasks', 'board']),
    conflictPolicy: z.enum(['newest', 'local', 'remote']).default('newest'),
  }),
]);

export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...(await getBoardSyncOverview()) });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not load Board sync settings.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Invalid Board sync request.' }, { status: 400 });
  }

  try {
    const cfg = await loadConfig();
    if (parsed.data.action === 'discover') {
      const targets = await discoverBoardSyncTargets(parsed.data.provider, cfg.integrations);
      return NextResponse.json({ ok: true, targets });
    }

    const { provider, targetId, direction, mode, conflictPolicy } = parsed.data;
    const target = await resolveBoardSyncTarget(provider, targetId, cfg.integrations);
    const currentCfg = await loadConfig();
    if (provider === 'linear') {
      if (currentCfg.integrations.linear?.apiKey !== cfg.integrations.linear?.apiKey) {
        throw new Error('Linear credentials changed while targets were loading. Run sync again.');
      }
    } else {
      const before = cfg.integrations.jira;
      const current = currentCfg.integrations.jira;
      if (
        current?.baseUrl !== before?.baseUrl
        || current?.cloudId !== before?.cloudId
        || current?.email !== before?.email
        || current?.apiToken !== before?.apiToken
      ) {
        throw new Error('Jira credentials changed while targets were loading. Run sync again.');
      }
    }
    const integrations = { ...currentCfg.integrations };
    if (provider === 'linear') {
      if (!integrations.linear) throw new Error('Linear is not configured.');
      integrations.linear = {
        ...integrations.linear,
        teamId: target.id,
        teamName: target.name,
        syncDirection: direction,
        syncMode: mode,
      };
    } else {
      if (!integrations.jira) throw new Error('Jira is not configured.');
      integrations.jira = {
        ...integrations.jira,
        projectKey: target.projectKey || target.key,
        projectName: target.projectName || (target.kind === 'project' ? target.name : undefined),
        boardId: target.kind === 'board' ? target.id.replace(/^board:/, '') : undefined,
        boardName: target.kind === 'board' ? target.name : undefined,
        syncDirection: direction,
        syncMode: mode,
      };
    }
    const result = await syncBoard({
      provider,
      target,
      direction,
      mode,
      conflictPolicy,
      creds: integrations,
    });
    if (provider === 'linear') {
      const original = currentCfg.integrations.linear;
      await updateIntegrationConfig('linear', (current) => {
        if (!current || current.apiKey !== original?.apiKey) return current;
        return {
          ...current,
          teamId: target.id,
          teamName: target.name,
          syncDirection: direction,
          syncMode: mode,
        };
      });
    } else {
      const original = currentCfg.integrations.jira;
      await updateIntegrationConfig('jira', (current) => {
        if (
          !current
          || current.baseUrl !== original?.baseUrl
          || current.cloudId !== original.cloudId
          || current.email !== original.email
          || current.apiToken !== original.apiToken
        ) return current;
        return {
          ...current,
          projectKey: target.projectKey || target.key,
          projectName: target.projectName || (target.kind === 'project' ? target.name : undefined),
          boardId: target.kind === 'board' ? target.id.replace(/^board:/, '') : undefined,
          boardName: target.kind === 'board' ? target.name : undefined,
          syncDirection: direction,
          syncMode: mode,
        };
      });
    }
    audit(
      'integration',
      `${provider} board sync ${result.ok ? 'completed' : 'completed with errors'}`,
      `${target.name}: ${result.imported} imported, ${result.exported} exported, ${result.updatedLocal + result.updatedRemote} updated, ${result.errors.length} errors`,
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : 'Board sync failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
