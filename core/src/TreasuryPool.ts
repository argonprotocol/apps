import {
  type ApiDecoration,
  type ArgonClient,
  fromFixedNumber,
  type PalletTreasuryTreasuryPool,
  PERMILL_DECIMALS,
} from '@argonprotocol/mainchain';
import { stringToU8a, u8aConcat } from '@polkadot/util';
import { bigNumberToBigInt, percentOf } from './utils.js';
import BigNumber from 'bignumber.js';
import { BondFunder } from './BondFunder.js';
import { MainchainCompat } from './MainchainCompat.js';

export interface IFrameBondHolder {
  accountId: string;
  bondedAmount: bigint;
  isOperator: boolean;
}

export interface IFrameBondSummary {
  holder: IFrameBondHolder;
  poolSharePct: number;
  totalEarnings: bigint;
  vaultEarnings: bigint;
  keepPct: number;
  frameStartDate: string;
  frameEndDate: string;
}

export interface IBondTargetAllocation {
  targetPrincipal: bigint;
}

export interface INextFrameBondAvailability {
  nextFrameCapacity: bigint;
  totalTargetPrincipal: bigint;
  nextFrameAvailable: bigint;
}

export class TreasuryPool {
  public static async getActiveCapital(
    client: ArgonClient,
    vaultId: number,
  ): Promise<{
    totalActivatedCapital: bigint;
    vaultActivatedCapital: bigint;
  }> {
    let totalCapitalRaised = 0n;
    let vaultCapital = 0n;

    for (const entrant of await client.query.treasury.capitalActive()) {
      totalCapitalRaised += entrant.activatedCapital.toBigInt();
      if (entrant.vaultId.toNumber() === vaultId) {
        vaultCapital += entrant.activatedCapital.toBigInt();
      }
    }
    return {
      totalActivatedCapital: totalCapitalRaised,
      vaultActivatedCapital: vaultCapital,
    };
  }

  public static getBidPoolPercentForVaults(client: ArgonClient | ApiDecoration<'promise'>): number {
    const percent = client.consts.treasury.percentForTreasuryReserves.toNumber();
    return (100 - percent) / 100;
  }

  public static async getTreasuryPayoutPotential(client: ArgonClient): Promise<bigint> {
    const bidPoolAccountId = TreasuryPool.getBidPoolAccountId(client);
    const accountInfo = await client.query.system.account(bidPoolAccountId);
    const revenue = accountInfo.data.free.toBigInt();
    const percentForVaults = TreasuryPool.getBidPoolPercentForVaults(client);
    return bigNumberToBigInt(BigNumber(revenue).times(percentForVaults));
  }

  public static getBidPoolAccountId(client: ArgonClient | ApiDecoration<'promise'>): Uint8Array {
    const palletId = client.consts.treasury.palletId.toU8a();
    const raw = u8aConcat(stringToU8a('modl'), palletId, new Uint8Array(32 - 4 - palletId.length));
    return client.registry.createType('AccountId32', raw).toU8a();
  }

  public static getBondPurchaseCapacity(
    totalBondCapacity: bigint,
    bondFullCapacity = MainchainCompat.bondFullCapacityPerFrame,
  ): bigint {
    if (totalBondCapacity <= 0n) return 0n;
    return bondFullCapacity ? totalBondCapacity : totalBondCapacity / 10n;
  }

  public static calculateNextFrameBondAvailability(
    totalBondCapacity: bigint,
    funders: IBondTargetAllocation[],
    bondFullCapacityPerFrame = MainchainCompat.bondFullCapacityPerFrame,
  ): INextFrameBondAvailability {
    const nextFrameCapacity = TreasuryPool.getBondPurchaseCapacity(totalBondCapacity, bondFullCapacityPerFrame);
    const totalTargetPrincipal = funders.reduce((sum, funder) => sum + funder.targetPrincipal, 0n);
    const nextFrameAvailable = totalTargetPrincipal < nextFrameCapacity ? nextFrameCapacity - totalTargetPrincipal : 0n;

    return {
      nextFrameCapacity,
      totalTargetPrincipal,
      nextFrameAvailable,
    };
  }

  public static potentialDailyRevenue(args: {
    distributableBidPool: bigint;
    globalActiveCapital: bigint;
    myActiveCapital: bigint;
    fullTreasuryCapacity: bigint;
    operatorKeepPct: number;
  }): bigint {
    const { distributableBidPool, globalActiveCapital, myActiveCapital, fullTreasuryCapacity, operatorKeepPct } = args;
    if (distributableBidPool <= 0n || fullTreasuryCapacity <= 0n) return 0n;

    const globalWithoutMe = globalActiveCapital - myActiveCapital;
    const projectedGlobal = globalWithoutMe + fullTreasuryCapacity;
    if (projectedGlobal <= 0n) return 0n;

    const grossRevenue = bigNumberToBigInt(
      BigNumber(distributableBidPool).multipliedBy(
        BigNumber(fullTreasuryCapacity).dividedBy(BigNumber(projectedGlobal)),
      ),
    );
    return bigNumberToBigInt(BigNumber(grossRevenue).multipliedBy(operatorKeepPct).dividedBy(100));
  }

  public static externalBondedCapital(funders: BondFunder[]): bigint {
    return funders.filter(f => !f.isOwn).reduce((sum, f) => sum + f.heldPrincipal, 0n);
  }

