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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BiddingCalculatorData best-block recovery', () => {
  it('retries the same frame after a current-state chain api failure', async () => {
    NetworkConfig.setNetwork('dev-docker');

    const finalizedApi = {
      consts: {
        miningSlot: {
          bidIncrements: {
            toBigInt: () => 10_000n,
          },
        },
      },
      runtimeVersion: {
        specVersion: {
          toNumber: () => 154,
        },
      },
    };
    const error = new Error('Unable to retrieve header and parent from supplied hash');
    const getCurrentApi = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(finalizedApi);
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
        blockWatch: {
          getCurrentApi,
        },
        framesById: {},
      } as any,
    );

    await expect(calculatorData.load(15)).rejects.toBe(error);
    await expect(calculatorData.load(15)).resolves.toBeUndefined();

    expect(getCurrentApi).toHaveBeenCalledTimes(2);
    expect(calculatorData.microgonsInCirculation).toBe(1_000n);
    expect(calculatorData.maximumMicronotsForBid).toBe(36n);
    expect(calculatorData.allowedBidIncrementMicrogons).toBe(10_000n);
  });
});
