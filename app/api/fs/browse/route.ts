import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import path from 'path';
import { resolveWorkspace } from '@/lib/workspace';

function isGitRepo(dir: string): boolean {
  try {
    return fsSync.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function defaultBrowseRoot(): string {
  if (process.env.USERPROFILE) return process.env.USERPROFILE;
  if (process.env.HOME) return process.env.HOME;
  return process.cwd();
}

export async function GET(req: NextRequest) {
  const dirParam = req.nextUrl.searchParams.get('dir');
  try {
    let current = dirParam?.trim()
      ? resolveWorkspace(dirParam)
      : defaultBrowseRoot();

    const stat = await fs.stat(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }

    const entries = await fs.readdir(current, { withFileTypes: true });
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => {
        const full = path.join(current, e.name);
        return { name: e.name, path: full, isRepo: isGitRepo(full) };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const parent = path.dirname(current);
    const hasParent = parent !== current;

    return NextResponse.json({
      ok: true,
      path: current,
      parent: hasParent ? parent : null,
      isRepo: isGitRepo(current),
      directories,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Browse failed';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}