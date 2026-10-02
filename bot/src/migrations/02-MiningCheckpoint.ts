import * as fs from 'node:fs';
import { JsonExt, type IBlockSyncFile, type MiningFrames } from '@argonprotocol/apps-core';
import type { IMigration } from './IMigration.ts';
import type { Storage } from '../Storage.ts';

export class MiningCheckpointMigration implements IMigration {
  version = 2;

  public async up(storage: Storage, miningFrames: MiningFrames): Promise<void> {
    const stateFile = storage.botStateFile();
    // Import the processed tip from the previous block queue.
    if (!(await stateFile.get()).lastProcessedBlockHash) {
      const sourcePath = ['bot-blocks.json', 'bot-blocks.json.migrating', 'bot-blocks.json.migrated']
        .map(file => storage.getPath(file))
        .find(file => fs.existsSync(file));
      if (sourcePath) {
        let saved: IBlockSyncFile | undefined;
        try {
          saved = JsonExt.parse(await fs.promises.readFile(sourcePath, 'utf8'));
        } catch (error) {
          console.warn(
            'Could not import the old mining checkpoint; replay will resume from the starting frame.',
            error,
          );
        }
        if (saved) {
          const blockHash = saved.blocksByNumber?.[saved.syncedToBlockNumber]?.hash;
          if (Number.isInteger(saved.syncedToBlockNumber) && saved.syncedToBlockNumber > 0 && blockHash) {
            const blockNumber = saved.syncedToBlockNumber;
            await stateFile.mutate(state => {
              state.lastProcessedBlockNumber = blockNumber;
              state.lastProcessedBlockHash = blockHash;
            });
          } else if (saved.syncedToBlockNumber !== 0) {
            console.warn('The old mining checkpoint is incomplete; replay will resume from the starting frame.');
          }
        }
      }
    }

    // Previous mint capture retained only one cohort. Replay from the first affected frame.
    let firstMintFrameId: number | undefined;
    for (const filename of await fs.promises.readdir(storage.botEarningsDir)) {
      const match = /^frame-(\d+)\.json$/.exec(filename);
      if (!match) continue;
      const frameId = Number(match[1]);
      const earnings = await storage.earningsFile(frameId).get();
      if (!Object.values(earnings.earningsByBlock).some(x => x.microgonsMinted > 0n && !x.microgonsMintedByCohort)) {
        continue;
      }
      firstMintFrameId = Math.min(firstMintFrameId ?? frameId, frameId);
    }
    if (firstMintFrameId === undefined) return;

    const frame = miningFrames.framesById[firstMintFrameId - 1];
    await stateFile.mutate(state => {
      // Older runtimes minted every block, including the affected frame's first block.
      // Start in the preceding frame so replay includes every affected payout.
      if (
        frame?.firstBlockHash &&
        frame.firstBlockNumber != null &&
        frame.firstBlockNumber <= state.lastProcessedBlockNumber
      ) {
        state.lastProcessedBlockNumber = frame.firstBlockNumber;
        state.lastProcessedBlockHash = frame.firstBlockHash;
      } else {
        state.lastProcessedBlockNumber = 0;
        state.lastProcessedBlockHash = '';
      }
      state.lastFinalizedProcessedBlockNumber = 0;
      state.lastFinalizedProcessedBlockHash = '';
    });
  }
}
