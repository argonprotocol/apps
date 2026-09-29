/**
 * Lets historical Mainchain RPC reads recover without restarting the client.
 *
 * Polkadot.js 16.5.6 and 17.0.1 cache request promises even when they resolve to null or reject.
 * Repeated retries can keep a failed read cached after the node recovers, trapping
 * bot startup in a sync loop. Its call cache is private and cannot be supplied by
 * the caller, so these providers reuse its transports and bypass that cache.
 *
 * Our bounded cache deduplicates pending reads, retains successful results for a
 * fixed TTL, and evicts misses and errors. Disconnects and clones get fresh caches
 * so transient RPC failures do not become permanent client state.
 */
import type { ArgonClient } from '@argonprotocol/mainchain';
import { MainchainApi } from '@argonprotocol/runtime-client';
import { HttpProvider, WsProvider } from '@polkadot/rpc-provider';
import { stringify } from '@polkadot/util';
import { LRUCache } from 'lru-cache';

type RpcCacheOptions = Pick<LRUCache.OptionsMaxLimit<string, Promise<unknown>, unknown>, 'max' | 'ttl'>;
const defaultCacheOptions: RpcCacheOptions = { max: 1024, ttl: 30_000 };

export async function getMainchainClient(host: string): Promise<ArgonClient> {
  const provider = host.startsWith('http') ? new MainchainHttpProvider(host) : new MainchainWsProvider(host);
  try {
    return await MainchainApi.create({ provider, noInitWarn: true, throwOnConnect: true });
  } catch (error) {
    await provider.disconnect();
    throw error;
  }
}

export class MainchainWsProvider extends WsProvider {
  private readonly callCache: RpcCallCache;

  constructor(
    private readonly endpoints: string | string[],
    private readonly cacheOptions: RpcCacheOptions = defaultCacheOptions,
  ) {
    const callCache = new RpcCallCache(cacheOptions);
    super(endpoints);
    this.callCache = callCache;
    this.on('disconnected', () => this.callCache.clear());
  }

  public override send<T>(
    method: string,
    params: unknown[],
    isCacheable?: boolean,
    subscription?: Parameters<WsProvider['send']>[3],
  ): Promise<T> {
    return this.callCache.send(method, params, isCacheable, () => super.send<T>(method, params, false, subscription));
  }

  public override clone(): MainchainWsProvider {
    return new MainchainWsProvider(this.endpoints, this.cacheOptions);
  }

  public override async disconnect(): Promise<void> {
    this.callCache.clear();
    await super.disconnect();
  }
}

export class MainchainHttpProvider extends HttpProvider {
  private readonly callCache: RpcCallCache;

  constructor(
    private readonly url: string,
    private readonly cacheOptions: RpcCacheOptions = defaultCacheOptions,
  ) {
    const callCache = new RpcCallCache(cacheOptions);
    super(url);
    this.callCache = callCache;
  }

  public override send<T>(method: string, params: unknown[], isCacheable?: boolean): Promise<T> {
    return this.callCache.send(method, params, isCacheable, () => super.send<T>(method, params, false));
  }

  public override clone(): MainchainHttpProvider {
    return new MainchainHttpProvider(this.url, this.cacheOptions);
  }

  public override async disconnect(): Promise<void> {
    this.callCache.clear();
    await super.disconnect();
  }
}

class RpcCallCache {
  private readonly requests: LRUCache<string, Promise<unknown>>;

  constructor(options: RpcCacheOptions) {
    this.requests = new LRUCache({ ...options, ttlResolution: 0 });
  }

  public send<T>(
    method: string,
    params: unknown[],
    isCacheable: boolean | undefined,
    send: () => Promise<T>,
  ): Promise<T> {
    if (!isCacheable) return send();

    const cacheKey = `${method}::${stringify(params)}`;
    const cached = this.requests.get(cacheKey);
    if (cached) return cached as Promise<T>;

    const pending = send().then(
      result => {
        if (result == null && this.requests.peek(cacheKey) === pending) this.requests.delete(cacheKey);
        return result;
      },
      error => {
        // A newer request may have replaced this one after expiry or disconnect.
        if (this.requests.peek(cacheKey) === pending) this.requests.delete(cacheKey);
        throw error;
      },
    );
    this.requests.set(cacheKey, pending);
    return pending;
  }

  public clear(): void {
    this.requests.clear();
  }
}
