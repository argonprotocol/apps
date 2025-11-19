import { type ArgonClient } from '@argonprotocol/mainchain';

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
    const treasuryTake = client.consts.treasury.bidPoolBurnPercent.toBigInt();
    return (revenue * treasuryTake) / 100n;
  }

  public static async getAuctionRevenue(client: ArgonClient): Promise<bigint> {
    const balanceBytes = await client.rpc.state.call('MiningSlotApi_bid_pool', '');
    const balance = client.createType('U128', balanceBytes);
    return balance.toBigInt();
  }
}
