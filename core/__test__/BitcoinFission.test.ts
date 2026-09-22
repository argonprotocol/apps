import { PriceIndex } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { describe, expect, it } from 'vitest';

import { BitcoinFission } from '../src/BitcoinFission.ts';

describe('BitcoinFission', () => {
  it('repairs stale action fees and close provenance without replacing newer current state', () => {
    const current = new BitcoinFission({
      ownerAccount: 'owner',
      fissionId: 4,
      liquidId: 7,
      lockId: 10,
      satoshis: 50_000_000n,
      microgonsAtTargetPerBtc: 1_200n,
      liquidityPromised: 800n,
      createdAtArgonBlock: 20,
      ratchetNumber: 1,
      lastUpdatedArgonBlock: 30,
      closedAtArgonBlock: 25,
      closedExtrinsicIndex: 2,
      closeReason: 'closed',
      redemptionAmount: 750n,
      closeTxFee: 0n,
      ratchets: [
        {
          source: 'lock',
          sourceRatchetIndex: 0,
          microgonsAtTargetPerBtc: 1_000n,
          amountMinted: 700n,
          amountBurned: 0n,
          mintPending: 0n,
          securityFee: 52_784_122n,
          securityFeeCoupon: 50_720_408n,
          txFee: 0n,
          blockNumber: 20,
        },
      ],
    });

    current.mergeRecoveredRecord({
      ownerAccount: 'owner',
      fissionId: 4,
      liquidId: 7,
      lockId: 10,
      satoshis: 50_000_000n,
      microgonsAtTargetPerBtc: 1_000n,
      liquidityPromised: 700n,
      createdAtArgonBlock: 20,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: 20,
      feeHistoryCompleteThroughBlock: 20,
      closedAtArgonBlock: 25,
      closedAtTick: 525,
      closedBlockHash: '0x25',
      closedExtrinsicIndex: 2,
      closeReason: 'closed',
      redemptionAmount: 750n,
      closeTxFee: 5n,
      ratchets: [
        {
          source: 'lock',
          sourceRatchetIndex: 0,
          microgonsAtTargetPerBtc: 1_000n,
          amountMinted: 700n,
          amountBurned: 0n,
          mintPending: 0n,
          securityFee: 52_784_122n,
          securityFeeCoupon: 52_784_122n,
          txFee: 1_719n,
          blockNumber: 20,
        },
      ],
    });

    expect(current).toMatchObject({
      microgonsAtTargetPerBtc: 1_200n,
      liquidityPromised: 800n,
      lastUpdatedArgonBlock: 30,
      closedAtTick: 525,
      closedBlockHash: '0x25',
      closeTxFee: 5n,
      ratchets: [
        expect.objectContaining({
          securityFee: 52_784_122n,
          securityFeeCoupon: 52_784_122n,
          txFee: 1_719n,
        }),
      ],
    });
  });

  it('allocates Liquid Bitcoin from only the selected vaults', () => {
    const allocations = BitcoinFission.allocateSatoshis({
      locks: [
        { lockId: 11, vaultId: 1 },
        { lockId: 22, vaultId: 2 },
        { lockId: 33, vaultId: 1 },
      ],
      maximumSatoshisByLockId: { 11: 20n, 22: 40n, 33: 30n },
      selectedVaultIds: new Set([1]),
      requestedSatoshis: 80n,
    });

    expect(allocations.map(({ lock, satoshis }) => [lock.lockId, satoshis])).toEqual([
      [11, 20n],
      [33, 30n],
    ]);
  });

  it('uses its stored liquidity as the source of a ratchet', () => {
    const priceIndex = new PriceIndex();
    priceIndex.argonUsdPrice = new BigNumber(0.5);
    priceIndex.argonUsdTargetPrice = new BigNumber(1);
    const fission = new BitcoinFission({
      ownerAccount: 'owner',
      fissionId: 4,
      liquidId: 7,
      lockId: 10,
      satoshis: 50_000_000n,
      microgonsAtTargetPerBtc: 1_000n,
      liquidityPromised: 700n,
      createdAtArgonBlock: 20,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: 20,
    });

    expect(fission.calculateRatchetAmounts({ priceIndex, microgonsAtTargetPerBtc: 1_100n })).toEqual({
      sourceLiquidity: 700n,
      replacementLiquidity: 742n,
      amountMinted: 42n,
      amountBurned: 0n,
    });
    expect(fission.calculateRatchetAmounts({ priceIndex, microgonsAtTargetPerBtc: 800n })).toEqual({
      sourceLiquidity: 700n,
      replacementLiquidity: 540n,
      amountMinted: 540n,
      amountBurned: 540n,
    });
  });

  it('applies the minimum ratchet change to each Fission independently', () => {
    const earlier = new BitcoinFission({
      ownerAccount: 'owner',
      fissionId: 4,
      liquidId: 7,
      lockId: 10,
      satoshis: 50_000_000n,
      microgonsAtTargetPerBtc: 1_000n,
      liquidityPromised: 500n,
      createdAtArgonBlock: 20,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: 20,
    });
    const later = new BitcoinFission({
      ownerAccount: 'owner',
      fissionId: 5,
      liquidId: 7,
      lockId: 11,
      satoshis: 50_000_000n,
      microgonsAtTargetPerBtc: 1_080n,
      liquidityPromised: 540n,
      createdAtArgonBlock: 21,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: 21,
    });

    expect(earlier.isRatchetAvailable({ microgonsAtTargetPerBtc: 1_049n, minimumRatchetPercent: 5n })).toBe(false);
    expect(earlier.isRatchetAvailable({ microgonsAtTargetPerBtc: 1_050n, minimumRatchetPercent: 5n })).toBe(true);
    expect(earlier.isRatchetAvailable({ microgonsAtTargetPerBtc: 1_100n, minimumRatchetPercent: 5n })).toBe(true);
    expect(later.isRatchetAvailable({ microgonsAtTargetPerBtc: 1_100n, minimumRatchetPercent: 5n })).toBe(false);
  });

  it('caps the close repayment at the Fission rate while retaining a lower current market value', () => {
    const priceIndex = new PriceIndex();
    priceIndex.argonUsdPrice = new BigNumber(0.5);
    priceIndex.argonUsdTargetPrice = new BigNumber(1);
    priceIndex.btcUsdPrice = new BigNumber(120_000);
    const fission = new BitcoinFission({
      ownerAccount: 'owner',
      fissionId: 4,
      liquidId: 7,
      lockId: 10,
      satoshis: 50_000_000n,
      microgonsAtTargetPerBtc: 100_000_000_000n,
      liquidityPromised: 67_500_000_000n,
      createdAtArgonBlock: 20,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: 20,
    });

    expect(fission.calculateRedemptionAmount(priceIndex)).toBe(67_530_000_000n);

    priceIndex.btcUsdPrice = new BigNumber(80_000);
    expect(fission.calculateRedemptionAmount(priceIndex)).toBe(54_024_000_000n);
  });
});
