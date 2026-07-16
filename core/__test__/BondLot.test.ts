import BigNumber from 'bignumber.js';
import { describe, expect, it } from 'vitest';
import { getOfflineRegistry, MICROGONS_PER_ARGON, type PalletTreasuryBondLot } from '@argonprotocol/mainchain';

import { BondLot } from '../src/BondLot.ts';
import { compoundXTimes } from '../src/utils.ts';

const Alice = `0x${'11'.repeat(32)}`;
const Bob = `0x${'22'.repeat(32)}`;

describe('BondLot', () => {
  it('loads app bond lot state from runtime bond lots', () => {
    const activeCodec = createBondLot({ bonds: 250, owner: Alice });
    const releasingCodec = createBondLot({ bonds: 150, owner: Alice, isReleasing: true, releaseFrame: 12 });
    const activeLot = BondLot.fromRuntime(1, activeCodec, activeCodec.owner.toString());
    const releasingLot = BondLot.fromRuntime(2, releasingCodec, releasingCodec.owner.toString());
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
    const ownCodec = createBondLot({ bonds: 250, owner: Alice });
    const lot = BondLot.fromRuntime(1, createBondLot({ bonds: 250, owner: Bob }), ownCodec.owner.toString());

    expect(lot.isOwn).toBe(false);
    expect(lot.canRelease).toBe(false);
  });

  it('calculates APY from large bigint treasury values without overflowing', () => {
    const lotCodec = createBondLot({
      bonds: 987_654_321,
      owner: Alice,
      participatedFrames: 10,
      lastFrameEarningsFrame: 100,
      cumulativeEarnings: 123_456_789_123_456_789_123_456n,
    });
    const lot = BondLot.fromRuntime(1, lotCodec, lotCodec.owner.toString());
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
      (() => {
        const lotCodec = createBondLot({
          bonds: 100,
          owner: Alice,
          participatedFrames: 10,
          lastFrameEarningsFrame: 10,
          cumulativeEarnings: 1_000_000n,
        });

        return BondLot.fromRuntime(1, lotCodec, lotCodec.owner.toString());
      })(),
      (() => {
        const lotCodec = createBondLot({
          bonds: 50,
          owner: Alice,
          createdFrame: 19,
          cumulativeEarnings: 0n,
        });

        return BondLot.fromRuntime(2, lotCodec, lotCodec.owner.toString());
      })(),
    ];
    const historicalDeployed = 100n * oneArgon * 10n;
    const expectedPerFrameReturn = BigNumber(1_000_000).dividedBy(historicalDeployed.toString());

    expect(BondLot.getAPY(lots)).toBeCloseTo(compoundXTimes(expectedPerFrameReturn.toNumber(), 365) * 100, 12);
  });

  it('marks argonot bond lots distinctly', () => {
    const lotCodec = createBondLot({
      bonds: 25,
      owner: Alice,
      program: { Argonot: null },
    });
    const lot = BondLot.fromRuntime(1, lotCodec, lotCodec.owner.toString());

    expect(lot.programType).toBe('Argonot');
    expect(lot.nativeAsset).toBe('ARGNOT');
    expect(lot.principalMicronots).toBe(25n * 1_000_000n);
    expect(lot.principalMicrogons).toBeUndefined();
    expect(lot.vaultId).toBeUndefined();
    expect(lot.bonusPercent).toBe(0);
  });

  it.each(['UserLiquidation', 'Bumped', 'VaultClosed'] as const)(
    'retains the %s release reason from runtime state',
    releaseReason => {
      const lotCodec = createBondLot({
        bonds: 25,
        owner: Alice,
        releaseFrame: 12,
        releaseReason,
      });
      const lot = BondLot.fromRuntime(1, lotCodec, lotCodec.owner.toString());

      expect(lot.releaseReason).toBe(releaseReason);
      expect(lot.isReleasing).toBe(true);
    },
  );

  it('keeps vault and argonot principal in separate native dimensions', () => {
    const vaultCodec = createBondLot({ bonds: 10, owner: Alice });
    const argonotCodec = createBondLot({ bonds: 20, owner: Alice, program: { Argonot: null } });
    const vaultLot = BondLot.fromRuntime(1, vaultCodec, vaultCodec.owner.toString());
    const argonotLot = BondLot.fromRuntime(2, argonotCodec, argonotCodec.owner.toString());
    const totals = BondLot.getTotals([vaultLot, argonotLot]);

    expect(vaultLot.nativeAsset).toBe('ARGN');
    expect(vaultLot.principalMicrogons).toBe(10n * BigInt(MICROGONS_PER_ARGON));
    expect(vaultLot.principalMicronots).toBeUndefined();
    expect(totals.totalBondMicrogons).toBe(10n * BigInt(MICROGONS_PER_ARGON));
    expect(totals.totalArgonotBondMicronots).toBe(20n * 1_000_000n);
  });

  it('does not mix raw argonot principal into vault-bond APY', () => {
    const vaultCodec = createBondLot({
      bonds: 10,
      owner: Alice,
      participatedFrames: 1,
      cumulativeEarnings: 1_000_000n,
    });
    const argonotCodec = createBondLot({
      bonds: 10,
      owner: Alice,
      program: { Argonot: null },
      participatedFrames: 1,
      cumulativeEarnings: 100_000_000n,
    });
    const vaultLot = BondLot.fromRuntime(1, vaultCodec, vaultCodec.owner.toString());
    const argonotLot = BondLot.fromRuntime(2, argonotCodec, argonotCodec.owner.toString());

    expect(BondLot.getAPY([vaultLot, argonotLot])).toBe(BondLot.getAPY([vaultLot]));
    expect(argonotLot.getAPY()).toBe(0);
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
  releaseReason?: 'UserLiquidation' | 'Bumped' | 'VaultClosed';
  program?: { Vault: { vaultId: number; sharingPercent: number; bonusPercent: number } } | { Argonot: null };
}): PalletTreasuryBondLot {
  let releaseReason = args.releaseReason;
  if (releaseReason === undefined && args.isReleasing) {
    releaseReason = 'UserLiquidation';
  }

  return getOfflineRegistry().createType('PalletTreasuryBondLot', {
    owner: args.owner,
    program: args.program ?? { Vault: { vaultId: 1, sharingPercent: 0, bonusPercent: 0 } },
    bonds: args.bonds,
    createdFrameId: args.createdFrame ?? 0,
    participatedFrames: args.participatedFrames ?? 0,
    lastFrameEarningsFrameId: args.lastFrameEarningsFrame ?? null,
    lastFrameEarnings: args.lastFrameEarnings ?? null,
    cumulativeEarnings: args.cumulativeEarnings ?? 0n,
    releaseFrameId: args.releaseFrame ?? null,
    releaseReason: releaseReason ?? null,
  });
}
