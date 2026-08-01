import { describe, expect, it, vi } from 'vitest';
import BiddingCalculator from '../src/BiddingCalculator.ts';

describe('BiddingCalculator loading', () => {
  it('keeps the frame subscription after a later frame load failure', async () => {
    const error = new Error('Unable to retrieve header and parent from supplied hash');
    const load = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const unsubscribe = vi.fn();
    let onFrame: (frameId: number) => Promise<void> | void = () => undefined;
    const onFrameId = vi.fn((callback: typeof onFrame) => {
      onFrame = callback;
      void callback(1);
      return { unsubscribe };
    });
    const calculator = new BiddingCalculator(
      {
        load,
        miningFrames: {
          load: vi.fn().mockResolvedValue(undefined),
          onFrameId,
        },
      } as any,
      {} as any,
    );
    const calculateBidAmounts = vi.spyOn(calculator, 'calculateBidAmounts').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await calculator.load();
    await onFrame(2);
    await onFrame(3);

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(3);
    expect(calculateBidAmounts).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith('Error loading bidding calculator frame', error);

    consoleError.mockRestore();
  });

  it('allows a later load to retry after a frame load failure', async () => {
    const error = new Error('Unable to retrieve header and parent from supplied hash');
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const unsubscribeFirst = vi.fn();
    const unsubscribeSecond = vi.fn();
    const onFrameId = vi.fn((callback: (frameId: number) => Promise<void> | void) => {
      void callback(1);
      return { unsubscribe: onFrameId.mock.calls.length === 1 ? unsubscribeFirst : unsubscribeSecond };
    });
    const calculator = new BiddingCalculator(
      {
        load,
        miningFrames: {
          load: vi.fn().mockResolvedValue(undefined),
          onFrameId,
        },
      } as any,
      {} as any,
    );
    vi.spyOn(calculator, 'calculateBidAmounts').mockImplementation(() => undefined);

    await expect(calculator.load()).rejects.toBe(error);
    await expect(calculator.load()).resolves.toBeUndefined();

    expect(load).toHaveBeenCalledTimes(2);
    expect(onFrameId).toHaveBeenCalledTimes(2);
    expect(unsubscribeFirst).toHaveBeenCalledOnce();
  });
});

describe('BiddingCalculator bid economics', () => {
  it('combines projected ARGN and ARGNOT rewards', () => {
    const calculator = new BiddingCalculator(
      {
        estimatedTransactionFee: 2_000_000n,
        microgonsToMineThisSeat: 20_000_000n,
        micronotsToMineThisSeat: 10_000_000n,
        microgonsInCirculation: 100_000_000n,
        maxPossibleMiningSeatCount: 1,
        microgonExchangeRateTo: { ARGNOT: 3_000_000n },
      } as any,
      {
        argonCirculationGrowthPctMin: 0,
        argonCirculationGrowthPctMax: 0,
        argonotPriceChangePctMin: 0,
        argonotPriceChangePctMax: 0,
      } as any,
    );

    expect(calculator.calculateBidEconomics({ bidPrincipal: 100_000_000n })).toEqual({
      microgonsMined: 20_000_000n,
      microgonsMinted: 0n,
      microgonsEarned: 20_000_000n,
      micronotsMined: 10_000_000n,
      microgonValue: 50_000_000n,
      projectedReturnPct: -50.98,
      annualArgonCirculationGrowthPct: 0,
      annualArgonotPriceChangePct: 0,
      projectedArgonotPrice: 3_000_000n,
    });
  });

  it('includes configured ARGN circulation growth in projected minting', () => {
    const calculator = new BiddingCalculator(
      {
        estimatedTransactionFee: 2_000_000n,
        microgonsToMineThisSeat: 20_000_000n,
        micronotsToMineThisSeat: 10_000_000n,
        microgonsInCirculation: 100_000_000n,
        maxPossibleMiningSeatCount: 1,
        microgonExchangeRateTo: { ARGNOT: 3_000_000n },
      } as any,
      {
        argonCirculationGrowthPctMin: 100,
        argonCirculationGrowthPctMax: 100,
        argonotPriceChangePctMin: 0,
        argonotPriceChangePctMax: 0,
      } as any,
    );

    const economics = calculator.calculateBidEconomics({ bidPrincipal: 100_000_000n });

    expect(economics.microgonsMinted).toBeGreaterThan(0n);
    expect(economics.microgonValue).toBeGreaterThan(50_000_000n);
    expect(economics.projectedReturnPct).toBeGreaterThan(-50.98);
  });
});
