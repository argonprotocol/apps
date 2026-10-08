import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { CurrentRuntimeQueries, LiveQueryRecord, RuntimeQueryResult } from '@argonprotocol/runtime-client';

import { MICRONOTS_PER_ARGONOT } from './Currency.js';
import type { ArgonCurrentQueryClient } from './MainchainClients.js';

type RuntimeBondLot = NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['bondLotById']>>;

export type IBondLotTotals = {
  totalBonds: number;
  activeBonds: number;
  returningBonds: number;
  totalBondMicrogons: bigint;
  activeBondMicrogons: bigint;
  returningBondMicrogons: bigint;
  returningBondFrame: number | null;
  lifetimeEarnings: bigint;
  totalArgonotBondMicronots: bigint;
};

export class BondLot implements RuntimeBondLot {
  declare public readonly owner: RuntimeBondLot['owner'];
  declare public readonly program: RuntimeBondLot['program'];
  declare public readonly bonds: RuntimeBondLot['bonds'];
  declare public readonly isFlexible: RuntimeBondLot['isFlexible'];
  declare public readonly lockedFrameTerms: RuntimeBondLot['lockedFrameTerms'];
  declare public readonly createdFrameId: RuntimeBondLot['createdFrameId'];
  declare public readonly participatedFrames: RuntimeBondLot['participatedFrames'];
  declare public readonly lastFrameEarningsFrameId: RuntimeBondLot['lastFrameEarningsFrameId'];
  declare public readonly lastFrameEarnings: RuntimeBondLot['lastFrameEarnings'];
  declare public readonly cumulativeEarnings: RuntimeBondLot['cumulativeEarnings'];
  declare public readonly releaseFrameId: RuntimeBondLot['releaseFrameId'];
  declare public readonly releaseReason: RuntimeBondLot['releaseReason'];

  public earningsDestination: 'Owner' | 'VaultForFlexible' = 'Owner';

  constructor(
    public readonly id: number,
    lot: RuntimeBondLot,
    public readonly ownAddress?: string,
  ) {
    Object.assign(this, lot);
  }

  public static fromRuntime(
    id: number,
    lot: NonNullable<LiveQueryRecord<'treasury', 'bondLotById'>>,
    ownAddress?: string,
  ): BondLot {
    if ('lockedFrameTerms' in lot) return new BondLot(id, lot, ownAddress);
    const normalized = new BondLot(id, { ...lot, lockedFrameTerms: null }, ownAddress);
    normalized.earningsDestination = 'VaultForFlexible';
    return normalized;
  }

  public static async get(client: ArgonCurrentQueryClient, id: number, ownAddress?: string): Promise<BondLot | null> {
    const lot = await client.query.treasury.bondLotById(id);
    return lot ? BondLot.fromRuntime(id, lot, ownAddress) : null;
  }

  public withEarningsBackfill(addedFrames: number, addedEarnings: bigint): BondLot {
    return new BondLot(
      this.id,
      {
        ...this,
        cumulativeEarnings: this.cumulativeEarnings + addedEarnings,
        participatedFrames: this.participatedFrames + addedFrames,
      },
      this.ownAddress,
    );
  }

  public get programType(): RuntimeBondLot['program']['type'] {
    return this.program.type;
  }

  public get nativeAsset(): 'ARGN' | 'ARGNOT' {
    return this.program.type === 'Vault' ? 'ARGN' : 'ARGNOT';
  }

  public get vaultId(): number | undefined {
    return this.program.type === 'Vault' ? this.program.value.vaultId : undefined;
  }

  public get isReleasing(): boolean {
    return this.releaseReason !== null;
  }

  public get isOwn(): boolean {
    return this.owner === this.ownAddress;
  }

  public get canRelease(): boolean {
    return this.isOwn;
  }

  public get activeBonds(): number {
    return this.isReleasing ? 0 : this.bonds;
  }

  public get returningBonds(): number {
    return this.isReleasing ? this.bonds : 0;
  }

  public get bondMicrogons(): bigint {
    return BondLot.bondsToMicrogons(this.bonds);
  }

  public get principalMicrogons(): bigint | undefined {
    if (this.programType !== 'Vault') return;
    return BondLot.bondsToMicrogons(this.bonds);
  }

  public get principalMicronots(): bigint | undefined {
    if (this.programType !== 'Argonot') return;
    return BigInt(this.bonds) * BigInt(MICRONOTS_PER_ARGONOT);
  }

  public get activeBondMicrogons(): bigint {
    return BondLot.bondsToMicrogons(this.activeBonds);
  }

  public get returningBondMicrogons(): bigint {
    return BondLot.bondsToMicrogons(this.returningBonds);
  }

  public static getTotals(lots: BondLot[]): IBondLotTotals {
    return lots.reduce<IBondLotTotals>(
      (totals, lot) => ({
        totalBonds: totals.totalBonds + lot.bonds,
        activeBonds: totals.activeBonds + lot.activeBonds,
        returningBonds: totals.returningBonds + lot.returningBonds,
        totalBondMicrogons: totals.totalBondMicrogons + (lot.principalMicrogons ?? 0n),
        activeBondMicrogons:
          totals.activeBondMicrogons + (lot.programType === 'Vault' ? BondLot.bondsToMicrogons(lot.activeBonds) : 0n),
        returningBondMicrogons:
          totals.returningBondMicrogons +
          (lot.programType === 'Vault' ? BondLot.bondsToMicrogons(lot.returningBonds) : 0n),
        returningBondFrame: BondLot.getEarliestFrame(totals.returningBondFrame, lot.releaseFrameId),
        lifetimeEarnings: totals.lifetimeEarnings + lot.cumulativeEarnings,
        totalArgonotBondMicronots: totals.totalArgonotBondMicronots + (lot.principalMicronots ?? 0n),
      }),
      {
        totalBonds: 0,
        activeBonds: 0,
        returningBonds: 0,
        totalBondMicrogons: 0n,
        activeBondMicrogons: 0n,
        returningBondMicrogons: 0n,
        returningBondFrame: null,
        lifetimeEarnings: 0n,
        totalArgonotBondMicronots: 0n,
      },
    );
  }

  public static bondsToMicrogons(bonds: number): bigint {
    return BigInt(bonds) * BigInt(MICROGONS_PER_ARGON);
  }

  public static microgonsToWholeBonds(microgons: bigint): number {
    return Number(microgons / BigInt(MICROGONS_PER_ARGON));
  }

  public static microgonsToBonds(microgons: bigint): number {
    const microgonsPerBond = BigInt(MICROGONS_PER_ARGON);
    if (microgons % microgonsPerBond !== 0n) {
      throw new Error('Treasury bonds must be purchased in whole-ARGN bond units.');
    }

    return Number(microgons / microgonsPerBond);
  }

  private static getEarliestFrame(current: number | null, next: number | null): number | null {
    if (next == null) return current;
    return current == null ? next : Math.min(current, next);
  }
}
