/**
 * Module-level cache for Providers rail + auth flags.
 *
 * Tab / chat navigation can remount ShibaStudio while `studioBootstrapped` is
 * already true — we intentionally skip full loadAll. Without this cache,
 * hasCloudAuth / OAuth / local / CLI all re-init as "off" until something
 * re-fetches. Keep the last known good provider picture for the browser tab.
 */
'use client';

export type CachedOauthStatus = {
  connected: boolean;
  expired: boolean;
  email?: string;
  displayName?: string;
  error?: string;
};

export type CachedGrokCliStatus = {
  installed: boolean;
  /** True only when the binary, supported command surface, and auth are usable. */
  ready: boolean;
  explicitlyTrusted?: boolean;
  discovery?: 'explicit' | 'path' | 'missing';
  authenticated?: boolean;
  authMode?: string;
  version?: string;
  versionNumber?: string;
  channel?: string;
  path?: string;
  error?: string;
  models?: string[];
  defaultModel?: string;
  capabilities?: {
    headless?: boolean;
    streamingJson?: boolean;
    acpStdio?: boolean;
    acpWebSocket?: boolean;
    sessions?: boolean;
    worktrees?: boolean;
    toolFiltering?: boolean;
    permissionRules?: boolean;
    sandbox?: boolean;
    mcp?: boolean;
    plugins?: boolean;
    selfVerification?: boolean;
    bestOfN?: boolean;
    structuredOutput?: boolean;
  };
  source?: {
    repository?: string;
    branch?: string;
    commit?: string;
    sourceRevision?: string;
    sourceVersion?: string;
    testedStableVersion?: string;
    syncedAt?: string;
    license?: string;
  };
};

export type CachedModelOption = {
  id: string;
  label: string;
  provider?: 'cloud' | 'local' | 'cli';
  reasoning?: boolean;
};

/** Subset of AppConfig / runtime flags the Providers rail and settings need. */
export type ProvidersUiSnapshot = {
  /** Opaque config blob from GET /api/config (includes hasCloudAuth, hasKey, …). */
  config: Record<string, unknown> | null;
  oauthStatus: CachedOauthStatus;
  cloudAuthMode: 'api_key' | 'oauth';
  localGrokEnabled: boolean;
  localGrokBaseUrl: string;
  localGrokReachable: boolean;
  localModelOptions: string[];
  localModelAllowlist: string[];
  grokCli: CachedGrokCliStatus | null;
  availableModels: CachedModelOption[];
  modelsError: string | null;
  hasApiKeyMasked: boolean;
  hasManagementKeyMasked: boolean;
  /** Partial fingerprints ("xai-ab…7f3a") shown in the Settings key inputs. */
  apiKeyMasked?: string;
  managementKeyMasked?: string;
};

const DEFAULT_OAUTH: CachedOauthStatus = { connected: false, expired: false };

let snapshot: ProvidersUiSnapshot | null = null;

export function getProvidersUiSnapshot(): ProvidersUiSnapshot | null {
  return snapshot;
}

export function hasProvidersUiSnapshot(): boolean {
  return snapshot !== null;
}

export function setProvidersUiSnapshot(next: ProvidersUiSnapshot): void {
  snapshot = next;
}

/** Merge patch into existing snapshot (or defaults). */
export function patchProvidersUiSnapshot(patch: Partial<ProvidersUiSnapshot>): ProvidersUiSnapshot {
  const base: ProvidersUiSnapshot = snapshot || {
    config: null,
    oauthStatus: { ...DEFAULT_OAUTH },
    cloudAuthMode: 'api_key',
    localGrokEnabled: false,
    localGrokBaseUrl: 'http://127.0.0.1:1234/v1',
    localGrokReachable: false,
    localModelOptions: [],
    localModelAllowlist: [],
    grokCli: null,
    availableModels: [],
    modelsError: null,
    hasApiKeyMasked: false,
    hasManagementKeyMasked: false,
  };
  snapshot = { ...base, ...patch };
  return snapshot;
}

export function clearProvidersUiSnapshot(): void {
  snapshot = null;
}
