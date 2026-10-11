import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PUBLIC_SITE_PAGES,
  SITE_CANONICAL_HOST,
  SITE_CANONICAL_ORIGIN,
  SITE_PUBLISH_PATHS,
  SITE_ROBOTS_SITEMAP_LINE,
  SITE_SITEMAP_URL,
  SOFTWARE_APPLICATION_JSON_LD,
  buildRobotsTxt,
  buildSitemapXml,
  type PublicSitePageId,
} from '../lib/site-seo';
import { SITE_TRAFFIC_REPOSITORY, SITE_TRAFFIC_URL } from '../lib/site-traffic-types';

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function utcDay(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function lastmodForSiteFile(rel: string, now = new Date()): string {
  const today = utcDay(now);
  const log = spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%cI', '--', rel], {
    encoding: 'utf8',
  });
  const fromGit = log.stdout.trim() ? utcDay(log.stdout.trim()) : today;
  const status = spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--', rel], {
    encoding: 'utf8',
  });
  const dirty = Boolean(status.stdout.trim());
  const candidate = dirty ? today : fromGit;
  return candidate > today ? today : candidate;
}

function canonicalHrefs(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*\brel=["']canonical["'][^>]*>/gi)].map((match) => {
    const href = match[0].match(/\bhref=["']([^"']+)["']/i);
    assert(href, `canonical tag is missing href: ${match[0]}`);
    return href[1];
  });
}

function parseSitemap(xml: string): Array<{ loc: string; lastmod: string }> {
  const urls = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<\/url>/g)];
  assert.equal(urls.length, xml.split('<url>').length - 1, 'every sitemap <url> has loc and lastmod');
  return urls.map((match) => ({ loc: match[1], lastmod: match[2] }));
}

function assertKnownPage(id: PublicSitePageId): PublicSitePageId {
  switch (id) {
    case 'home':
    case 'docs':
    case 'packages':
    case 'traffic':
      return id;
    default: {
      const _never: never = id;
      throw new Error(`Unhandled public site page: ${_never}`);
    }
  }
}

function main() {
  assert.equal(SITE_CANONICAL_HOST, 'shiba-studio.io');
  assert.equal(SITE_TRAFFIC_URL, 'https://shiba-studio.io');
  assert.equal(SITE_CANONICAL_ORIGIN, 'https://shiba-studio.io');
  assert.doesNotMatch(SITE_CANONICAL_ORIGIN, /www\./);
  assert.equal(read('site/CNAME').trim(), SITE_CANONICAL_HOST);

  const robots = read('site/robots.txt');
  assert.equal(robots, buildRobotsTxt());
  assert.match(robots, new RegExp(`^${SITE_ROBOTS_SITEMAP_LINE}$`, 'm'));
  assert.doesNotMatch(robots, /www\.shiba-studio\.io/);
  assert.doesNotMatch(robots, /Disallow: \//);

  const today = utcDay(new Date());
  const expectedEntries = PUBLIC_SITE_PAGES.map((page) => {
    assertKnownPage(page.id);
    return { loc: page.loc, lastmod: lastmodForSiteFile(page.file) };
  });
  const sitemap = read('site/sitemap.xml');
  assert.equal(sitemap, buildSitemapXml(expectedEntries));
  const parsed = parseSitemap(sitemap);
  assert.equal(parsed.length, PUBLIC_SITE_PAGES.length);
  assert.deepEqual(
    parsed.map((entry) => entry.loc),
    PUBLIC_SITE_PAGES.map((page) => page.loc),
  );
  for (const entry of parsed) {
    assert.match(entry.lastmod, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.lastmod <= today, `${entry.loc} lastmod ${entry.lastmod} must not be in the future`);
  }
  assert.equal(sitemap.includes(SITE_SITEMAP_URL), false, 'sitemap lists pages, not itself');

  const knownGithub = `https://github.com/${SITE_TRAFFIC_REPOSITORY}`;
  for (const page of PUBLIC_SITE_PAGES) {
    const html = read(page.file);
    const hrefs = canonicalHrefs(html);
    assert.equal(hrefs.length, 1, `${page.file} must have exactly one canonical`);
    assert.equal(hrefs[0], page.loc, `${page.file} canonical must be ${page.loc}`);
    assert.match(html, new RegExp(knownGithub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const home = read('site/index.html');
  const jsonBlocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(jsonBlocks.length, 1, 'home must have one JSON-LD block');
  const jsonLd = JSON.parse(jsonBlocks[0][1]) as Record<string, unknown>;
  assert.equal(jsonLd['@context'], SOFTWARE_APPLICATION_JSON_LD['@context']);
  assert.equal(jsonLd['@type'], SOFTWARE_APPLICATION_JSON_LD['@type']);
  assert.equal(jsonLd.name, SOFTWARE_APPLICATION_JSON_LD.name);
  assert.equal(jsonLd.url, SOFTWARE_APPLICATION_JSON_LD.url);
  assert.equal(jsonLd.description, SOFTWARE_APPLICATION_JSON_LD.description);
  assert.equal(jsonLd.applicationCategory, SOFTWARE_APPLICATION_JSON_LD.applicationCategory);
  assert.equal(jsonLd.operatingSystem, SOFTWARE_APPLICATION_JSON_LD.operatingSystem);
  assert.equal(jsonLd.downloadUrl, SOFTWARE_APPLICATION_JSON_LD.downloadUrl);
  assert.equal(jsonLd.license, SOFTWARE_APPLICATION_JSON_LD.license);
  assert.equal(jsonLd.image, SOFTWARE_APPLICATION_JSON_LD.image);
  assert.deepEqual(jsonLd.sameAs, [...SOFTWARE_APPLICATION_JSON_LD.sameAs]);
  const invented = (jsonLd.sameAs as string[]).filter((url) => url !== knownGithub);
  assert.deepEqual(invented, [], 'JSON-LD sameAs may only include the public GitHub repo');

  const publish = read('.github/scripts/publish-native-packages.mjs');
  for (const published of SITE_PUBLISH_PATHS) {
    assert(
      publish.includes(`'${published}'`) || publish.includes(`"${published}"`),
      `publish-native-packages.mjs must copy ${published}`,
    );
  }
  assert.match(publish, /traffic\/index\.html/);
  assert.doesNotMatch(publish, /repository-traffic\.json/);

  const verifyAll = read('scripts/verify-all.ts');
  assert.match(verifyAll, /verify-site-seo\.ts/);

  console.log('verify-site-seo: OK');
}

main();
