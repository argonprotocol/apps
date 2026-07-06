import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stats } from '../lib/Stats.ts';
import { botEmitter } from '../lib/Bot.ts';

describe('Stats', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits on the active load instead of resolving early', async () => {
    let resolveCurrencyLoad!: () => void;
    const currencyLoad = new Promise<void>(resolve => {
      resolveCurrencyLoad = resolve;
    });
    const { stats, currency } = createStats({
      currency: {
        load: vi.fn().mockReturnValue(currencyLoad),
      },
    });

    const firstLoad = stats.load();
    const secondLoad = stats.load();
    let didSecondLoadResolve = false;
    void secondLoad.then(() => {
      didSecondLoadResolve = true;
    });

    await Promise.resolve();
    expect(didSecondLoadResolve).toBe(false);

    resolveCurrencyLoad();
    await Promise.all([firstLoad, secondLoad]);

    expect(currency.load).toHaveBeenCalledOnce();
  });

  it('retries a failed bootstrap without duplicating bot subscriptions', async () => {
    const onSpy = vi.spyOn(botEmitter, 'on');
    const { stats } = createStats();
    vi.spyOn(stats as any, 'updateMiningSeats')
      .mockRejectedValueOnce(new Error('bootstrap failed'))
      .mockResolvedValue(undefined);

    const firstLoadedPromise = stats.isLoadedPromise;
    await expect(stats.load()).rejects.toThrow('bootstrap failed');
    await expect(firstLoadedPromise).rejects.toThrow('bootstrap failed');
    expect(onSpy).not.toHaveBeenCalled();

    await expect(stats.load()).resolves.toBeUndefined();
    await expect(stats.isLoadedPromise).resolves.toBeUndefined();

    expect(onSpy).toHaveBeenCalledTimes(3);
  });
});

function createStats(
  args: {
    config?: Record<string, any>;
    currency?: Record<string, any>;
    miningFrames?: Record<string, any>;
  } = {},
) {
  const stats = new Stats(
    Promise.resolve({} as any),
    {
      isLoadedPromise: Promise.resolve(),
      ...args.config,
    } as any,
    {
      load: vi.fn().mockResolvedValue(undefined),
      ...args.currency,
    } as any,
    {
      currentFrameId: 12,
      load: vi.fn().mockResolvedValue(undefined),
      ...args.miningFrames,
    } as any,
  );

  vi.spyOn(stats as any, 'updateDashboard').mockResolvedValue(undefined);
  vi.spyOn(stats as any, 'updateMiningSeats').mockResolvedValue(undefined);
  vi.spyOn(stats as any, 'updateMiningBids').mockResolvedValue(undefined);
  vi.spyOn(stats as any, 'updateAccruedProfits').mockResolvedValue(undefined);
  vi.spyOn(stats as any, 'updateServerState').mockResolvedValue(undefined);

  return {
    stats,
    currency: (stats as any).currency,
  };
}
