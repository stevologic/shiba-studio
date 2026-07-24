/**
 * Renders every committed brand raster from lib/brand.ts.
 * Run: npm run generate:brand
 *
 * Outputs are committed rather than generated at request time — social crawlers
 * and iOS both fetch these with short timeouts, and the studio must serve them
 * even when it is running fully offline.
 *
 * Text in the social card is rasterised with the host's system fonts, so
 * regenerating on a different OS can reflow it slightly. Re-render, eyeball the
 * card, and commit the result.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';

import {
  BRAND_ASSETS,
  FAVICON_ICO_SIZES,
  MASKABLE_ART_SCALE,
  SOCIAL_CARD_ALT,
  shibaMarkSvg,
  socialCardSvg,
} from '../lib/brand';

const ROOT = path.resolve(__dirname, '..');

function out(rel: string): string {
  return path.join(ROOT, ...rel.split('/'));
}

async function writeFileEnsured(rel: string, data: Buffer | string): Promise<void> {
  const target = out(rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  const { size } = await fs.stat(target);
  console.log(`  ${rel.padEnd(38)} ${String(size).padStart(7)} bytes`);
}

/**
 * Rasterise a mark SVG onto an opaque black backdrop — iOS composites any
 * transparency onto black when it draws the home-screen icon, so the icon
 * decides its own background rather than inheriting one.
 *
 * `flatten` alone drops the alpha channel and emits 24-bit RGB, which Next's
 * ICO decoder rejects ("The PNG is not in RGBA format!"), so the (now fully
 * opaque) alpha channel is put back.
 */
async function renderIcon(svg: string, size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg))
    .resize(size, size, { fit: 'fill' })
    .flatten({ background: '#000000' })
    .ensureAlpha(1)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Pack PNG frames into an .ico container.
 *
 * ICONDIR (6 bytes) + one 16-byte ICONDIRENTRY per frame + the PNG payloads.
 * PNG-compressed frames are what every current browser and Windows Vista+
 * shell read; a width/height byte of 0 means 256.
 */
function buildIco(frames: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(16 * frames.length);
  let offset = header.length + directory.length;

  frames.forEach((frame, index) => {
    const entry = index * 16;
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, entry + 0);
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size (0 = truecolour)
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(frame.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.png.length;
  });

  return Buffer.concat([header, directory, ...frames.map((f) => f.png)]);
}

async function main(): Promise<void> {
  console.log('=== SHIBA BRAND ASSETS ===');

  // Rounded tile: browser tabs, bookmarks, Android "any" icons.
  const roundedMark = shibaMarkSvg({ size: 1024 });
  // Full bleed: iOS masks the touch icon itself, so shipping our own rounding
  // would double-round it and leave black wedges in the corners.
  const bleedMark = shibaMarkSvg({ size: 1024, radius: 0 });
  // Maskable: art pulled into the centre safe zone that Android may crop to.
  const maskableMark = shibaMarkSvg({ size: 1024, radius: 0, artScale: MASKABLE_ART_SCALE });

  const bySize = new Map(BRAND_ASSETS.map((asset) => [asset.file, asset]));
  const iconFor = (file: string): number => {
    const asset = bySize.get(file);
    if (!asset) throw new Error(`BRAND_ASSETS is missing ${file}`);
    return asset.width;
  };

  console.log('icons:');
  await writeFileEnsured('app/icon.svg', shibaMarkSvg({ size: 64 }));

  const icoFrames = await Promise.all(
    FAVICON_ICO_SIZES.map(async (size) => ({ size, png: await renderIcon(roundedMark, size) })),
  );
  await writeFileEnsured('app/favicon.ico', buildIco(icoFrames));

  await writeFileEnsured('app/apple-icon.png', await renderIcon(bleedMark, iconFor('app/apple-icon.png')));
  await writeFileEnsured('public/icons/icon-192.png', await renderIcon(roundedMark, iconFor('public/icons/icon-192.png')));
  await writeFileEnsured('public/icons/icon-512.png', await renderIcon(roundedMark, iconFor('public/icons/icon-512.png')));
  await writeFileEnsured(
    'public/icons/icon-maskable-512.png',
    await renderIcon(maskableMark, iconFor('public/icons/icon-maskable-512.png')),
  );

  console.log('social card:');
  const card = await sharp(Buffer.from(socialCardSvg()))
    .flatten({ background: '#000000' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFileEnsured('app/opengraph-image.png', card);
  await writeFileEnsured('app/twitter-image.png', card);
  await writeFileEnsured('app/opengraph-image.alt.txt', SOCIAL_CARD_ALT);
  await writeFileEnsured('app/twitter-image.alt.txt', SOCIAL_CARD_ALT);

  console.log('done.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
