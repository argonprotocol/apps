import { describe, expect, it, vi } from 'vitest';
import {
  type Codec,
  FIXED_U128_DECIMALS,
  getOfflineRegistry,
  MICROGONS_PER_ARGON,
  type PalletTreasuryFrameVaultCapital,
  type PalletTreasuryBondLot,
  type PalletTreasuryVaultBondState,
  toFixedNumber,
} from '@argonprotocol/mainchain';
import { encodeAddress } from '@polkadot/util-crypto';
import { toPlain } from '@argonprotocol/runtime-client';

import { MICRONOTS_PER_ARGONOT } from '../src/Currency.ts';
import { TreasuryBonds } from '../src/TreasuryBonds.ts';

const registry = getOfflineRegistry();
const operatorAddress = encodeAddress(new Uint8Array(32).fill(0x11));
const buyerAddress = encodeAddress(new Uint8Array(32).fill(0x22));
const displayLotsById = new Map([
  [1, createVaultBondLot({ owner: buyerAddress, bonds: 3 })],
  [2, createVaultBondLot({ owner: operatorAddress, bonds: 20, isFlexible: true })],
  [3, createVaultBondLot({ owner: operatorAddress, bonds: 5, releaseReason: 'UserLiquidation' })],
]);

describe('TreasuryBonds', () => {
  it('limits Argonot purchases to the unfilled portion of the circulation cap', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getArgonotBondPurchaseCapacity({
        totalIssuanceMicronots: 1_000n * oneArgonot,
        maxBondedPercent: 40,
        totalActiveBonds: 325,
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

  it('uses the configured minimum for Argonot purchases while the active lot set has room', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getArgonotBondMinimumPurchase({
        configuredMinimumMicrounits: 100n * oneArgonot,
        activeLotCount: 999,
        maxActiveLots: 1_000,
        smallestActiveLotBonds: 250,
      }),
    ).toBe(100);
  });

  it('rounds the configured Argonot minimum up to a whole stake', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getArgonotBondMinimumPurchase({
        configuredMinimumMicrounits: oneArgonot + 1n,
        activeLotCount: 0,
        maxActiveLots: 1_000,
      }),
    ).toBe(2);
  });

  it('requires a full-set Argonot purchase to beat the smallest active lot', () => {
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getArgonotBondMinimumPurchase({
        configuredMinimumMicrounits: 100n * oneArgonot,
        activeLotCount: 1_000,
        maxActiveLots: 1_000,
        smallestActiveLotBonds: 250,
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

  it('scales the Argonot target by the vault share of the ARGN securitization target', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getVaultArgonotSecuritizationTarget({
        activatedSecuritizationMicrogons: 20_000n * oneArgon,
        totalArgonIssuanceMicrogons: 1_000_000n * oneArgon,
        totalArgonotIssuanceMicronots: 2_000_000n * oneArgonot,
      }),
    ).toBe(48_000n * oneArgonot);
  });

  it('caps the vault Argonot target at 40 percent of ARGNOT circulation', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const oneArgonot = BigInt(MICRONOTS_PER_ARGONOT);

    expect(
      TreasuryBonds.getVaultArgonotSecuritizationTarget({
        activatedSecuritizationMicrogons: 500_000n * oneArgon,
        totalArgonIssuanceMicrogons: 1_000_000n * oneArgon,
        totalArgonotIssuanceMicronots: 2_000_000n * oneArgonot,
      }),
    ).toBe(800_000n * oneArgonot);
  });

  it('uses flexible bond reservations without counting flexible bonds against available capacity', async () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    let activatedSecuritization = 10n * oneArgon;
    const vault = createCapacityVault(() => activatedSecuritization);

    const runtimeState = registry.createType<PalletTreasuryVaultBondState>('PalletTreasuryVaultBondState', {
      regularBondLots: [{ bondLotId: 1, bonds: 3 }],
      flexibleBonds: 20,
      reservedBondSpace: 2,
    });
    const client = createVaultBondClient(runtimeState, displayLotsById, [2, 3]);
    const bondState = await TreasuryBonds.getVaultBondState(client as any, 1, operatorAddress);

    expect(bondState.flexibleBonds).toBe(20);
    expect(bondState.reservedBondSpace).toBe(2);
    expect(bondState.ordinaryBonds).toBe(3);
    expect(bondState.bondLots.map(({ id, isOwn, isReleasing }) => ({ id, isOwn, isReleasing }))).toEqual([
      { id: 1, isOwn: false, isReleasing: false },
      { id: 2, isOwn: true, isReleasing: false },
      { id: 3, isOwn: true, isReleasing: true },
    ]);

    expect(
      TreasuryBonds.availableBondSpace({
        vault,
        bondState: bondState.capacityState,
      }),
    ).toBe(5n * oneArgon);

    const moreFlexibleState = registry.createType<PalletTreasuryVaultBondState>('PalletTreasuryVaultBondState', {
      regularBondLots: [{ bondLotId: 1, bonds: 3 }],
      flexibleBonds: 200,
      reservedBondSpace: 2,
    });
    const moreFlexibleClient = createVaultBondClient(moreFlexibleState, displayLotsById, [2, 3]);
    const moreFlexibleBondState = await TreasuryBonds.getVaultBondState(moreFlexibleClient as any, 1, operatorAddress);

    expect(
      TreasuryBonds.availableBondSpace({
        vault,
        bondState: moreFlexibleBondState.capacityState,
      }),
    ).toBe(5n * oneArgon);

    activatedSecuritization = 4n * oneArgon;

    expect(
      TreasuryBonds.availableBondSpace({
        vault,
        bondState: bondState.capacityState,
      }),
    ).toBe(0n);
  });

  it('loads current-runtime regular bond frame allocations', async () => {
    const frameCapital = registry.createType<PalletTreasuryFrameVaultCapital>('PalletTreasuryFrameVaultCapital', {
      frameId: 10,
      vaults: {
        1: {
          regularBondAllocations: [{ bondLotId: 1, prorata: toFixedNumber(0.3, FIXED_U128_DECIMALS) }],
          flexibleBondsEligible: 7,
          flexibleProrata: toFixedNumber(0.7, FIXED_U128_DECIMALS),
          eligibleBonds: 10,
        },
      },
    });
    const client = createFrameBondClient(frameCapital, displayLotsById);

    const result = await TreasuryBonds.getCurrentFrameBondLots(client as any, 1, operatorAddress);

    expect(result.totalActiveBonds).toBe(10);
    expect(result.bondLots.map(({ id, bonds }) => ({ id, bonds }))).toEqual([{ id: 'lot:1', bonds: 3 }]);
  });

  it('caps purchases at activated securitization instead of full vault securitization', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const vault = {
      activatedSecuritization: () => 4n * oneArgon,
      securitization: 10n * oneArgon,
    };

    expect(
      TreasuryBonds.availableBondSpace({
        vault,
        bondState: [{ activeBonds: 3 }],
      }),
    ).toBe(oneArgon);
  });
});

function createVaultBondClient(vaultState: Codec, lotsById: Map<number, Codec>, ownerLotIds: number[]) {
  return {
    query: {
      treasury: {
        bondLotsByVault: vi.fn(async () => toPlain(vaultState)),
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

function createVaultBondLot({
  owner,
  bonds,
  isFlexible,
  releaseReason,
}: {
  owner: string;
  bonds: number;
  isFlexible?: boolean;
  releaseReason?: 'UserLiquidation';
}) {
  return registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
    owner,
    program: { Vault: { vaultId: 1, sharingPercent: 0, bonusPercent: 0 } },
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

function createCapacityVault(activatedSecuritization: () => bigint) {
  return {
    activatedSecuritization,
  };
}
