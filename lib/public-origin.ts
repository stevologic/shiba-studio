/**
 * Parse the one browser-visible origin that an operator's reverse proxy owns.
 *
 * This is intentionally an exact origin, not a CORS-style domain allowlist.
 * Shiba's APIs can execute commands and write files, so accepting wildcards,
 * paths, or forwarded headers from an untrusted request would reopen the DNS
 * rebinding / cross-site request boundary enforced by proxy.ts.
 */
export function parsePublicOrigin(raw: string | undefined): URL | null {
  if (raw === undefined || raw === '') return null;
  if (raw !== raw.trim() || /\s|\\|\*|%/.test(raw)) {
    throw new Error('SHIBA_PUBLIC_ORIGIN must be one exact http(s) origin without whitespace, wildcards, or encoded host characters.');
  }
  const shape = /^https?:\/\/([^/?#]+)\/?$/i.exec(raw);
  if (!shape || shape[1].endsWith(':')) {
    throw new Error('SHIBA_PUBLIC_ORIGIN must contain only scheme, host, and optional port.');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('SHIBA_PUBLIC_ORIGIN is not a valid URL origin.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('SHIBA_PUBLIC_ORIGIN must be one exact http(s) root origin without credentials, path, query, or fragment.');
  }
  return new URL(parsed.origin);
}

export function configuredPublicOrigin(): URL | null {
  return parsePublicOrigin(process.env.SHIBA_PUBLIC_ORIGIN);
}

/** Match the request's preserved Host against the configured origin exactly. */
export function publicOriginForRequestHost(rawHost: string | null | undefined): URL | null {
  const configured = configuredPublicOrigin();
  if (!configured || !rawHost) return null;
  const host = rawHost.trim();
  if (!host || /[\s\\/@?#%]/.test(host)) return null;
  try {
    const requestAuthority = new URL(`${configured.protocol}//${host}`);
    return requestAuthority.origin === configured.origin ? configured : null;
  } catch {
    return null;
  }
}

export function publicTerminalProxyEnabled(): boolean {
  return process.env.SHIBA_PUBLIC_TERMINAL_PROXY === '1';
}

export function publicTerminalWebSocketUrl(origin: URL): string {
  const url = new URL('/api/terminal/ws', origin);
  url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Return a public terminal endpoint only after the operator's explicit opt-in. */
export function publicTerminalWebSocketUrlForRequestHost(
  rawHost: string | null | undefined,
): string | null {
  if (!publicTerminalProxyEnabled()) return null;
  const origin = publicOriginForRequestHost(rawHost);
  return origin ? publicTerminalWebSocketUrl(origin) : null;
}
