'use client';

// A non-extractable AES-GCM key is structured-cloned into this browser
// profile's IndexedDB. Copied cache records and device tokens are unusable
// without that device-bound key.

const DB_NAME = 'shiba-companion-v1';
const STORE_NAME = 'device-bound';
const KEY_ID = 'crypto-key';
const SESSION_ID = 'session';
const SUMMARY_ID = 'summary';

interface SealedValue {
  iv: string;
  ciphertext: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open companion cache'));
  });
}

async function readValue<T>(id: string): Promise<T | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error || new Error('Could not read companion cache'));
    transaction.oncomplete = () => database.close();
  });
}

async function writeValue(id: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, id);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Could not write companion cache')); };
  });
}

async function deviceKey(): Promise<CryptoKey> {
  const existing = await readValue<CryptoKey>(KEY_ID);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await writeValue(KEY_ID, key);
  return key;
}

async function seal(value: unknown): Promise<SealedValue> {
  const key = await deviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function open<T>(value: SealedValue | null): Promise<T | null> {
  if (!value) return null;
  try {
    const key = await deviceKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(value.iv) },
      key,
      base64ToBytes(value.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

export async function saveCompanionSession(value: unknown): Promise<void> {
  await writeValue(SESSION_ID, await seal(value));
}

export async function loadCompanionSession<T>(): Promise<T | null> {
  return open<T>(await readValue<SealedValue>(SESSION_ID));
}

export async function saveCompanionSummary(value: unknown): Promise<void> {
  await writeValue(SUMMARY_ID, await seal(value));
}

export async function loadCompanionSummary<T>(): Promise<T | null> {
  return open<T>(await readValue<SealedValue>(SUMMARY_ID));
}

export async function clearCompanionDevice(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
