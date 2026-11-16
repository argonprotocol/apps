interface IRpcCallStats {
  requests: number;
  cacheHits: number;
  errors: number;
  pending: number;
  peakPending: number;
  totalMs: number;
  maxMs: number;
}

/** Request metadata only: parameters, storage keys and response values are never retained. */
export class RpcStats {
  private readonly startedAt = performance.now();
  private readonly total = RpcStats.createCounters();
  private readonly methods = new Map<string, IRpcCallStats>();
  private readonly storage = new Map<string, number>();
  private readonly storageNames = new Map<string, string>();
  private readonly windows = new Map<number, IRpcCallStats>();

  public snapshot() {
    return {
      elapsedMs: Math.round(performance.now() - this.startedAt),
      total: { ...this.total },
      methods: Object.fromEntries([...this.methods].map(([method, stats]) => [method, { ...stats }])),
      storage: Object.fromEntries(
        [...this.storage].map(([prefix, reads]) => [this.storageNames.get(prefix) ?? prefix, reads]),
      ),
      windows: [...this.windows].map(([fromMs, stats]) => ({ fromMs, ...stats })),
    };
  }

  public nameStorage(prefix: string, name: string): void {
    this.storageNames.set(prefix, name);
  }

  public request<T>(method: string, params: unknown[], cached: boolean, send: () => Promise<T>): Promise<T> {
    let name = method;
    if (method === 'state_call' && typeof params[0] === 'string' && /^[a-zA-Z0-9_]+$/.test(params[0])) {
      name += `.${params[0]}`;
    }

    let stats = this.methods.get(name);
    if (!stats) {
      stats = RpcStats.createCounters();
      this.methods.set(name, stats);
    }

    const startedAt = performance.now();
    const fromMs = Math.floor((startedAt - this.startedAt) / 10_000) * 10_000;
    let window = this.windows.get(fromMs);
    if (!window) {
      window = RpcStats.createCounters();
      this.windows.set(fromMs, window);
      if (this.windows.size > 60) this.windows.delete(this.windows.keys().next().value!);
    }
    const counters = [this.total, stats, window];
    if (cached) {
      for (const counter of counters) counter.cacheHits++;
      return send();
    }

    for (const counter of counters) {
      counter.requests++;
      counter.pending++;
      counter.peakPending = Math.max(counter.peakPending, counter.pending);
    }
    window.peakPending = Math.max(window.peakPending, this.total.pending);
    // Only the fixed pallet/storage prefix is counted, never the account or map-key suffix.
    let keys: unknown[] = [];
    if (method === 'state_getStorage' || method === 'state_getKeysPaged') keys = [params[0]];
    if (method === 'state_queryStorageAt' || method === 'state_subscribeStorage') {
      if (Array.isArray(params[0])) keys = params[0];
    }
    for (const key of keys) {
      if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}/.test(key)) continue;
      const prefix = key.slice(0, 66);
      this.storage.set(prefix, (this.storage.get(prefix) ?? 0) + 1);
    }

    let response: Promise<T>;
    try {
      response = send();
    } catch (error) {
      this.complete(counters, startedAt, true);
      throw error;
    }
    return response.then(
      result => {
        this.complete(counters, startedAt, false);
        return result;
      },
      error => {
        this.complete(counters, startedAt, true);
        throw error;
      },
    );
  }

  private complete(counters: IRpcCallStats[], startedAt: number, failed: boolean): void {
    const durationMs = performance.now() - startedAt;
    for (const counter of counters) {
      counter.pending--;
      counter.totalMs += durationMs;
      counter.maxMs = Math.max(counter.maxMs, durationMs);
      if (failed) counter.errors++;
    }
  }

  private static createCounters(): IRpcCallStats {
    return { requests: 0, cacheHits: 0, errors: 0, pending: 0, peakPending: 0, totalMs: 0, maxMs: 0 };
  }
}
