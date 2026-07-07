// Encrypted-at-rest storage for credentials (xAI API key, OAuth tokens,
// integration secrets). Values are sealed with AES-256-GCM using a machine
// key that lives OUTSIDE the project directory (~/.shiba-studio/shiba-studio.key),
// so neither source code nor the repo's data files ever contain usable
// plaintext secrets. Set SHIBA_SECRET_KEY (64 hex chars) to override the
// key file, e.g. for headless or containerized deployments.

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import * as fsSync from 'fs';
import path from 'path';
import { shibaHome } from './data-paths';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  const file = path.join(shibaHome(), 'shiba-studio.key');
  // Pre-rebrand installs named the key grokdesk.key — carry it over so
  // credentials sealed under the old name stay readable.
  const legacy = path.join(shibaHome(), 'grokdesk.key');
  if (!fsSync.existsSync(file) && fsSync.existsSync(legacy)) {
    try {
      fsSync.renameSync(legacy, file);
    } catch {
      return legacy;
    }
  }
  return file;
}

function loadOrCreateKeySync(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = (process.env.SHIBA_SECRET_KEY || process.env.GROKDESK_SECRET_KEY)?.trim();
  if (envKey && /^[0-9a-f]{64}$/i.test(envKey)) {
    cachedKey = Buffer.from(envKey, 'hex');
    return cachedKey;
  }

  const file = keyFilePath();
  try {
    const raw = fsSync.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      cachedKey = Buffer.from(raw, 'hex');
      return cachedKey;
    }
  } catch {
    /* no key yet — generate below */
  }

  const key = randomBytes(32);
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  // mode 0o600 restricts the key to the current user on POSIX; on Windows the
  // file inherits the user-profile ACL, which is equivalently user-private.
  fsSync.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  cachedKey = key;
  return key;
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Seal a plaintext secret as `enc:v1:<base64(iv|tag|ciphertext)>`. */
export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (isEncryptedSecret(plain)) return plain;
  const key = loadOrCreateKeySync();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Open a sealed secret. Plaintext values pass through unchanged so existing
 * unencrypted stores keep working and are migrated on their next save.
 * A sealed value that cannot be opened (e.g. the key file was deleted)
 * returns '' rather than corrupt data.
 */
export function decryptSecret(value: string): string {
  if (!value || !isEncryptedSecret(value)) return value;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, loadOrCreateKeySync(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Where the machine key lives — surfaced in Settings so users know what to back up. */
export function secretKeyLocation(): string {
  if (process.env.SHIBA_SECRET_KEY) return 'SHIBA_SECRET_KEY environment variable';
  if (process.env.GROKDESK_SECRET_KEY) return 'GROKDESK_SECRET_KEY environment variable (legacy name — prefer SHIBA_SECRET_KEY)';
  return keyFilePath();
}
