import {
  type AccountId32,
  type ArgonClient,
  FIXED_U128_DECIMALS,
  fromFixedNumber,
  type PalletTreasuryFrameVaultCapital,
  type PalletTreasuryVaultCapital,
  PERMILL_DECIMALS,
  type SubmittableExtrinsic,
  toFixedNumber,
  type u128,
  type u32,
} from '@argonprotocol/mainchain';
import { stringToU8a, u8aConcat } from '@polkadot/util';
import { bigNumberToBigInt } from './utils.js';
import BigNumber from 'bignumber.js';
import { BondLot, type IBondLotSource, type V146TreasuryFunderState } from './BondLot.js';
import type { ArgonQueryClient } from './MainchainClients.js';

export interface IFrameBondLot {
  id: string;
  accountId: string;
  bonds: number;
  prorata: bigint;
  isOperator: boolean;
  details?: BondLot;
}

export interface IFrameBondSummary {
  bondLot: IFrameBondLot;
  poolSharePct: number;
  totalEarnings: bigint;
  vaultEarnings: bigint;
  keepPct: number;
  frameStartDate: string;
  frameEndDate: string;
}

export interface INextFrameBondAvailability {
  nextFrameBondCapacity: number;
  totalActiveBonds: number;
  nextFrameAvailableBonds: number;
}

export class TreasuryBonds {
  public static bondFullCapacityPerFrame = false;

  public static hasFullCapacityPerFrame(client: ArgonQueryClient): boolean {
    return typeof client.query.treasury.pendingBondReleasesByFrame === 'function';
  }

  public static async getActiveBonds(
    client: ArgonQueryClient,
    vaultId: number,
  ): Promise<{
    totalActiveBonds: number;
    vaultActiveBonds: number;
  }> {
    if (typeof client.query.treasury.currentFrameVaultCapital !== 'function') {
      let totalActiveBonds = 0;
      let vaultActiveBonds = 0;
      const capitalActive = await (
        client.query.treasury as unknown as {
          capitalActive: () => Promise<Iterable<V146CapitalActive>>;
        }
      ).capitalActive();

      for (const entrant of capitalActive) {
        const activeBonds = BondLot.microgonsToWholeBonds(entrant.activatedCapital.toBigInt());
        totalActiveBonds += activeBonds;

        if (entrant.vaultId.toNumber() === vaultId) {
          vaultActiveBonds += activeBonds;
        }
      }

      return {
        totalActiveBonds,
        vaultActiveBonds,
      };
    }

    const frameCapital = await client.query.treasury.currentFrameVaultCapital();
    if (frameCapital.isNone) {
      return {
        totalActiveBonds: 0,
        vaultActiveBonds: 0,
      };
    }

    let totalActiveBonds = 0;
    let vaultActiveBonds = 0;

    for (const [nextVaultId, capital] of frameCapital.unwrap().vaults.entries()) {
      const activeBonds = capital.eligibleBonds.toNumber();
      totalActiveBonds += activeBonds;

      if (nextVaultId.toNumber() === vaultId) {
        vaultActiveBonds = activeBonds;
      }
    }

    return {
      totalActiveBonds,
      vaultActiveBonds,
    };
  }

  public static getBidPoolPercentForVaults(client: ArgonQueryClient): number {
    const percent = client.consts.treasury.percentForTreasuryReserves.toNumber();
    return (100 - percent) / 100;
  }

  public static async getTreasuryPayoutPotential(client: ArgonQueryClient): Promise<bigint> {
    return this.getDistributableBidPool(client);
  }

  public static async getDistributableBidPool(client: ArgonQueryClient): Promise<bigint> {
    const bidPoolAccountId = TreasuryBonds.getBidPoolAccountId(client);
    const accountInfo = await client.query.system.account(bidPoolAccountId);
    const revenue = accountInfo.data.free.toBigInt();
    const percentForVaults = TreasuryBonds.getBidPoolPercentForVaults(client);
    return bigNumberToBigInt(BigNumber(revenue).times(percentForVaults));
  }

  public static getBidPoolAccountId(client: ArgonQueryClient): Uint8Array {
    const palletId = client.consts.treasury.palletId.toU8a();
    const raw = u8aConcat(stringToU8a('modl'), palletId, new Uint8Array(32 - 4 - palletId.length));
    return client.registry.createType('AccountId32', raw).toU8a();
  }

