/**
 * Brand asset source of truth: every shipped icon and the social share card are
 * drawn from these builders so the favicon, the iOS home-screen icon, and the
 * link-unfurl card can never drift from lib/theme.ts.
 *
 * Raster outputs are produced by `npm run generate:brand` and committed
 * (social crawlers need a plain static file, not a render at request time);
 * `scripts/verify-brand-assets.ts` asserts the committed files still match
 * BRAND_ASSETS.
 */

import { THEME_COLORS, THEME_IDENTITY } from './theme';

/** Fur/glasses palette of the shiba mark — the one warm accent in a monochrome UI. */
export const BRAND_MARK_COLORS = {
  earOuter: '#c68642',
  earInner: '#e8a85c',
  fur: '#e8a85c',
  muzzle: '#f5d5a8',
  glasses: '#111111',
  nose: '#2d2d2d',
} as const;

/**
 * Icons ship opaque: iOS composites any alpha onto black when it draws the
 * home-screen icon, so a transparent mark would lose its backdrop entirely.
 * A near-black gradient (not flat #000) keeps the tile visible against a dark
 * home screen while staying inside the monochrome identity.
 */
export const BRAND_ICON_BACKDROP = { top: '#161616', bottom: '#050505' } as const;

/** `<meta name="theme-color">` and the manifest theme — the app shell colour. */
export const BRAND_THEME_COLOR = THEME_COLORS.bg;
export const BRAND_BACKGROUND_COLOR = THEME_COLORS.bg;

/** Corner rounding of the standalone mark, in units of the 64-wide viewBox. */
const MARK_RADIUS = 12;

/**
 * Maskable icons are cropped to a circle inscribed in the centre 80%, so the
 * art is scaled into that safe zone and the backdrop is left to bleed.
 */
export const MASKABLE_ART_SCALE = 0.66;

export type MarkOptions = {
  /** Rendered square size in px. The art itself is a 64-unit viewBox. */
  size?: number;
  /** Corner radius in viewBox units. 0 = full bleed (what iOS and maskable want). */
  radius?: number;
  /** Scale the shiba art inside the tile; < 1 leaves a safe-zone margin. */
  artScale?: number;
  /** Opaque backdrop. `false` draws the art alone on transparency. */
  backdrop?: boolean;
};

/** The shiba-with-sunglasses mark, drawn on a 64-unit grid. */
export function shibaMarkSvg(options: MarkOptions = {}): string {
  const { size = 512, radius = MARK_RADIUS, artScale = 1, backdrop = true } = options;
  const c = BRAND_MARK_COLORS;
  const offset = (64 - 64 * artScale) / 2;

  const backdropLayer = backdrop
    ? `<defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BRAND_ICON_BACKDROP.top}"/>
      <stop offset="1" stop-color="${BRAND_ICON_BACKDROP.bottom}"/>
    </linearGradient>
    <radialGradient id="warmth" cx="0.5" cy="0.62" r="0.62">
      <stop offset="0" stop-color="${c.fur}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${c.fur}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" rx="${radius}" fill="url(#tile)"/>
  <rect width="64" height="64" rx="${radius}" fill="url(#warmth)"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">
  ${backdropLayer}
  <g transform="translate(${offset.toFixed(3)} ${offset.toFixed(3)}) scale(${artScale})">
    <path d="M14 22 L22 6 L30 20 Z" fill="${c.earOuter}"/>
    <path d="M34 20 L42 6 L50 22 Z" fill="${c.earOuter}"/>
    <path d="M16 20 L22 10 L28 19 Z" fill="${c.earInner}"/>
    <path d="M36 19 L42 10 L48 20 Z" fill="${c.earInner}"/>
    <ellipse cx="32" cy="36" rx="22" ry="20" fill="${c.fur}"/>
    <ellipse cx="32" cy="40" rx="14" ry="11" fill="${c.muzzle}"/>
    <rect x="14" y="30" width="14" height="9" rx="2" fill="${c.glasses}"/>
    <rect x="36" y="30" width="14" height="9" rx="2" fill="${c.glasses}"/>
    <rect x="27" y="33" width="10" height="3" fill="${c.glasses}"/>
    <rect x="15" y="31" width="5" height="3" rx="1" fill="rgba(255,255,255,0.15)"/>
    <rect x="44" y="31" width="5" height="3" rx="1" fill="rgba(255,255,255,0.15)"/>
    <ellipse cx="32" cy="44" rx="4" ry="3" fill="${c.nose}"/>
    <path d="M32 47 Q28 51 24 49" stroke="${c.nose}" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M32 47 Q36 51 40 49" stroke="${c.nose}" stroke-width="1.5" stroke-linecap="round" fill="none"/>
  </g>
</svg>`;
}

