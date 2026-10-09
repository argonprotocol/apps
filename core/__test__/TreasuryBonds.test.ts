import BigNumber from 'bignumber.js';
import { describe, expect, it, vi } from 'vitest';
import {
  type Codec,
  FIXED_U128_DECIMALS,
  getOfflineRegistry,
  MICROGONS_PER_ARGON,
  type PalletTreasuryFrameVaultCapital,
  type PalletTreasuryBondLot,
  type PalletTreasuryVaultBondState,
  type ArgonPrimitivesVaultVaultTerms,
  PriceIndex,
  toFixedNumber,
} from '@argonprotocol/mainchain';
import { encodeAddress } from '@polkadot/util-crypto';
import { getBundledMetadata, runtimeClient, toPlain } from '@argonprotocol/runtime-client';
import { Metadata, TypeRegistry } from '@polkadot/types';
import type { PreviousRuntimeSpec as RuntimeSpec159 } from '../src/runtimeCompatibility.ts';

import { BondLot } from '../src/BondLot.ts';
import { MICRONOTS_PER_ARGONOT } from '../src/Currency.ts';
import { TreasuryBonds } from '../src/TreasuryBonds.ts';
import { Vault } from '../src/Vault.ts';

const registry = getOfflineRegistry();
const deployedRegistry = new TypeRegistry();
const deployedMetadata = Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-159'))![1];
deployedRegistry.setMetadata(new Metadata(deployedRegistry, deployedMetadata));
const operatorAddress = encodeAddress(new Uint8Array(32).fill(0x11));
const buyerAddress = encodeAddress(new Uint8Array(32).fill(0x22));
const displayLotsById = new Map([
  [1, createBondLot({ owner: buyerAddress, bonds: 3 })],
  [2, createBondLot({ owner: operatorAddress, bonds: 20, isFlexible: true })],
  [3, createBondLot({ owner: operatorAddress, bonds: 5, releaseReason: 'UserLiquidation' })],
]);

