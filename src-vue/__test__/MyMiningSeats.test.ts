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

    const subscribedEvents = onSpy.mock.calls.map(([event]) => event);
    expect(subscribedEvents.length).toBeGreaterThan(0);
    expect(new Set(subscribedEvents).size).toBe(subscribedEvents.length);
  });

  it('applies a server mining summary without rereading the local mining tables', async () => {
    const { myMiningSeats } = createMyMiningSeats();
    await myMiningSeats.load();

    botEmitter.emit('updated-mining-summary', {
      observedAt: new Date('2026-07-28T12:00:00Z'),
      sourceBlockNumber: 456,
      latestFrameId: 13,
      cohorts: [
        {
          id: 12,
          progress: 10,
          transactionFeesTotal: 100n,
          micronotsStakedPerSeat: 200n,
          microgonsBidPerSeat: 300n,
          seatCountWon: 1,
          microgonsToBeMinedPerSeat: 400n,
          micronotsToBeMinedPerSeat: 500n,
          argonotPriceAtBid: 2_000_000n,
          closingArgonotPrice: 0n,
          micronotsMinedTotal: 10n,
          microgonsMinedTotal: 20n,
          microgonsMintedTotal: 30n,
          microgonFeesCollectedTotal: 40n,
        },
      ],
      frames: [],
      currentBids: [
        {
          frameId: 13,
          confirmedAtBlockNumber: 456,
          address: '5-bidder',
          subAccountIndex: 0,
          microgonsPerSeat: 600n,
          micronotsStakedPerSeat: 700n,
          bidPosition: 0,
        },
      ],
      global: {
        seatsTotal: 1,
        framesCompleted: 1,
        framesRemaining: 9,
        framedCost: 50n,
        transactionFeesTotal: 100n,
        microgonsBidTotal: 300n,
        micronotsMinedTotal: 10n,
        microgonsMinedTotal: 20n,
        microgonsMintedTotal: 30n,
      },
    });

    await vi.waitFor(() => {
      expect(myMiningSeats.latestFrameId).toBe(13);
      expect(myMiningSeats.miningCohorts[0]?.microgonsMinedTotal).toBe(20n);
      expect(myMiningSeats.pendingBids).toEqual({
        bidCount: 1,
        microgonsBidTotal: 600n,
        micronotsStakedTotal: 700n,
      });
      expect(myMiningSeats.getCohortsByIds([12, 99]).map(cohort => cohort.id)).toEqual([12]);
    });
  });

  it('restores the cached server mining summary during startup', async () => {
    const summary = {
      observedAt: new Date('2026-07-28T12:00:00Z'),
      sourceBlockNumber: 456,
      latestFrameId: 13,
      cohorts: [],
      frames: [],
      currentBids: [],
      global: {
        seatsTotal: 2,
        framesCompleted: 5,
        framesRemaining: 15,
        framedCost: 100n,
        transactionFeesTotal: 10n,
        microgonsBidTotal: 90n,
        micronotsMinedTotal: 20n,
        microgonsMinedTotal: 30n,
        microgonsMintedTotal: 40n,
      },
    };
    const { myMiningSeats } = createMyMiningSeats({
      db: {
        financialCacheTable: {
          get: vi.fn().mockResolvedValue(summary),
        },
      },
    });

    await myMiningSeats.load();
    await myMiningSeats.subscribeToDashboard();

    expect(myMiningSeats.latestFrameId).toBe(13);
    expect(myMiningSeats.global.seatsTotal).toBe(2);
  });

  it('continues startup when cached mining summary restoration fails', async () => {
    const { myMiningSeats } = createMyMiningSeats({
      db: {
        financialCacheTable: {
          get: vi.fn().mockRejectedValue(new Error('corrupt cache')),
        },
      },
    });

    await expect(myMiningSeats.load()).resolves.toBeUndefined();

    expect(myMiningSeats.isLoaded).toBe(true);
    expect(myMiningSeats.miningCohorts).toEqual([]);
  });
});

function createMyMiningSeats(
  args: {
    config?: Record<string, any>;
    currency?: Record<string, any>;
    miningFrames?: Record<string, any>;
    db?: Record<string, any>;
  } = {},
) {
  const currency = {
    load: vi.fn().mockResolvedValue(undefined),
    microgonsPer: { ARGNOT: 1_000_000n },
    ...args.currency,
  };
  const myMiningSeats = new MyMiningSeats(
    Promise.resolve({
      financialCacheTable: {
        get: vi.fn().mockResolvedValue(undefined),
      },
      ...args.db,
    } as any),
    {
      isLoadedPromise: Promise.resolve(),
      ...args.config,
    } as any,
    currency as any,
    {
      currentFrameId: 12,
      load: vi.fn().mockResolvedValue(undefined),
      framesById: {},
      getFrameDate: vi.fn().mockReturnValue(new Date('2026-07-28T00:00:00Z')),
      ...args.miningFrames,
    } as any,
  );

  vi.spyOn(myMiningSeats as any, 'updateServerState').mockResolvedValue(undefined);

  return {
    myMiningSeats,
    currency,
  };
}
