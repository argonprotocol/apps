import { describe, expect, it, vi } from 'vitest';
import {
  getOfflineRegistry,
  MICROGONS_PER_ARGON,
  type PalletTreasuryBondLot,
  type PalletTreasuryBondLotSummary,
  type PalletTreasuryVaultBondState,
  PriceIndex,
  type Vec,
  Vault,
} from '@argonprotocol/mainchain';
import { encodeAddress } from '@polkadot/util-crypto';

import { MICRONOTS_PER_ARGONOT } from '../src/Currency.ts';
import { TreasuryBonds } from '../src/TreasuryBonds.ts';
import { numberCodec, optionCodec } from './helpers/codecs.ts';

const registry = getOfflineRegistry();
const operatorAddress = encodeAddress(new Uint8Array(32).fill(0x11));
const buyerAddress = encodeAddress(new Uint8Array(32).fill(0x22));
const displayLotsById = new Map([
  [1, createVaultBondLot({ owner: buyerAddress, bonds: 3 })],
  [2, createVaultBondLot({ owner: operatorAddress, bonds: 20, isBackfill: true })],
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

  it('keeps owner display lots separate from current runtime capacity', async () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    let capacityBonds = 10n;
    const vault = createCapacityVault(() => capacityBonds);
    const priceIndex = new PriceIndex();
    vi.spyOn(priceIndex, 'getSatoshiPriceInTargetMicrogons').mockImplementation(
      satoshis => BigInt(satoshis) * oneArgon,
    );

    const runtimeState = registry.createType<PalletTreasuryVaultBondState>('PalletTreasuryVaultBondState', {
      bondLots: [{ bondLotId: 1, bonds: 3 }],
      backfillBonds: 20,
      backfillBondsReserved: 2,
    });
    const client = createVaultBondClient(runtimeState, displayLotsById, [2, 3]);
    const bondState = await TreasuryBonds.getVaultBondState(client as any, 1, operatorAddress);

    expect(bondState.backfillBonds).toBe(20);
    expect(bondState.backfillBondsReserved).toBe(2);
    expect(bondState.ordinaryBonds).toBe(3);
    expect(
      bondState.bondLots.map(({ id, isOwn, isBackfill, isReleasing }) => ({ id, isOwn, isBackfill, isReleasing })),
    ).toEqual([
      { id: 1, isOwn: false, isBackfill: false, isReleasing: false },
      { id: 2, isOwn: true, isBackfill: true, isReleasing: false },
      { id: 3, isOwn: true, isBackfill: false, isReleasing: true },
    ]);

    expect(
      TreasuryBonds.availableBondSpace({
        vault,
        priceIndex,
        bondState: bondState.capacityState,
      }),
    ).toBe(5n * oneArgon);

    const moreBackfillState = registry.createType<PalletTreasuryVaultBondState>('PalletTreasuryVaultBondState', {
      bondLots: [{ bondLotId: 1, bonds: 3 }],
      backfillBonds: 200,
      backfillBondsReserved: 2,
    });
    const moreBackfillClient = createVaultBondClient(moreBackfillState, displayLotsById, [2, 3]);
    const moreBackfillBondState = await TreasuryBonds.getVaultBondState(moreBackfillClient as any, 1, operatorAddress);

    expect(
      TreasuryBonds.availableBondSpace({
        vault,
        priceIndex,
        bondState: moreBackfillBondState.capacityState,
      }),
    ).toBe(5n * oneArgon);

    capacityBonds = 4n;

    expect(
      TreasuryBonds.availableBondSpace({
        vault,
        priceIndex,
        bondState: bondState.capacityState,
      }),
    ).toBe(0n);
  });

  it('uses only legacy storage summaries for capacity', async () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const vault = createCapacityVault(() => 10n);
    const priceIndex = new PriceIndex();
    vi.spyOn(priceIndex, 'getSatoshiPriceInTargetMicrogons').mockImplementation(
      satoshis => BigInt(satoshis) * oneArgon,
    );

    const legacyState = registry.createType<Vec<PalletTreasuryBondLotSummary>>('Vec<PalletTreasuryBondLotSummary>', [
      { bondLotId: 1, bonds: 3 },
    ]);
    const client = createVaultBondClient(legacyState, displayLotsById, [2, 3]);
    const bondState = await TreasuryBonds.getVaultBondState(client as any, 1, operatorAddress);

    expect(bondState.backfillBonds).toBe(0);
    expect(bondState.backfillBondsReserved).toBe(0);
    expect(bondState.ordinaryBonds).toBe(3);
    expect(bondState.bondLots.map(lot => lot.id)).toEqual([1, 2, 3]);
    expect(
      TreasuryBonds.availableBondSpace({
        vault,
        priceIndex,
        bondState: bondState.capacityState,
      }),
    ).toBe(7n * oneArgon);
  });

  it('uses the larger of vault securitization and securitized Bitcoin value for bond capacity', () => {
    const oneArgon = BigInt(MICROGONS_PER_ARGON);
    const vault = createCapacityVault(() => 4n, 10n * oneArgon);
    const priceIndex = new PriceIndex();
    vi.spyOn(priceIndex, 'getSatoshiPriceInTargetMicrogons').mockImplementation(
      satoshis => BigInt(satoshis) * oneArgon,
    );
    const bondState = [{ activeBonds: 3 }];

    expect(TreasuryBonds.availableBondSpace({ vault, priceIndex, bondState })).toBe(7n * oneArgon);

    vault.securitization = 2n * oneArgon;

    expect(TreasuryBonds.availableBondSpace({ vault, priceIndex, bondState })).toBe(1n * oneArgon);
  });
});

function createVaultBondClient(
  vaultState: PalletTreasuryVaultBondState | Vec<PalletTreasuryBondLotSummary>,
  lotsById: Map<number, PalletTreasuryBondLot>,
  ownerLotIds: number[],
) {
  return {
    query: {
      treasury: {
        bondLotsByVault: vi.fn(async () => vaultState),
        bondLotIdsByAccount: {
          keys: vi.fn(async () => ownerLotIds.map(id => ({ args: [undefined, numberCodec(id)] }))),
        },
        bondLotById: {
          multi: vi.fn(async (ids: number[]) => ids.map(id => optionCodec(lotsById.get(id)))),
        },
      },
    },
  };
}

function createVaultBondLot({
  owner,
  bonds,
  isBackfill,
  releaseReason,
}: {
  owner: string;
  bonds: number;
  isBackfill?: boolean;
  releaseReason?: 'UserLiquidation';
}) {
  return registry.createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
    owner,
    program: { Vault: { vaultId: 1, sharingPercent: 0, bonusPercent: 0 } },
    bonds,
    isBackfill: isBackfill ?? false,
    createdFrameId: 1,
    participatedFrames: 0,
    lastFrameEarningsFrameId: null,
    lastFrameEarnings: null,
    cumulativeEarnings: 0,
    releaseFrameId: releaseReason ? 2 : null,
    releaseReason: releaseReason ?? null,
  });
}

function createCapacityVault(getCapacityBonds: () => bigint, securitization = 0n) {
  const vault = Object.assign(Object.create(Vault.prototype), {
    effectiveSecuritizedSatoshis: getCapacityBonds,
    securitization,
  }) as Vault;

  vault.availableBondSpace = vault.availableBondSpace.bind(vault);
  return vault;
}
