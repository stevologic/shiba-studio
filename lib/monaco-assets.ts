import { promises as fs } from 'node:fs';
import path from 'node:path';

export type MonacoAssetResolution =
  | { ok: true; path: string; size: number }
  | { ok: false; reason: 'invalid' | 'missing' };

const MAX_ASSET_SEGMENTS = 32;
const MAX_ASSET_PATH_CHARS = 2_048;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * Resolve a Monaco URL only within the installed `min/vs` tree.
 * The realpath check also prevents a replaced package symlink from exposing
 * arbitrary local files through the asset endpoint.
 */
export async function resolveMonacoAsset(
  assetRoot: string,
  asset: readonly string[],
): Promise<MonacoAssetResolution> {
  if (
    asset.length < 2
    || asset.length > MAX_ASSET_SEGMENTS
    || asset[0] !== 'vs'
    || asset.join('/').length > MAX_ASSET_PATH_CHARS
    || asset.some((segment) => (
      !segment
      || segment === '.'
      || segment === '..'
      || segment.length > 255
      || !SAFE_SEGMENT.test(segment)
    ))
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const rootReal = await fs.realpath(assetRoot);
  const requested = path.resolve(rootReal, ...asset.slice(1));
  if (!isInside(rootReal, requested)) {
    return { ok: false, reason: 'invalid' };
  }

  let requestedReal: string;
  try {
    requestedReal = await fs.realpath(requested);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, reason: 'missing' };
    }
    throw error;
  }

  if (!isInside(rootReal, requestedReal)) {
    return { ok: false, reason: 'invalid' };
  }
  const stat = await fs.stat(requestedReal);
  if (!stat.isFile()) {
    return { ok: false, reason: 'missing' };
  }
  return { ok: true, path: requestedReal, size: stat.size };
}