describe('TreasuryBonds', () => {
  it.each([159, 160])('encodes vault Bitcoin terms with runtime %s metadata', spec => {
    const runtimeRegistry = spec === 159 ? deployedRegistry : registry;
    const terms = Vault.encodeTerms(runtimeRegistry, {
      bitcoinAnnualPercentRate: new BigNumber(0.075),
      bitcoinBaseFee: 1_000_000n,
    });
    const decoded = runtimeRegistry.createType<
      ArgonPrimitivesVaultVaultTerms | RuntimeSpec159.ArgonPrimitivesVaultVaultTerms
    >('ArgonPrimitivesVaultVaultTerms', terms.toU8a());
    expect(decoded.bitcoinAnnualPercentRate.toBigInt()).toBe(75_000_000_000_000_000n);
    expect(decoded.bitcoinBaseFee.toBigInt()).toBe(1_000_000n);
    expect('treasuryProfitSharing' in decoded).toBe(spec === 159);
    if ('treasuryProfitSharing' in decoded) expect(decoded.treasuryProfitSharing.toNumber()).toBe(100_000);
  });

  it('previews ARGNOT notice, retains due withdrawals, and cancels newest notices first', () => {
    const vault = createCapacityVault();
    vault.securitizationExitNoticeBlocks = 52_560;
    vault.securitizationReleaseSchedule.set(100, {
      lockedCommitments: 0n,
      relockableCommitments: 0n,
      argonWithdrawals: 0n,
      argonotWithdrawals: 20n,
    });
    const commitment = { heldMicronots: 100n, committedMicronots: 80n, encumberedMicronots: 40n };

    // The saved target is 80. A reduction to 50 returns 20 immediately and puts 10 on notice.
    expect([...vault.previewArgonotWithdrawals(50n, commitment, 200)]).toEqual([
      [100, 20n],
      [52_848, 10n],
    ]);
    expect(vault.securitizationReleaseSchedule.get(100)?.argonotWithdrawals).toBe(20n);
    expect(vault.securitizationReleaseSchedule.size).toBe(1);

    // After that command finalizes, raising the target cancels the newest 10 and then 15 of the older 20.
    commitment.heldMicronots = 80n;
    vault.securitizationReleaseSchedule.set(52_848, {
      lockedCommitments: 0n,
      relockableCommitments: 0n,
      argonWithdrawals: 0n,
      argonotWithdrawals: 10n,
    });
    // Minting can later encumber 70, so the remaining 10 free cannot release the oldest whole 20.
    commitment.encumberedMicronots = 70n;
    expect([...vault.previewArgonotWithdrawals(50n, commitment, 52_900)]).toEqual([
      [100, 20n],
      [52_848, 10n],
    ]);
    expect([...vault.previewArgonotWithdrawals(75n, commitment, 52_900)]).toEqual([[100, 5n]]);
    expect([...vault.previewArgonotWithdrawals(100n, commitment, 52_900)]).toEqual([]);
    expect(vault.securitizationReleaseSchedule.get(52_848)?.argonotWithdrawals).toBe(10n);
  });

  it('keeps collateral and relock capacity held when previewing ARGN withdrawals', () => {
    const vault = createCapacityVault({ securitization: 100n, securitizationLocked: 60n });
    vault.securitizationExitNoticeBlocks = 52_560;
    vault.securitizationTarget = 80n;
    vault.committedMicrogons = 40n;
    // Storage order must not decide which withdrawal is canceled.
    vault.securitizationReleaseSchedule.set(100, {
      lockedCommitments: 0n,
      relockableCommitments: 0n,
      argonWithdrawals: 20n,
      argonotWithdrawals: 0n,
    });
    vault.securitizationReleaseSchedule.set(72, {
      lockedCommitments: 0n,
      relockableCommitments: 10n,
      argonWithdrawals: 0n,
      argonotWithdrawals: 0n,
    });

    // A 50 reduction can immediately release only 30: 60 collateral and 10 relockable remain held.
    expect([...vault.previewArgonWithdrawals(30n, 200, 499)]).toEqual([
      [100, 20n],
      [52_848, 20n],
    ]);
    expect(vault.securitization).toBe(100n);
    expect(vault.getRelockCapacity()).toBe(10n);

    vault.securitization = 70n;
    vault.securitizationTarget = 30n;
    vault.securitizationReleaseSchedule.set(52_848, {
      lockedCommitments: 0n,
      relockableCommitments: 0n,
      argonWithdrawals: 20n,
      argonotWithdrawals: 0n,
    });
    expect([...vault.previewArgonWithdrawals(30n, 52_900, 500)]).toEqual([
      [100, 20n],
      [52_848, 20n],
    ]);
    expect([...vault.previewArgonWithdrawals(55n, 52_900, 500)]).toEqual([[100, 15n]]);
    expect(vault.getRelockCapacity()).toBe(10n);
  });

  it('only shows deployed collateral releases as withdrawals above the saved funding amount', () => {
    const storedVault = deployedRegistry.createType<RuntimeSpec159.ArgonPrimitivesVault>('ArgonPrimitivesVault', {
      operatorAccountId: operatorAddress,
      securitization: 100n,
      securitizationTarget: 100n,
      securitizationReleaseSchedule: { 100: 50n, 200: 30n },
    });
    const vault = Vault.fromRuntime(1, toPlain(storedVault) as Parameters<typeof Vault.fromRuntime>[1], 60_000, {
      vaults: {},
      operationalAccounts: { operationalMinimumVaultSecuritization: 100n },
    } as Parameters<typeof Vault.fromRuntime>[3]);
    expect([...vault.previewArgonWithdrawals(100n, 300, 500)]).toEqual([]);

    vault.securitizationTarget = 40n;
    expect([...vault.previewArgonWithdrawals(40n, 300, 500)]).toEqual([
      [100, 50n],
      [200, 10n],
    ]);
    expect(vault.getRelockCapacity()).toBe(80n);
  });

  it('keeps the deployed certification minimum held until its release tick', () => {
    const storedVault = deployedRegistry.createType<RuntimeSpec159.ArgonPrimitivesVault>('ArgonPrimitivesVault', {
      operatorAccountId: operatorAddress,
      securitization: 100n,
      securitizationTarget: 100n,
      operationalMinimumReleaseTick: 500,
    });
    const vault = Vault.fromRuntime(1, toPlain(storedVault) as Parameters<typeof Vault.fromRuntime>[1], 60_000, {
      vaults: {},
      operationalAccounts: { operationalMinimumVaultSecuritization: 100n },
    } as Parameters<typeof Vault.fromRuntime>[3]);

    expect(vault.availableArgonWithdrawal(499)).toBe(0n);

    vault.securitization = 150n;
    expect(vault.availableArgonWithdrawal(499)).toBe(50n);
    expect(vault.availableArgonWithdrawal(500)).toBe(150n);

    vault.operationalMinimumReleaseTick = null;
    expect(vault.availableArgonWithdrawal(499)).toBe(150n);
  });

  it.each([159, 160])('limits Argonot purchases using active network stakes on runtime %s', async spec => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);
    const client = runtimeClient({
      query: {
        treasuryPositions:
          spec === 160
            ? {
                networkTotals: async () =>
                  registry.createType('ArgonPrimitivesTreasuryPositionQuantities', { stakes: 325, bonds: 800 }),
              }
            : {},
        treasury:
          spec === 159
            ? {
                totalActiveArgonotBonds: async () => deployedRegistry.createType('u32', 325),
              }
            : {},
      },
    });
    const totalActiveBonds = await TreasuryBonds.getActiveArgonotBonds(client as any);

    expect(
      TreasuryBonds.getArgonotBondPurchaseCapacity({
        totalIssuanceMicronots: 1_000n * oneArgonot,
        maxBondedPercent: 40,
        totalActiveBonds,
      }),
    ).toBe(75n * oneArgonot);
  });

  it('credits an evicted Argonot lot toward purchase capacity', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getArgonotBondPurchaseCapacity({
        totalIssuanceMicronots: 1_000n * oneArgonot,
        maxBondedPercent: 40,
        totalActiveBonds: 395,
        replacedBonds: 3,
      }),
    ).toBe(8n * oneArgonot);
  });

  it('uses the configured minimum for Argonot purchases without replacement', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getBondMinimumPurchase({
        configuredMinimumMicrounits: 100n * oneArgonot,
      }),
    ).toBe(100);
  });

  it('rounds the configured Argonot minimum up to a whole stake', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getBondMinimumPurchase({
        configuredMinimumMicrounits: oneArgonot + 1n,
      }),
    ).toBe(2);
  });

  it('requires a full-set Argonot purchase to beat the smallest active lot', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getBondMinimumPurchase({
        configuredMinimumMicrounits: 100n * oneArgonot,
        replacementBonds: 250,
      }),
    ).toBe(251);
  });

  it('limits one Argonot purchase to ten percent of total network capacity', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getArgonotBondPurchaseLimit({
        totalIssuanceMicronots: 1_000n * oneArgonot,
        maxBondedPercent: 40,
      }),
    ).toBe(40n * oneArgonot);
  });

  it('rounds the Argonot purchase limit down to whole stakes', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getArgonotBondPurchaseLimit({
        totalIssuanceMicronots: 499n * oneArgonot,
        maxBondedPercent: 40,
      }),
    ).toBe(19n * oneArgonot);
  });

  it('uses the frame protocol price, rounds the full micronot target up, and preserves missing-price meaning', () => {
    expect(
      TreasuryBonds.getVaultArgonotSecuritizationTarget({
        securitizationMicrogons: 2_400_000_000n,
        averageMicrogonsPerArgonot: 2_000_000n,
      }),
    ).toBe(2_400_000_000n);
    expect(
      TreasuryBonds.getVaultArgonotSecuritizationTarget({
        securitizationMicrogons: 10_000_000n,
        averageMicrogonsPerArgonot: 3_000_000n,
      }),
    ).toBe(6_666_667n);
    expect(TreasuryBonds.getVaultArgonotSecuritizationTarget({ securitizationMicrogons: 10n })).toBeUndefined();
    expect(TreasuryBonds.getVaultArgonotSecuritizationTarget({ securitizationMicrogons: 0n })).toBe(0n);
  });

  it('keeps the frozen capital and network denominator fixed across capture scenarios', () => {
    const position = {
      securitization: 2_400_000_000n,
      activatedSecuritization: 2_400_000_000n,
      bitcoinLockedMicrogons: 2_400_000_000n,
      activeBondMicrogons: 2_400_000_000n,
      argonotSecuritizationInMicrogons: 0n,
      upstreamParticipation: new BigNumber(1),
    };
    const args = {
      position,
      frameCapital: { targetSecuritization: 10_000_000_000n, totalSecuritization: 8_000_000_000n },
      fullBidPool: 1_000_000_000n,
      percentForVaultPool: new BigNumber(0.51),
    };
    const empty = TreasuryBonds.vaultRevenuePotential(args);
    const half = TreasuryBonds.vaultRevenuePotential({
      ...args,
      position: { ...position, argonotSecuritizationInMicrogons: 2_400_000_000n },
    });
    const full = TreasuryBonds.vaultRevenuePotential({
      ...args,
      position: { ...position, argonotSecuritizationInMicrogons: 4_800_000_000n },
    });
    expect(empty.capturedPercent).toBeCloseTo(25.84, 2);
    expect(empty.securitizationPercent).toBe(24);
    expect(
      TreasuryBonds.vaultRevenuePotential({
        ...args,
        frameCapital: { ...args.frameCapital, targetSecuritization: 6_000_000_000n },
      }).securitizationPercent,
    ).toBe(30);
    const paidOutPool = TreasuryBonds.vaultRevenuePotential({ ...args, fullBidPool: 0n });
    expect(paidOutPool.actualEarnings).toBe(0n);
    expect(paidOutPool.capturedPercent).toBeCloseTo(25.84, 2);
    expect(paidOutPool.capturedWithMaximumArgonotsPercent).toBe(100);
    expect(TreasuryBonds.vaultRevenuePotential({ ...args, fullBidPool: 1n }).capturedPercent).toBeCloseTo(25.84, 2);
    expect(half.capturedPercent).toBeCloseTo(59.17, 2);
    expect(full.capturedPercent).toBe(100);
    const undersecuritizedBitcoin = TreasuryBonds.vaultRevenuePotential({
      ...args,
      position: {
        ...position,
        bitcoinLockedMicrogons: 2_880_000_000n,
        argonotSecuritizationInMicrogons: 4_800_000_000n,
      },
    });
    // Full Bitcoin allocation still loses rewards when its value exceeds ARGN securitization by 20%.
    expect(undersecuritizedBitcoin.capturedPercent).toBeCloseTo(77.85, 2);
    const noBitcoin = TreasuryBonds.vaultRevenuePotential({
      ...args,
      position: {
        ...position,
        activatedSecuritization: 0n,
        bitcoinLockedMicrogons: 0n,
        argonotSecuritizationInMicrogons: 4_800_000_000n,
      },
    });
    expect(noBitcoin.capturedPercent).toBeCloseTo(5.88, 2);
    expect(empty.maximumEarnings).toBe(full.maximumEarnings);
    const partial = TreasuryBonds.vaultRevenuePotential({
      ...args,
      position: {
        ...position,
        activatedSecuritization: 1_200_000_000n,
        argonotSecuritizationInMicrogons: 4_800_000_000n,
      },
    });
    expect(partial.capturedPercent).toBeCloseTo(47.75, 2);
    expect(partial.capturedWithMaximumArgonotsPercent).toBeCloseTo(47.75, 2);
    expect(position.argonotSecuritizationInMicrogons).toBe(0n);
    expect(
      TreasuryBonds.argonBondPoolEarnings({
        eligibleMicrogons: 1_000_000n,
        frameCapital: { targetSecuritization: 10_000_000n, totalActiveBonds: 2n },
        bondPool: 100_000n,
      }),
    ).toBe(10_000n);
  });

  it('uses flexible bond reservations without counting flexible bonds against available capacity', async () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    let bitcoinCapacityMicrogons = 10n * oneArgon;

    const runtimeState = deployedRegistry.createType<RuntimeSpec159.PalletTreasuryVaultBondState>(
      'PalletTreasuryVaultBondState',
      {
        regularBondLots: [{ bondLotId: 1, bonds: 3 }],
        flexibleBonds: 20,
        reservedBondSpace: 2,
      },
    );
    const client = createVaultBondClient(runtimeState, displayLotsById, [2, 3]);
    const bondState = await TreasuryBonds.getVaultBondState(client as any, 1, operatorAddress);

    expect(bondState.flexibleBonds).toBe(20);
    expect(bondState.reservedBondSpace).toBe(2);
    expect(bondState.regularBonds).toBe(3);
    expect(bondState.bondLots.map(({ id, isOwn, isReleasing }) => ({ id, isOwn, isReleasing }))).toEqual([
      { id: 1, isOwn: false, isReleasing: false },
      { id: 2, isOwn: true, isReleasing: false },
      { id: 3, isOwn: true, isReleasing: true },
    ]);

    expect(
      TreasuryBonds.availableBondSpace({
        capacityMicrogons: bitcoinCapacityMicrogons,
        bondState: bondState,
      }),
    ).toBe(5n * oneArgon);

    const moreFlexibleState = deployedRegistry.createType<RuntimeSpec159.PalletTreasuryVaultBondState>(
      'PalletTreasuryVaultBondState',
      {
        regularBondLots: [{ bondLotId: 1, bonds: 3 }],
        flexibleBonds: 200,
        reservedBondSpace: 2,
      },
    );
    const moreFlexibleClient = createVaultBondClient(moreFlexibleState, displayLotsById, [2, 3]);
    const moreFlexibleBondState = await TreasuryBonds.getVaultBondState(moreFlexibleClient as any, 1, operatorAddress);

    expect(
      TreasuryBonds.availableBondSpace({
        capacityMicrogons: bitcoinCapacityMicrogons,
        bondState: moreFlexibleBondState,
      }),
    ).toBe(5n * oneArgon);

    bitcoinCapacityMicrogons = 4n * oneArgon;

    expect(
      TreasuryBonds.availableBondSpace({
        capacityMicrogons: bitcoinCapacityMicrogons,
        bondState: bondState,
      }),
    ).toBe(0n);

    const fullSet = deployedRegistry.createType<RuntimeSpec159.PalletTreasuryVaultBondState>(
      'PalletTreasuryVaultBondState',
      {
        regularBondLots: [
          { bondLotId: 1, bonds: 3 },
          { bondLotId: 4, bonds: 1 },
        ],
        flexibleBonds: 20,
        reservedBondSpace: 2,
      },
    );
    const fullSetClient = createVaultBondClient(fullSet, displayLotsById, [2, 3]);
    const replacement = await TreasuryBonds.getVaultBondState(fullSetClient as any, 1, operatorAddress);
    expect(TreasuryBonds.availableBondSpace({ capacityMicrogons: 10n * oneArgon, bondState: replacement })).toBe(
      5n * oneArgon,
    );
    expect(replacement.minimumPurchaseBonds).toBe(2);
    expect(TreasuryBonds.availableBondSpace({ capacityMicrogons: 0n, bondState: replacement })).toBe(0n);
  });

  it.each([
    {
      description: 'recognizes a failed Vault release alongside an Argonot purchase',
      releasedProgram: 'Vault' as const,
      purchasedProgram: 'Argonot' as const,
      holdPallet: 'balances' as const,
      purchasedLotExists: true,
      expected: true,
    },
    {
      description: 'recognizes a failed Argonot release alongside a Vault purchase',
      releasedProgram: 'Argonot' as const,
      purchasedProgram: 'Vault' as const,
      holdPallet: 'ownership' as const,
      purchasedLotExists: true,
      expected: true,
    },
    {
      description: 'rejects a failed Vault release alongside a Vault purchase',
      releasedProgram: 'Vault' as const,
      purchasedProgram: 'Vault' as const,
      holdPallet: 'balances' as const,
      purchasedLotExists: true,
      expected: false,
    },
    {
      description: 'rejects reconciliation when the purchased lot is unavailable',
      releasedProgram: 'Vault' as const,
      purchasedProgram: 'Argonot' as const,
      holdPallet: 'balances' as const,
      purchasedLotExists: false,
      expected: false,
    },
  ])('$description', async ({ releasedProgram, purchasedProgram, holdPallet, purchasedLotExists, expected }) => {
    const releasedLotId = 10;
    const purchasedLotId = 11;
    const principal = 10_000_000n;
    const releasedCodec = createBondLot({
      owner: buyerAddress,
      bonds: 10,
      programType: releasedProgram,
      releaseReason: 'UserLiquidation',
    });
    const purchasedCodec = createBondLot({ owner: buyerAddress, bonds: 5, programType: purchasedProgram });
    const releasedLot = BondLot.fromRuntime(releasedLotId, toPlain(releasedCodec) as any, buyerAddress);
    const parentApi = {
      query: {
        treasury: {
          bondLotById: vi.fn(async (id: number) => (id === releasedLotId ? toPlain(releasedCodec) : null)),
        },
        [holdPallet]: {
          holds: vi.fn(async () => [{ id: { type: 'Treasury' }, amount: principal }]),
        },
      },
    };
    const api = {
      query: {
        treasury: {
          bondLotById: vi.fn(async (id: number) =>
            purchasedLotExists && id === purchasedLotId ? toPlain(purchasedCodec) : null,
          ),
        },
        [holdPallet]: { holds: vi.fn(async () => []) },
      },
    };
    const events = [
      {
        event: {
          section: 'treasury',
          method: 'CouldNotReleaseBondLot',
          data: {
            frameId: 2,
            programId: releasedProgram === 'Vault' ? { type: 'Vault', value: { vaultId: 1 } } : { type: 'Argonot' },
            bondLotId: releasedLotId,
            accountId: buyerAddress,
            amount: principal,
            dispatchError: { type: 'ConsumerRemaining' },
          },
        },
        phase: { type: 'Initialization' },
        topics: [],
      },
      {
        event: {
          section: 'treasury',
          method: 'BondLotPurchased',
          data: {
            programId: purchasedProgram === 'Vault' ? { type: 'Vault', value: { vaultId: 1 } } : { type: 'Argonot' },
            bondLotId: purchasedLotId,
            accountId: buyerAddress,
            bonds: 5,
          },
        },
        phase: { type: 'ApplyExtrinsic', value: 1 },
        topics: [],
      },
    ];

    await expect(
      TreasuryBonds.didFailedReleaseRemoveHold({
        accountId: buyerAddress,
        lot: releasedLot,
        events: events as any,
        parentApi: parentApi as any,
        api: api as any,
      }),
    ).resolves.toBe(expected);
  });

  it('keeps deployed-runtime participation distinct from payout shares in an underfilled vault', async () => {
    const frameCapital = deployedRegistry.createType<RuntimeSpec159.PalletTreasuryFrameVaultCapital>(
      'PalletTreasuryFrameVaultCapital',
      {
        frameId: 10,
        vaults: {
          1: {
            regularBondAllocations: [{ bondLotId: 1, prorata: toFixedNumber(0.03, FIXED_U128_DECIMALS) }],
            flexibleBondsEligible: 7,
            flexibleProrata: toFixedNumber(0.07, FIXED_U128_DECIMALS),
            eligibleBonds: 10,
          },
        },
      },
    );
    const client = createFrameBondClient(frameCapital, displayLotsById);

    const result = await TreasuryBonds.getCurrentFrameBondLots(client as any, 1, operatorAddress);

    expect(result.totalActiveBonds).toBe(10);
    expect(result.flexibleBondsEligible).toBe(7);
    expect(result.bondLots.map(({ lot, eligibleMicrogons }) => ({ id: lot.id, eligibleMicrogons }))).toEqual([
      { id: 1, eligibleMicrogons: 3_000_000n },
    ]);

    // A price decline can leave regular principal above capacity. Keep the
    // resulting fractional participation; whole-bond purchase rules do not apply.
    const reducedCapital = deployedRegistry.createType<RuntimeSpec159.PalletTreasuryFrameVaultCapital>(
      'PalletTreasuryFrameVaultCapital',
      {
        frameId: 11,
        vaults: {
          1: {
            regularBondAllocations: [
              { bondLotId: 1, prorata: toFixedNumber(new BigNumber(3).div(7), FIXED_U128_DECIMALS) },
              { bondLotId: 4, prorata: toFixedNumber(new BigNumber(4).div(7), FIXED_U128_DECIMALS) },
            ],
            flexibleBondsEligible: 0,
            eligibleBonds: 5,
          },
        },
      },
    );
    const reducedLots = new Map(displayLotsById);
    reducedLots.set(4, createBondLot({ owner: buyerAddress, bonds: 4 }));
    const reduced = await TreasuryBonds.getCurrentFrameBondLots(
      createFrameBondClient(reducedCapital, reducedLots) as any,
      1,
      operatorAddress,
    );
    expect(reduced.bondLots.map(lot => lot.eligibleMicrogons)).toEqual([2_142_857n, 2_857_142n]);
  });

  it('uses the candidate bond index and frozen frame terms through purchases and releases', async () => {
    const vaultState = registry.createType<PalletTreasuryVaultBondState>('PalletTreasuryVaultBondState', {
      regularBonds: 3,
      flexibleBonds: 20,
      displacedFlexibleBonds: 15,
      reservedBondSpace: 2,
      lockedFrameTerms: { flexibleBonds: 7, displacedFlexibleBonds: 1 },
    });
    const lots = new Map([
      [
        1,
        registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
          owner: buyerAddress,
          bonds: 3,
          program: { Vault: { vaultId: 1 } },
        }),
      ],
      [
        2,
        registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
          owner: operatorAddress,
          bonds: 20,
          program: { Vault: { vaultId: 1 } },
          isFlexible: true,
          lockedFrameTerms: { bonds: 2, isFlexible: true },
        }),
      ],
      [
        3,
        registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
          owner: operatorAddress,
          bonds: 5,
          program: { Vault: { vaultId: 1 } },
          releaseReason: 'UserLiquidation',
          lockedFrameTerms: { bonds: 5, isFlexible: false },
        }),
      ],
      [
        4,
        registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
          owner: buyerAddress,
          bonds: 100,
          program: { Vault: { vaultId: 1 } },
          lockedFrameTerms: { bonds: 0, isFlexible: false },
        }),
      ],
    ]);
    const client = createVaultBondClient(vaultState, lots, [2, 3]);
    Object.assign(client.query.treasury, {
      currentFrameVaultCapital: vi.fn(async () =>
        toPlain(
          registry.createType<PalletTreasuryFrameVaultCapital>('PalletTreasuryFrameVaultCapital', {
            frameId: 10,
            totalActiveBonds: 25,
            targetSecuritization: 100_000_000,
            totalSecuritization: 50_000_000,
            vaultSecuritizationPositions: {},
          }),
        ),
      ),
    });
    const state = await TreasuryBonds.getVaultBondState(client as any, 1, operatorAddress);
    expect(state.bondLots.map(lot => lot.id)).toEqual([1, 2, 3, 4]);
    expect(TreasuryBonds.availableBondSpace({ capacityMicrogons: 10_000_000n, bondState: state })).toBe(5_000_000n);
    const frame = await TreasuryBonds.getCurrentFrameBondLots(client as any, 1, operatorAddress);
    expect(frame.bondLots.map(({ lot, eligibleMicrogons }) => ({ id: lot.id, eligibleMicrogons }))).toEqual([
      { id: 1, eligibleMicrogons: 3_000_000n },
      { id: 2, eligibleMicrogons: 1_714_285n },
      { id: 3, eligibleMicrogons: 5_000_000n },
    ]);
    expect(frame.totalActiveBonds).toBe(9.714285);
    const vault = createCapacityVault({ securitization: 10_000_000n }, true);
    vault.committedMicrogons = 10_000_000n;
    expect(vault.bondCapacityMicrogons(new PriceIndex())).toBe(10_000_000n);
    vault.isClosed = true;
    expect(vault.bondCapacityMicrogons(new PriceIndex())).toBe(0n);
  });

  it('projects the fixed vault pool without an operator residual from bond holder earnings', () => {
    const position = {
      securitization: 1_000n,
      activatedSecuritization: 1_000n,
      bitcoinLockedMicrogons: 1_000n,
      activeBondMicrogons: 1_000n,
      argonotSecuritizationInMicrogons: 2_000n,
      upstreamParticipation: new BigNumber(1),
    };
    const args = {
      position,
      frameCapital: { targetSecuritization: 1_000n, totalSecuritization: 1_000n },
      fullBidPool: 100_000n,
      percentForVaultPool: new BigNumber(0.57),
    };
    expect(TreasuryBonds.vaultPoolEarnings(args)).toBe(57_000n);
    const upstreamHalf = { ...args, position: { ...position, upstreamParticipation: new BigNumber(0.5) } };
    expect(TreasuryBonds.vaultPoolEarnings(upstreamHalf)).toBe(29_000n);
    expect(
      TreasuryBonds.vaultPoolEarnings({
        ...args,
        position: { ...position, upstreamParticipation: new BigNumber(0) },
      }),
    ).toBe(1_000n);
    const potential = TreasuryBonds.vaultRevenuePotential(upstreamHalf);
    expect(potential.actualEarnings).toBe(29_000n);
    expect(potential.maximumEarnings).toBe(57_000n);
    expect(potential.capturedPercent).toBeCloseTo((29 / 57) * 100, 8);
    expect(potential.capturedWithMaximumArgonotsPercent).toBe(potential.capturedPercent);
    expect(potential.upstreamParticipationPercent).toBe(50);
    expect(
      TreasuryBonds.vaultPoolEarnings({
        ...args,
        position: { ...position, activatedSecuritization: 0n, argonotSecuritizationInMicrogons: 0n },
      }),
    ).toBe(1_000n);
    expect(
      TreasuryBonds.vaultPoolEarnings({
        ...args,
        frameCapital: { targetSecuritization: 2_000n, totalSecuritization: 1_000n },
      }),
    ).toBe(28_500n);
  });

  it('caps purchases at the market value of eligible Bitcoin security', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const vault = createCapacityVault({
      securitization: 2_000_000_000n,
      securitizationLocked: 1_052_698_425n,
      securitizedSatoshis: 1_408_910n,
    });
    const priceIndex = new PriceIndex();
    priceIndex.btcUsdPrice = new BigNumber('77311.097');
    priceIndex.argonUsdPrice = new BigNumber('1.061');
    const capacityMicrogons = vault.bondCapacityMicrogons(priceIndex);

    expect(capacityMicrogons).toBe(1_026_619_959n);
    expect(
      TreasuryBonds.availableBondSpace({
        capacityMicrogons,
        bondState: { regularBonds: 3, reservedBondSpace: 0, replacementBonds: 0, isAtBondLotLimit: false },
      }),
    ).toBe(1_023n * oneArgon);
  });

  it.each([
    { btcUsdPrice: undefined, argonUsdPrice: new BigNumber(1) },
    { btcUsdPrice: new BigNumber(1), argonUsdPrice: undefined },
    { btcUsdPrice: new BigNumber(1), argonUsdPrice: new BigNumber(0) },
  ])('reports no bond capacity when a market price is unavailable', ({ btcUsdPrice, argonUsdPrice }) => {
    const priceIndex = new PriceIndex();
    priceIndex.btcUsdPrice = btcUsdPrice;
    priceIndex.argonUsdPrice = argonUsdPrice;

    expect(
      TreasuryBonds.availableBondSpace({
        capacityMicrogons: createCapacityVault().bondCapacityMicrogons(priceIndex),
      }),
    ).toBe(0n);
  });

  it('excludes displaced flexible Bitcoin security from eligible capacity', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const vault = createCapacityVault({
      securitization: 10n * oneArgon,
      securitizationLocked: 12n * oneArgon,
      flexibleSecuritizationLocked: 5n * oneArgon,
      securitizedSatoshis: 120n,
      flexibleSecuritizedSatoshis: 50n,
    });

    expect(vault.bondEligibleSatoshis()).toBe(100n);

    vault.securitizationPendingActivation = 4n * oneArgon;
    expect(vault.bondEligibleSatoshis()).toBe(120n);

    vault.securitizationPendingActivation = 8n * oneArgon;
    expect(vault.bondEligibleSatoshis()).toBe(120n);
  });

  it('reports the displaced share of flexible Bitcoin security', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const vault = createCapacityVault({
      securitization: 10n * oneArgon,
      securitizationLocked: 12n * oneArgon,
      flexibleSecuritizationLocked: 5n * oneArgon,
    });

    expect(vault.flexibleSecuritizationDisplacementPercent()).toBe(40);

    vault.securitizationPendingActivation = 4n * oneArgon;
    expect(vault.flexibleSecuritizationDisplacementPercent()).toBe(0);
  });

  it('matches FixedU128 rounding for displaced flexible Bitcoin security', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const vault = createCapacityVault({
      securitization: 10n * oneArgon,
      securitizationLocked: 12n * oneArgon,
      flexibleSecuritizationLocked: 3n * oneArgon,
      securitizedSatoshis: 3n,
      flexibleSecuritizedSatoshis: 3n,
    });

    expect(vault.bondEligibleSatoshis()).toBe(0n);

    vault.securitizedSatoshis = 999n;
    vault.ratioAdjustedSatoshis = 2n;
    expect(vault.bondEligibleSatoshis()).toBe(0n);
  });

  it('normalizes previous-runtime backfill security into the same eligible capacity', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const values = {
      securitization: 10n * oneArgon,
      securitizationLocked: 12n * oneArgon,
      flexibleSecuritizationLocked: 5n * oneArgon,
      securitizedSatoshis: 120n,
      flexibleSecuritizedSatoshis: 50n,
    };

    expect(createCapacityVault(values, true).bondEligibleSatoshis()).toBe(
      createCapacityVault(values).bondEligibleSatoshis(),
    );
  });
});

