import BigNumber from 'bignumber.js';
import { describe, expect, it } from 'vitest';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { TreasuryBondLotByIdResultSpec160Variant6 } from '@argonprotocol/runtime-client';

import { BondLot } from '../src/BondLot.ts';

const Alice = `0x${'11'.repeat(32)}`;
const Bob = `0x${'22'.repeat(32)}`;

describe('BondLot', () => {
  it('loads app bond lot state from runtime bond lots', () => {
    const activeCodec = createBondLot({ bonds: 250, owner: Alice, isFlexible: true });
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
    expect(activeLot.isFlexible).toBe(true);
    expect(releasingLot.isFlexible).toBe(false);
    expect(releasingLot.activeBonds).toBe(0);
    expect(releasingLot.returningBonds).toBe(150);
    expect(releasingLot.releaseFrameId).toBe(12);
  });

  it('does not mark external bond lots as releasable', () => {
    const ownCodec = createBondLot({ bonds: 250, owner: Alice });
    const lot = BondLot.fromRuntime(1, createBondLot({ bonds: 250, owner: Bob }), ownCodec.owner.toString());

    expect(lot.isOwn).toBe(false);
    expect(lot.canRelease).toBe(false);
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

      expect(lot.releaseReason?.type).toBe(releaseReason);
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
});

function createBondLot(args: {
  bonds: number;
  owner: string;
  isFlexible?: boolean;
  isReleasing?: boolean;
  releaseFrame?: number;
  participatedFrames?: number;
  createdFrame?: number;
  lastFrameEarningsFrame?: number;
  lastFrameEarnings?: bigint;
  cumulativeEarnings?: bigint;
  releaseReason?: 'UserLiquidation' | 'Bumped' | 'VaultClosed';
  program?: { Vault: { vaultId: number; sharingPercent: number; bonusPercent: number } } | { Argonot: null };
}): NonNullable<TreasuryBondLotByIdResultSpec160Variant6> {
  let releaseReason = args.releaseReason;
  if (releaseReason === undefined && args.isReleasing) {
    releaseReason = 'UserLiquidation';
  }

  const program = args.program ?? { Vault: { vaultId: 1, sharingPercent: 0, bonusPercent: 0 } };
  return {
    owner: args.owner,
    program:
      'Vault' in program
        ? {
            type: 'Vault',
            value: {
              vaultId: program.Vault.vaultId,
              sharingPercent: new BigNumber(program.Vault.sharingPercent),
              bonusPercent: new BigNumber(program.Vault.bonusPercent),
            },
          }
        : { type: 'Argonot' },
    bonds: args.bonds,
    isFlexible: args.isFlexible ?? false,
    lockedFrameTerms: null,
    createdFrameId: args.createdFrame ?? 0,
    participatedFrames: args.participatedFrames ?? 0,
    lastFrameEarningsFrameId: args.lastFrameEarningsFrame ?? null,
    lastFrameEarnings: args.lastFrameEarnings ?? null,
    cumulativeEarnings: args.cumulativeEarnings ?? 0n,
    releaseFrameId: args.releaseFrame ?? null,
    releaseReason: releaseReason ? { type: releaseReason } : null,
  };
}
