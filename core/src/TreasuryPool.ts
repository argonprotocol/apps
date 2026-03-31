import {
  type ApiDecoration,
  type ArgonClient,
  fromFixedNumber,
  type PalletTreasuryTreasuryPool,
  PERMILL_DECIMALS,
} from '@argonprotocol/mainchain';
import { stringToU8a, u8aConcat } from '@polkadot/util';
import { bigNumberToBigInt, calculateAPY, percentOf } from './utils.js';
import BigNumber from 'bignumber.js';

export interface IFunderState {
  heldPrincipal: bigint;
  targetPrincipal: bigint;
  lifetimeCompoundedEarnings: bigint;
  lifetimePrincipalDeployed: bigint;
  lifetimePrincipalLastBasisFrame: number;
}

export interface IBondFunder {
  accountId: string;
  heldPrincipal: bigint;
  targetPrincipal: bigint;
  bondedPrincipal: bigint;
  isOwn: boolean;
}

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

  public static funderAPY(funder: IFunderState, currentFrameId: number): number {
    if (funder.lifetimePrincipalDeployed <= 0n) return 0;
    const activeDays = currentFrameId - funder.lifetimePrincipalLastBasisFrame;
    if (activeDays <= 0) return 0;
    return calculateAPY(
      funder.lifetimePrincipalDeployed,
      funder.lifetimePrincipalDeployed + funder.lifetimeCompoundedEarnings,
      activeDays,
    );
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

  public static externalBondedCapital(funders: IBondFunder[]): bigint {
    return funders.filter(f => !f.isOwn).reduce((sum, f) => sum + f.heldPrincipal, 0n);
  }

  public static totalBondedCapital(funders: IBondFunder[]): bigint {
    return funders.reduce((sum, f) => sum + f.heldPrincipal, 0n);
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
    onUpdate: (state: IFunderState | null) => void,
  ): Promise<() => void> {
    return await client.query.treasury.funderStateByVaultAndAccount(vaultId, accountId, stateOption => {
      if (stateOption.isSome) {
        const s = stateOption.unwrap();
        onUpdate({
          heldPrincipal: s.heldPrincipal.toBigInt(),
          targetPrincipal: s.targetPrincipal.toBigInt(),
          lifetimeCompoundedEarnings: s.lifetimeCompoundedEarnings.toBigInt(),
          lifetimePrincipalDeployed: s.lifetimePrincipalDeployed.toBigInt(),
          lifetimePrincipalLastBasisFrame: s.lifetimePrincipalLastBasisFrame.toNumber(),
        });
      } else {
        onUpdate(null);
      }
    });
  }
}