  public static totalBondedCapital(funders: BondFunder[]): bigint {
    return funders.reduce((sum, f) => sum + f.heldPrincipal, 0n);
  }

  public static async getBondFunders(client: ArgonClient, vaultId: number, ownAddress?: string): Promise<BondFunder[]> {
    const entries = await client.query.treasury.funderStateByVaultAndAccount.entries(vaultId);

    const funders: BondFunder[] = [];
    for (const [key, stateOption] of entries) {
      if (stateOption.isNone) continue;

      const accountId = key.args[1].toString();
      funders.push(new BondFunder(accountId, stateOption.unwrap(), accountId === ownAddress));
    }

    return funders;
  }

  public static parseFrameBondHolders(pool: PalletTreasuryTreasuryPool, operatorAddress: string) {
    const holders: IFrameBondHolder[] = [];
    let totalBonds = 0n;
    for (const [holderIdRaw, amount] of pool.bondHolders) {
      const accountId = holderIdRaw.toHuman();
      holders.push({
        accountId,
        bondedAmount: amount.toBigInt(),
        isOperator: accountId === operatorAddress,
      });
      totalBonds += amount.toBigInt();
    }
    const vaultSharingPct = fromFixedNumber(pool.vaultSharingPercent.toBigInt(), PERMILL_DECIMALS)
      .times(100)
      .toNumber();
    const distributedEarnings = pool.distributedEarnings.isSome ? pool.distributedEarnings.unwrap().toBigInt() : 0n;

    return { holders, vaultSharingPct, totalBonds, distributedEarnings };
  }

  public static projectedFrameEarnings(args: {
    funderBondedAmount: bigint;
    vaultActiveCapital: bigint;
    globalActiveCapital: bigint;
    distributableBidPool: bigint;
    earningsSharePct: number;
  }): bigint {
    const { funderBondedAmount, vaultActiveCapital, globalActiveCapital, distributableBidPool, earningsSharePct } =
      args;
    if (funderBondedAmount <= 0n || vaultActiveCapital <= 0n || globalActiveCapital <= 0n || distributableBidPool <= 0n)
      return 0n;
    const vaultEarnings = (distributableBidPool * vaultActiveCapital) / globalActiveCapital;
    const partyPortion = (vaultEarnings * BigInt(Math.round(earningsSharePct))) / 100n;
    return (partyPortion * funderBondedAmount) / vaultActiveCapital;
  }

  public static async getBondFrameHistory(
    client: ArgonClient,
    vaultId: number,
    accountId: string,
    operatorAddress: string,
  ): Promise<Array<{ frameId: number; balance: bigint; earnings: bigint; sharingPct: number }>> {
    const entries = await client.query.treasury.vaultPoolsByFrame.entries();
    const result: Array<{ frameId: number; balance: bigint; earnings: bigint; sharingPct: number }> = [];
    const isOperator = accountId === operatorAddress;

    for (const [frameIdRaw, vaultPoolMap] of entries) {
      const frameId = frameIdRaw.args[0].toNumber();

      const vaultEntry = [...vaultPoolMap.entries()].find(([vid]) => vid.toNumber() === vaultId);
      if (!vaultEntry?.[1]) continue;

      const { holders, vaultSharingPct, distributedEarnings, totalBonds } = TreasuryPool.parseFrameBondHolders(
        vaultEntry[1],
        operatorAddress,
      );

      const userHolder = holders.find(h => h.accountId === accountId);
      if (!userHolder || userHolder.bondedAmount <= 0n) continue;

      let userEarnings = 0n;
      if (totalBonds > 0n && distributedEarnings > 0n) {
        const contributorPortion = isOperator ? 100 - vaultSharingPct : vaultSharingPct;
        const bondProrata = BigNumber(userHolder.bondedAmount).div(BigNumber(totalBonds)).times(100).toNumber();
        userEarnings = percentOf(percentOf(distributedEarnings, contributorPortion), bondProrata);
      }
      result.push({ frameId, balance: userHolder.bondedAmount, earnings: userEarnings, sharingPct: vaultSharingPct });
    }

    return result.sort((a, b) => b.frameId - a.frameId);
  }

  public static async subscribeBidPool(
    client: ArgonClient,
    onUpdate: (distributableBidPool: bigint) => void,
  ): Promise<() => void> {
    const vaultPercent = TreasuryPool.getBidPoolPercentForVaults(client);
    const bidPoolAccountId = TreasuryPool.getBidPoolAccountId(client);
    return await client.query.system.account(bidPoolAccountId, account => {
      const free = account.data.free.toBigInt();
      onUpdate(bigNumberToBigInt(BigNumber(free).times(vaultPercent)));
    });
  }

  public static async subscribeFunderState(
    client: ArgonClient,
    vaultId: number,
    accountId: string,
    isOwn: boolean,
    onUpdate: (state: BondFunder | null) => void,
  ): Promise<() => void> {
    return await client.query.treasury.funderStateByVaultAndAccount(vaultId, accountId, stateOption => {
      if (stateOption.isSome) {
        onUpdate(new BondFunder(accountId, stateOption.unwrap(), isOwn));
      } else {
        onUpdate(null);
      }
    });
  }
}
