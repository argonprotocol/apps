import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyMiningSeats } from '../lib/MyMiningSeats.ts';
import { botEmitter } from '../lib/Bot.ts';

describe('MyMiningSeats', () => {
  afterEach(() => {
    botEmitter.all.clear();
    vi.restoreAllMocks();
  });

  it('waits on the active load instead of resolving early', async () => {
    let resolveCurrencyLoad!: () => void;
    const currencyLoad = new Promise<void>(resolve => {
      resolveCurrencyLoad = resolve;
    });
    const { myMiningSeats, currency } = createMyMiningSeats({
      currency: {
        load: vi.fn().mockReturnValue(currencyLoad),
      },
    });

    const firstLoad = myMiningSeats.load();
    const secondLoad = myMiningSeats.load();
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

  it('does not reread server state after a cohort update from the same bot sync', async () => {
    const { myMiningSeats, updateMiningSeats, updateServerState } = createMyMiningSeats();
    await myMiningSeats.load();
    updateMiningSeats.mockClear();
    updateServerState.mockClear();

    botEmitter.emit('updated-server-state');
    botEmitter.emit('updated-cohort-data', 13);

    await vi.waitFor(() => {
      expect(myMiningSeats.latestFrameId).toBe(13);
    });
    expect(updateMiningSeats).toHaveBeenCalledOnce();
    expect(updateMiningSeats).toHaveBeenCalledWith(3);
    expect(updateServerState).toHaveBeenCalledOnce();
  });

  it('retries a failed bootstrap without duplicating bot subscriptions', async () => {
    const onSpy = vi.spyOn(botEmitter, 'on');
    const { myMiningSeats } = createMyMiningSeats({
      currency: {
        load: vi.fn().mockRejectedValueOnce(new Error('bootstrap failed')).mockResolvedValue(undefined),
      },
    });

    const firstLoadedPromise = myMiningSeats.isLoadedPromise;
    await expect(myMiningSeats.load()).rejects.toThrow('bootstrap failed');
    await expect(firstLoadedPromise).rejects.toThrow('bootstrap failed');
    expect(onSpy).not.toHaveBeenCalled();

    await expect(myMiningSeats.load()).resolves.toBeUndefined();
    await expect(myMiningSeats.isLoadedPromise).resolves.toBeUndefined();

    expect(onSpy).toHaveBeenCalledTimes(4);
  });
});

function createMyMiningSeats(
  args: {
    config?: Record<string, any>;
    currency?: Record<string, any>;
    miningFrames?: Record<string, any>;
  } = {},
) {
  const currency = {
    load: vi.fn().mockResolvedValue(undefined),
    ...args.currency,
  };
  const myMiningSeats = new MyMiningSeats(
    Promise.resolve({} as any),
    {
      isLoadedPromise: Promise.resolve(),
      ...args.config,
    } as any,
    currency as any,
    {
      currentFrameId: 12,
      load: vi.fn().mockResolvedValue(undefined),
      ...args.miningFrames,
    } as any,
  );

  const updateMiningSeats = vi.spyOn(myMiningSeats as any, 'updateMiningSeats').mockResolvedValue(undefined);
  vi.spyOn(myMiningSeats as any, 'updateMiningBids').mockResolvedValue(undefined);
  const updateServerState = vi.spyOn(myMiningSeats as any, 'updateServerState').mockResolvedValue(undefined);

  return {
    myMiningSeats,
    updateMiningSeats,
    updateServerState,
    currency,
  };
}
