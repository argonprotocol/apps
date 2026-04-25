import BigNumber from 'bignumber.js';
import {
  MICROGONS_PER_ARGON,
  type Option,
  type PalletTreasuryBondLot,
  type u64,
  type u128,
} from '@argonprotocol/mainchain';

import { compoundXTimes } from './utils.js';

export interface IBondLotSource {
  id: number;
  lot: PalletTreasuryBondLot;
}

export interface V146TreasuryFunderState {
  readonly heldPrincipal: u128;
  readonly pendingUnlockAmount: u128;
  readonly pendingUnlockAtFrame: Option<u64>;
  readonly lifetimeCompoundedEarnings: u128;
  readonly lifetimePrincipalDeployed: u128;
  readonly lifetimePrincipalLastBasisFrame: u64;
}

export type IBondLotTotals = {
  totalBonds: number;
  activeBonds: number;
  returningBonds: number;
  totalBondMicrogons: bigint;
  activeBondMicrogons: bigint;
  returningBondMicrogons: bigint;
  returningBondFrame: number | null;
};

type IBondLotModel = {
  id: number;
  accountId: string;
  vaultId: number;
  bonds: number;
  createdFrame: number;
  participatedFrames: number;
  lastEarningsFrame: number | null;
  lastEarnings: bigint;
  lifetimeEarnings: bigint;
  lifetimeBondedFrameMicrogons: bigint;
  releaseFrame: number | null;
  isReleasing: boolean;
  isOwn: boolean;
  canRelease: boolean;
};

export class BondLot {
  public readonly id: number;
  public readonly accountId: string;
  public readonly vaultId: number;
  public readonly bonds: number;
  public readonly createdFrame: number;
  public readonly participatedFrames: number;
  public readonly lastEarningsFrame: number | null;
  public readonly lastEarnings: bigint;
  public readonly lifetimeEarnings: bigint;
  public readonly lifetimeBondedFrameMicrogons: bigint;
  public readonly releaseFrame: number | null;
  public readonly isReleasing: boolean;
  public readonly isOwn: boolean;
  public readonly canRelease: boolean;

  constructor(model: IBondLotModel) {
    this.id = model.id;
    this.accountId = model.accountId;
    this.vaultId = model.vaultId;
    this.bonds = model.bonds;
    this.createdFrame = model.createdFrame;
    this.participatedFrames = model.participatedFrames;
    this.lastEarningsFrame = model.lastEarningsFrame;
    this.lastEarnings = model.lastEarnings;
    this.lifetimeEarnings = model.lifetimeEarnings;
    this.lifetimeBondedFrameMicrogons = model.lifetimeBondedFrameMicrogons;
    this.releaseFrame = model.releaseFrame;
    this.isReleasing = model.isReleasing;
    this.isOwn = model.isOwn;
    this.canRelease = model.canRelease;
  }

  public static fromRuntime(id: number, lot: PalletTreasuryBondLot, ownAddress?: string): BondLot {
    const accountId = lot.owner.toString();
    const bonds = lot.bonds.toNumber();
    const participatedFrames = lot.participatedFrames.toNumber();

    return new BondLot({
      id,
      accountId,
      vaultId: lot.vaultId.toNumber(),
      bonds,
      createdFrame: lot.createdFrameId.toNumber(),
      participatedFrames,
      lastEarningsFrame: lot.lastFrameEarningsFrameId.isSome ? lot.lastFrameEarningsFrameId.unwrap().toNumber() : null,
      lastEarnings: lot.lastFrameEarnings.isSome ? lot.lastFrameEarnings.unwrap().toBigInt() : 0n,
      lifetimeEarnings: lot.cumulativeEarnings.toBigInt(),
      lifetimeBondedFrameMicrogons: BondLot.bondsToMicrogons(bonds) * BigInt(participatedFrames),
      releaseFrame: lot.releaseFrameId.isSome ? lot.releaseFrameId.unwrap().toNumber() : null,
      isReleasing: lot.releaseReason.isSome,
      isOwn: accountId === ownAddress,
      canRelease: accountId === ownAddress,
    });
  }

  public static fromV146FunderState(args: {
    accountId: string;
    vaultId: number;
    state: V146TreasuryFunderState;
    ownAddress?: string;
  }): BondLot[] {
    const { accountId, vaultId, state, ownAddress } = args;
    const heldPrincipal = state.heldPrincipal.toBigInt();
    const pendingReturn = state.pendingUnlockAmount.toBigInt();
    const activePrincipal = heldPrincipal > pendingReturn ? heldPrincipal - pendingReturn : 0n;
    const releaseFrame = state.pendingUnlockAtFrame.isSome ? state.pendingUnlockAtFrame.unwrap().toNumber() : null;
    const isOwn = accountId === ownAddress;
    const lots: BondLot[] = [];

    if (activePrincipal > 0n) {
      lots.push(
        new BondLot({
          id: 0,
          accountId,
          vaultId,
          bonds: BondLot.microgonsToWholeBonds(activePrincipal),
          createdFrame: 0,
          participatedFrames: 0,
          lastEarningsFrame: state.lifetimePrincipalLastBasisFrame.toNumber(),
          lastEarnings: 0n,
          lifetimeEarnings: state.lifetimeCompoundedEarnings.toBigInt(),
          lifetimeBondedFrameMicrogons: state.lifetimePrincipalDeployed.toBigInt(),
          releaseFrame: null,
          isReleasing: false,
          isOwn,
          canRelease: isOwn,
        }),
      );
    }

    if (pendingReturn > 0n) {
      lots.push(
        new BondLot({
          id: 1,
          accountId,
          vaultId,
          bonds: BondLot.microgonsToWholeBonds(pendingReturn),
          createdFrame: 0,
          participatedFrames: 0,
          lastEarningsFrame: null,
          lastEarnings: 0n,
          lifetimeEarnings: 0n,
          lifetimeBondedFrameMicrogons: 0n,
          releaseFrame,
          isReleasing: true,
          isOwn,
          canRelease: false,
        }),
      );
    }

    return lots;
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
    const lifetimeEarnings = lots.reduce((sum, lot) => sum + lot.lifetimeEarnings, 0n);
    const lifetimeBondedFrameAmount = lots.reduce((sum, lot) => {
      return sum + lot.lifetimeBondedFrameMicrogons;
    }, 0n);

    if (lifetimeBondedFrameAmount <= 0n) return 0;

    const perFrameReturn = BigNumber(lifetimeEarnings.toString())
      .dividedBy(lifetimeBondedFrameAmount.toString())
      .toNumber();

    return compoundXTimes(perFrameReturn, 365) * 100;
  }

  public static getTotals(lots: BondLot[]): IBondLotTotals {
    return lots.reduce<IBondLotTotals>(
      (totals, lot) => ({
        totalBonds: totals.totalBonds + lot.bonds,
        activeBonds: totals.activeBonds + lot.activeBonds,
        returningBonds: totals.returningBonds + lot.returningBonds,
        totalBondMicrogons: totals.totalBondMicrogons + lot.bondMicrogons,
        activeBondMicrogons: totals.activeBondMicrogons + lot.activeBondMicrogons,
        returningBondMicrogons: totals.returningBondMicrogons + lot.returningBondMicrogons,
        returningBondFrame: BondLot.getEarliestFrame(totals.returningBondFrame, lot.releaseFrame),
      }),
      {
        totalBonds: 0,
        activeBonds: 0,
        returningBonds: 0,
        totalBondMicrogons: 0n,
        activeBondMicrogons: 0n,
        returningBondMicrogons: 0n,
        returningBondFrame: null,
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
