import Path from 'node:path';
import { LRU } from 'tiny-lru';
import * as fs from 'node:fs';
import {
  type IBidsFile,
  type IBlockSyncFile,
  type IBotStateFile,
  type IEarningsFile,
  type IHistoryFile,
  MiningFrames,
} from '@argonprotocol/commander-core';
import { JsonStore } from './JsonStore.ts';

export class Storage {
  private lruCache = new LRU<JsonStore<any>>(100);

  constructor(private basedir: string) {
    fs.mkdirSync(this.basedir, { recursive: true });
    fs.mkdirSync(Path.join(this.basedir, 'bot-bids'), { recursive: true });
    fs.mkdirSync(Path.join(this.basedir, 'bot-earnings'), { recursive: true });
    fs.mkdirSync(Path.join(this.basedir, 'bot-history'), { recursive: true });
  }

  public botBlockSyncFile(): JsonStore<IBlockSyncFile> {
    const key = `bot-blocks.json`;
    let entry = this.lruCache.get(key) as JsonStore<IBlockSyncFile> | undefined;
    if (!entry) {
      entry = new JsonStore<IBlockSyncFile>(Path.join(this.basedir, key), () => ({
        blocksByNumber: {},
        syncedToBlockNumber: 0,
        finalizedBlockNumber: 0,
        bestBlockNumber: 0,
      }));
      this.lruCache.set(key, entry);
    }
    return entry;
  }

  public botStateFile(): JsonStore<IBotStateFile> {
    const key = `bot-state.json`;
    let entry = this.lruCache.get(key) as JsonStore<IBotStateFile> | undefined;
    if (!entry) {
      entry = new JsonStore<IBotStateFile>(Path.join(this.basedir, key), () => {
        return {
          isReady: false,
          hasMiningBids: false,
          hasMiningSeats: false,
          argonBlockNumbers: { localNode: 0, mainNode: 0 },
          bitcoinBlockNumbers: { localNode: 0, mainNode: 0 },
          bidsLastModifiedAt: new Date(),
          earningsLastModifiedAt: new Date(),
          oldestFrameIdToSync: 0,
          currentFrameId: 0,
          currentFrameTickRange: [0, 0],
          currentTick: 0,
          syncProgress: 0,
          maxSeatsPossible: 10, // TODO: instead of hardcoded 10, fetch from chain
          maxSeatsReductionReason: '',
          lastBlockNumberByFrameId: {},
        };
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }

  /**
   * @param frameId - the frame id of the last block mined
   */
  public earningsFile(frameId: number): JsonStore<IEarningsFile> {
    const key = `bot-earnings/frame-${frameId}.json`;
    let entry = this.lruCache.get(key) as JsonStore<IEarningsFile> | undefined;
    if (!entry) {
      entry = new JsonStore<IEarningsFile>(Path.join(this.basedir, key), () => {
        const tickRange = MiningFrames.getTickRangeForFrame(frameId);
        return {
          frameId,
          frameTickRange: tickRange,
          firstBlockNumber: 0,
          lastBlockNumber: 0,
          microgonToUsd: [],
          microgonToBtc: [],
          microgonToArgonot: [],
          earningsByBlock: {},

          transactionFeesTotal: 0n,
          accruedMicrogonProfits: 0n,
          accruedMicronotProfits: 0n,
          previousFrameAccruedMicrogonProfits: null,
          previousFrameAccruedMicronotProfits: null,
        };
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }

  public bidsFile(cohortBiddingFrameId: number, cohortActivationFrameId: number): JsonStore<IBidsFile> {
    const key = `bot-bids/frame-${cohortBiddingFrameId}-${cohortActivationFrameId}.json`;
    let entry = this.lruCache.get(key) as JsonStore<IBidsFile> | undefined;
    if (!entry) {
      entry = new JsonStore<IBidsFile>(Path.join(this.basedir, key), () => {
        const tickRange = MiningFrames.getTickRangeForFrame(cohortBiddingFrameId);
        return {
          cohortBiddingFrameId,
          cohortActivationFrameId,
          biddingFrameTickRange: tickRange,
          lastBlockNumber: 0,
          seatCountWon: 0,
          allMinersCount: 0,
          microgonsBidTotal: 0n,
          transactionFeesByBlock: {},
          micronotsStakedPerSeat: 0n,
          microgonsToBeMinedPerBlock: 0n,
          winningBids: [],
        };
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }

  public historyFile(frameId: number): JsonStore<IHistoryFile> {
    const key = `bot-history/frame-${frameId}.json`;
    let entry = this.lruCache.get(key) as JsonStore<IHistoryFile> | undefined;
    if (!entry) {
      entry = new JsonStore<IHistoryFile>(Path.join(this.basedir, key), () => {
        return {
          activities: [],
        };
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }
}
