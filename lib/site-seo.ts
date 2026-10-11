import { SITE_TRAFFIC_REPOSITORY, SITE_TRAFFIC_URL } from './site-traffic-types';

export const SITE_CANONICAL_HOST = new URL(SITE_TRAFFIC_URL).host;
export const SITE_CANONICAL_ORIGIN = `https://${SITE_CANONICAL_HOST}`;

export type PublicSitePageId = 'home' | 'docs' | 'packages' | 'traffic';

export interface PublicSitePage {
  id: PublicSitePageId;
  file: string;
  loc: string;
}

export const PUBLIC_SITE_PAGES: readonly PublicSitePage[] = [
  { id: 'home', file: 'site/index.html', loc: `${SITE_CANONICAL_ORIGIN}/` },
  { id: 'docs', file: 'site/docs.html', loc: `${SITE_CANONICAL_ORIGIN}/docs.html` },
  { id: 'packages', file: 'site/packages.html', loc: `${SITE_CANONICAL_ORIGIN}/packages.html` },
  { id: 'traffic', file: 'site/traffic/index.html', loc: `${SITE_CANONICAL_ORIGIN}/traffic/` },
];

export const SITE_SITEMAP_URL = `${SITE_CANONICAL_ORIGIN}/sitemap.xml`;
export const SITE_ROBOTS_SITEMAP_LINE = `Sitemap: ${SITE_SITEMAP_URL}`;

export const SITE_PUBLISH_PATHS = [
  'index.html',
  'docs.html',
  'packages.html',
  'robots.txt',
  'sitemap.xml',
  'CNAME',
  'traffic/index.html',
] as const;

export const SOFTWARE_APPLICATION_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Shiba Studio',
  url: `${SITE_CANONICAL_ORIGIN}/`,
  description:
    'The localhost agent studio powered exclusively by Grok 4.6 / xAI. Chat, code, browse, and automate — all on your machine.',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Windows, macOS',
  downloadUrl: `${SITE_CANONICAL_ORIGIN}/packages.html`,
  license: `https://github.com/${SITE_TRAFFIC_REPOSITORY}/blob/main/LICENSE`,
  image: `${SITE_CANONICAL_ORIGIN}/og-card.png`,
  sameAs: [`https://github.com/${SITE_TRAFFIC_REPOSITORY}`],
} as const;

export function buildRobotsTxt(): string {
  return `User-agent: *\nAllow: /\n\n${SITE_ROBOTS_SITEMAP_LINE}\n`;
}

export function buildSitemapXml(entries: ReadonlyArray<{ loc: string; lastmod: string }>, now = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  const urls = entries.map((entry) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.lastmod)) {
      throw new Error(`lastmod for ${entry.loc} is not YYYY-MM-DD: ${entry.lastmod}`);
    }
    if (entry.lastmod > today) {
      throw new Error(`lastmod ${entry.lastmod} is in the future for ${entry.loc}`);
    }
    return `  <url>\n    <loc>${entry.loc}</loc>\n    <lastmod>${entry.lastmod}</lastmod>\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
