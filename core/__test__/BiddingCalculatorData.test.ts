import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/Currency.js', () => ({
  Currency: class {
    public async fetchMicrogonsInCirculation(): Promise<bigint> {
      return 1_000n;
    }

    public async fetchMainchainRates(): Promise<{ USD: bigint; ARGNOT: bigint }> {
      return { USD: 2n, ARGNOT: 3n };
    }
  },
}));

import BiddingCalculatorData from '../src/BiddingCalculatorData.ts';
import { NetworkConfig } from '../src/NetworkConfig.ts';
import type { IBlockHeaderInfo } from '../src/BlockWatch.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BiddingCalculatorData best-block recovery', () => {
  it('retries with the finalized block when the latest head cannot be decorated', async () => {
    NetworkConfig.setNetwork('dev-docker');

    const latestHeader = createHeaderInfo(155, '0xbest', '0x154', false);
    const finalizedHeader = createHeaderInfo(154, '0xfinalized', '0x153', true);
    const finalizedApi = {
      consts: {
        miningSlot: {
          bidIncrements: {
            toBigInt: () => 10_000n,
          },
        },
      },
    };
    const clientAt = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unable to retrieve header and parent from supplied hash'))
      .mockResolvedValueOnce(finalizedApi);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calculatorData = new BiddingCalculatorData(
      {
        clients: {},
        fetchNextFrameId: vi.fn().mockResolvedValue(16),
        fetchTickAtStartOfNextCohort: vi.fn().mockResolvedValue(1_000),
        fetchNextCohortSize: vi.fn().mockResolvedValue(25),
        getNextEpochMaxMiners: vi.fn().mockResolvedValue(50),
        fetchPreviousDayWinningBidAmounts: vi.fn().mockResolvedValue([10n, 20n]),
        fetchMicrogonsMinedPerBlockDuringNextCohort: vi.fn().mockResolvedValue(500n),
        fetchCurrentMicronotsForBid: vi.fn().mockResolvedValue(30n),
        fetchMaximumMicronotsForEndOfEpochBid: vi.fn().mockResolvedValue(40n),
        minimumMicronotsMinedDuringTickRange: vi.fn().mockResolvedValue(250n),
      } as any,
      {
        waitForFrameId: vi.fn().mockResolvedValue(undefined),
        clientAt,
        blockWatch: {
          bestBlockHeader: latestHeader,
          finalizedBlockHeader: finalizedHeader,
        },
        framesById: {},
      } as any,
    );

    await expect(calculatorData.load(15)).resolves.toBeUndefined();

    expect(clientAt.mock.calls).toEqual([[latestHeader], [finalizedHeader]]);
    expect(calculatorData.microgonsInCirculation).toBe(1_000n);
    expect(calculatorData.allowedBidIncrementMicrogons).toBe(10_000n);
  });
});

function createHeaderInfo(
  blockNumber: number,
  blockHash: string,
  parentHash: string,
  isFinalized: boolean,
): IBlockHeaderInfo {
  return {
    isFinalized,
    blockNumber,
    blockHash,
    blockTime: blockNumber * 1_000,
    parentHash,
    author: 'author',
    tick: blockNumber,
  };
}