function createVaultBondClient(vaultState: Codec, lotsById: Map<number, Codec>, ownerLotIds: number[]) {
  return {
    consts: {
      treasury: { minimumArgonsPerContributor: 1_000_000n, maxTreasuryContributors: 2 },
      operationalAccounts: { operationalMinimumVaultSecuritization: 100_000_000n },
    },
    query: {
      ticks: { genesisTicker: async () => ({ tickDurationMillis: 60_000 }) },
      vaults: {
        vaultsById: async () =>
          toPlain(
            deployedRegistry.createType('ArgonPrimitivesVault', {
              operatorAccountId: operatorAddress,
              securitization: 10_000_000n,
              ratioAdjustedSatoshis: 10,
              securitizedSatoshis: 10,
            }),
          ),
      },
      priceIndex: {
        current: async () => ({ btcUsdPrice: new BigNumber(100_000_000), argonUsdPrice: new BigNumber(1) }),
      },
      treasury: {
        bondLotsByVault: vi.fn(async () => toPlain(vaultState)),
        bondLotIdsByVault: {
          keys: vi.fn(async () => [...lotsById.keys()].map(id => ({ args: [1, id] }))),
        },
        bondLotIdsByAccount: {
          keys: vi.fn(async () => ownerLotIds.map(id => ({ args: [undefined, id] }))),
        },
        bondLotById: {
          multi: vi.fn(async (ids: number[]) => ids.map(id => toPlain(lotsById.get(id)) ?? null)),
        },
      },
    },
  };
}

