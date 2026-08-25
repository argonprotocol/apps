import {
  type ArgonClient,
  FIXED_U128_DECIMALS,
  fromFixedNumber,
  type PalletTreasuryBondLotSummary,
  type PalletTreasuryVaultBondState,
  type PalletTreasuryVaultCapital,
  type SubmittableExtrinsic,
} from '@argonprotocol/mainchain';
import { stringToU8a, u8aConcat } from '@polkadot/util';
import { bigNumberToBigInt } from './utils.js';
import BigNumber from 'bignumber.js';
import { BondLot, type IBondLotSource } from './BondLot.js';
import { MICRONOTS_PER_ARGONOT } from './Currency.js';
import type { ArgonQueryClient } from './MainchainClients.js';
import type { RuntimeSpec157 } from './runtimeCompatibility.js';
import type { Vault } from './Vault.js';

const U32_MAX = 4_294_967_295n;

export interface IFrameBondLot {
  id: string;
  accountId: string;
  bonds: number;
  prorata: bigint;
  isOperator: boolean;
  details: BondLot;
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

export type VaultBondCapacityState = { activeBonds: number }[];

export class TreasuryBonds {
  public static async getActiveBonds(
    client: ArgonQueryClient,
    vaultId: number,
  ): Promise<{
    totalActiveBonds: number;
    vaultActiveBonds: number;
  }> {
    const frameCapitalRaw = await client.query.treasury.currentFrameVaultCapital();
    if (frameCapitalRaw.isNone) {
      return {
        totalActiveBonds: 0,
        vaultActiveBonds: 0,
      };
    }

    let totalActiveBonds = 0;
    let vaultActiveBonds = 0;
    for (const [nextVaultId, capital] of frameCapitalRaw.unwrap().vaults.entries()) {
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

  public static getBondPurchaseCapacity(totalBondCapacityMicrogons: bigint): number {
    if (totalBondCapacityMicrogons <= 0n) return 0;
    return BondLot.microgonsToWholeBonds(totalBondCapacityMicrogons);
  }

  public static getArgonotBondPurchaseCapacity(args: {
    totalIssuanceMicronots: bigint;
    maxBondedPercent: number;
    totalActiveBonds: number;
    replacedBonds?: number;
  }): bigint {
    const { totalIssuanceMicronots, maxBondedPercent, totalActiveBonds, replacedBonds = 0 } = args;
    const unitsPerBond = BigInt(MICRONOTS_PER_ARGONOT);
    const maximumActiveBonds = (totalIssuanceMicronots * BigInt(maxBondedPercent)) / 100n / unitsPerBond;
    const remainingBonds = maximumActiveBonds - BigInt(totalActiveBonds) + BigInt(replacedBonds);

    return remainingBonds > 0n ? remainingBonds * unitsPerBond : 0n;
  }

  public static getArgonotBondMinimumPurchase(args: {
    configuredMinimumMicrounits: bigint;
    activeLotCount: number;
    maxActiveLots: number;
    smallestActiveLotBonds?: number;
  }): number {
    const { configuredMinimumMicrounits, activeLotCount, maxActiveLots, smallestActiveLotBonds } = args;
    const unitsPerBond = BigInt(MICRONOTS_PER_ARGONOT);
    const configuredMinimum = (configuredMinimumMicrounits + unitsPerBond - 1n) / unitsPerBond;
    let minimumBonds = configuredMinimum > 1n ? configuredMinimum : 1n;
    minimumBonds = minimumBonds < U32_MAX ? minimumBonds : U32_MAX;

    if (activeLotCount >= maxActiveLots && smallestActiveLotBonds !== undefined) {
      const cutoffMinimum = BigInt(smallestActiveLotBonds) + 1n;
      if (cutoffMinimum > minimumBonds) minimumBonds = cutoffMinimum;
    }

    return Number(minimumBonds);
  }

  public static getArgonotBondPurchaseLimit(args: {
    totalIssuanceMicronots: bigint;
    maxBondedPercent: number;
  }): bigint {
    const { totalIssuanceMicronots, maxBondedPercent } = args;
    const unitsPerBond = BigInt(MICRONOTS_PER_ARGONOT);
    const maximumActiveBonds = (totalIssuanceMicronots * BigInt(maxBondedPercent)) / 100n / unitsPerBond;
    const maximumPurchaseBonds = maximumActiveBonds / 10n;

    return maximumPurchaseBonds * unitsPerBond;
  }

  public static getVaultArgonotSecuritizationTarget(args: {
    activatedSecuritizationMicrogons: bigint;
    totalArgonIssuanceMicrogons: bigint;
    totalArgonotIssuanceMicronots: bigint;
  }): bigint {
    const { activatedSecuritizationMicrogons, totalArgonIssuanceMicrogons, totalArgonotIssuanceMicronots } = args;
    if (
      activatedSecuritizationMicrogons <= 0n ||
      totalArgonIssuanceMicrogons <= 0n ||
      totalArgonotIssuanceMicronots <= 0n
    ) {
      return 0n;
    }

    const networkArgonSecuritizationTarget = BigNumber(totalArgonIssuanceMicrogons).dividedBy(3);
    const vaultSecuritizationShare = BigNumber.minimum(
      BigNumber(activatedSecuritizationMicrogons).dividedBy(networkArgonSecuritizationTarget),
      1,
    );
    const networkArgonotTarget = BigNumber(totalArgonotIssuanceMicronots)
      .multipliedBy(40)
      .dividedBy(100)
      .integerValue(BigNumber.ROUND_DOWN);

    return bigNumberToBigInt(networkArgonotTarget.multipliedBy(vaultSecuritizationShare), true);
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
    return (await TreasuryBonds.getVaultBondState(client, vaultId, ownAddress)).bondLots;
  }

  public static async getVaultBondState(client: ArgonQueryClient, vaultId: number, ownAddress?: string) {
    const { summaries, capacityState, ordinaryBonds, flexibleBonds, reservedBondSpace } =
      await TreasuryBonds.getVaultBondSources(client, vaultId);
    const idsBySourceOrder = [...summaries].map(summary => summary.bondLotId.toNumber());

    if (ownAddress) {
      const accountKeys = await client.query.treasury.bondLotIdsByAccount.keys(ownAddress);
      idsBySourceOrder.push(...accountKeys.map(key => key.args[1].toNumber()));
    }

    const ids = [...new Set(idsBySourceOrder)];
    const lotsById = await TreasuryBonds.getBondLotsById(client, ids);
    const bondLots = ids.flatMap(id => {
      const lot = lotsById.get(id);
      if (!lot) return [];

      const bondLot = BondLot.fromRuntime(id, lot, ownAddress);
      return bondLot.vaultId === vaultId ? [bondLot] : [];
    });

    return {
      bondLots,
      capacityState,
      ordinaryBonds,
      flexibleBonds,
      reservedBondSpace,
    };
  }

  public static availableBondSpace({
    vault,
    bondState,
  }: {
    vault: Pick<Vault, 'activatedSecuritization'>;
    bondState?: VaultBondCapacityState;
  }): bigint {
    const bondCapacity = TreasuryBonds.getBondPurchaseCapacity(vault.activatedSecuritization());
    const unavailableBonds = [...(bondState ?? [])].reduce((total, state) => total + state.activeBonds, 0);
    const availableBonds = bondCapacity > unavailableBonds ? bondCapacity - unavailableBonds : 0;

    return BondLot.bondsToMicrogons(availableBonds);
  }

  public static async getBondLotsByAccount(client: ArgonQueryClient, accountId: string): Promise<BondLot[]> {
    const accountKeys = await client.query.treasury.bondLotIdsByAccount.keys(accountId);
    const ids = [...new Set(accountKeys.map(key => key.args[1].toNumber()))];
    const lotsById = await TreasuryBonds.getBondLotsById(client, ids);

    return ids.flatMap(id => {
      const lot = lotsById.get(id);
      return lot ? [BondLot.fromRuntime(id, lot, accountId)] : [];
    });
  }

  public static async getCurrentFrameBondLots(client: ArgonQueryClient, vaultId: number, operatorAddress: string) {
    const bondLots: IFrameBondLot[] = [];
    const frameCapitalRaw = await client.query.treasury.currentFrameVaultCapital();
    if (frameCapitalRaw.isNone) {
      return {
        bondLots,
        totalActiveBonds: 0,
        distributedEarnings: 0n,
      };
    }

    let vaultCapital: PalletTreasuryVaultCapital | RuntimeSpec157.PalletTreasuryVaultCapital | undefined;
    for (const [nextVaultId, capital] of frameCapitalRaw.unwrap().vaults.entries()) {
      if (nextVaultId.toNumber() !== vaultId) continue;

      vaultCapital = capital as PalletTreasuryVaultCapital | RuntimeSpec157.PalletTreasuryVaultCapital;
      break;
    }
    if (!vaultCapital) {
      return {
        bondLots,
        totalActiveBonds: 0,
        distributedEarnings: 0n,
      };
    }

    const totalActiveBonds = vaultCapital.eligibleBonds.toNumber();
    const allocations =
      'regularBondAllocations' in vaultCapital ? vaultCapital.regularBondAllocations : vaultCapital.bondLotAllocations;
    const bondLotIds = allocations.map(allocation => allocation.bondLotId.toNumber());
    const bondLotsById = await TreasuryBonds.getBondLotsById(client, bondLotIds);

    for (const allocation of allocations) {
      const bondLotId = allocation.bondLotId.toNumber();
      const prorata = allocation.prorata.toBigInt();
      const lot = bondLotsById.get(bondLotId);
      if (!lot) continue;

      const accountId = lot.owner.toString();
      const bonds = TreasuryBonds.getProrataBonds(totalActiveBonds, prorata);
      const entry = {
        id: `lot:${bondLotId}`,
        accountId,
        bonds,
        prorata,
        isOperator: accountId === operatorAddress,
        details: BondLot.fromRuntime(bondLotId, lot, operatorAddress),
      };
      bondLots.push(entry);
    }

    return {
      bondLots,
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
    bondPurchaseMicrogons: bigint;
  }): Promise<SubmittableExtrinsic> {
    const { client, vaultId } = args;
    const bonds = BondLot.microgonsToBonds(args.bondPurchaseMicrogons);
    return client.tx.treasury.buyBonds(vaultId, bonds, null);
  }

  public static async buildReleaseBondLotTx(args: {
    client: ArgonClient;
    bondLotId: number;
  }): Promise<SubmittableExtrinsic> {
    return args.client.tx.treasury.liquidateBondLot(args.bondLotId);
  }

  public static async subscribeBondLots(
    client: ArgonClient,
    vaultId: number,
    accountId: string,
    onUpdate: (lots: BondLot[]) => void,
  ): Promise<() => void> {
    return await client.query.treasury.bondLotsByVault(vaultId, () => {
      void TreasuryBonds.getBondLots(client, vaultId, accountId).then(lots => {
        onUpdate(lots.filter(lot => lot.accountId === accountId));
      });
    });
  }

  private static async getBondLotsForVault(client: ArgonQueryClient, vaultId: number): Promise<IBondLotSource[]> {
    const { summaries } = await TreasuryBonds.getVaultBondSources(client, vaultId);
    const ids = [...summaries].map(summary => summary.bondLotId.toNumber());
    const lotsById = await TreasuryBonds.getBondLotsById(client, ids);

    return ids.flatMap(id => {
      const lot = lotsById.get(id);
      return lot ? [{ id, lot }] : [];
    });
  }

  private static async getVaultBondSources(client: ArgonQueryClient, vaultId: number) {
    const vaultState = (await client.query.treasury.bondLotsByVault(vaultId)) as
      | PalletTreasuryVaultBondState
      | RuntimeSpec157.PalletTreasuryVaultBondState;
    let summaries: Iterable<PalletTreasuryBondLotSummary | RuntimeSpec157.PalletTreasuryBondLotSummary>;
    let flexibleBonds = 0;
    let reservedBondSpace = 0;

    if ('regularBondLots' in vaultState) {
      summaries = vaultState.regularBondLots;
      flexibleBonds = vaultState.flexibleBonds.toNumber();
      reservedBondSpace = vaultState.reservedBondSpace.toNumber();
    } else {
      summaries = vaultState.bondLots;
      flexibleBonds = vaultState.backfillBonds.toNumber();
      reservedBondSpace = vaultState.backfillBondsReserved.toNumber();
    }

    const capacityState = [...summaries].map(summary => ({
      activeBonds: summary.bonds.toNumber(),
    }));
    const ordinaryBonds = capacityState.reduce((total, summary) => total + summary.activeBonds, 0);
    if (reservedBondSpace > 0) {
      capacityState.push({
        activeBonds: reservedBondSpace,
      });
    }

    return {
      summaries,
      capacityState,
      ordinaryBonds,
      flexibleBonds,
      reservedBondSpace,
    };
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
        result.set(ids[i], lot.unwrap() as IBondLotSource['lot']);
      }
    }

    return result;
  }

  private static getProrataBonds(totalBonds: number, prorata: bigint): number {
    const share = fromFixedNumber(prorata, FIXED_U128_DECIMALS);
    return Number(bigNumberToBigInt(BigNumber(totalBonds).times(share)));
  }
}
