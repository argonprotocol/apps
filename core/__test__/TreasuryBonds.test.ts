import BigNumber from 'bignumber.js';
import { describe, expect, it, vi } from 'vitest';
import {
  type Codec,
  getOfflineRegistry,
  MICROGONS_PER_ARGON,
  type PalletTreasuryFrameVaultCapital,
  type PalletTreasuryBondLot,
  type PalletTreasuryVaultBondState,
  type ArgonPrimitivesVaultVaultTerms,
} from '@argonprotocol/mainchain';
import { encodeAddress } from '@polkadot/util-crypto';
import { getBundledMetadata, runtimeClient, toPlain } from '@argonprotocol/runtime-client';
import { Metadata, TypeRegistry } from '@polkadot/types';
import type { PreviousRuntimeSpec as RuntimeSpec159 } from '../src/runtimeCompatibility.ts';

import { MICRONOTS_PER_ARGONOT } from '../src/Currency.ts';
import { TreasuryBonds } from '../src/TreasuryBonds.ts';
import { Vault } from '../src/Vault.ts';

const registry = getOfflineRegistry();
const deployedRegistry = new TypeRegistry();
const deployedMetadata = Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-159'))![1];
deployedRegistry.setMetadata(new Metadata(deployedRegistry, deployedMetadata));
const operatorAddress = encodeAddress(new Uint8Array(32).fill(0x11));
const buyerAddress = encodeAddress(new Uint8Array(32).fill(0x22));

describe('TreasuryBonds', () => {
  it('encodes vault Bitcoin terms with current runtime metadata', () => {
    const terms = Vault.encodeTerms(registry, {
      bitcoinAnnualPercentRate: new BigNumber(0.075),
      bitcoinBaseFee: 1_000_000n,
    });
    const decoded = registry.createType<ArgonPrimitivesVaultVaultTerms>(
      'ArgonPrimitivesVaultVaultTerms',
      terms.toU8a(),
    );
    expect(decoded.bitcoinAnnualPercentRate.toBigInt()).toBe(75_000_000_000_000_000n);
    expect(decoded.bitcoinBaseFee.toBigInt()).toBe(1_000_000n);
    expect('treasuryProfitSharing' in decoded).toBe(false);
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

  it.each([160])('limits Argonot purchases using active network stakes on runtime %s', async spec => {
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

  it('uses network capacity to calculate a bond pool share', () => {
    expect(
      TreasuryBonds.argonBondPoolEarnings({
        eligibleMicrogons: 1_000_000n,
        frameCapital: { targetSecuritization: 10_000_000n, totalActiveBonds: 2n },
        bondPool: 100_000n,
      }),
    ).toBe(10_000n);
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
    expect(state.bondLots.map(({ id, isOwn, isReleasing }) => ({ id, isOwn, isReleasing }))).toEqual([
      { id: 1, isOwn: false, isReleasing: false },
      { id: 2, isOwn: true, isReleasing: false },
      { id: 3, isOwn: true, isReleasing: true },
      { id: 4, isOwn: false, isReleasing: false },
    ]);
    expect(TreasuryBonds.availableBondSpace({ capacityMicrogons: 10_000_000n, bondState: state })).toBe(5_000_000n);
    expect(TreasuryBonds.availableBondSpace({ capacityMicrogons: 4_000_000n, bondState: state })).toBe(0n);
    expect(TreasuryBonds.availableBondSpace({ capacityMicrogons: 0n, bondState: state })).toBe(0n);

    client.query.treasury.bondLotsByVault.mockResolvedValueOnce(
      toPlain(
        registry.createType<PalletTreasuryVaultBondState>('PalletTreasuryVaultBondState', {
          ...Object.fromEntries(vaultState),
          flexibleBonds: 200,
        }),
      ),
    );
    const moreFlexibleState = await TreasuryBonds.getVaultBondState(client as any, 1, operatorAddress);
    expect(TreasuryBonds.availableBondSpace({ capacityMicrogons: 10_000_000n, bondState: moreFlexibleState })).toBe(
      5_000_000n,
    );

    const frame = await TreasuryBonds.getCurrentFrameBondLots(client as any, 1, operatorAddress);
    expect(frame.bondLots.map(({ lot, eligibleMicrogons }) => ({ id: lot.id, eligibleMicrogons }))).toEqual([
      { id: 1, eligibleMicrogons: 3_000_000n },
      { id: 2, eligibleMicrogons: 1_714_285n },
      { id: 3, eligibleMicrogons: 5_000_000n },
    ]);
    expect(frame.totalActiveBonds).toBe(9.714285);
    const vault = createCapacityVault({ securitization: 10_000_000n });
    vault.committedMicrogons = 10_000_000n;
    expect(vault.bondCapacityMicrogons()).toBe(10_000_000n);
    vault.isClosed = true;
    expect(vault.bondCapacityMicrogons()).toBe(0n);
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
});

function createVaultBondClient(vaultState: Codec, lotsById: Map<number, Codec>, ownerLotIds: number[]) {
  return {
    consts: {
      treasury: { minimumArgonsPerContributor: 1_000_000n, maxArgonBondLots: 100 },
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
        totalArgonBondLots: async () => lotsById.size,
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

function createCapacityVault(
  overrides: Partial<{
    securitization: bigint;
    securitizationLocked: bigint;
    flexibleSecuritizationLocked: bigint;
    securitizedSatoshis: bigint;
    flexibleSecuritizedSatoshis: bigint;
  }> = {},
) {
  return new Vault(
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
}
