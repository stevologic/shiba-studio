import type { MetadataRoute } from 'next';

import {
  BRAND_BACKGROUND_COLOR,
  BRAND_THEME_COLOR,
} from '@/lib/brand';
import { THEME_IDENTITY } from '@/lib/theme';

/**
 * Root web app manifest, served at /manifest.webmanifest.
 * The Companion keeps its own scoped manifest at /companion/manifest.webmanifest.
 *
 * `minimal-ui` rather than `standalone` on purpose: adding Studio to a home
 * screen should still launch inside a browser context, because sign-in redirects
 * (xAI / Google OAuth) and file downloads break out of a standalone window.
 * The iOS home-screen icon comes from app/apple-icon.png either way.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: THEME_IDENTITY.metadataTitle,
    short_name: THEME_IDENTITY.brandName,
    description: THEME_IDENTITY.metadataDescription,
    start_url: '/',
    scope: '/',
    display: 'minimal-ui',
    background_color: BRAND_BACKGROUND_COLOR,
    theme_color: BRAND_THEME_COLOR,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
