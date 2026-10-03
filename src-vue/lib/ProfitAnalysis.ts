import { MiningFrames } from '@argonprotocol/apps-core';
import dayjs from 'dayjs';
import type { MyVault } from './MyVault.ts';
import type { ArgonBonds } from './ArgonBonds.ts';
import type { IVaultFrameRecord } from '../interfaces/IVaultFrameRecord.ts';
import type { IChartItem } from '../interfaces/IChartItem.ts';
import { VaultFinancials } from './financials/MyVault.ts';

export class ProfitAnalysis {
  items: IChartItem[] = [];
  records: IVaultFrameRecord[] = [];

  constructor(
    private myVault: MyVault,
    private miningFrames: MiningFrames,
    private argonBonds: ArgonBonds,
    private currentFrameId = miningFrames.currentFrameId,
  ) {}

  public update() {
    const firstFrameId = Math.max(0, this.currentFrameId - 365);
    const frames = (this.myVault.data.stats?.changesByFrame ?? []).filter(
      frame => frame.frameId >= firstFrameId && frame.frameId < this.currentFrameId,
    );
    const returns = VaultFinancials.getFrameReturns(this.myVault.vaultId!, frames, this.argonBonds.data);
    const maxReturn = Math.max(0, ...[...returns.values()].map(Math.abs));
    const records: IVaultFrameRecord[] = [];
    const items: IChartItem[] = [];

    for (let frameId = firstFrameId; frameId <= this.currentFrameId; frameId++) {
      let firstTick: number;
      try {
        firstTick = this.miningFrames.getTickStart(frameId);
      } catch {
        continue;
      }
      const date = dayjs.utc(MiningFrames.getTickDate(firstTick)).toISOString();
      const frameProfitPercent = returns.get(frameId);
      records.push({ id: frameId, date, firstTick, frameProfitPercent });
      let score: number | null = null;
      if (frameProfitPercent !== undefined) {
        score = maxReturn > 0 ? (frameProfitPercent / maxReturn) * 100 : 0;
      }
      const previous = items.at(-1);
      const item: IChartItem = {
        id: frameId,
        date,
        score,
        isFiller: false,
        previous,
        next: undefined,
      };
      if (previous) previous.next = item;
      items.push(item);
    }

    this.records = records;
    this.items = items;
  }
}
