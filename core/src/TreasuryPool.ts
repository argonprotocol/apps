import { type ArgonClient } from '@argonprotocol/mainchain';
import { bigNumberToBigInt } from './utils.js';
import BigNumber from 'bignumber.js';

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

  public static async getTreasuryPayoutPotential(client: ArgonClient): Promise<bigint> {
    const revenue = await TreasuryPool.getAuctionRevenue(client);
    const bidBurnPercent = (100 - client.consts.treasury.bidPoolBurnPercent.toNumber()) / 100;
    const treasuryTake = BigNumber(revenue).times(bidBurnPercent);
    return bigNumberToBigInt(treasuryTake);
  }

  public static async getAuctionRevenue(client: ArgonClient): Promise<bigint> {
    const balanceBytes = await client.rpc.state.call('MiningSlotApi_bid_pool', '');
    const balance = client.createType('U128', balanceBytes);
    return balance.toBigInt();
  }
}
