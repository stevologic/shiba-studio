/**
 * Small client-side JSON resource coordinator.
 *
 * React transitions, Strict Mode, the shell, and an active panel can all ask
 * for the same resource at nearly the same time. Sharing the underlying GET
 * avoids duplicate disk/database work. If an SSE invalidation lands while a
 * request is running, the in-flight result is discarded and one trailing
 * request is made so deduplication never hides newer data.
 */
'use client';

interface JsonEntry {
  value?: unknown;
  loadedAt: number;
  promise: Promise<unknown> | null;
  dirty: boolean;
  /** Incremented when a mutation installs an authoritative response snapshot. */
  snapshotVersion: number;
}

interface ClientJsonOptions {
  /** Reuse the last successful value for this many milliseconds. */
  maxAgeMs?: number;
  /** Stops only this caller from applying the result; the shared GET continues. */
  signal?: AbortSignal;
}

const entries = new Map<string, JsonEntry>();

function entryFor(url: string): JsonEntry {
  const existing = entries.get(url);
  if (existing) return existing;
  const entry: JsonEntry = { loadedAt: 0, promise: null, dirty: false, snapshotVersion: 0 };
  entries.set(url, entry);
  return entry;
}

function abortError(): Error {
  const error = new Error('The request was aborted');
  error.name = 'AbortError';
  return error;
}

function forCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
      .catch(() => {});
  });
}

function startJsonRequest<T>(url: string, entry: JsonEntry): Promise<T> {
  const run = (async () => {
    // An invalidation during fetch marks this pass dirty. Do not publish that
    // possibly stale snapshot; immediately fetch one clean trailing snapshot.
    for (;;) {
      entry.dirty = false;
      const snapshotVersion = entry.snapshotVersion;
      const response = await fetch(url, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = data && typeof data === 'object' && 'error' in data
          ? String((data as { error?: unknown }).error || `Request failed (${response.status})`)
          : `Request failed (${response.status})`;
        throw new Error(message);
      }
      if (entry.dirty) continue;
      // A successful mutation may have supplied a newer authoritative value
      // while this GET was running. Resolve consumers with that snapshot and
      // never let the older response overwrite it.
      if (entry.snapshotVersion !== snapshotVersion && entry.value !== undefined) {
        return entry.value as T;
      }
      entry.value = data;
      entry.loadedAt = Date.now();
      return data as T;
    }
  })();
  entry.promise = run;
  void run.finally(() => {
    if (entry.promise === run) entry.promise = null;
  }).catch(() => {});
  return run;
}

/** Load a same-origin JSON GET with cross-component single-flight semantics. */
export function loadClientJson<T>(url: string, options: ClientJsonOptions = {}): Promise<T> {
  const entry = entryFor(url);
  const maxAgeMs = Math.max(0, options.maxAgeMs || 0);
  if (
    entry.value !== undefined
    && maxAgeMs > 0
    && Date.now() - entry.loadedAt < maxAgeMs
    && !entry.dirty
  ) {
    return forCaller(Promise.resolve(entry.value as T), options.signal);
  }
  const shared = (entry.promise as Promise<T> | null) || startJsonRequest<T>(url, entry);
  return forCaller(shared, options.signal);
}

/**
 * Mark a resource stale. If it is currently loading, that shared request will
 * perform exactly one clean trailing read before resolving.
 */
export function invalidateClientJson(url: string): void {
  const entry = entryFor(url);
  entry.loadedAt = 0;
  if (entry.promise) entry.dirty = true;
  else entry.value = undefined;
}

/**
 * Install the authoritative JSON returned by a successful mutation. This
 * avoids an immediate GET of data the server already returned, while keeping
 * later SSE invalidations able to force a fresh read.
 */
export function setClientJsonSnapshot<T>(url: string, value: T): void {
  const entry = entryFor(url);
  entry.snapshotVersion += 1;
  entry.value = value;
  entry.loadedAt = Date.now();
  entry.dirty = false;
}

/** Timestamp of the latest successful snapshot, used to ignore older SSE events. */
export function clientJsonLoadedAt(url: string): number {
  return entries.get(url)?.loadedAt || 0;
}

/** Test-only reset; deliberately not used by product code. */
export function clearClientJsonCacheForTests(): void {
  entries.clear();
}