  public static getBondPurchaseCapacity(
    totalBondCapacityMicrogons: bigint,
    bondFullCapacity = TreasuryBonds.bondFullCapacityPerFrame,
  ): number {
    if (totalBondCapacityMicrogons <= 0n) return 0;

    const availableMicrogons = bondFullCapacity ? totalBondCapacityMicrogons : totalBondCapacityMicrogons / 10n;

    return BondLot.microgonsToWholeBonds(availableMicrogons);
  }

  public static calculateNextFrameBondAvailability(
    totalBondCapacityMicrogons: bigint,
    bondLots: Pick<BondLot, 'activeBonds'>[],
    bondFullCapacityPerFrame = TreasuryBonds.bondFullCapacityPerFrame,
  ): INextFrameBondAvailability {
    const nextFrameBondCapacity = TreasuryBonds.getBondPurchaseCapacity(
      totalBondCapacityMicrogons,
      bondFullCapacityPerFrame,
    );
    const totalActiveBonds = bondLots.reduce((sum, lot) => sum + lot.activeBonds, 0);
    const nextFrameAvailableBonds =
      totalActiveBonds < nextFrameBondCapacity ? nextFrameBondCapacity - totalActiveBonds : 0;

    return {
      nextFrameBondCapacity,
      totalActiveBonds,
      nextFrameAvailableBonds,
    };
  }

  public static potentialDailyRevenue(args: {
    distributableBidPool: bigint;
    globalActiveBonds: number;
    myActiveBonds: number;
    fullTreasuryBondCapacity: number;
    operatorKeepPct: number;
  }): bigint {
    const { distributableBidPool, globalActiveBonds, myActiveBonds, fullTreasuryBondCapacity, operatorKeepPct } = args;
    if (distributableBidPool <= 0n || fullTreasuryBondCapacity <= 0) return 0n;

    const globalWithoutMe = globalActiveBonds - myActiveBonds;
    const projectedGlobal = globalWithoutMe + fullTreasuryBondCapacity;
    if (projectedGlobal <= 0) return 0n;

    const grossRevenue = bigNumberToBigInt(
      BigNumber(distributableBidPool).multipliedBy(
        BigNumber(fullTreasuryBondCapacity).dividedBy(BigNumber(projectedGlobal)),
      ),
    );
    return bigNumberToBigInt(BigNumber(grossRevenue).multipliedBy(operatorKeepPct).dividedBy(100));
  }

  public static externalActiveBonds(bondLots: BondLot[]): number {
    return bondLots.filter(lot => !lot.isOwn).reduce((sum, lot) => sum + lot.activeBonds, 0);
  }

  public static totalActiveBonds(bondLots: BondLot[]): number {
    return bondLots.reduce((sum, lot) => sum + lot.activeBonds, 0);
  }

  public static async getBondLots(client: ArgonQueryClient, vaultId: number, ownAddress?: string): Promise<BondLot[]> {
    if (typeof client.query.treasury.bondLotsByVault !== 'function') {
      const entries = await (
        client.query.treasury as unknown as {
          funderStateByVaultAndAccount: V146FunderStateByVaultAndAccount;
        }
      ).funderStateByVaultAndAccount.entries(vaultId);

      const lots: BondLot[] = [];
      for (const [key, stateOption] of entries) {
        if (stateOption.isNone) continue;

        lots.push(
          ...BondLot.fromV146FunderState({
            accountId: key.args[1].toString(),
            vaultId,
            state: stateOption.unwrap(),
            ownAddress,
          }),
        );
      }

      return lots;
    }

    const vaultSummaries = await client.query.treasury.bondLotsByVault(vaultId);
    const idsBySourceOrder = vaultSummaries.map(summary => summary.bondLotId.toNumber());

    if (ownAddress) {
      const accountKeys = await client.query.treasury.bondLotIdsByAccount.keys(ownAddress);
      idsBySourceOrder.push(...accountKeys.map(key => key.args[1].toNumber()));
    }

    const ids = [...new Set(idsBySourceOrder)];
    const lotsById = await TreasuryBonds.getBondLotsById(client, ids);

    return ids.flatMap(id => {
      const lot = lotsById.get(id);
      return lot?.vaultId.toNumber() === vaultId ? [BondLot.fromRuntime(id, lot, ownAddress)] : [];
    });
  }

