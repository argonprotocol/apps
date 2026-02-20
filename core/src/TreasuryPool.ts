import { type ApiDecoration, type ArgonClient } from '@argonprotocol/mainchain';
import { bigNumberToBigInt } from './utils.js';
import BigNumber from 'bignumber.js';
import { SpecLte146 } from './MainchainCompat.js';

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
    const treasuryConstsCompat = client.consts.treasury as SpecLte146.ITreasuryConstants;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const percent = (
      treasuryConstsCompat.bidPoolBurnPercent ?? client.consts.treasury.percentForTreasuryReserves
    ).toNumber();
    return (100 - percent) / 100;
  }

  public static async getTreasuryPayoutPotential(client: ArgonClient): Promise<bigint> {
    const revenue = await TreasuryPool.getAuctionRevenue(client);
    const percentForVaults = TreasuryPool.getBidPoolPercentForVaults(client);
    const calculatedPayout = BigNumber(revenue).times(percentForVaults);
    return bigNumberToBigInt(calculatedPayout);
  }

  public static async getAuctionRevenue(client: ArgonClient): Promise<bigint> {
    const balanceBytes = await client.rpc.state.call('MiningSlotApi_bid_pool', '');
    const balance = client.createType('U128', balanceBytes);
    return balance.toBigInt();
  }
}
