import Path from 'node:path';
import { LRU } from 'tiny-lru';
import * as fs from 'node:fs';
import {
  type IBidsFile,
  type IBlockSyncFile,
  type IBotStateFile,
  type IEarningsFile,
  type IHistoryFile,
} from '@argonprotocol/apps-core';
import { JsonStore } from './JsonStore.ts';
import { RewardTicksMigration } from './migrations/01-RewardTicks.ts';
import type { IMigration } from './migrations/IMigration.ts';

export class Storage {
  public get botBidsDir(): string {
    return Path.join(this.basedir, 'bot-bids');
  }

  public get botEarningsDir(): string {
    return Path.join(this.basedir, 'bot-earnings');
  }

  public get botHistoryDir(): string {
    return Path.join(this.basedir, 'bot-history');
  }

  public get version(): Promise<number> {
    return this.storageVersion.get().then(x => x.version);
  }

  private lruCache = new LRU<JsonStore<any>>(100);
  private readonly botState: JsonStore<IBotStateFile>;
  private readonly blockSync: JsonStore<IBlockSyncFile>;
  private readonly storageVersion: JsonStore<{ version: number }>;
  private migrations: IMigration[] = [new RewardTicksMigration()];

  constructor(private basedir: string) {
    fs.mkdirSync(this.basedir, { recursive: true });
    fs.mkdirSync(this.botBidsDir, { recursive: true });
    fs.mkdirSync(this.botEarningsDir, { recursive: true });
    fs.mkdirSync(this.botHistoryDir, { recursive: true });
    this.botState = new JsonStore(this.basedir, 'bot-state.json', () => {
      return {
        hasMiningBids: false,
        hasMiningSeats: false,
        bidsLastModifiedAt: new Date(),
        earningsLastModifiedAt: new Date(),
        oldestFrameIdToSync: 0,
        currentFrameId: 0,
        currentFrameFirstTick: 0,
        currentFrameRewardTicksRemaining: 0,
        currentTick: 0,
        syncProgress: 0,
        lastBlockNumberByFrameId: {},
      };
    });
    this.blockSync = new JsonStore(this.basedir, 'bot-blocks.json', () => ({
      blocksByNumber: {},
      syncedToBlockNumber: 0,
      finalizedBlockNumber: 0,
      bestBlockNumber: 0,
    }));
    this.storageVersion = new JsonStore(this.basedir, 'storage-version.json', () => ({
      version: 0,
    }));
  }

  public async close(): Promise<void> {
    console.log('STORAGE SHUTTING DOWN');
    const promises: Promise<void>[] = [];
    for (const entry of this.lruCache.values()) {
      promises.push(entry.close());
    }
    promises.push(this.botState.close());
    promises.push(this.blockSync.close());
    promises.push(this.storageVersion.close());
    await Promise.all(promises);
    console.log('STORAGE SHUTDOWN COMPLETE');
  }

  public async migrate(): Promise<void> {
    const storageVersion = await this.storageVersion.get();

    for (const migration of this.migrations) {
      if (migration.version <= storageVersion.version) continue;
      await migration.up(this);
      await this.storageVersion.mutate(x => {
        x.version = migration.version;
        return true;
      });
    }
  }

  public getPath(path: string): string {
    return Path.join(this.basedir, path);
  }

  public botBlockSyncFile(): JsonStore<IBlockSyncFile> {
    return this.blockSync;
  }

  public botStateFile(): JsonStore<IBotStateFile> {
    return this.botState;
  }

  /**
   * @param frameId - the frame id of the last block mined
   */
  public earningsFile(frameId: number): JsonStore<IEarningsFile> {
    const key = `bot-earnings/frame-${frameId}.json`;
    let entry = this.lruCache.get(key) as JsonStore<IEarningsFile> | undefined;
    if (!entry) {
      entry = new JsonStore<IEarningsFile>(this.basedir, key, () => {
        return {
          frameId,
          frameFirstTick: 0,
          frameRewardTicksRemaining: 0,
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
      entry = new JsonStore<IBidsFile>(this.basedir, key, () => {
        return {
          cohortBiddingFrameId,
          cohortActivationFrameId,
          biddingFrameFirstTick: 0,
          biddingFrameRewardTicksRemaining: 0,
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
      entry = new JsonStore<IHistoryFile>(this.basedir, key, () => {
        return {
          activities: [],
        };
      });
      this.lruCache.set(key, entry);
    }
    return entry;
  }
}
