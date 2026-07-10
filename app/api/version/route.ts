import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeVersion } from '@/lib/runtime-version';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface UpdateProbe {
  latest: string | null;
  url: string | null;
  updateAvailable: boolean;
  checkedAt: number;
}
interface VersionGlobals { __shibaUpdateProbe?: UpdateProbe }
const g = globalThis as unknown as VersionGlobals;
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000; // GitHub is rate-limited; 4×/day is plenty

function newerSemver(latest: string, current: string): boolean {
  const p = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [p(latest), p(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

/** Best-effort "update available" probe against GitHub releases (cached). */
async function checkForUpdate(currentVersion: string): Promise<UpdateProbe> {
  const cached = g.__shibaUpdateProbe;
  if (cached && Date.now() - cached.checkedAt < UPDATE_TTL_MS) return cached;
  const probe: UpdateProbe = { latest: null, url: null, updateAvailable: false, checkedAt: Date.now() };
  try {
    const res = await fetch('https://api.github.com/repos/stevologic/shiba-studio/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const rel = await res.json() as { tag_name?: string; html_url?: string };
      if (rel.tag_name) {
        probe.latest = rel.tag_name;
        probe.url = rel.html_url || null;
        probe.updateAvailable = newerSemver(rel.tag_name, currentVersion);
      }
    }
  } catch { /* offline or no releases yet — stay silent */ }
  g.__shibaUpdateProbe = probe;
  return probe;
}

/** Lightweight poll endpoint so the UI always shows the running tree's commit.
 *  ?checkUpdate=1 also probes GitHub releases (cached 6h). */
export async function GET(req: NextRequest) {
  const runtime = getRuntimeVersion();
  const update = req.nextUrl.searchParams.get('checkUpdate')
    ? await checkForUpdate(runtime.version)
    : undefined;
  return NextResponse.json({
    ok: true,
    version: runtime.version,
    commit: runtime.commit,
    commitFull: runtime.commitFull,
    dirty: runtime.dirty,
    root: runtime.root,
    source: runtime.source,
    checkedAt: runtime.checkedAt,
    ...(update ? { update } : {}),
  });
}
