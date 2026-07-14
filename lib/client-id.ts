import { v4 as uuidv4 } from 'uuid';

export interface ClientRandomSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

/**
 * Generate a browser-safe UUID without relying on Crypto.randomUUID, which is
 * unavailable when Studio is opened through an HTTP mDNS name such as
 * shiba.local. getRandomValues remains available in that browser context.
 */
export function createClientId(randomSource: ClientRandomSource = globalThis.crypto): string {
  const random = randomSource.getRandomValues(new Uint8Array(16));
  return uuidv4({ random });
}