function createFrameBondClient(frameCapital: Codec, lotsById: Map<number, Codec>) {
  return {
    query: {
      treasury: {
        currentFrameVaultCapital: vi.fn(async () => toPlain(frameCapital)),
        bondLotById: {
          multi: vi.fn(async (ids: number[]) => ids.map(id => toPlain(lotsById.get(id)) ?? null)),
        },
      },
    },
  };
}

function createBondLot({
  owner,
  bonds,
  programType = 'Vault',
  isFlexible,
  releaseReason,
}: {
  owner: string;
  bonds: number;
  programType?: 'Vault' | 'Argonot';
  isFlexible?: boolean;
  releaseReason?: 'UserLiquidation';
}) {
  return registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
    owner,
    program:
      programType === 'Vault' ? { Vault: { vaultId: 1, sharingPercent: 0, bonusPercent: 0 } } : { Argonot: null },
    bonds,
    isFlexible: isFlexible ?? false,
    createdFrameId: 1,
    participatedFrames: 0,
    lastFrameEarningsFrameId: null,
    lastFrameEarnings: null,
    cumulativeEarnings: 0,
    releaseFrameId: releaseReason ? 2 : null,
    releaseReason: releaseReason ?? null,
  });
}

function createCapacityVault(
  overrides: Partial<{
    securitization: bigint;
    securitizationLocked: bigint;
    flexibleSecuritizationLocked: bigint;
    securitizedSatoshis: bigint;
    flexibleSecuritizedSatoshis: bigint;
  }> = {},
  nativeRuntime = false,
) {
  const vault = new Vault(
    1,
    {
      operatorAccountId: operatorAddress,
      delegateAccountId: null,
      securitization: overrides.securitization ?? 10n,
      securitizationTarget: 10n,
      securitizationLocked: overrides.securitizationLocked ?? 10n,
      flexibleSecuritizationLocked: overrides.flexibleSecuritizationLocked ?? 0n,
      reservedSecuritizationSpace: 0n,
      flexibleRatioAdjustedSatoshis: overrides.flexibleSecuritizedSatoshis ?? 0n,
      securitizationPendingActivation: 0n,
      committedMicrogons: 0n,
      securitizedSatoshis: overrides.securitizedSatoshis ?? 1n,
      totalSatoshis: overrides.securitizedSatoshis ?? 1n,
      ratioAdjustedSatoshis: overrides.securitizedSatoshis ?? 1n,
      securitizationReleaseSchedule: {},
      securitizationRatio: new BigNumber(1),
      isClosed: false,
      terms: { bitcoinAnnualPercentRate: new BigNumber(0), bitcoinBaseFee: 0n },
      pendingTerms: null,
      openedTick: 1,
    },
    60_000,
  );
  vault.bondCapacitySource = nativeRuntime ? 'Securitization' : 'Bitcoin';
  return vault;
}
