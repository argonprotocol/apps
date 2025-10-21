import { Config } from './Config';
import { Db } from './Db';
import { BotFetch } from './BotFetch';
import {
  type IBidsFile,
  type IBotState,
  type IBotStateStarting,
  type IFrameEarningsRollup,
  MiningFrames,
} from '@argonprotocol/commander-core';
import { getMining } from '../stores/mainchain';
import { BotServerIsLoading, BotServerIsSyncing } from '../interfaces/BotErrors';
import { IBotEmitter } from './Bot';
import Installer from './Installer';
import { IBidEntry } from './db/FrameBidsTable.ts';

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
  setMaxSeatsReductionReason: (x: string) => void;
};

export class BotSyncer {
  public isMissingCurrentFrame: boolean = false;
  public isPaused: boolean = false;

  private db: Db;
  private config: Config;
  private botState!: IBotState;
  private botFns: IBotFns;
  private installer: Installer;
  private isLoaded: boolean = false;

  private isSyncingThePast: boolean = false;

  private mainchain = getMining();

  private bidsFileCacheByActivationFrameId: Record<number, [number, IBidsFile]> = {};
  private lastModifiedDate: Date | null = null;

  constructor(config: Config, db: Db, installer: Installer, botFn: IBotFns) {
    this.config = config;
    this.db = db;
    this.installer = installer;
    this.botFns = botFn;
  }

