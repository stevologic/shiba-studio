/**
 * Brand asset verification: the committed favicon, iOS touch icon, manifest
 * icons, and social card are present, decodable, and still match lib/brand.ts.
 *
 * These files are only ever exercised by browsers, iOS, and link crawlers, so
 * nothing else in the suite would notice them rotting. Regenerate with
 * `npm run generate:brand`.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';

import {
  BRAND_ASSETS,
  BRAND_BACKGROUND_COLOR,
  BRAND_THEME_COLOR,
  BRAND_VECTOR_ASSETS,
  FAVICON_ICO_SIZES,
  PUBLIC_BRAND_ROUTES,
  SOCIAL_CARD_ALT,
  shibaMarkSvg,
} from '../lib/brand';
import { config as proxyConfig } from '../proxy';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';

const ROOT = path.resolve(__dirname, '..');

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function abs(rel: string): string {
  return path.join(ROOT, ...rel.split('/'));
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PngHeader = { width: number; height: number; bitDepth: number; colorType: number };

/** Read IHDR directly — cheaper than a decode and enough to police the format. */
function readPngHeader(buf: Buffer): PngHeader {
  assert(buf.subarray(0, 8).equals(PNG_MAGIC), 'buffer starts with the PNG signature');
  assert(buf.subarray(12, 16).toString('latin1') === 'IHDR', 'first PNG chunk is IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf.readUInt8(24),
    colorType: buf.readUInt8(25),
  };
}

const PNG_COLOR_TYPE_RGB = 2;
const PNG_COLOR_TYPE_RGBA = 6;

type IcoFrame = { width: number; height: number; payload: Buffer };

/** Parse the ICONDIR/ICONDIRENTRY table so a truncated icon fails here, not in a browser. */
function parseIco(buf: Buffer): IcoFrame[] {
  assert(buf.readUInt16LE(0) === 0, 'ICO reserved field is 0');
  assert(buf.readUInt16LE(2) === 1, 'ICO type is 1 (icon)');
  const count = buf.readUInt16LE(4);
  assert(count > 0, 'ICO declares at least one frame');

  const frames: IcoFrame[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const declaredWidth = buf.readUInt8(entry) || 256;
    const declaredHeight = buf.readUInt8(entry + 1) || 256;
    const bytes = buf.readUInt32LE(entry + 8);
    const offset = buf.readUInt32LE(entry + 12);
    assert(offset + bytes <= buf.length, `ICO frame ${declaredWidth}px lies inside the file`);
    frames.push({ width: declaredWidth, height: declaredHeight, payload: buf.subarray(offset, offset + bytes) });
  }
  return frames;
}

async function verifyRasters(log: string[]): Promise<void> {
  console.log('=== BRAND RASTERS ===');
  for (const asset of BRAND_ASSETS) {
    const buf = await fs.readFile(abs(asset.file));
    const header = readPngHeader(buf);
    assert(header.width === asset.width && header.height === asset.height,
      `${asset.file} is ${asset.width}x${asset.height} (found ${header.width}x${header.height})`);
    assert(header.bitDepth === 8, `${asset.file} is 8-bit`);
    if (asset.kind === 'icon') {
      // Next's ICO/image decoder rejects non-RGBA PNGs, and iOS wants a real
      // alpha channel present even though every pixel is opaque.
      assert(header.colorType === PNG_COLOR_TYPE_RGBA, `${asset.file} is RGBA (colour type 6)`);
    } else {
      // Share cards carry no alpha at all, so no client composites them onto white.
      assert(header.colorType === PNG_COLOR_TYPE_RGB, `${asset.file} is flat RGB (colour type 2)`);
    }
    log.push(`${asset.file} ${header.width}x${header.height} type=${header.colorType} ${buf.length}B — ${asset.purpose}`);
    console.log(`  ok  ${asset.file} (${header.width}x${header.height}, ${buf.length}B)`);
  }
}