  public static async getCurrentFrameBondLots(
    client: ArgonQueryClient,
    vaultId: number,
    operatorAddress: string,
    frameId?: number,
  ) {
    if (typeof client.query.treasury.currentFrameVaultCapital !== 'function') {
      if (frameId === undefined) {
        return {
          bondLots: [],
          vaultSharingPct: 0,
          totalActiveBonds: 0,
          distributedEarnings: 0n,
        };
      }

      const poolMap = await (
        client.query.treasury as unknown as {
          vaultPoolsByFrame: (frameId: number) => Promise<V146VaultPoolsByFrame>;
        }
      ).vaultPoolsByFrame(frameId);

      for (const [vaultIdCodec, pool] of poolMap.entries()) {
        if (vaultIdCodec.toNumber() !== vaultId) continue;

        const holderBonds: Array<{ accountId: string; bonds: number }> = [];

        for (const [accountIdCodec, amount] of pool.bondHolders.entries()) {
          const accountId = accountIdCodec.toString();
          const bonds = BondLot.microgonsToWholeBonds(amount.toBigInt());
          holderBonds.push({ accountId, bonds });
        }

        const bondLots: IFrameBondLot[] = [];
        const totalActiveBonds = holderBonds.reduce((sum, holder) => sum + holder.bonds, 0);

        for (const { accountId, bonds } of holderBonds) {
          bondLots.push({
            id: `account:${accountId}`,
            accountId,
            bonds,
            prorata: TreasuryBonds.getProrataFromBonds(bonds, totalActiveBonds),
            isOperator: accountId === operatorAddress,
          });
        }

        const vaultSharingPct = fromFixedNumber(pool.vaultSharingPercent.toBigInt(), PERMILL_DECIMALS)
          .times(100)
          .toNumber();
        const distributedEarnings = pool.distributedEarnings.isSome ? pool.distributedEarnings.unwrap().toBigInt() : 0n;

        return {
          bondLots,
          vaultSharingPct,
          totalActiveBonds,
          distributedEarnings,
        };
      }

      return {
        bondLots: [],
        vaultSharingPct: 0,
        totalActiveBonds: 0,
        distributedEarnings: 0n,
      };
    }

    const bondLots: IFrameBondLot[] = [];
    const frameCapital = await client.query.treasury.currentFrameVaultCapital();
    if (frameCapital.isNone) {
      return {
        bondLots,
        vaultSharingPct: 0,
        totalActiveBonds: 0,
        distributedEarnings: 0n,
      };
    }

    const vaultCapital = TreasuryBonds.getVaultCapital(frameCapital.unwrap(), vaultId);
    if (!vaultCapital) {
      return {
        bondLots,
        vaultSharingPct: 0,
        totalActiveBonds: 0,
        distributedEarnings: 0n,
      };
    }

    const totalActiveBonds = vaultCapital.eligibleBonds.toNumber();
    const bondLotIds = vaultCapital.bondLotAllocations.map(allocation => allocation.bondLotId.toNumber());
    const bondLotsById = await TreasuryBonds.getBondLotsById(client, bondLotIds);

    for (const allocation of vaultCapital.bondLotAllocations) {
      const bondLotId = allocation.bondLotId.toNumber();
      const prorata = allocation.prorata.toBigInt();
      const lot = bondLotsById.get(bondLotId);
      if (!lot) continue;

      const accountId = lot.owner.toString();
      const bonds = TreasuryBonds.getProrataBonds(totalActiveBonds, prorata);
      bondLots.push({
        id: `lot:${bondLotId}`,
        accountId,
        bonds,
        prorata,
        isOperator: accountId === operatorAddress,
        details: BondLot.fromRuntime(bondLotId, lot, operatorAddress),
      });
    }

    const vaultSharingPct = fromFixedNumber(vaultCapital.vaultSharingPercent.toBigInt(), PERMILL_DECIMALS)
      .times(100)
      .toNumber();

    return {
      bondLots,
      vaultSharingPct,
      totalActiveBonds,
      distributedEarnings: 0n,
    };
  }

