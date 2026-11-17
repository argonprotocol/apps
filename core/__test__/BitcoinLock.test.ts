import { describe, expect, it } from 'vitest';
import BigNumber from 'bignumber.js';
import { PriceIndex } from '@argonprotocol/mainchain';

import { BitcoinLock } from '../src/BitcoinLock.ts';
import type { BlockWatch, RuntimeSystemEventRecord } from '../src/BlockWatch.ts';
import type { IBitcoinLockConfig } from '../src/BitcoinLock.ts';

describe('BitcoinLock current runtime state', () => {
  it('matches native rounding when a near-target quote wins by one microgon', () => {
    // Numeric oracle inputs 1.007 / 1.06 produce this 18-decimal R. Native FixedU128
    // truncates R squared before the quadratic, making this quote cheaper than exact R=0.95.
    const observedR = new BigNumber('0.949999999999999879');
    expect(BitcoinLock.calculateRedemptionRate(observedR).toFixed(18)).toBe('0.949999999999999998');
    expect(BitcoinLock.getBestRedemptionRValue(new BigNumber('0.95'), observedR)).toEqual(observedR);
  });

  it.each([60_000, 2_000])(
    'requires the entire hold and cosign window in protocol ticks (tick duration %s)',
    tickDurationMillis => {
      const config: IBitcoinLockConfig = {
        argonTicksPerDay: 1_440,
        ticksPerBitcoinBlock: 10n,
        lockReleaseCosignDeadlineFrames: 10,
        securitizationHoldBlocks: 6,
        tickDurationMillis,
        bitcoinNetwork: { type: 'Bitcoin' },
      };
      // The runtime requires strictly more than (30 + 10) protocol days, or 5,760 Bitcoin blocks.
      const lock = { vaultClaimHeight: 10_000 };
      expect(BitcoinLock.hasRepaymentWindow({ lock, currentBitcoinHeight: 4_239, holdFrames: 30, config })).toBe(true);
      expect(BitcoinLock.hasRepaymentWindow({ lock, currentBitcoinHeight: 4_240, holdFrames: 30, config })).toBe(false);
      expect(BitcoinLock.hasRepaymentWindow({ lock, currentBitcoinHeight: 10_001, holdFrames: 30, config })).toBe(
        false,
      );
    },
  );

  it.each([
    [undefined, 11n],
    [60_000_000n, 37n],
  ] as const)('finds the minimum satoshis for coverage at price %s', (microgonsAtTargetPerBtc, expectedSatoshis) => {
    const priceIndex = new PriceIndex();
    priceIndex.btcUsdPrice = new BigNumber(200);
    priceIndex.argonUsdPrice = new BigNumber(0.95);
    priceIndex.argonUsdTargetPrice = new BigNumber(1);
    const satoshis = BitcoinLock.satoshisRequiredForRedemptionAmount(priceIndex, 20n, microgonsAtTargetPerBtc);

    // At the selected price: floor(37 * 0.6) * 0.95 rounds to 20; 36 satoshis yields 19.
    expect(satoshis).toBe(expectedSatoshis);
    expect(BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis, microgonsAtTargetPerBtc })).toBe(20n);
    expect(
      BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: satoshis - 1n,
        microgonsAtTargetPerBtc,
      }),
    ).toBeLessThan(20n);
    expect(BitcoinLock.satoshisRequiredForRedemptionAmount(priceIndex, 0n, microgonsAtTargetPerBtc)).toBe(0n);
  });

  it('uses native nearest fixed-point rounding before charging for additional guarantee coverage', () => {
    expect(
      BitcoinLock.calculateResecuritizationFee({
        vault: { terms: { bitcoinBaseFee: 0n, bitcoinAnnualPercentRate: new BigNumber(1) } },
        currentCoverageMicrogons: 0n,
        replacementCoverageMicrogons: 1_000_000_000_000_000_000n,
        createdAtBitcoinHeight: 0,
        vaultClaimBitcoinHeight: 52_560,
        currentBitcoinHeight: 52_559,
      }),
    ).toBe(19_025_875_190_259n);
  });

  it('walks the finalized cosign chain to find an earlier release', async () => {
    const releaseHeightsByBlock = {
      140: { cosignHeight: 130, previousCosignHeight: 120, releaseNumber: 3 },
      120: { cosignHeight: 120, previousCosignHeight: 110, releaseNumber: 2 },
      110: { cosignHeight: 110, previousCosignHeight: null, releaseNumber: 1 },
    } as const;
    const signatures = [new Uint8Array([1]), new Uint8Array([2])];
    const releaseOneEvent = {
      phase: { type: 'ApplyExtrinsic', value: 1 },
      topics: [],
      event: {
        section: 'bitcoinLocks',
        method: 'BitcoinUtxoCosigned',
        data: { lockId: 7, vaultId: 3, releaseNumber: 1, signatures },
      },
    } as unknown as RuntimeSystemEventRecord;
    const blockWatch = {
      getFinalizedApi: async () => ({
        query: {
          bitcoinLocks: { lockReleaseCosignHeightById: async () => releaseHeightsByBlock[140] },
        },
      }),
      getHeaderByBlockNumber: async (blockNumber: number) => ({ blockNumber, blockHash: `0x${blockNumber}` }),
      getApi: async ({ blockNumber }: { blockNumber: number }) => ({
        query: {
          bitcoinLocks: {
            lockReleaseCosignHeightById: async () =>
              releaseHeightsByBlock[blockNumber as keyof typeof releaseHeightsByBlock],
          },
        },
      }),
      getEvents: async ({ blockNumber }: { blockNumber: number }) => (blockNumber === 110 ? [releaseOneEvent] : []),
    } as unknown as BlockWatch;

    await expect(BitcoinLock.findVaultCosignatures(blockWatch, 7, 1)).resolves.toEqual({
      blockHeight: 110,
      signatures,
    });
  });
});
