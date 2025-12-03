import type { IMigration } from './IMigration.ts';
import type { Storage } from '../Storage.ts';
import { type IBidsFile, type IEarningsFile } from '@argonprotocol/apps-core';
import { migrateDirectory } from './migrationUtils.ts';

export class RewardTicksMigration implements IMigration {
  version = 1;
  public async up(storage: Storage): Promise<void> {
    if (!(await storage.botStateFile().exists())) {
      return;
    }
    await storage.botStateFile().mutate(x => {
      x.currentFrameRewardTicksRemaining = 0;
      x.currentFrameFirstTick = (x as any).currentFrameTickRange[0] ?? 0;
      delete (x as any).currentFrameTickRange;
    });

    await migrateDirectory<
      IBidsFile,
      'biddingFrameFirstTick' | 'biddingFrameRewardTicksRemaining',
      { biddingFrameTickRange: [number, number] }
    >(storage.botBidsDir, (_key, oldRecord) => {
      const newRecord: IBidsFile = oldRecord as any;
      newRecord.biddingFrameFirstTick = oldRecord.biddingFrameTickRange[0];
      newRecord.biddingFrameRewardTicksRemaining = 0;
      return newRecord;
    });

    await migrateDirectory<
      IEarningsFile,
      'frameRewardTicksRemaining' | 'frameFirstTick',
      { frameTickRange: [number, number] }
    >(storage.botEarningsDir, (_key, oldRecord) => {
      const newRecord: IEarningsFile = oldRecord as any;
      newRecord.frameFirstTick = oldRecord.frameTickRange[0];
      newRecord.frameRewardTicksRemaining = 0;
      return newRecord;
    });
  }
}