async function verifyIosIcon(log: string[]): Promise<void> {
  console.log('=== iOS HOME-SCREEN ICON ===');
  const file = 'app/apple-icon.png';
  const image = sharp(abs(file));
  const { width = 0, height = 0 } = await image.metadata();
  assert(width === 180 && height === 180, 'apple-icon.png is 180x180 (the size iOS asks for)');

  // iOS composites alpha onto black and applies its own squircle mask. A
  // transparent or pre-rounded icon therefore renders with black wedges, so
  // every corner pixel must be opaque artwork.
  const { data, info } = await sharp(abs(file)).raw().toBuffer({ resolveWithObject: true });
  assert(info.channels === 4, 'apple-icon.png keeps an alpha channel');
  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  for (const [x, y] of corners) {
    const alpha = data[(y * width + x) * info.channels + 3];
    assert(alpha === 255, `apple-icon.png corner (${x},${y}) is opaque, not a rounded transparent notch`);
  }
  log.push(`app/apple-icon.png 180x180 opaque corners`);
  console.log('  ok  180x180, full bleed, all four corners opaque');
}

async function verifyFavicon(log: string[]): Promise<void> {
  console.log('=== FAVICON.ICO ===');
  const buf = await fs.readFile(abs('app/favicon.ico'));
  const frames = parseIco(buf);
  assert(frames.length === FAVICON_ICO_SIZES.length,
    `favicon.ico packs ${FAVICON_ICO_SIZES.length} frames (found ${frames.length})`);

  const sizes = frames.map((f) => f.width).sort((a, b) => a - b);
  assert(JSON.stringify(sizes) === JSON.stringify([...FAVICON_ICO_SIZES].sort((a, b) => a - b)),
    `favicon.ico frames are ${FAVICON_ICO_SIZES.join('/')} (found ${sizes.join('/')})`);

  for (const frame of frames) {
    const header = readPngHeader(frame.payload);
    assert(header.width === frame.width && header.height === frame.height,
      `favicon.ico ${frame.width}px frame payload matches its directory entry`);
    assert(header.colorType === PNG_COLOR_TYPE_RGBA,
      `favicon.ico ${frame.width}px frame is RGBA — Next fails the whole page on anything else`);
  }
  log.push(`app/favicon.ico frames=${sizes.join(',')} ${buf.length}B`);
  console.log(`  ok  ${frames.length} RGBA frames: ${sizes.join(', ')}`);
}

async function verifyVectorsMatchSource(log: string[]): Promise<void> {
  console.log('=== VECTORS ===');
  for (const rel of BRAND_VECTOR_ASSETS) {
    const svg = await fs.readFile(abs(rel), 'utf8');
    assert(svg.trimStart().startsWith('<svg'), `${rel} is an SVG document`);
    assert(svg.includes('viewBox="0 0 64 64"'), `${rel} draws on the shared 64-unit grid`);
  }
  // The committed favicon vector must be exactly what lib/brand.ts renders,
  // otherwise the tab icon and the generated rasters drift apart. Newlines are
  // normalised so a CRLF checkout is not mistaken for drift.
  const lf = (value: string) => value.replace(/\r\n/g, '\n');
  const committed = await fs.readFile(abs('app/icon.svg'), 'utf8');
  assert(lf(committed) === lf(shibaMarkSvg({ size: 64 })),
    'app/icon.svg matches shibaMarkSvg() — run `npm run generate:brand`');
  log.push(`app/icon.svg matches lib/brand.ts shibaMarkSvg()`);
  console.log('  ok  app/icon.svg is byte-identical to shibaMarkSvg()');
}

