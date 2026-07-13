/**
 * Team-scoped API keys — store only a hash; return the raw secret once.
 * BoxyHQ team ApiKey pattern (hashed at rest).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface StoredApiKey {
  id: string;
  teamId: string;
  name: string;
  /** sha256 hex of the secret. */
  hash: string;
  /** First 8 chars of secret for UI display. */
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface IssuedApiKey {
  record: StoredApiKey;
  /** Shown once to the caller — never persisted. */
  secret: string;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export class TeamApiKeyVault {
  private readonly keys = new Map<string, StoredApiKey>();

  issue(teamId: string, name: string): IssuedApiKey {
    const id = `key_${randomBytes(8).toString('hex')}`;
    const secret = `ssk_${randomBytes(24).toString('base64url')}`;
    const record: StoredApiKey = {
      id,
      teamId,
      name,
      hash: hashSecret(secret),
      prefix: secret.slice(0, 12),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.keys.set(id, record);
    return { record, secret };
  }

  revoke(keyId: string): boolean {
    const rec = this.keys.get(keyId);
    if (!rec || rec.revokedAt) return false;
    rec.revokedAt = new Date().toISOString();
    return true;
  }

  /**
   * Resolve a bearer secret to a stored key if valid and not revoked.
   */
  verify(secret: string): StoredApiKey | null {
    const candidateHash = hashSecret(secret);
    for (const rec of this.keys.values()) {
      if (rec.revokedAt) continue;
      if (safeEqualHex(rec.hash, candidateHash)) return { ...rec };
    }
    return null;
  }

  listForTeam(teamId: string): StoredApiKey[] {
    return [...this.keys.values()]
      .filter((k) => k.teamId === teamId)
      .map((k) => ({ ...k }));
  }
}
