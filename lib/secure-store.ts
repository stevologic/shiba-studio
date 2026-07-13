// Encrypted-at-rest storage for credentials (xAI API key, OAuth tokens,
// integration secrets). Values are sealed with AES-256-GCM using a machine
// key that lives OUTSIDE the project directory (~/.shiba-studio/shiba-studio.key),
// so neither source code nor the repo's data files ever contain usable
// plaintext secrets. Set SHIBA_SECRET_KEY (64 hex chars) to override the
// key file, e.g. for headless or containerized deployments.

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import path from 'path';
import { shibaHome } from './data-paths';

// Runtime-only credential paths are intentionally outside the project. A
// static fs import makes Next's file tracer conservatively copy the entire
// repository because the key-file path is user-configurable.
const builtinFs = process.getBuiltinModule?.('fs') as typeof import('fs') | undefined;
if (!builtinFs) throw new Error('Shiba Studio requires Node.js 22.5+');
const fsSync: typeof import('fs') = builtinFs;

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function keyFromHex(raw: string, source: string): Buffer {
  const clean = raw.trim();
  if (!/^[0-9a-f]{64}$/i.test(clean)) {
    throw new Error(`${source} is malformed; expected exactly 64 hexadecimal characters`);
  }
  return Buffer.from(clean, 'hex');
}

function isFsError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function keyFilePath(): string {
  const configured = process.env.SHIBA_SECRET_KEY_FILE?.trim();
  if (configured) return path.resolve(/* turbopackIgnore: true */ configured);
  const file = path.join(/* turbopackIgnore: true */ shibaHome(), 'shiba-studio.key');
  // Pre-rebrand installs named the key grokdesk.key — carry it over so
  // credentials sealed under the old name stay readable.
  const legacy = path.join(/* turbopackIgnore: true */ shibaHome(), 'grokdesk.key');
  if (!fsSync.existsSync(/* turbopackIgnore: true */ file) && fsSync.existsSync(/* turbopackIgnore: true */ legacy)) {
    try {
      fsSync.renameSync(/* turbopackIgnore: true */ legacy, file);
    } catch {
      return legacy;
    }
  }
  return file;
}

function loadOrCreateKeySync(): Buffer {
  if (cachedKey) return cachedKey;

  const envName = process.env.SHIBA_SECRET_KEY !== undefined
    ? 'SHIBA_SECRET_KEY'
    : process.env.GROKDESK_SECRET_KEY !== undefined
      ? 'GROKDESK_SECRET_KEY'
      : null;
  if (envName) {
    cachedKey = keyFromHex(process.env[envName] || '', envName);
    return cachedKey;
  }

  const file = keyFilePath();
  try {
    const raw = fsSync.readFileSync(/* turbopackIgnore: true */ file, 'utf8');
    cachedKey = keyFromHex(raw, `Secret key file ${file}`);
    return cachedKey;
  } catch (error) {
    // Only a genuinely absent key may trigger generation. Replacing an
    // unreadable or malformed key would orphan every encrypted credential.
    if (!isFsError(error, 'ENOENT')) throw error;
    /* no key yet — generate below */
  }

  const key = randomBytes(32);
  fsSync.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  // mode 0o600 restricts the key to the current user on POSIX; on Windows the
  // file inherits the user-profile ACL, which is equivalently user-private.
  try {
    // Exclusive creation prevents two first-start processes from silently
    // overwriting each other's newly generated keys.
    fsSync.writeFileSync(/* turbopackIgnore: true */ file, key.toString('hex'), { mode: 0o600, flag: 'wx' });
    cachedKey = key;
    return key;
  } catch (error) {
    if (!isFsError(error, 'EEXIST')) throw error;
    const raw = fsSync.readFileSync(/* turbopackIgnore: true */ file, 'utf8');
    cachedKey = keyFromHex(raw, `Secret key file ${file}`);
    return cachedKey;
  }
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
 * A sealed value that cannot be opened fails closed. Returning an empty value
 * could let a later save overwrite the only ciphertext with data loss.
 */
export function decryptSecret(value: string): string {
  if (!value || !isEncryptedSecret(value)) return value;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    if (buf.length < IV_LEN + TAG_LEN) throw new Error('Encrypted secret payload is truncated');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, loadOrCreateKeySync(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error('Encrypted secret could not be decrypted; the ciphertext and key were left unchanged', { cause: error });
  }
}

/** Where the machine key lives — surfaced in Settings so users know what to back up. */
export function secretKeyLocation(): string {
  if (process.env.SHIBA_SECRET_KEY !== undefined) return 'SHIBA_SECRET_KEY environment variable';
  if (process.env.GROKDESK_SECRET_KEY !== undefined) return 'GROKDESK_SECRET_KEY environment variable (legacy name — prefer SHIBA_SECRET_KEY)';
  return keyFilePath();
}

/** The active key as 64 hex chars — embedded in backups so encrypted
 *  credentials restore on a new machine. Treat exports like a password. */
export function exportSecretKeyHex(): string {
  return loadOrCreateKeySync().toString('hex');
}

/**
 * Install a key from a backup. Safe rules: a matching key (or env-provided
 * key) is a no-op; a brand-new machine (no key yet) gets the backup's key
 * written; a machine whose existing key DIFFERS is refused — overwriting
 * would brick every secret already sealed on this machine.
 */
export function importSecretKeyHex(hex: string): { ok: boolean; reason?: string } {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) return { ok: false, reason: 'Backup key is malformed (expected 64 hex chars)' };

  const envName = process.env.SHIBA_SECRET_KEY !== undefined
    ? 'SHIBA_SECRET_KEY'
    : process.env.GROKDESK_SECRET_KEY !== undefined
      ? 'GROKDESK_SECRET_KEY'
      : null;
  if (envName) {
    const envKey = (process.env[envName] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(envKey)) {
      return { ok: false, reason: `${envName} is malformed (expected exactly 64 hex characters)` };
    }
    if (envKey === clean) return { ok: true };
    return { ok: false, reason: 'This machine uses SHIBA_SECRET_KEY; set it to the backup’s key to read restored credentials' };
  }

  const file = keyFilePath();
  if (fsSync.existsSync(/* turbopackIgnore: true */ file)) {
    const raw = fsSync.readFileSync(/* turbopackIgnore: true */ file, 'utf8').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(raw)) {
      return { ok: false, reason: 'This machine encryption key file is malformed and was left unchanged' };
    }
    if (raw === clean) return { ok: true };
    return {
      ok: false,
      reason: 'This machine already has a different encryption key. Restored credentials stay sealed under the backup’s key — '
        + 'to adopt them, stop the server, replace ~/.shiba-studio/shiba-studio.key with the key from the backup, and restart.',
    };
  }

  // Fresh machine — install the backup's key so restored secrets open.
  fsSync.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  try {
    fsSync.writeFileSync(/* turbopackIgnore: true */ file, clean, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (!isFsError(error, 'EEXIST')) throw error;
    const raced = fsSync.readFileSync(/* turbopackIgnore: true */ file, 'utf8').trim().toLowerCase();
    if (raced !== clean) {
      return { ok: false, reason: 'A different machine encryption key was installed concurrently; it was left unchanged' };
    }
  }
  cachedKey = Buffer.from(clean, 'hex');
  return { ok: true };
}
