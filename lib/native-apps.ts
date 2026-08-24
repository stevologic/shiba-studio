import { readFileSync } from 'node:fs';
import path from 'node:path';

export const NATIVE_APP_PLATFORMS = ['windows', 'macos'] as const;
export type NativeAppPlatform = (typeof NATIVE_APP_PLATFORMS)[number];

export const NATIVE_APP_KINDS = ['desktop-host', 'companion'] as const;
export type NativeAppKind = (typeof NATIVE_APP_KINDS)[number];

export const NATIVE_APP_CHANNELS = ['main', 'development'] as const;
export type NativeAppChannel = (typeof NATIVE_APP_CHANNELS)[number];

export const NATIVE_APP_CATALOG_PATH = 'apps/catalog.json';
export const PACKAGES_PAGE_PATH = 'site/packages.html';
export const PACKAGES_MANIFEST_PATH = 'site/packages/manifest.json';
export const NATIVE_APP_RELEASE_TAG_PREFIX = 'packages';

export interface NativeAppDefinition {
  id: NativeAppPlatform;
  name: string;
  platform: NativeAppPlatform;
  kind: NativeAppKind;
  enabled: boolean;
  project: string;
  artifact: string;
  summary: string;
}

export interface NativeAppCatalog {
  version: 1;
  page: typeof PACKAGES_PAGE_PATH;
  channels: NativeAppChannel[];
  releaseTagPrefix: typeof NATIVE_APP_RELEASE_TAG_PREFIX;
  apps: NativeAppDefinition[];
}

export interface NativePackageOffer {
  name: string;
  file: string;
  url: string;
}

export interface NativePackageChannelSnapshot {
  sha: string;
  runUrl: string;
  releaseUrl: string;
  apps: Record<NativeAppPlatform, NativePackageOffer>;
}

export interface NativePackagesManifest {
  version: 1;
  updatedAt: string;
  page: string;
  channels: Partial<Record<NativeAppChannel, NativePackageChannelSnapshot>>;
}

interface UnknownCatalog {
  version?: unknown;
  page?: unknown;
  channels?: unknown;
  releaseTagPrefix?: unknown;
  apps?: unknown;
}

function isPlatform(value: unknown): value is NativeAppPlatform {
  return NATIVE_APP_PLATFORMS.includes(value as NativeAppPlatform);
}

function isKind(value: unknown): value is NativeAppKind {
  return NATIVE_APP_KINDS.includes(value as NativeAppKind);
}

function isChannel(value: unknown): value is NativeAppChannel {
  return NATIVE_APP_CHANNELS.includes(value as NativeAppChannel);
}

export function assertNever(value: never, label: string): never {
  throw new Error(`Unhandled ${label}: ${String(value)}`);
}

export function releaseTagForChannel(channel: NativeAppChannel): string {
  switch (channel) {
    case 'main':
    case 'development':
      return `${NATIVE_APP_RELEASE_TAG_PREFIX}-${channel}`;
    default:
      return assertNever(channel, 'native app channel');
  }
}

export function parseNativeAppCatalog(raw: unknown): NativeAppCatalog {
  const input = (raw ?? {}) as UnknownCatalog;
  if (input.version !== 1) throw new Error('Native app catalog version must be 1');
  if (input.page !== PACKAGES_PAGE_PATH) throw new Error(`Catalog page must be ${PACKAGES_PAGE_PATH}`);
  if (input.releaseTagPrefix !== NATIVE_APP_RELEASE_TAG_PREFIX) {
    throw new Error(`Catalog releaseTagPrefix must be ${NATIVE_APP_RELEASE_TAG_PREFIX}`);
  }
  if (!Array.isArray(input.channels) || input.channels.length !== NATIVE_APP_CHANNELS.length) {
    throw new Error('Catalog must list both main and development channels');
  }
  for (const channel of input.channels) {
    if (!isChannel(channel)) throw new Error(`Unknown native app channel: ${String(channel)}`);
  }
  if (!Array.isArray(input.apps) || input.apps.length !== NATIVE_APP_PLATFORMS.length) {
    throw new Error('Catalog must list exactly the Windows and macOS apps');
  }

  const apps = input.apps.map((entry, index) => {
    const app = (entry ?? {}) as Record<string, unknown>;
    if (!isPlatform(app.id) || !isPlatform(app.platform) || app.id !== app.platform) {
      throw new Error(`Catalog app ${index} must have matching id/platform`);
    }
    if (!isKind(app.kind)) throw new Error(`Catalog app ${app.id} has an unknown kind`);
    if (app.enabled !== true) throw new Error(`Catalog app ${app.id} must be enabled`);
    if (typeof app.name !== 'string' || !app.name.trim()) throw new Error(`Catalog app ${app.id} is missing a name`);
    if (typeof app.project !== 'string' || !app.project.startsWith('apps/')) {
      throw new Error(`Catalog app ${app.id} is missing a project path`);
    }
    if (typeof app.artifact !== 'string' || !app.artifact.endsWith('.zip')) {
      throw new Error(`Catalog app ${app.id} is missing a zip artifact`);
    }
    if (typeof app.summary !== 'string' || app.summary.length < 12) {
      throw new Error(`Catalog app ${app.id} is missing a summary`);
    }
    const platform = app.platform;
    const kind = app.kind;
    switch (platform) {
      case 'windows':
      case 'macos':
        if (kind !== 'desktop-host') throw new Error(`${platform} app must be a desktop host`);
        break;
      default:
        assertNever(platform, 'native app platform');
    }
    return {
      id: app.id,
      name: app.name,
      platform,
      kind,
      enabled: true,
      project: app.project,
      artifact: app.artifact,
      summary: app.summary,
    };
  });

  const ids = new Set(apps.map((app) => app.id));
  for (const platform of NATIVE_APP_PLATFORMS) {
    if (!ids.has(platform)) throw new Error(`Catalog is missing the ${platform} app`);
  }

  return {
    version: 1,
    page: PACKAGES_PAGE_PATH,
    channels: [...NATIVE_APP_CHANNELS],
    releaseTagPrefix: NATIVE_APP_RELEASE_TAG_PREFIX,
    apps,
  };
}

export function loadNativeAppCatalog(repoRoot: string): NativeAppCatalog {
  const file = path.join(repoRoot, NATIVE_APP_CATALOG_PATH);
  return parseNativeAppCatalog(JSON.parse(readFileSync(file, 'utf8')));
}

export function emptyPackagesManifest(pageUrl = 'https://shiba-studio.io/packages.html'): NativePackagesManifest {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    page: pageUrl,
    channels: {},
  };
}

export function mergePackagesManifest(
  existing: NativePackagesManifest | null,
  channel: NativeAppChannel,
  snapshot: NativePackageChannelSnapshot,
  pageUrl = 'https://shiba-studio.io/packages.html',
): NativePackagesManifest {
  const next: NativePackagesManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    page: pageUrl,
    channels: { ...(existing?.channels ?? {}) },
  };
  next.channels[channel] = snapshot;
  return next;
}