  public async load(): Promise<void> {
    if (this.isLoaded) return;
    this.isLoaded = true;
    console.log('BotSyncer: Loading...');
    await this.config.isLoadedPromise;
    await this.installer.isLoadedPromise;

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
      this.config.isMinerUpToDate &&
      this.config.isMinerInstalled &&
      this.config.hasSavedBiddingRules &&
      !this.config.isMinerWaitingForUpgradeApproval
    );
  }

  private async syncCurrentBids() {
    console.log('syncCurrentBids');
    const activeBidsFile = await BotFetch.fetchBidsFile();

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

  private async updateBotState(retries: number = 0): Promise<void> {
    this.botState = await BotFetch.fetchBotState();
    console.log('BotState: Updating bot state...', this.botState);

    this.botFns.setMaxSeatsReductionReason(this.botState.maxSeatsReductionReason);
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
      await this.syncCurrentFrame();
    }
  }

  private async syncCurrentFrame(): Promise<void> {
    await this.syncDbFrame(this.botState.currentFrameId, this.botState.currentTick);
  }

  private async syncThePast(progress: number): Promise<void> {
    if (this.isSyncingThePast) return;
    this.isSyncingThePast = true;

    const oldestFrameIdToSync = this.botState.oldestFrameIdToSync;
    const latestFrameIdProcessed = this.config.latestFrameIdProcessed;
    const currentFrameId = this.botState.currentFrameId;
    const currentTick = this.botState.currentTick;
    const framesToSync = currentFrameId - oldestFrameIdToSync + 1;

    console.log('Syncing the past frames...', {
      oldestFrameIdToSync,
      latestFrameIdProcessed,
      currentFrameId,
      framesToSync,
    });

    const promise = new Promise<void>(async resolve => {
      for (let frameId = latestFrameIdProcessed; frameId <= currentFrameId; frameId++) {
        await this.syncDbFrame(frameId, currentTick);
        if (frameId > this.config.latestFrameIdProcessed) {
          this.config.latestFrameIdProcessed = frameId;
        }
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

  public async syncDbFrame(frameId: number, currentTick: number): Promise<void> {
    const earningsFile = await BotFetch.fetchEarningsFile(frameId);
    const frameProgress = await this.calculateProgress(earningsFile.frameTickRange, currentTick);

    await this.db.framesTable.insertOrUpdate(
      frameId,
      earningsFile.frameTickRange[0],
      earningsFile.frameTickRange[1],
      earningsFile.firstBlockNumber,
      earningsFile.lastBlockNumber,
      earningsFile.microgonToUsd,
      earningsFile.microgonToBtc,
      earningsFile.microgonToArgonot,
      frameProgress,
      false,
    );
    console.info('INSERTING FRAME', frameId);
    // Every frame should have a corresponding cohort, even if it has no seats
    await this.syncDbCohort(frameId, currentTick);
    const processedCohorts: Set<number> = new Set([frameId]);

    const earningsByCohortActivationFrameId: { [frameId: number]: IFrameEarningsRollup } = {};
    let maxBlockNumber = 0;

    for (const [blockNumberStr, earningsOfBlock] of Object.entries(earningsFile.earningsByBlock)) {
      const blockNumber = parseInt(blockNumberStr, 10);
      const cohortActivationFrameId = earningsOfBlock.authorCohortActivationFrameId;
      earningsByCohortActivationFrameId[cohortActivationFrameId] ??= {
        lastBlockMinedAt: '',
        blocksMinedTotal: 0,
        microgonFeesCollectedTotal: 0n,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
        micronotsMinedTotal: 0n,
      };

      const earningsDuringFrame = earningsByCohortActivationFrameId[cohortActivationFrameId];
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
    const cohortEarningsByFrameId = await this.injectMissingCohortEarnings(earningsByCohortActivationFrameId, frameId);
    const cohortEarningsEntries = Object.entries(cohortEarningsByFrameId);

    let blocksMinedTotal = 0;
    let micronotsMinedTotal = 0n;
    let microgonsMinedTotal = 0n;
    let microgonsMintedTotal = 0n;
    let microgonFeesCollectedTotal = 0n;

    await Promise.all(
      cohortEarningsEntries.map(async ([cohortActivationFrameIdStr, cohortEarningsDuringFrame]) => {
        const cohortActivationFrameId = parseInt(cohortActivationFrameIdStr, 10);
        if (cohortActivationFrameId < this.config.oldestFrameIdToSync) return;
        if (!processedCohorts.has(cohortActivationFrameId)) {
          await this.syncDbCohort(cohortActivationFrameId, currentTick);
          processedCohorts.add(cohortActivationFrameId);
        }
        await this.syncDbCohortFrame(cohortActivationFrameId, frameId, cohortEarningsDuringFrame);
        blocksMinedTotal += cohortEarningsDuringFrame.blocksMinedTotal;
        micronotsMinedTotal += cohortEarningsDuringFrame.micronotsMinedTotal;
        microgonsMinedTotal += cohortEarningsDuringFrame.microgonsMinedTotal;
        microgonsMintedTotal += cohortEarningsDuringFrame.microgonsMintedTotal;
        microgonFeesCollectedTotal += cohortEarningsDuringFrame.microgonFeesCollectedTotal;
      }),
    );

    const { seatCountActive, seatCostTotalFramed } = await this.db.cohortsTable.fetchActiveSeatData(
      frameId,
      frameProgress,
    );
    const bidsFile = await this.fetchBidsFileFromCache({ cohortActivationFrameId: frameId });
    const allMinersCount = bidsFile.allMinersCount;

    const yesterdaysFrameId = this.botState.currentFrameId - 1;
    const isProcessed = frameProgress === 100.0 && frameId < yesterdaysFrameId;
    if (!isProcessed) {
      console.log('EARNINGS FILE: ', frameId, earningsFile);
    }

    await this.db.framesTable.update({
      id: frameId,
      firstTick: earningsFile.frameTickRange[0],
      lastTick: earningsFile.frameTickRange[1],
      firstBlockNumber: earningsFile.firstBlockNumber,
      lastBlockNumber: earningsFile.lastBlockNumber,
      microgonToUsd: earningsFile.microgonToUsd,
      microgonToBtc: earningsFile.microgonToBtc,
      microgonToArgonot: earningsFile.microgonToArgonot,

      allMinersCount,
      seatCountActive,
      seatCostTotalFramed,
      blocksMinedTotal,
      micronotsMinedTotal,
      microgonsMinedTotal,
      microgonsMintedTotal,
      microgonFeesCollectedTotal,
      accruedMicrogonProfits: earningsFile.accruedMicrogonProfits,
      accruedMicronotProfits: earningsFile.accruedMicronotProfits,

      progress: frameProgress,
      isProcessed,
    });
  }

  private async injectMissingCohortEarnings(
    cohortEarningsByFrameId: Record<string, IFrameEarningsRollup>,
    currentFrameId: number,
  ): Promise<Record<string, IFrameEarningsRollup>> {
    const frameIdsToCheck = [];
    // Check previous 9 frames for to ensure we have all active cohorts in earnings object
    for (let i = 0; i < 10; i++) {
      const frameIdToCheck = currentFrameId - i;
      if (cohortEarningsByFrameId[frameIdToCheck]) continue;
      if (frameIdToCheck < this.config.oldestFrameIdToSync) break;
      frameIdsToCheck.push(frameIdToCheck);
    }
    const cohortsById = await this.db.cohortsTable.fetchById(...frameIdsToCheck);

    for (const [frameId, cohort] of Object.entries(cohortsById)) {
      let didWinSeats = false;

      if (cohort) {
        didWinSeats = !!cohort.seatCountWon;
      } else {
        const bidsFile = await this.fetchBidsFileFromCache({ cohortActivationFrameId: Number(frameId) });
        didWinSeats = !!bidsFile.winningBids.filter(x => typeof x.subAccountIndex === 'number').length;
      }

      if (didWinSeats) {
        cohortEarningsByFrameId[frameId] = {
          lastBlockMinedAt: '',
          blocksMinedTotal: 0,
          microgonsMinedTotal: 0n,
          microgonsMintedTotal: 0n,
          micronotsMinedTotal: 0n,
          microgonFeesCollectedTotal: 0n,
        };
      }
    }

    return cohortEarningsByFrameId;
  }

  private async syncDbCohort(cohortActivationFrameId: number, currentTick: number): Promise<void> {
    console.info('syncDbCohort', cohortActivationFrameId);
    const bidsFile = await this.fetchBidsFileFromCache({ cohortActivationFrameId });
    const biddingFrameProgress = await this.calculateProgress(bidsFile.biddingFrameTickRange, currentTick);
    if (biddingFrameProgress < 100.0) {
      console.info('syncDbCohort SKIPPING', cohortActivationFrameId, bidsFile);
      return;
    }

    const currentFrameProgress = await this.calculateProgress(this.botState.currentFrameTickRange, currentTick);
    const ticksPerCohort = BigInt(MiningFrames.ticksPerCohort);

    try {
      const [cohortStartingTick] = MiningFrames.getTickRangeForFrame(cohortActivationFrameId);
      const cohortEndingTick = cohortStartingTick + Number(ticksPerCohort);
      const framesCompleted = Math.min(this.botState.currentFrameId - cohortActivationFrameId, 10);
      const miningSeatCount = BigInt(bidsFile.allMinersCount) || 1n;
      const progress = Math.min((framesCompleted * 100 + currentFrameProgress) / 10, 100);
      const micronotsStaked = bidsFile.micronotsStakedPerSeat * BigInt(bidsFile.seatCountWon);

      const microgonsToBeMinedDuringCohort = bidsFile.microgonsToBeMinedPerBlock * ticksPerCohort;
      const micronotsToBeMinedDuringCohort = await this.mainchain.getMinimumMicronotsMinedDuringTickRange(
        cohortStartingTick,
        cohortEndingTick,
      );

      const microgonsToBeMinedPerSeat = microgonsToBeMinedDuringCohort / miningSeatCount;
      const micronotsToBeMinedPerSeat = micronotsToBeMinedDuringCohort / miningSeatCount;
      const transactionFeesTotal = Object.values(bidsFile.transactionFeesByBlock).reduce((acc, fee) => acc + fee, 0n);
      const microgonsBidPerSeat =
        bidsFile.seatCountWon > 0 ? bidsFile.microgonsBidTotal / BigInt(bidsFile.seatCountWon) : 0n;

      await this.db.cohortsTable.insertOrUpdate({
        id: cohortActivationFrameId,
        progress,
        transactionFeesTotal,
        micronotsStakedPerSeat: micronotsStaked,
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

  private async syncDbCohortFrame(
    cohortActivationFrameId: number,
    frameId: number,
    cohortEarningsDuringFrame: IFrameEarningsRollup,
  ): Promise<void> {
    await this.db.cohortFramesTable.insertOrUpdate({
      frameId,
      cohortActivationFrameId,
      ...cohortEarningsDuringFrame,
    });
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
    const millisecondsToCache = isCurrentFrame ? 1_000 : 600_000;

    timeoutId = setTimeout(() => {
      delete this.bidsFileCacheByActivationFrameId[cohortActivationFrameId];
    }, millisecondsToCache) as unknown as number;

    this.bidsFileCacheByActivationFrameId[cohortActivationFrameId] = [timeoutId, bidsFile];

    return bidsFile;
  }

  private async syncServerState(): Promise<void> {
    const latestBitcoinBlockNumbers = this.botState.bitcoinBlockNumbers;
    const latestArgonBlockNumbers = this.botState.argonBlockNumbers;
    const savedState = await this.db.serverStateTable.get();
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
    const lastActivityDate = lastActivityTick ? new Date(MiningFrames.tickMillis * lastActivityTick) : null;
    const hasBotActivityChanges =
      savedState?.botActivities?.length !== history.activities.length ||
      lastActivityDate !== savedState?.botActivityLastUpdatedAt;

    if (!hasBotActivityChanges && !hasBitcoinChanges && !hasArgonChanges) {
      return;
    }
    let bitcoinLastUpdatedAt = savedState?.bitcoinBlocksLastUpdatedAt;
    if (hasBitcoinChanges) {
      bitcoinLastUpdatedAt = new Date(this.botState.bitcoinBlockNumbers.localNodeBlockTime * 1000);
    }
    let argonBlocksLastUpdatedAt = savedState?.botActivityLastUpdatedAt;
    if (hasArgonChanges) {
      try {
        argonBlocksLastUpdatedAt = await this.getArgonTimestamp(latestArgonBlockNumbers.localNode);
      } catch (e) {
        console.error('Error fetching argon block timestamp:', e);
        argonBlocksLastUpdatedAt = new Date();
      }
    }

    await this.db.serverStateTable.insertOrUpdateBlocks({
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
    const dbFramesExpected = yesterdaysFrameId - oldestFrameIdToSync - 2; // do not include today or yesterday's frame since they arenot processed yet
    if (dbFramesExpected <= 0) return 100;

    const dbFramesProcessed = Math.min(await this.db.framesTable.fetchProcessedCount(), dbFramesExpected);
    const dbCohortsProcessed = Math.min(await this.db.cohortsTable.fetchCount(), dbFramesExpected);

    console.log(
      'dbFramesExpected',
      dbFramesExpected,
      'dbFramesProcessed',
      dbFramesProcessed,
      'dbCohortsProcessed',
      dbCohortsProcessed,
    );

    return (Math.min(dbFramesProcessed, dbCohortsProcessed) / dbFramesExpected) * 100;
  }

  private async getArgonTimestamp(atBlock: number): Promise<Date> {
    const client = await this.mainchain.prunedClientOrArchivePromise;
    const hash = await client.rpc.chain.getBlockHash(atBlock);
    const clientAt = await client.at(hash);
    const timestamp = (await clientAt.query.timestamp.now()).toNumber();
    return new Date(timestamp);
  }

  private async calculateProgress(tickRange: [number, number], currentTick: number): Promise<number> {
    const [firstTick, lastTick] = tickRange;
    if (currentTick < firstTick) {
      return 0;
    } else if (currentTick > lastTick) {
      return 100;
    }
    return Math.min(((currentTick - firstTick) / (lastTick - firstTick)) * 100, 100);
  }
}
