import {
  clearClientJsonCacheForTests,
  clientJsonLoadedAt,
  invalidateClientJson,
  loadClientJson,
  setClientJsonSnapshot,
} from '../lib/client-json';

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  passed += 1;
  console.log(`PASS ${message}`);
}

type Pending = { resolve: (response: Response) => void };

async function verifyLiveEventConnection() {
  const mutableGlobal = globalThis as unknown as Record<string, unknown>;
  const originalWindow = mutableGlobal.window;
  const originalEventSource = mutableGlobal.EventSource;
  let current: FakeEventSource | null = null;

  class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = FakeEventSource.OPEN;
    url: string;
    withCredentials = false;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(url: string | URL) {
      this.url = String(url);
      // The test needs the concrete fake instance so it can simulate open/reconnect events.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      current = this;
    }
    close() { this.readyState = FakeEventSource.CLOSED; }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  }

  mutableGlobal.window = {};
  mutableGlobal.EventSource = FakeEventSource;
  try {
    const { subscribeLiveEvents } = await import('../lib/live-events');
    let reconnects = 0;
    let concreteEvents = 0;
    const unsubscribe = subscribeLiveEvents(['runs', 'tasks'], (_type, meta) => {
      if (meta.reconnect) reconnects += 1;
      else concreteEvents += 1;
    });
    const source = current as FakeEventSource | null;
    assert(!!source, 'one shared EventSource is created for a subscription');
    source!.onopen?.(new Event('open'));
    assert(Number(reconnects) === 0, 'initial EventSource open does not reload freshly loaded data');
    source!.onopen?.(new Event('open'));
    assert(Number(reconnects) === 1, 'a real reconnect invokes the subscription once, not once per type');
    source!.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({ type: 'tasks', ts: new Date().toISOString() }),
    }));
    assert(Number(concreteEvents) === 1, 'a concrete invalidation is delivered once');
    unsubscribe();
  } finally {
    if (originalWindow === undefined) delete mutableGlobal.window;
    else mutableGlobal.window = originalWindow;
    if (originalEventSource === undefined) delete mutableGlobal.EventSource;
    else mutableGlobal.EventSource = originalEventSource;
  }
}

async function main() {
  const originalFetch = globalThis.fetch;
  const pending: Pending[] = [];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Promise<Response>((resolve) => pending.push({ resolve }));
  }) as typeof fetch;

  try {
    clearClientJsonCacheForTests();
    const first = loadClientJson<{ value: number }>('/api/probe');
    const second = loadClientJson<{ value: number }>('/api/probe');
    assert(calls === 1, 'concurrent consumers share one GET');
    pending.shift()!.resolve(Response.json({ value: 1 }));
    assert((await first).value === 1 && (await second).value === 1, 'shared consumers receive the same snapshot');

    const cached = await loadClientJson<{ value: number }>('/api/probe', { maxAgeMs: 1_000 });
    assert(cached.value === 1 && calls === 1, 'fresh cache avoids a remount GET');
    assert(clientJsonLoadedAt('/api/probe') > 0, 'successful load records freshness time');

    invalidateClientJson('/api/probe');
    const latest = loadClientJson<{ value: number }>('/api/probe');
    assert(Number(calls) === 2, 'invalidated resource starts a fresh GET');
    invalidateClientJson('/api/probe');
    pending.shift()!.resolve(Response.json({ value: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(Number(calls) === 3, 'in-flight invalidation causes one trailing GET');
    pending.shift()!.resolve(Response.json({ value: 3 }));
    assert((await latest).value === 3, 'dirty in-flight snapshot is never published');

    const beforeMutation = loadClientJson<{ value: number }>('/api/mutation');
    assert(Number(calls) === 4, 'mutation test starts one GET');
    setClientJsonSnapshot('/api/mutation', { value: 9 });
    pending.shift()!.resolve(Response.json({ value: 4 }));
    assert((await beforeMutation).value === 9, 'mutation snapshot wins over an older in-flight GET');
    const mutationCached = await loadClientJson<{ value: number }>('/api/mutation', { maxAgeMs: 1_000 });
    assert(mutationCached.value === 9 && Number(calls) === 4, 'mutation response is reused without an immediate GET');
    invalidateClientJson('/api/mutation');
    const afterMutation = loadClientJson<{ value: number }>('/api/mutation');
    pending.shift()!.resolve(Response.json({ value: 10 }));
    assert((await afterMutation).value === 10, 'a later invalidation still refreshes a mutation snapshot');

    await verifyLiveEventConnection();
    console.log(`${passed} passed, 0 failed`);
  } finally {
    globalThis.fetch = originalFetch;
    clearClientJsonCacheForTests();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
