import { Config } from './Config';
import { Db } from './Db';
import { BotFetch } from './BotFetch';
import {
  IBidReductionReason,
  type IBidsFile,
  type IBotState,
  type IBotStateStarting,
  IEarningsFile,
  type IFrameEarningsRollup,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { getMining } from '../stores/mainchain';
import { BotServerIsLoading, BotServerIsSyncing } from '../interfaces/BotErrors';
import { IBotEmitter } from './Bot';
import Installer from './Installer';
import { IBidEntry } from './db/FrameBidsTable.ts';
import { SyncStateKeys } from './db/SyncStateTable.ts';

export enum BotStatus {
  Starting = 'Starting',
  ServerSyncing = 'ServerSyncing',
  DbSyncing = 'DbSyncing',
  Ready = 'Ready',
  Broken = 'Broken',
}

export type IBotFns = {
  onEvent: (type: keyof IBotEmitter, payload?: any) => void;
  setStatus: (x: BotStatus) => void;
  setServerSyncProgress: (x: number) => void;
  setDbSyncProgress: (x: number) => void;
  setMaxSeatsPossible: (x: number) => void;
  setMaxSeatsReductionReason: (x: IBidReductionReason | null) => void;
};

export class BotSyncer {
  public isPaused: boolean = false;

  private db: Db;
  private config: Config;
  private botState!: IBotState;
  private botFns: IBotFns;
  private installer: Installer;
  private isLoaded: boolean = false;

  private isSyncingThePast: boolean = false;

  private mainchain = getMining();
  private miningFrames: MiningFrames;

  private bidsFileCacheByActivationFrameId: Record<number, [number, IBidsFile]> = {};
  private lastModifiedDate: Date | null = null;

  constructor(config: Config, db: Db, installer: Installer, miningFrames: MiningFrames, botFn: IBotFns) {
    this.config = config;
    this.db = db;
    this.installer = installer;
    this.botFns = botFn;
    this.miningFrames = miningFrames;
  }

  public async load(): Promise<void> {
    if (this.isLoaded) return;
    this.isLoaded = true;
    console.log('BotSyncer: Loading...');
    await this.config.isLoadedPromise;
    await this.installer.isLoadedPromise;
    await this.miningFrames.load();

    console.log('BotSyncer: Running...');
    void this.runContinuously();
  }

  private async runContinuously(): Promise<void> {
    if (this.isRunnable) {
      try {
        const lastModifiedDate = await BotFetch.lastModifiedDate();
        if ((lastModifiedDate?.getTime() ?? 0) > (this.lastModifiedDate?.getTime() ?? 0)) {
          this.lastModifiedDate = lastModifiedDate;
          await this.runSync();
        }
      } catch (error) {
        await this.installer.ensureIpAddressIsWhitelisted();
      }
    }

    setTimeout(this.runContinuously.bind(this), 1000);
  }

  private async runSync(): Promise<void> {
    try {
      console.log('BotSyncer: Running sync...');
      await this.updateBotState();
      await this.syncServerState();
      await this.syncCurrentBids();

      if (!this.isSyncingThePast) {
        this.botFns.setStatus(BotStatus.Ready);
        this.botFns.onEvent('updated-cohort-data', this.botState.currentFrameId);
      }
    } catch (e) {
      this.lastModifiedDate = null; // Reset last modified date to ensure we re-fetch on next run
      if (e instanceof BotServerIsLoading) {
        this.botFns.setStatus(BotStatus.Starting);
      } else if (e instanceof BotServerIsSyncing) {
        this.botFns.setStatus(BotStatus.ServerSyncing);
        this.botFns.setServerSyncProgress(e.progress);
      } else {
        this.botFns.setStatus(BotStatus.Broken);
        console.error('BotSyncer error:', e);
      }
    }
  }

  private get isRunnable(): boolean {
    return (
      !this.isPaused &&
      this.config.isMinerReadyToInstall &&
      this.config.isMinerInstalled &&
      this.config.isMinerInstalling &&
      this.config.hasSavedBiddingRules
    );
  }

  private async syncCurrentBids() {
    const activeBidsFile = await BotFetch.fetchBidsFile();
    console.log('BotSyncer: Syncing bids for bidding frame...', activeBidsFile.cohortBiddingFrameId);
    await this.db.frameBidsTable.insertOrUpdate(
      activeBidsFile.cohortBiddingFrameId,
      activeBidsFile.lastBlockNumber,
      [...activeBidsFile.winningBids.entries()].map(([bidPosition, bid]) => {
        return {
          subAccountIndex: bid.subAccountIndex,
          address: bid.address,
          lastBidAtTick: bid.lastBidAtTick,
          microgonsPerSeat: bid.microgonsPerSeat ?? 0n,
          micronotsStakedPerSeat: activeBidsFile.micronotsStakedPerSeat,
          bidPosition,
        } as IBidEntry;
      }),
    );

    this.botFns.onEvent('updated-bids-data', activeBidsFile.winningBids);
  }

  private async updateBotState(): Promise<void> {
    this.botState = await BotFetch.fetchBotState();
    console.log('BotState: Updating bot state...', this.botState);

    this.botFns.setMaxSeatsReductionReason(this.botState.maxSeatsReductionReason ?? null);
    this.botFns.setMaxSeatsPossible(this.botState.maxSeatsPossible);

    if (this.botState.oldestFrameIdToSync > 0) {
      this.config.oldestFrameIdToSync = this.botState.oldestFrameIdToSync;
    }

    if (this.config.oldestFrameIdToSync > this.config.latestFrameIdProcessed) {
      this.config.latestFrameIdProcessed = this.config.oldestFrameIdToSync;
    }

    this.config.hasMiningSeats = this.botState.hasMiningSeats;
    this.config.hasMiningBids = this.botState.hasMiningBids;

    await this.config.save();

    const dbSyncProgress = await this.calculateDbSyncProgress(this.botState);

    if (dbSyncProgress < 100.0) {
      this.botFns.setStatus(BotStatus.DbSyncing);
      this.botFns.setDbSyncProgress(dbSyncProgress);
      await this.syncThePast(dbSyncProgress);
    } else {
      this.botFns.setStatus(BotStatus.Ready);
      await this.syncCurrentFrame();
    }
  }

  private async syncCurrentFrame(): Promise<void> {
    const currentFrameId = this.botState.currentFrameId;
    const completedFrames = await this.db.framesTable.fetchExistingCompleteSince(currentFrameId - 10);
    for (let frameId = currentFrameId - 10; frameId <= currentFrameId; frameId++) {
      if (!completedFrames.includes(frameId)) {
        await this.syncDbFrame(frameId);
      }
    }
  }

  private async syncThePast(progress: number): Promise<void> {
    if (this.isSyncingThePast) return;
    this.isSyncingThePast = true;

    const oldestFrameIdToSync = this.botState.oldestFrameIdToSync;
    const latestFrameIdProcessed = this.config.latestFrameIdProcessed;
    const currentFrameId = this.botState.currentFrameId;
    const currentTick = this.botState.currentTick;
    const framesToSync = currentFrameId - oldestFrameIdToSync + 1;

    const latestDbProcessedFrame = await this.db.framesTable.fetchLastProcessedFrame();
    const startFrameToSync = Math.min(latestDbProcessedFrame, latestFrameIdProcessed);

    console.log('Syncing the past frames...', {
      oldestFrameIdToSync,
      latestFrameIdProcessed,
      startFrameToSync,
      currentFrameId,
      framesToSync,
      currentTick,
    });

    const promise = new Promise<void>(async resolve => {
      for (let frameId = startFrameToSync; frameId <= currentFrameId; frameId++) {
        await this.syncDbFrame(frameId);
        progress = await this.calculateDbSyncProgress(this.botState);
        this.botFns.setDbSyncProgress(progress);
      }

      if (progress > -100) {
        this.isSyncingThePast = false;
      }
      resolve();
    });

    if (framesToSync < 2) {
      await promise;
    }
  }

  public async syncDbFrame(frameId: number): Promise<void> {
    const earningsFile = await BotFetch.fetchEarningsFile(frameId);
    const frameProgress = this.calculateProgress(earningsFile.frameRewardTicksRemaining);

    await this.db.framesTable.insertOrUpdate({
      ...earningsFile,
      id: frameId,
      firstTick: earningsFile.frameFirstTick,
      rewardTicksRemaining: earningsFile.frameRewardTicksRemaining,
      progress: frameProgress,
    });
    console.info('PROCESSING FRAME', frameId, earningsFile);
    const cohortIdsInDb = await this.db.cohortsTable.fetchCohortIdsSince(frameId - 10);
    // Every frame should have a corresponding cohort, even if it has no seats

    const earningsByCohortActivationFrameId: { [frameId: number]: IFrameEarningsRollup } = {};
    for (let i = frameId - 10; i <= frameId; i++) {
      if (i < this.config.oldestFrameIdToSync) continue;
      if (i > frameId) continue;
      if (!cohortIdsInDb.includes(i)) {
        await this.syncDbCohort(i, earningsFile);
      }
      earningsByCohortActivationFrameId[i] = {
        lastBlockMinedAt: '',
        blocksMinedTotal: 0,
        microgonFeesCollectedTotal: 0n,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
        micronotsMinedTotal: 0n,
      };
    }

    let maxBlockNumber = 0;
    let blocksMinedTotal = 0;
    let micronotsMinedTotal = 0n;
    let microgonsMinedTotal = 0n;
    let microgonsMintedTotal = 0n;
    let microgonFeesCollectedTotal = 0n;

    for (const [blockNumberStr, earningsOfBlock] of Object.entries(earningsFile.earningsByBlock)) {
      const blockNumber = parseInt(blockNumberStr, 10);
      const cohortActivationFrameId = earningsOfBlock.authorCohortActivationFrameId;

      const earningsDuringFrame = earningsByCohortActivationFrameId[cohortActivationFrameId];
      if (!earningsDuringFrame) {
        console.warn(
          `Earnings for block ${blockNumber} has cohortActivationFrameId ${cohortActivationFrameId} which is not tracked in frame ${frameId}`,
        );
        continue;
      }
      earningsDuringFrame.blocksMinedTotal += 1;
      if (blockNumber > maxBlockNumber) {
        earningsDuringFrame.lastBlockMinedAt = earningsOfBlock.blockMinedAt;
        maxBlockNumber = blockNumber;
      }
      earningsDuringFrame.lastBlockMinedAt = earningsOfBlock.blockMinedAt;
      earningsDuringFrame.microgonFeesCollectedTotal += earningsOfBlock.microgonFeesCollected;
      earningsDuringFrame.microgonsMinedTotal += earningsOfBlock.microgonsMined;
      earningsDuringFrame.microgonsMintedTotal += earningsOfBlock.microgonsMinted;
      earningsDuringFrame.micronotsMinedTotal += earningsOfBlock.micronotsMined;
    }

    await Promise.all([
      ...Object.entries(earningsByCohortActivationFrameId).map(
        async ([cohortActivationFrameIdStr, cohortEarningsDuringFrame]) => {
          await this.db.cohortFramesTable.insertOrUpdate({
            frameId,
            cohortActivationFrameId: Number(cohortActivationFrameIdStr),
            ...cohortEarningsDuringFrame,
          });
          blocksMinedTotal += cohortEarningsDuringFrame.blocksMinedTotal;
          micronotsMinedTotal += cohortEarningsDuringFrame.micronotsMinedTotal;
          microgonsMinedTotal += cohortEarningsDuringFrame.microgonsMinedTotal;
          microgonsMintedTotal += cohortEarningsDuringFrame.microgonsMintedTotal;
          microgonFeesCollectedTotal += cohortEarningsDuringFrame.microgonFeesCollectedTotal;
        },
      ),
      // NOTE: must update frame progress before cohortFrames are updated
      this.db.cohortsTable.updateProgress(),
    ]);

    const { seatCountActive, seatCostTotalFramed } = await this.db.cohortsTable.fetchActiveSeatData(
      frameId,
      frameProgress,
    );
    const bidsFile = await this.fetchBidsFileFromCache({ cohortActivationFrameId: frameId });
    const allMinersCount = bidsFile.allMinersCount;

    const botLastFrame = this.botState.currentFrameId - 1;
    const isProcessed = frameProgress === 100.0 || frameId < botLastFrame;

    await this.db.framesTable.update({
      id: frameId,

      allMinersCount,
      seatCountActive,
      seatCostTotalFramed,
      blocksMinedTotal,
      micronotsMinedTotal,
      microgonsMinedTotal,
      microgonsMintedTotal,
      microgonFeesCollectedTotal,

      isProcessed,
    });
    if (frameId > this.config.latestFrameIdProcessed) {
      this.config.latestFrameIdProcessed = frameId;
      await this.config.save();
    }
  }

  private async syncDbCohort(cohortActivationFrameId: number, earningsFile: IEarningsFile): Promise<void> {
    console.info('syncDbCohort', cohortActivationFrameId);
    const bidsFile = await this.fetchBidsFileFromCache({ cohortActivationFrameId });
    const biddingFrameProgress = this.calculateProgress(bidsFile.biddingFrameRewardTicksRemaining);
    if (biddingFrameProgress < 100.0) {
      console.info('syncDbCohort SKIPPING', cohortActivationFrameId, bidsFile);
      return;
    }

    const ticksPerCohort = BigInt(NetworkConfig.ticksPerCohort);

    try {
      await this.miningFrames.waitForFrameId(cohortActivationFrameId);
      const cohortStartingTick = this.miningFrames.getTickStart(cohortActivationFrameId);
      const miningSeatCount = BigInt(bidsFile.allMinersCount) || 1n;

      const microgonsToBeMinedDuringCohort = bidsFile.microgonsToBeMinedPerBlock * ticksPerCohort;
      const micronotsToBeMinedDuringCohort = await this.mainchain.minimumMicronotsMinedDuringTickRange(
        cohortStartingTick,
        cohortStartingTick + Number(ticksPerCohort),
      );

      const microgonsToBeMinedPerSeat = microgonsToBeMinedDuringCohort / miningSeatCount;
      const micronotsToBeMinedPerSeat = micronotsToBeMinedDuringCohort / miningSeatCount;
      const transactionFeesTotal = Object.values(bidsFile.transactionFeesByBlock).reduce((acc, fee) => acc + fee, 0n);
      const microgonsBidPerSeat =
        bidsFile.seatCountWon > 0 ? bidsFile.microgonsBidTotal / BigInt(bidsFile.seatCountWon) : 0n;

      await this.db.cohortsTable.insertOrUpdate({
        id: cohortActivationFrameId,
        transactionFeesTotal,
        micronotsStakedPerSeat: bidsFile.micronotsStakedPerSeat,
        microgonsBidPerSeat,
        seatCountWon: bidsFile.seatCountWon,
        microgonsToBeMinedPerSeat,
        micronotsToBeMinedPerSeat,
      });
    } catch (e) {
      console.error('Error syncing cohort:', e);
      throw e;
    }
  }

  // I'm using a hash to call out which frame ID is being used to fetch the bids file
  private async fetchBidsFileFromCache(id: { cohortActivationFrameId: number }): Promise<IBidsFile> {
    const { cohortActivationFrameId } = id;
    let [timeoutId, bidsFile] = this.bidsFileCacheByActivationFrameId[cohortActivationFrameId] || [];

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (!bidsFile) {
      bidsFile = await BotFetch.fetchBidsFile(cohortActivationFrameId);
    }

    const isCurrentFrame = cohortActivationFrameId === this.botState.currentFrameId;
    const millisecondsToCache = isCurrentFrame ? 1e3 : 10 * NetworkConfig.rewardTicksPerFrame;

    timeoutId = setTimeout(() => {
      delete this.bidsFileCacheByActivationFrameId[cohortActivationFrameId];
    }, millisecondsToCache) as unknown as number;

    this.bidsFileCacheByActivationFrameId[cohortActivationFrameId] = [timeoutId, bidsFile];

    return bidsFile;
  }

  private async syncServerState(): Promise<void> {
    const latestBitcoinBlockNumbers = this.botState.bitcoinBlockNumbers;
    const latestArgonBlockNumbers = this.botState.argonBlockNumbers;
    const savedState = await this.db.syncStateTable.get(SyncStateKeys.Server);
    const history = await BotFetch.fetchHistory().then(x => {
      x.activities.sort((a, b) => b.id - a.id);
      return x;
    });

    const hasBitcoinChanges =
      savedState?.bitcoinLocalNodeBlockNumber !== latestBitcoinBlockNumbers.localNode ||
      savedState?.bitcoinMainNodeBlockNumber !== latestBitcoinBlockNumbers.mainNode;
    const hasArgonChanges =
      savedState?.argonLocalNodeBlockNumber !== latestArgonBlockNumbers.localNode ||
      savedState?.argonMainNodeBlockNumber !== latestArgonBlockNumbers.mainNode;
    const lastActivityTick = history.activities.at(0)?.tick;
    const lastActivityDate = lastActivityTick ? new Date(NetworkConfig.tickMillis * lastActivityTick) : null;
    const hasBotActivityChanges =
      savedState?.botActivities?.length !== history.activities.length ||
      lastActivityDate !== savedState?.botActivityLastUpdatedAt;

    if (!hasBotActivityChanges && !hasBitcoinChanges && !hasArgonChanges) {
      return;
    }
    let bitcoinLastUpdatedAt = savedState?.bitcoinBlocksLastUpdatedAt;
    if (hasBitcoinChanges) {
      bitcoinLastUpdatedAt = new Date(this.botState.bitcoinBlockNumbers.localNodeBlockTime * 1000);
      if (bitcoinLastUpdatedAt > new Date()) {
        bitcoinLastUpdatedAt = new Date();
      }
    }
    let argonBlocksLastUpdatedAt = savedState?.argonBlocksLastUpdatedAt;
    if (hasArgonChanges) {
      try {
        argonBlocksLastUpdatedAt = await this.getArgonTimestamp(latestArgonBlockNumbers.localNode);
      } catch (e) {
        console.error('Error fetching argon block timestamp:', e);
        argonBlocksLastUpdatedAt = new Date();
      }
    }

    await this.db.syncStateTable.upsert(SyncStateKeys.Server, {
      latestFrameId: this.botState.currentFrameId,
      argonBlocksLastUpdatedAt,
      argonLocalNodeBlockNumber: this.botState.argonBlockNumbers.localNode,
      argonMainNodeBlockNumber: this.botState.argonBlockNumbers.mainNode,
      bitcoinLocalNodeBlockNumber: latestBitcoinBlockNumbers.localNode,
      bitcoinMainNodeBlockNumber: latestBitcoinBlockNumbers.mainNode,
      bitcoinBlocksLastUpdatedAt: bitcoinLastUpdatedAt,
      botActivities: history.activities,
      botActivityLastUpdatedAt: lastActivityDate || savedState?.botActivityLastUpdatedAt || new Date(),
      botActivityLastBlockNumber:
        (history.activities.at(-1)?.blockNumber || savedState?.botActivityLastBlockNumber) ?? 0,
    });

    this.botFns.onEvent('updated-server-state');
  }

  private async calculateDbSyncProgress(botState: IBotState | IBotStateStarting): Promise<number> {
    const { oldestFrameIdToSync, currentFrameId } = botState as IBotState;
    if (!oldestFrameIdToSync || !currentFrameId) {
      return 0.0;
    }

    const yesterdaysFrameId = currentFrameId - 1;
    const dbFramesExpected = yesterdaysFrameId - oldestFrameIdToSync - 2; // do not include today or yesterday's frame since they aren't processed yet
    if (dbFramesExpected <= 0) return 100;

    const dbFramesProcessed = Math.min(await this.db.framesTable.fetchProcessedCount(), dbFramesExpected);
    const dbCohortsProcessed = Math.min(await this.db.cohortsTable.fetchCount(), dbFramesExpected);

    return (Math.min(dbFramesProcessed, dbCohortsProcessed) / dbFramesExpected) * 100;
  }

  private async getArgonTimestamp(atBlock: number): Promise<Date> {
    return this.miningFrames.blockWatch.getBlockTime(atBlock);
  }

  private calculateProgress(rewardTicksRemaining: number): number {
    if (rewardTicksRemaining <= 0) {
      return 100;
    }
    const totalRewardTicks = NetworkConfig.rewardTicksPerFrame;
    return Math.min(((totalRewardTicks - rewardTicksRemaining) / totalRewardTicks) * 100, 100);
  }
}