  public static projectedFrameEarnings(args: {
    bondLotProrata: bigint;
    vaultBonds: number;
    globalBonds: number;
    distributableBidPool: bigint;
    earningsSharePct: number;
  }): bigint {
    const { bondLotProrata, vaultBonds, globalBonds, distributableBidPool, earningsSharePct } = args;
    if (bondLotProrata <= 0n || vaultBonds <= 0 || globalBonds <= 0 || distributableBidPool <= 0n) {
      return 0n;
    }

    const vaultEarnings = (distributableBidPool * BigInt(vaultBonds)) / BigInt(globalBonds);
    const partyPortion = (vaultEarnings * BigInt(Math.round(earningsSharePct))) / 100n;
    return bigNumberToBigInt(
      BigNumber(partyPortion.toString()).times(fromFixedNumber(bondLotProrata, FIXED_U128_DECIMALS)),
    );
  }

  public static prorataToPercent(prorata: bigint): number {
    return fromFixedNumber(prorata, FIXED_U128_DECIMALS).times(100).toNumber();
  }

  public static async getBondFrameHistory(
    client: ArgonQueryClient,
    vaultId: number,
    accountId: string,
  ): Promise<Array<{ frameId: number; bonds: number; earnings: bigint }>> {
    if (typeof client.query.treasury.bondLotsByVault !== 'function') {
      return [];
    }

    const result: Array<{ frameId: number; bonds: number; earnings: bigint }> = [];

    for (const { lot } of await TreasuryBonds.getBondLotsForVault(client, vaultId)) {
      if (lot.owner.toString() !== accountId || lot.lastFrameEarningsFrameId.isNone) continue;

      const frameId = lot.lastFrameEarningsFrameId.unwrap().toNumber();
      const bonds = lot.bonds.toNumber();
      const earnings = lot.lastFrameEarnings.isSome ? lot.lastFrameEarnings.unwrap().toBigInt() : 0n;

      result.push({ frameId, bonds, earnings });
    }

    return result.sort((a, b) => b.frameId - a.frameId);
  }

  public static async buildBuyBondTx(args: {
    client: ArgonClient;
    vaultId: number;
    accountId: string;
    bondPurchaseMicrogons: bigint;
  }): Promise<SubmittableExtrinsic> {
    if (typeof args.client.tx.treasury.buyBonds !== 'function') {
      const currentActiveBondMicrogons = await TreasuryBonds.getV146ActiveBondMicrogons(
        args.client,
        args.vaultId,
        args.accountId,
      );

      return (
        args.client.tx.treasury as unknown as {
          setAllocation: (vaultId: number, amount: bigint) => SubmittableExtrinsic;
        }
      ).setAllocation(args.vaultId, currentActiveBondMicrogons + args.bondPurchaseMicrogons);
    }

    return args.client.tx.treasury.buyBonds(args.vaultId, BondLot.microgonsToBonds(args.bondPurchaseMicrogons));
  }

  public static async buildReleaseBondLotTx(args: {
    client: ArgonClient;
    bondLot: Pick<BondLot, 'id' | 'vaultId' | 'accountId' | 'activeBondMicrogons'>;
  }): Promise<SubmittableExtrinsic> {
    if (typeof args.client.tx.treasury.liquidateBondLot !== 'function') {
      const currentActiveBondMicrogons = await TreasuryBonds.getV146ActiveBondMicrogons(
        args.client,
        args.bondLot.vaultId,
        args.bondLot.accountId,
      );
      const nextActiveBondMicrogons =
        currentActiveBondMicrogons > args.bondLot.activeBondMicrogons
          ? currentActiveBondMicrogons - args.bondLot.activeBondMicrogons
          : 0n;

      return (
        args.client.tx.treasury as unknown as {
          setAllocation: (vaultId: number, amount: bigint) => SubmittableExtrinsic;
        }
      ).setAllocation(args.bondLot.vaultId, nextActiveBondMicrogons);
    }

    return args.client.tx.treasury.liquidateBondLot(args.bondLot.id);
  }

