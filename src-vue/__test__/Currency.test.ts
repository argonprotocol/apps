import { afterEach, describe, expect, it, vi } from 'vitest';
import { Currency, UnitOfMeasurement } from '../lib/Currency.ts';

describe('Currency', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});

function createCurrentPriceIndexQuery() {
  const option = {
    isSome: false,
    toHex: () => '0x00',
    unwrap: () => {
      throw new Error('should not unwrap an empty price index');
    },
  };

  return vi.fn((callback?: (value: typeof option) => void) => {
    if (callback) {
      callback(option);
      return Promise.resolve(() => undefined);
    }
    return Promise.resolve(option);
  });
}
