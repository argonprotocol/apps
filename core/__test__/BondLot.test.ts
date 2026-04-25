import BigNumber from 'bignumber.js';
import { describe, expect, it } from 'vitest';
import { MICROGONS_PER_ARGON, type PalletTreasuryBondLot } from '@argonprotocol/mainchain';

import { BondLot } from '../src/BondLot.ts';
import { compoundXTimes } from '../src/utils.ts';

describe('BondLot', () => {
  it('loads app bond lot state from runtime bond lots', () => {
    const activeLot = BondLot.fromRuntime(
      1,
      createBondLot({ bonds: 250, owner: '5Owner' }) as PalletTreasuryBondLot,
      '5Owner',
    );
    const releasingLot = BondLot.fromRuntime(
      2,
      createBondLot({ bonds: 150, owner: '5Owner', isReleasing: true, releaseFrame: 12 }) as PalletTreasuryBondLot,
      '5Owner',
    );
    const oneArgon = BigInt(MICROGONS_PER_ARGON);

    expect(activeLot.bonds).toBe(250);
    expect(activeLot.bondMicrogons).toBe(250n * oneArgon);
    expect(activeLot.activeBonds).toBe(250);
    expect(activeLot.returningBonds).toBe(0);
    expect(activeLot.isOwn).toBe(true);
    expect(activeLot.canRelease).toBe(true);
    expect(releasingLot.activeBonds).toBe(0);
    expect(releasingLot.returningBonds).toBe(150);
    expect(releasingLot.releaseFrame).toBe(12);
  });

  it('does not mark external bond lots as releasable', () => {
    const lot = BondLot.fromRuntime(
      1,
      createBondLot({ bonds: 250, owner: '5ExternalOwner' }) as PalletTreasuryBondLot,
      '5Owner',
    );

    expect(lot.isOwn).toBe(false);
    expect(lot.canRelease).toBe(false);
  });

  it('calculates APY from large bigint treasury values without overflowing', () => {
    const lot = BondLot.fromRuntime(
      1,
      createBondLot({
        bonds: 987_654_321,
        owner: '5Owner',
        participatedFrames: 10,
        lastFrameEarningsFrame: 100,
        cumulativeEarnings: 123_456_789_123_456_789_123_456n,
      }) as PalletTreasuryBondLot,
      '5Owner',
    );
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const historicalDeployed = 987_654_321n * oneArgon * 10n;
    const expectedPerFrameReturn = BigNumber('123456789123456789123456')
      .dividedBy(historicalDeployed.toString())
      .toNumber();

    expect(lot.getAPY()).toBeCloseTo(compoundXTimes(expectedPerFrameReturn, 365) * 100, 12);
  });

  it('calculates APY from paid participating frames', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const lots = [
      BondLot.fromRuntime(
        1,
        createBondLot({
          bonds: 100,
          owner: '5Owner',
          participatedFrames: 10,
          lastFrameEarningsFrame: 10,
          cumulativeEarnings: 1_000_000n,
        }) as PalletTreasuryBondLot,
        '5Owner',
      ),
      BondLot.fromRuntime(
        2,
        createBondLot({
          bonds: 50,
          owner: '5Owner',
          createdFrame: 19,
          cumulativeEarnings: 0n,
        }) as PalletTreasuryBondLot,
        '5Owner',
      ),
    ];
    const historicalDeployed = 100n * oneArgon * 10n;
    const expectedPerFrameReturn = BigNumber(1_000_000).dividedBy(historicalDeployed.toString());

    expect(BondLot.getAPY(lots)).toBeCloseTo(compoundXTimes(expectedPerFrameReturn.toNumber(), 365) * 100, 12);
  });
});

function createBondLot(args: {
  bonds: number;
  owner: string;
  isReleasing?: boolean;
  releaseFrame?: number;
  participatedFrames?: number;
  createdFrame?: number;
  lastFrameEarningsFrame?: number;
  lastFrameEarnings?: bigint;
  cumulativeEarnings?: bigint;
}) {
  return {
    owner: { toString: () => args.owner },
    vaultId: { toNumber: () => 1 },
    bonds: { toNumber: () => args.bonds },
    cumulativeEarnings: { toBigInt: () => args.cumulativeEarnings ?? 0n },
    lastFrameEarnings: {
      isSome: args.lastFrameEarnings !== undefined,
      unwrap: () => ({ toBigInt: () => args.lastFrameEarnings }),
    },
    lastFrameEarningsFrameId: {
      isSome: args.lastFrameEarningsFrame !== undefined,
      unwrap: () => ({ toNumber: () => args.lastFrameEarningsFrame }),
    },
    participatedFrames: { toNumber: () => args.participatedFrames ?? 0 },
    createdFrameId: { toNumber: () => args.createdFrame ?? 0 },
    releaseReason: { isSome: args.isReleasing ?? false },
    releaseFrameId: {
      isSome: args.releaseFrame !== undefined,
      unwrap: () => ({ toNumber: () => args.releaseFrame }),
    },
  };
}
