import path from 'node:path';
import { promises as fs } from 'node:fs';
import { NextResponse } from 'next/server';
import { resolveMonacoAsset } from '@/lib/monaco-assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function assetError(error: string, status: number) {
  return NextResponse.json(
    { error },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ asset?: string[] }> },
) {
  const { asset = [] } = await context.params;

  try {
    const assetRoot = path.resolve(process.cwd(), 'node_modules', 'monaco-editor', 'min', 'vs');
    const resolved = await resolveMonacoAsset(assetRoot, asset);
    if (!resolved.ok && resolved.reason === 'invalid') {
      return assetError('Invalid Monaco asset path.', 400);
    }
    if (!resolved.ok) {
      return assetError('Monaco asset not found.', 404);
    }
    const bytes = await fs.readFile(resolved.path);
    const contentType = MIME_TYPES[path.extname(resolved.path).toLowerCase()] || 'application/octet-stream';
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'public, max-age=86400',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return assetError('Monaco asset not found.', 404);
    }
    console.error('[shiba-studio] Monaco asset request failed', error);
    return assetError('Could not load Monaco asset.', 500);
  }
}