/** Font stack for generated art. System faces only — the generator runs offline. */
const CARD_FONT = 'Segoe UI, Helvetica Neue, Helvetica, Arial, sans-serif';

const SOCIAL_CARD_SIZE = { width: 1200, height: 630 } as const;

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 1200x630 link-unfurl card: the studio's black shell with a warm glow behind
 * the mark, so a shared link renders a real background instead of a blank tile.
 */
export function socialCardSvg(): string {
  const { width, height } = SOCIAL_CARD_SIZE;
  const c = BRAND_MARK_COLORS;
  const gridStep = 48;

  const gridLines: string[] = [];
  for (let x = gridStep; x < width; x += gridStep) {
    gridLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`);
  }
  for (let y = gridStep; y < height; y += gridStep) {
    gridLines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);
  }

  const chips = ['LOCALHOST ONLY', 'COMPUTER USE', 'AUTOMATIONS'];
  let chipX = 88;
  const chipMarkup = chips
    .map((label) => {
      // librsvg has no text metrics here; approximate the advance width so the
      // pill hugs its label at 18px with 2px of tracking.
      const chipWidth = Math.round(label.length * 11.4 + 44);
      const markup = `<g transform="translate(${chipX} 536)">
      <rect width="${chipWidth}" height="46" rx="23" fill="#0e0e0e" stroke="${THEME_COLORS.border}"/>
      <text x="${chipWidth / 2}" y="30" text-anchor="middle" font-family="${CARD_FONT}" font-size="18" font-weight="600" letter-spacing="2" fill="${THEME_COLORS.textMuted}">${escapeXmlText(label)}</text>
    </g>`;
      chipX += chipWidth + 16;
      return markup;
    })
    .join('\n    ');

  // The mark draws on a 64-unit grid; inlining drops its own viewBox, so scale
  // it into card coordinates explicitly.
  const markSize = 132;
  const mark = shibaMarkSvg({ size: 64, radius: 14 })
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '')
    // Namespace the gradient ids so they cannot collide once inlined.
    .replace(/"tile"/g, '"markTile"')
    .replace(/"warmth"/g, '"markWarmth"')
    .replace(/url\(#tile\)/g, 'url(#markTile)')
    .replace(/url\(#warmth\)/g, 'url(#markWarmth)');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <defs>
    <radialGradient id="glow" cx="0.12" cy="0.2" r="0.62">
      <stop offset="0" stop-color="${c.fur}" stop-opacity="0.17"/>
      <stop offset="1" stop-color="${c.fur}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.45" r="0.78">
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.75"/>
    </radialGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${c.fur}"/>
      <stop offset="0.55" stop-color="${c.earOuter}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${c.earOuter}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="${THEME_COLORS.bg}"/>
  <g stroke="#ffffff" stroke-opacity="0.035" stroke-width="1">
    ${gridLines.join('\n    ')}
  </g>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  <rect width="${width}" height="${height}" fill="url(#vignette)"/>

  <g transform="translate(88 74) scale(${(markSize / 64).toFixed(4)})">
    ${mark.trim()}
  </g>

  <text x="264" y="146" font-family="${CARD_FONT}" font-size="54" font-weight="700" letter-spacing="1" fill="${THEME_COLORS.text}">${escapeXmlText(THEME_IDENTITY.brandName)}</text>
  <text x="266" y="188" font-family="${CARD_FONT}" font-size="19" font-weight="600" letter-spacing="4.5" fill="${THEME_COLORS.textDim}">${escapeXmlText(THEME_IDENTITY.heroEyebrow)}</text>

  <text x="88" y="330" font-family="${CARD_FONT}" font-size="66" font-weight="700" fill="${THEME_COLORS.text}">Your Grok agent studio.</text>
  <text x="88" y="404" font-family="${CARD_FONT}" font-size="66" font-weight="700" fill="${c.fur}">On your machine.</text>
  <text x="88" y="462" font-family="${CARD_FONT}" font-size="25" fill="${THEME_COLORS.textMuted}">Chat that acts, a sub-browser that annotates your app, automations that run while you sleep.</text>

  ${chipMarkup}

  <rect x="0" y="${height - 6}" width="${width}" height="6" fill="url(#rule)"/>
</svg>`;
}

export type BrandAsset = {
  /** Repo-relative output path. */
  file: string;
  /** Pixel size of the raster (square icons: width === height). */
  width: number;
  height: number;
  /**
   * `icon` rasters keep a (fully opaque) alpha channel: Next's ICO decoder
   * rejects non-RGBA PNGs outright, and iOS wants the channel present.
   * `social` cards ship as flat RGB so no client can composite them onto white.
   */
  kind: 'icon' | 'social';
  purpose: string;
};

/**
 * Every committed raster. The generator writes exactly this list and the
 * verifier reads it back, so an icon can never silently go missing.
 */
export const BRAND_ASSETS: readonly BrandAsset[] = [
  { file: 'app/apple-icon.png', width: 180, height: 180, kind: 'icon', purpose: 'iOS home-screen icon (opaque, full bleed — iOS applies its own mask)' },
  { file: 'public/icons/icon-192.png', width: 192, height: 192, kind: 'icon', purpose: 'web app manifest icon' },
  { file: 'public/icons/icon-512.png', width: 512, height: 512, kind: 'icon', purpose: 'web app manifest icon / install prompt' },
  { file: 'public/icons/icon-maskable-512.png', width: 512, height: 512, kind: 'icon', purpose: 'web app manifest maskable icon' },
  { file: 'app/opengraph-image.png', width: SOCIAL_CARD_SIZE.width, height: SOCIAL_CARD_SIZE.height, kind: 'social', purpose: 'Open Graph link-unfurl card' },
  { file: 'app/twitter-image.png', width: SOCIAL_CARD_SIZE.width, height: SOCIAL_CARD_SIZE.height, kind: 'social', purpose: 'X / Twitter summary_large_image card' },
] as const;

/** Vector assets written alongside the rasters. */
export const BRAND_VECTOR_ASSETS = ['app/icon.svg', 'public/shiba-logo.svg'] as const;

/** Sizes packed into app/favicon.ico. */
export const FAVICON_ICO_SIZES = [16, 32, 48, 64, 128, 256] as const;

export const SOCIAL_CARD_ALT = `${THEME_IDENTITY.brandName} — ${THEME_IDENTITY.heroTitle}`;

/**
 * Static brand routes that must stay reachable for every client, including LAN
 * companion clients: iOS fetches the touch icon and manifest when a phone adds
 * the app to its home screen, and crawlers fetch the card when a link is shared.
 * Mirrored in the `proxy.ts` matcher — keep the two in sync.
 */
export const PUBLIC_BRAND_ROUTES = [
  '/favicon.ico',
  '/icon.svg',
  '/apple-icon.png',
  '/opengraph-image.png',
  '/twitter-image.png',
  '/manifest.webmanifest',
  '/shiba-logo.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
] as const;
