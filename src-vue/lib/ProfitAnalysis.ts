import { getPercent, IVaultFrameStats, MiningFrames, percentOf, TreasuryPool } from '@argonprotocol/apps-core';
import dayjs from 'dayjs';
import { getMainchainClient } from '../stores/mainchain.ts';
import { MyVault } from './MyVault.ts';
import { IVaultFrameRecord } from '../interfaces/IVaultFrameRecord.ts';
import { IChartItem } from '../interfaces/IChartItem.ts';
import { Vaults } from './Vaults.ts';

export class ProfitAnalysis {
  frameIdLoaded: number | undefined = undefined;
  items: IChartItem[] = [];
  records: IVaultFrameRecord[] = [];

  constructor(
    private vaults: Vaults,
    private myVault: MyVault,
    private miningFrames: MiningFrames,
    private currentFrameId?: number,
  ) {}

  public async update() {
    const stats = this.myVault.data.stats;

    this.currentFrameId ??= this.miningFrames.currentFrameId;
    if (this.frameIdLoaded === this.currentFrameId) {
      return;
    }

    this.frameIdLoaded = this.currentFrameId;
    console.log('Load chart data to frame', this.currentFrameId);

    const treasuryPoolCapitalByFrame: { [frameId: string]: { capitalRaised: bigint; payout: bigint } } = {};
    const frameIds: number[] = [];
    for (let frameId = Math.max(0, this.currentFrameId - 365); frameId <= this.currentFrameId; frameId++) {
      treasuryPoolCapitalByFrame[frameId] = { capitalRaised: 0n, payout: 0n };
      frameIds.push(frameId);
    }
    console.log('LOADING CHART DATA: ', this.currentFrameId, frameIds);

    for (const vaultStats of Object.values(this.vaults.stats?.vaultsById || {})) {
      for (const change of vaultStats.changesByFrame || []) {
        if (!treasuryPoolCapitalByFrame[change.frameId]) continue;
        treasuryPoolCapitalByFrame[change.frameId].payout += change.treasuryPool.totalEarnings;
        treasuryPoolCapitalByFrame[change.frameId].capitalRaised +=
          change.treasuryPool.externalCapital + change.treasuryPool.vaultCapital;
      }
    }
    const records: IVaultFrameRecord[] = [];
    const myVaultRevenueByFrame = (stats?.changesByFrame ?? []).reduce(
      (acc, frame) => {
        acc[frame.frameId] = frame;
        return acc;
      },
      {} as { [frameId: number]: IVaultFrameStats },
    );

    const trailingTreasuryCapitalAmounts: [capital: bigint, frameId: number][] = [];

    let maxFrameProfitPercent = 0;
    let treasuryPercentActivated = 0;
    let bitcoinPercentUsed = 0;

    for (const frameId of frameIds) {
      const treasuryAtFrame = treasuryPoolCapitalByFrame[frameId];
      const startTick = this.miningFrames.getTickStart(frameId);
      const startingDate = MiningFrames.getTickDate(startTick);

      const myFrameRevenue = myVaultRevenueByFrame[frameId];
      const record = {
        id: frameId,
        date: dayjs.utc(startingDate).toISOString(),
        firstTick: startTick,
        progress: 100,
        totalTreasuryPayout: treasuryAtFrame.payout,
        myTreasuryPayout: 0n,
        myTreasuryPercentTake: 0,
        bitcoinChangeMicrogons: 0n,
        treasuryChangeMicrogons: 0n,
        frameProfitPercent: 0,
        bitcoinPercentUsed: 0,
        treasuryPercentActivated: 0,
        profitMaximizationPercent: 0,
      };
      records.push(record);
      const trailingTreasuryCapitalTotal = trailingTreasuryCapitalAmounts.slice(0, 9).reduce((acc, [capital]) => {
        return acc + capital;
      }, 0n);
      const rollingTreasuryCapital = trailingTreasuryCapitalTotal + (trailingTreasuryCapitalAmounts[9]?.[0] ?? 0n);
      if (frameId === this.currentFrameId && this.myVault.createdVault) {
        record.progress = this.miningFrames.getCurrentFrameProgress();
        const client = await getMainchainClient(false);
        record.totalTreasuryPayout = await TreasuryPool.getTreasuryPayoutPotential(client);
        const securitization = this.myVault.createdVault.securitization;
        const activatedSecuritization = this.myVault.createdVault.activatedSecuritization();
        const { vaultActivatedCapital, totalActivatedCapital } = await TreasuryPool.getActiveCapital(
          client,
          this.myVault.createdVault.vaultId ?? 0,
        );
        record.myTreasuryPercentTake = getPercent(vaultActivatedCapital, totalActivatedCapital);
        record.myTreasuryPayout = percentOf(record.totalTreasuryPayout, record.myTreasuryPercentTake);

        bitcoinPercentUsed =
          activatedSecuritization > 0n
            ? getPercent(activatedSecuritization - this.myVault.createdVault.getRelockCapacity(), securitization)
            : 0;
        treasuryPercentActivated = getPercent(trailingTreasuryCapitalTotal + vaultActivatedCapital, securitization);
        record.frameProfitPercent = getPercent(
          record.myTreasuryPayout + (myFrameRevenue?.bitcoinFeeRevenue ?? 0n),
          securitization + vaultActivatedCapital,
        );

        record.bitcoinChangeMicrogons = myFrameRevenue?.microgonLiquidityAdded ?? 0n;
        if (rollingTreasuryCapital !== undefined) {
          record.treasuryChangeMicrogons =
            trailingTreasuryCapitalTotal + vaultActivatedCapital - rollingTreasuryCapital;
        }
        // NOTE: don't add to trailing capital since this is still being updated
      } else if (myFrameRevenue) {
        const {
          securitizationRelockable,
          securitizationActivated,
          securitization,
          bitcoinFeeRevenue,
          microgonLiquidityAdded,
          treasuryPool: {
            externalCapital: poolExternalCapital,
            vaultCapital: poolVaultCapital,
            totalEarnings: poolTotalEarnings,
            vaultEarnings: poolVaultEarnings,
          },
        } = myFrameRevenue;
        const vaultActivatedCapital = poolExternalCapital + poolVaultCapital;
        bitcoinPercentUsed = getPercent(securitizationActivated - (securitizationRelockable ?? 0n), securitization);
        treasuryPercentActivated = getPercent(trailingTreasuryCapitalTotal + vaultActivatedCapital, securitization);

        record.myTreasuryPayout = poolTotalEarnings;
        record.myTreasuryPercentTake = getPercent(vaultActivatedCapital, treasuryAtFrame.capitalRaised);
        record.bitcoinChangeMicrogons = microgonLiquidityAdded;
        if (rollingTreasuryCapital !== undefined) {
          record.treasuryChangeMicrogons =
            trailingTreasuryCapitalTotal + vaultActivatedCapital - rollingTreasuryCapital;
        }
        record.frameProfitPercent = getPercent(
          poolVaultEarnings + bitcoinFeeRevenue,
          securitization + vaultActivatedCapital,
        );

        trailingTreasuryCapitalAmounts.unshift([vaultActivatedCapital, frameId]);
        if (trailingTreasuryCapitalAmounts.length > 10) {
          trailingTreasuryCapitalAmounts.length = 10;
        }
      }
      // Always update the percents. If there's no frame entry, it means 0 activity that frame
      record.treasuryPercentActivated = treasuryPercentActivated;
      record.bitcoinPercentUsed = bitcoinPercentUsed;
      record.profitMaximizationPercent = getPercent(bitcoinPercentUsed * treasuryPercentActivated, 100 * 100);
      maxFrameProfitPercent = Math.max(maxFrameProfitPercent, record.frameProfitPercent);
    }

    const items: IChartItem[] = [];
    let isFiller = true;
    for (const [index, frame] of records.entries()) {
      if (myVaultRevenueByFrame[frame.id]) {
        isFiller = false;
      }
      const item = {
        id: frame.id,
        date: frame.date,
        score: (frame.frameProfitPercent / maxFrameProfitPercent) * 100,
        isFiller,
        previous: items[index - 1],
        next: undefined,
      };
      items.push(item);
    }

    for (const [index, item] of items.entries()) {
      item.next = items[index + 1];
    }

    this.items = items;
    this.records = records;
  }
}
