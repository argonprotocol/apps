import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyMiningSeats } from '../lib/MyMiningSeats.ts';
import { botEmitter } from '../lib/Bot.ts';
import type { IFrameBidRecord } from '../interfaces/db/IFrameBidRecord.ts';

describe('MyMiningSeats', () => {
  afterEach(() => {
    botEmitter.all.clear();
    vi.restoreAllMocks();
  });

  it('waits on the active load instead of resolving early', async () => {
    let resolveCurrencyReady!: () => void;
    const currencyReady = new Promise<void>(resolve => {
      resolveCurrencyReady = resolve;
    });
    const { myMiningSeats, currency } = createMyMiningSeats({
      currency: {
        isLoadedPromise: currencyReady,
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

    resolveCurrencyReady();
    await Promise.all([firstLoad, secondLoad]);

    expect(currency.load).not.toHaveBeenCalled();
  });

  it('loads mining state once currency rates are ready without waiting for its live subscription', async () => {
    const { myMiningSeats, currency, updateMiningSeats, updateMiningBids, updateServerState } = createMyMiningSeats({
      currency: {
        isLoadedPromise: Promise.resolve(),
        load: vi.fn(() => new Promise<void>(() => undefined)),
      },
    });

    await expect(myMiningSeats.load()).resolves.toBeUndefined();

    expect(currency.load).not.toHaveBeenCalled();
    expect(updateMiningSeats).toHaveBeenCalledOnce();
    expect(updateMiningBids).toHaveBeenCalledOnce();
    expect(updateServerState).toHaveBeenCalledOnce();
  });

  it('does not reread server state after a cohort update from the same bot sync', async () => {
    const { myMiningSeats, updateServerState } = createMyMiningSeats();
    await myMiningSeats.load();
    updateServerState.mockClear();
    const fetchFinancialPositions = vi.fn().mockResolvedValue([]);
    myMiningSeats.db = {
      cohortsTable: { fetchFinancialPositions },
      frameBidsTable: { fetchForFrameId: vi.fn().mockResolvedValue([]) },
    } as any;

    botEmitter.emit('updated-server-state');
    botEmitter.emit('updated-mining-state', 13);

    await vi.waitFor(() => {
      expect(myMiningSeats.latestFrameId).toBe(13);
    });
    expect(fetchFinancialPositions).toHaveBeenCalledOnce();
    expect(fetchFinancialPositions).toHaveBeenCalledWith(3);
    expect(updateServerState).toHaveBeenCalledOnce();
  });

  it('publishes the new frame bid and seat projection at one revision', async () => {
    const { myMiningSeats, updateMiningSeats, updateMiningBids } = createMyMiningSeats();
    await myMiningSeats.load();
    const startingRevision = myMiningSeats.financialRevision;
    updateMiningSeats.mockRestore();
    updateMiningBids.mockRestore();
    const fetchForFrameId = vi.fn((frameId: number) => Promise.resolve([createFrameBid(frameId)]));
    let finishSeatRefresh!: () => void;
    const fetchFinancialPositions = vi.fn(
      () =>
        new Promise<[]>(resolve => {
          finishSeatRefresh = () => resolve([]);
        }),
    );
    myMiningSeats.db = {
      cohortsTable: { fetchFinancialPositions },
      frameBidsTable: { fetchForFrameId },
    } as any;

    botEmitter.emit('updated-mining-state', 13);

    await vi.waitFor(() => expect(fetchForFrameId).toHaveBeenCalledWith(13));
    expect(myMiningSeats.pendingBids.microgonsBidTotal).toBe(0n);
    expect(myMiningSeats.financialRevision).toBe(startingRevision);
    finishSeatRefresh();

    await vi.waitFor(() => {
      expect(myMiningSeats.pendingBids.microgonsBidTotal).toBe(13n);
      expect(myMiningSeats.financialRevision).toBe(startingRevision + 1);
    });
    expect(myMiningSeats.latestFrameId).toBe(13);
  });

  it('retries a failed bootstrap without duplicating bot subscriptions', async () => {
    const onSpy = vi.spyOn(botEmitter, 'on');
    const { myMiningSeats, currency } = createMyMiningSeats({
      currency: {
        isLoadedPromise: Promise.reject(new Error('bootstrap failed')),
      },
    });

    const firstLoadedPromise = myMiningSeats.isLoadedPromise;
    await expect(myMiningSeats.load()).rejects.toThrow('bootstrap failed');
    await expect(firstLoadedPromise).rejects.toThrow('bootstrap failed');
    expect(onSpy).not.toHaveBeenCalled();

    currency.isLoadedPromise = Promise.resolve();
    await expect(myMiningSeats.load()).resolves.toBeUndefined();
    await expect(myMiningSeats.isLoadedPromise).resolves.toBeUndefined();

    expect(onSpy).toHaveBeenCalledTimes(3);
  });

  it('advances automatically but only moves backward for explicit frame navigation', () => {
    const { myMiningSeats } = createMyMiningSeats();
    myMiningSeats.latestFrameId = 13;
    myMiningSeats.selectedFrameId = 12;

    expect(myMiningSeats.selectFrameId(13, { skipDashboardUpdate: true })).toBe(true);
    expect(myMiningSeats.selectedFrameId).toBe(13);

    expect(myMiningSeats.selectFrameId(12, { skipDashboardUpdate: true })).toBe(false);
    expect(myMiningSeats.selectedFrameId).toBe(13);

    expect(myMiningSeats.selectFrameId(12, { isUserAction: true, skipDashboardUpdate: true })).toBe(true);
    expect(myMiningSeats.selectedFrameId).toBe(12);
  });
});

function createFrameBid(frameId: number): IFrameBidRecord {
  return {
    frameId,
    confirmedAtBlockNumber: frameId,
    address: `address-${frameId}`,
    subAccountIndex: 0,
    lastBidAtTick: frameId,
    bidPosition: 0,
    microgonsPerSeat: BigInt(frameId),
    micronotsStakedPerSeat: BigInt(frameId),
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

function createMyMiningSeats(
  args: {
    config?: Record<string, any>;
    currency?: Record<string, any>;
    miningFrames?: Record<string, any>;
  } = {},
) {
  const currency = {
    isLoadedPromise: Promise.resolve(),
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
  const updateMiningBids = vi.spyOn(myMiningSeats as any, 'updateMiningBids').mockResolvedValue(undefined);
  const updateServerState = vi.spyOn(myMiningSeats as any, 'updateServerState').mockResolvedValue(undefined);

  return {
    myMiningSeats,
    updateMiningSeats,
    updateMiningBids,
    updateServerState,
    currency,
  };
}