  public static async subscribeBondLots(
    client: ArgonClient,
    vaultId: number,
    accountId: string,
    onUpdate: (lots: BondLot[]) => void,
  ): Promise<() => void> {
    if (typeof client.query.treasury.bondLotsByVault !== 'function') {
      return await (
        client.query.treasury as unknown as {
          funderStateByVaultAndAccount: V146FunderStateByVaultAndAccount;
        }
      ).funderStateByVaultAndAccount(vaultId, accountId, stateOption => {
        onUpdate(
          stateOption.isSome
            ? BondLot.fromV146FunderState({
                accountId,
                vaultId,
                state: stateOption.unwrap(),
                ownAddress: accountId,
              })
            : [],
        );
      });
    }

    return await client.query.treasury.bondLotsByVault(vaultId, () => {
      void TreasuryBonds.getBondLots(client, vaultId, accountId).then(lots => {
        onUpdate(lots.filter(lot => lot.accountId === accountId));
      });
    });
  }

  private static async getBondLotsForVault(client: ArgonQueryClient, vaultId: number): Promise<IBondLotSource[]> {
    const summaries = await client.query.treasury.bondLotsByVault(vaultId);
    const ids = summaries.map(summary => summary.bondLotId.toNumber());
    const lotsById = await TreasuryBonds.getBondLotsById(client, ids);

    return ids.flatMap(id => {
      const lot = lotsById.get(id);
      return lot ? [{ id, lot }] : [];
    });
  }

  private static async getBondLotsById(
    client: ArgonQueryClient,
    ids: number[],
  ): Promise<Map<number, IBondLotSource['lot']>> {
    if (ids.length === 0) return new Map();

    const lots = await client.query.treasury.bondLotById.multi(ids);
    const result = new Map<number, IBondLotSource['lot']>();

    for (let i = 0; i < ids.length; i += 1) {
      const lot = lots[i];
      if (lot.isSome) {
        result.set(ids[i], lot.unwrap());
      }
    }

    return result;
  }

  private static getVaultCapital(
    frameCapital: PalletTreasuryFrameVaultCapital,
    vaultId: number,
  ): PalletTreasuryVaultCapital | undefined {
    for (const [nextVaultId, vaultCapital] of frameCapital.vaults.entries()) {
      if (nextVaultId.toNumber() === vaultId) {
        return vaultCapital;
      }
    }
  }

  private static async getV146ActiveBondMicrogons(
    client: ArgonClient,
    vaultId: number,
    accountId: string,
  ): Promise<bigint> {
    const stateOption = await (
      client.query.treasury as unknown as {
        funderStateByVaultAndAccount: V146FunderStateByVaultAndAccount;
      }
    ).funderStateByVaultAndAccount(vaultId, accountId);
    if (stateOption.isNone) return 0n;

    const state = stateOption.unwrap();
    const heldPrincipal = state.heldPrincipal.toBigInt();
    const pendingReturn = state.pendingUnlockAmount.toBigInt();
    return heldPrincipal > pendingReturn ? heldPrincipal - pendingReturn : 0n;
  }

  private static getProrataBonds(totalBonds: number, prorata: bigint): number {
    const share = fromFixedNumber(prorata, FIXED_U128_DECIMALS);
    return Number(bigNumberToBigInt(BigNumber(totalBonds).times(share)));
  }

  private static getProrataFromBonds(bonds: number, totalBonds: number): bigint {
    if (bonds <= 0 || totalBonds <= 0) return 0n;
    return toFixedNumber(BigNumber(bonds).dividedBy(totalBonds), FIXED_U128_DECIMALS);
  }
}

interface V146CapitalActive {
  readonly activatedCapital: u128;
  readonly vaultId: u32;
}

interface V146FunderStateByVaultAndAccount {
  (vaultId: number, accountId: string): Promise<V146Option<V146TreasuryFunderState>>;
  (
    vaultId: number,
    accountId: string,
    callback: (stateOption: V146Option<V146TreasuryFunderState>) => void,
  ): Promise<() => void>;
  entries(vaultId: number): Promise<Array<[V146StorageKey<[u32, AccountId32]>, V146Option<V146TreasuryFunderState>]>>;
}

interface V146Option<T> {
  readonly isNone: boolean;
  readonly isSome: boolean;
  unwrap(): T;
}

interface V146StorageKey<T> {
  readonly args: T;
}

interface V146VaultPoolsByFrame {
  entries(): Iterable<[u32, V146VaultPool]>;
}

interface V146VaultPool {
  readonly bondHolders: {
    entries(): Iterable<[AccountId32, u128]>;
  };
  readonly vaultSharingPercent: u128;
  readonly distributedEarnings: {
    isSome: boolean;
    unwrap(): u128;
  };
}
