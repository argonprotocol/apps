import { afterEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { setFetchImplementation } from '@argonprotocol/apps-core';
import { Currency, UnitOfMeasurement } from '../lib/Currency.ts';

describe('Currency', () => {
  afterEach(() => {
    setFetchImplementation();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not invent an ETH value when price feeds fail and recovers when a feed returns', async () => {
    let ethPriceAvailable = false;
    setFetchImplementation(async input => {
      const url = String(input);
      if (url.includes('ETH-USD/ticker') || url.includes('api.kraken.com')) {
        if (!ethPriceAvailable) throw new Error('Price feed unavailable');
        return new Response(JSON.stringify({ price: '2500' }), { status: 200 });
      }
      return new Response(JSON.stringify({ rates: {} }), { status: 200 });
    });

    const current = vi.fn(async () => ({
      btcUsdPrice: BigNumber(50_000),
      argonotUsdPrice: BigNumber(1),
      argonUsdPrice: BigNumber(1),
      argonUsdTargetPrice: BigNumber(1),
      argonTimeWeightedAverageLiquidity: BigNumber(0),
      tick: 1,
    }));
    const currency = new Currency(
      {
        prunedClientOrArchivePromise: Promise.resolve({ query: { priceIndex: { current } } }),
        events: { on: vi.fn() },
      } as any,
      { isLoadedPromise: Promise.resolve(), defaultCurrencyKey: UnitOfMeasurement.ARGN } as any,
    );
    currency.microgonsPer = { ...currency.microgonsPer };

    vi.useFakeTimers();
    await currency.load();
    expect(currency.microgonsPer.ETH).toBe(1_000_000n);
    expect(currency.hasEthPrice).toBe(false);
    expect(() => currency.convertEthToMicrogon(1)).toThrow('ETH price is unavailable.');

    ethPriceAvailable = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(currency.microgonsPer.ETH).toBe(2_500_000_000n);
    expect(currency.hasEthPrice).toBe(true);
    expect(currency.convertEthToMicrogon(1)).toBe(2_500_000_000n);

    ethPriceAvailable = false;
    await currency.fetchMainchainRates();
    expect(currency.microgonsPer.ETH).toBe(2_500_000_000n);
    expect(currency.hasEthPrice).toBe(true);
  });

  it('retries the initial load after a config bootstrap failure', async () => {
    let shouldFailConfig = true;
    const current = createCurrentPriceIndexQuery();
    const currency = new Currency(
      {
        prunedClientOrArchivePromise: Promise.resolve({
          query: {
            priceIndex: { current },
          },
        }),
        events: { on: vi.fn() },
      } as any,
      {
        get isLoadedPromise() {
          return shouldFailConfig ? Promise.reject(new Error('config failed')) : Promise.resolve();
        },
        defaultCurrencyKey: UnitOfMeasurement.USD,
      } as any,
    );

    const firstLoadedPromise = currency.isLoadedPromise;
    await expect(currency.load()).rejects.toThrow('config failed');
    await expect(firstLoadedPromise).rejects.toThrow('config failed');

    shouldFailConfig = false;

    await expect(currency.load()).resolves.toBeUndefined();
    await expect(currency.isLoadedPromise).resolves.toBeUndefined();

    expect(currency.key).toBe(UnitOfMeasurement.USD);
    expect(current).toHaveBeenCalledTimes(2);
  });

  it('shares the in-flight initial load', async () => {
    let resolveConfig!: () => void;
    const configReady = new Promise<void>(resolve => {
      resolveConfig = resolve;
    });
    const current = createCurrentPriceIndexQuery();
    const currency = new Currency(
      {
        prunedClientOrArchivePromise: Promise.resolve({
          query: {
            priceIndex: { current },
          },
        }),
        events: { on: vi.fn() },
      } as any,
      {
        isLoadedPromise: configReady,
        defaultCurrencyKey: UnitOfMeasurement.USD,
      } as any,
    );

    const firstLoad = currency.load();
    const secondLoad = currency.load();
    let didSecondLoadResolve = false;
    void secondLoad.then(() => {
      didSecondLoadResolve = true;
    });

    await Promise.resolve();
    expect(didSecondLoadResolve).toBe(false);

    resolveConfig();
    await Promise.all([firstLoad, secondLoad]);

    expect(current).toHaveBeenCalledTimes(2);
  });

  it('values argonots at a fixed historical price', () => {
    expect(Currency.convertMicronotToMicrogonAtPrice(1_500_000n, 2_000_000n)).toBe(3_000_000n);
  });

  it('calculates the argons minted to guarantee the mining floor', () => {
    expect(
      Currency.microgonsMintedForMiningFloor({
        microgonsMined: 1_000_000n,
        microgonsMinted: 0n,
        micronotsMined: 1_000_000n,
        argonotPrice: 2_000_000n,
        microgonFloor: 5_000_000n,
      }),
    ).toBe(2_000_000n);
  });

  it('shares historical rate reads by block hash without changing current rates', async () => {
    const priceIndex = {
      btcUsdPrice: BigNumber(20),
      argonotUsdPrice: BigNumber(4),
      argonUsdPrice: BigNumber(2),
      argonUsdTargetPrice: BigNumber(2),
      argonTimeWeightedAverageLiquidity: BigNumber(0),
      tick: 1,
    };
    const current = vi.fn(async () => priceIndex);
    const currency = new Currency(
      { events: { on: vi.fn() } } as any,
      { isLoadedPromise: Promise.resolve(), defaultCurrencyKey: UnitOfMeasurement.USD } as any,
    );
    currency.microgonsPer = {
      ...currency.microgonsPer,
      ARGNOT: 9n,
      BTC: 8n,
      USD: 7n,
    };
    currency.priceIndex.argonotUsdPrice = BigNumber(9);

    const api = { query: { priceIndex: { current } } } as any;
    const first = currency.fetchMainchainRatesAtBlock({ api, block: { blockHash: '0x01' } });
    const second = currency.fetchMainchainRatesAtBlock({ api, block: { blockHash: '0x01' } });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ARGNOT: 2_000_000n, BTC: 10_000_000n, USD: 500_000n },
      { ARGNOT: 2_000_000n, BTC: 10_000_000n, USD: 500_000n },
    ]);
    expect(current).toHaveBeenCalledOnce();
    expect(currency.microgonsPer).toMatchObject({ ARGNOT: 9n, BTC: 8n, USD: 7n });
    expect(currency.priceIndex.argonotUsdPrice?.toNumber()).toBe(9);
  });
});

function createCurrentPriceIndexQuery() {
  const current = null;

  return vi.fn((callback?: (value: typeof current) => void) => {
    if (callback) {
      callback(current);
      return Promise.resolve(() => undefined);
    }
    return Promise.resolve(current);
  });
}
