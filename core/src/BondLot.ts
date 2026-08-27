import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';

import { MICRONOTS_PER_ARGONOT } from './Currency.js';
import { calculateAnnualPercentageYield } from './FinancialReturns.js';

type RuntimeBondLot = NonNullable<HistoricalQueryRecord<'treasury', 'bondLotById'>>;

export interface IBondLotSource {
  id: number;
  lot: RuntimeBondLot;
}

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

type IBondLotModel = {
  id: number;
  programType: 'Vault' | 'Argonot';
  accountId: string;
  vaultId?: number;
  bonds: number;
  createdFrame: number;
  participatedFrames: number;
  lastEarningsFrame: number | null;
  lastEarnings: bigint;
  lifetimeEarnings: bigint;
  lifetimeBondedFrameMicrogons: bigint;
  sharingPercent?: number;
  bonusPercent: number;
  releaseFrame: number | null;
  releaseReason?: NonNullable<RuntimeBondLot['releaseReason']>['type'];
  isReleasing: boolean;
  isFlexible: boolean;
  isOwn: boolean;
  canRelease: boolean;
};

export class BondLot {
  public readonly id: number;
  public readonly programType: 'Vault' | 'Argonot';
  public readonly nativeAsset: 'ARGN' | 'ARGNOT';
  public readonly accountId: string;
  public readonly vaultId?: number;
  public readonly bonds: number;
  public readonly createdFrame: number;
  public readonly participatedFrames: number;
  public readonly lastEarningsFrame: number | null;
  public readonly lastEarnings: bigint;
  public readonly lifetimeEarnings: bigint;
  public readonly lifetimeBondedFrameMicrogons: bigint;
  public sharingPercent?: number;
  public readonly bonusPercent: number;
  public readonly releaseFrame: number | null;
  public readonly releaseReason?: NonNullable<RuntimeBondLot['releaseReason']>['type'];
  public readonly isReleasing: boolean;
  public readonly isFlexible: boolean;
  public readonly isOwn: boolean;
  public readonly canRelease: boolean;

  constructor(model: IBondLotModel) {
    this.id = model.id;
    this.programType = model.programType;
    this.nativeAsset = model.programType === 'Vault' ? 'ARGN' : 'ARGNOT';
    this.accountId = model.accountId;
    this.vaultId = model.vaultId;
    this.bonds = model.bonds;
    this.createdFrame = model.createdFrame;
    this.participatedFrames = model.participatedFrames;
    this.lastEarningsFrame = model.lastEarningsFrame;
    this.lastEarnings = model.lastEarnings;
    this.lifetimeEarnings = model.lifetimeEarnings;
    this.lifetimeBondedFrameMicrogons = model.lifetimeBondedFrameMicrogons;
    this.sharingPercent = model.sharingPercent;
    this.bonusPercent = model.bonusPercent;
    this.releaseFrame = model.releaseFrame;
    this.releaseReason = model.releaseReason;
    this.isReleasing = model.isReleasing;
    this.isFlexible = model.isFlexible;
    this.isOwn = model.isOwn;
    this.canRelease = model.canRelease;
  }

  public static fromRuntime(id: number, lot: RuntimeBondLot, ownAddress?: string): BondLot {
    const accountId = lot.owner;
    const bonds = lot.bonds;
    const participatedFrames = lot.participatedFrames;
    const programType = lot.program?.type ?? 'Vault';
    let vaultId: number | undefined;
    let sharingPercent: number | undefined;
    let bonusPercent = 0;

    if (programType === 'Vault') {
      const vaultTerms = lot.program?.type === 'Vault' ? lot.program.value : undefined;
      vaultId = vaultTerms?.vaultId ?? lot.vaultId;
      sharingPercent = (vaultTerms?.sharingPercent ?? lot.sharingPercent)?.times(100).toNumber();
      bonusPercent = (vaultTerms?.bonusPercent ?? lot.bonusPercent)?.times(100).toNumber() ?? 0;
    }

    return new BondLot({
      id,
      programType,
      accountId,
      vaultId,
      bonds,
      createdFrame: lot.createdFrameId,
      participatedFrames,
      lastEarningsFrame: lot.lastFrameEarningsFrameId,
      lastEarnings: lot.lastFrameEarnings ?? 0n,
      lifetimeEarnings: lot.cumulativeEarnings,
      lifetimeBondedFrameMicrogons:
        programType === 'Vault' ? BondLot.bondsToMicrogons(bonds) * BigInt(participatedFrames) : 0n,
      sharingPercent,
      bonusPercent,
      releaseFrame: lot.releaseFrameId,
      releaseReason: lot.releaseReason?.type,
      isReleasing: lot.releaseReason !== null,
      isFlexible: lot.isFlexible ?? lot.isBackfill ?? false,
      isOwn: accountId === ownAddress,
      canRelease: accountId === ownAddress,
    });
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

  public getAPY(): number {
    return BondLot.getAPY([this]);
  }

  public static getAPY(lots: BondLot[]): number {
    const vaultLots = lots.filter(lot => lot.programType === 'Vault');
    const lifetimeEarnings = vaultLots.reduce((sum, lot) => sum + lot.lifetimeEarnings, 0n);
    const lifetimeBondedFrameAmount = vaultLots.reduce((sum, lot) => {
      return sum + lot.lifetimeBondedFrameMicrogons;
    }, 0n);

    if (lifetimeBondedFrameAmount <= 0n) return 0;

    return calculateAnnualPercentageYield({
      startingValue: lifetimeBondedFrameAmount,
      endingValue: lifetimeBondedFrameAmount + lifetimeEarnings,
      periodDays: 1,
    });
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
        returningBondFrame: BondLot.getEarliestFrame(totals.returningBondFrame, lot.releaseFrame),
        lifetimeEarnings: totals.lifetimeEarnings + lot.lifetimeEarnings,
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
