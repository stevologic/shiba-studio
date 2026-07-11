// Partial masking for stored secrets. The server never ships a full key to
// the browser: display surfaces get `xai-ab…7f3a` style fingerprints (enough
// to recognize WHICH key is stored, useless to steal), and save/test paths
// substitute the stored value whenever a masked placeholder round-trips back.
// Client-safe: pure string logic, no Node imports.

/** Mask marker — real tokens never contain '…' or '•'. */
const ELLIPSIS = '…';

/**
 * Partial fingerprint of a secret: first 6 + … + last 4 for long values,
 * all-bullets for short ones (revealing 10 chars of a short secret would
 * give too much of it away).
 */
export function maskSecret(value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (v.length < 16) return '••••••••';
  return `${v.slice(0, 6)}${ELLIPSIS}${v.slice(-4)}`;
}

/** True when a value is a mask placeholder rather than a real secret. */
export function isMaskedSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.includes(ELLIPSIS) || /^•+$/.test(value.trim());
}

/**
 * Credential fields that hold secrets, by field-name suffix. Deliberately a
 * suffix match: `tokenExpiry`, `clientId`, `vaultPath`, `baseUrl`, `email`,
 * `channel` must stay readable.
 */
const SECRET_FIELD_RE = /(token|secret|key|password|serviceaccountjson)$/i;

export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_RE.test(name);
}

type CredsMap = Record<string, unknown>;

/** Deep-mask every secret string field of an integrations map (service → fields). */
export function maskIntegrationCreds<T extends object>(integrations: T): T {
  const out: CredsMap = {};
  for (const [service, fields] of Object.entries((integrations || {}) as CredsMap)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      out[service] = fields;
      continue;
    }
    const masked: CredsMap = {};
    for (const [k, v] of Object.entries(fields as CredsMap)) {
      masked[k] = typeof v === 'string' && v && isSecretFieldName(k) ? maskSecret(v) : v;
    }
    out[service] = masked;
  }
  return out as T;
}

/**
 * Reverse direction: a client sent creds that may contain mask placeholders
 * (it only ever saw masked values). Replace every masked field with the
 * currently stored secret so saves/tests operate on real credentials.
 */
export function restoreMaskedCreds<T extends object>(incoming: T, stored: object): T {
  const out: CredsMap = {};
  const storedMap = (stored || {}) as CredsMap;
  for (const [service, fields] of Object.entries((incoming || {}) as CredsMap)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      out[service] = fields;
      continue;
    }
    const storedFields = (storedMap[service] && typeof storedMap[service] === 'object')
      ? (storedMap[service] as CredsMap)
      : {};
    const restored: CredsMap = {};
    for (const [k, v] of Object.entries(fields as CredsMap)) {
      restored[k] = isMaskedSecret(v) && typeof storedFields[k] === 'string'
        ? storedFields[k]
        : v;
    }
    out[service] = restored;
  }
  return out as T;
}