async function verifySocialCard(log: string[]): Promise<void> {
  console.log('=== SOCIAL CARD ===');
  for (const rel of ['app/opengraph-image.alt.txt', 'app/twitter-image.alt.txt']) {
    const alt = await fs.readFile(abs(rel), 'utf8');
    assert(alt.trim() === SOCIAL_CARD_ALT.trim(), `${rel} carries the shared alt text`);
  }

  // A card that renders as a flat black rectangle is the failure this catches:
  // the background must actually carry the warm glow and the mark.
  const { dominant } = await sharp(abs('app/opengraph-image.png')).stats();
  const distinctColours = await sharp(abs('app/opengraph-image.png'))
    .resize(64, 34, { fit: 'fill' })
    .raw()
    .toBuffer()
    .then((buf) => {
      const seen = new Set<string>();
      for (let i = 0; i < buf.length; i += 3) seen.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`);
      return seen.size;
    });
  assert(distinctColours > 32, `social card renders a real background, not a flat fill (${distinctColours} colours)`);
  log.push(`app/opengraph-image.png dominant=${JSON.stringify(dominant)} colours=${distinctColours}`);
  console.log(`  ok  card has ${distinctColours} distinct sampled colours`);
}

async function verifyHeadWiring(log: string[]): Promise<void> {
  console.log('=== HEAD WIRING ===');
  const layout = await fs.readFile(abs('app/layout.tsx'), 'utf8');
  const required: Array<[string, string]> = [
    ['metadataBase', 'absolute URLs for unfurled links'],
    ['manifest.webmanifest', 'web app manifest link'],
    ['summary_large_image', 'X/Twitter large card'],
    ['appleWebApp', 'iOS home-screen label'],
    ['openGraph', 'Open Graph block'],
    ['themeColor', 'viewport theme colour'],
  ];
  for (const [needle, label] of required) {
    assert(layout.includes(needle), `app/layout.tsx wires ${label} (${needle})`);
  }
  assert(!/icons:\s*\{/.test(layout),
    'app/layout.tsx leaves icons to the app/ file conventions instead of emitting duplicate <link> tags');

  const manifestModule = await import('../app/manifest');
  const manifest = manifestModule.default();
  assert(manifest.theme_color === BRAND_THEME_COLOR, 'manifest theme_color comes from lib/brand.ts');
  assert(manifest.background_color === BRAND_BACKGROUND_COLOR, 'manifest background_color comes from lib/brand.ts');
  const icons = manifest.icons ?? [];
  assert(icons.some((icon) => icon.purpose === 'maskable'), 'manifest ships a maskable icon');
  for (const icon of icons) {
    assert(typeof icon.src === 'string' && icon.src.startsWith('/'), 'manifest icon src is root-relative');
    await fs.access(abs(`public${icon.src}`));
  }
  log.push(`app/manifest.ts icons=${icons.length} display=${manifest.display}`);
  console.log(`  ok  layout metadata + manifest (${icons.length} icons, display=${manifest.display})`);
}

function verifyProxyExemptions(log: string[]): void {
  console.log('=== LAN REACHABILITY ===');
  const matcher = proxyConfig.matcher;
  assert(typeof matcher === 'string', 'proxy.ts exports a single string matcher');
  const pattern = new RegExp(`^${matcher}$`);

  // Brand routes must sit outside the proxy matcher: a phone adding Studio to
  // its home screen and a chat client unfurling a link both arrive as LAN
  // clients, which the boundary otherwise redirects to /companion.
  for (const route of PUBLIC_BRAND_ROUTES) {
    assert(!pattern.test(route), `${route} is exempt from the proxy matcher (LAN clients must reach it)`);
  }
  // The exemptions must stay narrow — the API and app shell keep the boundary.
  for (const guarded of ['/', '/api/chat', '/companion', '/api/companion/data']) {
    assert(pattern.test(guarded), `${guarded} is still matched by proxy.ts`);
  }
  log.push(`proxy matcher exempts ${PUBLIC_BRAND_ROUTES.length} brand routes, still guards /api/*`);
  console.log(`  ok  ${PUBLIC_BRAND_ROUTES.length} brand routes exempt, /api/* still guarded`);
}

async function main(): Promise<void> {
  await fs.mkdir(SCRATCH, { recursive: true });
  const log: string[] = [`BRAND_ASSETS_VERIFY ${new Date().toISOString()}`, ''];

  await verifyRasters(log);
  await verifyIosIcon(log);
  await verifyFavicon(log);
  await verifyVectorsMatchSource(log);
  await verifySocialCard(log);
  await verifyHeadWiring(log);
  verifyProxyExemptions(log);

  await fs.writeFile(path.join(SCRATCH, 'brand-assets-verify.txt'), log.join('\n'), 'utf8');
  console.log('\nBRAND ASSETS OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
