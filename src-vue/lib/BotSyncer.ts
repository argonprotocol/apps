import { Config } from './Config';
import { Db } from './Db';
import { BotWsClient } from './BotWsClient.ts';
import {
  type IBidsFile,
  type IBotState,
  type IBotStateStarting,
  IEarningsFile,
  type IFrameEarningsRollup,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { getMining } from '../stores/mainchain';
import { IBotEmitter } from './Bot';
import Installer from './Installer';
import { IBidEntry } from './db/FrameBidsTable.ts';
import { SyncStateKeys } from './db/SyncStateTable.ts';
import { SERVER_ENV_VARS } from './Env.ts';
import { SSH } from './SSH.ts';

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
  setBotState: (state: IBotState) => void;
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
  private botWsClient: BotWsClient | undefined;
  private lastIpWhitelistedTime: number = 0;
  private lastStateRefreshAt: number = 0;
  private pendingState: IBotState | IBotStateStarting | undefined;
  private syncInFlight: Promise<void> | undefined;

  private bidsFileCacheByActivationFrameId: Record<number, [number, IBidsFile]> = {};

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
    void this.loopToStayConnected();
  }

  public async getClient(): Promise<BotWsClient> {
    if (!this.botWsClient) {
      const ipAddress = await SSH.getIpAddress();
      const url = `ws://${ipAddress}:${SERVER_ENV_VARS.BOT_PORT}`;
      const client = new BotWsClient(url);
      await client.connectDeferred.promise;
      this.botWsClient = client;

      client.events.on('/state', (state: IBotState) => {
        this.pendingState = state;
        this.lastStateRefreshAt = Date.now();
        void this.drainSyncQueue();
      });
      client.events.on('ws:disconnected', () => {
        this.lastStateRefreshAt = 0;
      });
    }
    return this.botWsClient;
  }

  public async refresh(): Promise<void> {
    const client = await this.getClient();
    const state = await client.fetch('/state');
    await this.runSync(state);
  }

  private async loopToStayConnected(): Promise<void> {
    try {
      if (this.isRunnable) {
        try {
          const now = Date.now();
          const maxStateAge = Math.ceil(NetworkConfig.tickMillis * 1.2);

          if (!this.pendingState && (!this.lastStateRefreshAt || now - this.lastStateRefreshAt > maxStateAge)) {
            const client = await this.getClient();
            this.pendingState = await client.fetch('/state');
            this.lastStateRefreshAt = Date.now();
          }

          await this.drainSyncQueue();
        } catch (error) {
          // try to whitelist IP again if connection fails, but only ever once every 10 minutes
          if (!this.lastIpWhitelistedTime || Date.now() - this.lastIpWhitelistedTime >= 10 * 60e3) {
            await this.installer.ensureIpAddressIsWhitelisted();
            this.lastIpWhitelistedTime = Date.now();
          }
        }
      }
    } catch (e) {
      console.error('BotSyncer loop error:', e);
    } finally {
      setTimeout(this.loopToStayConnected.bind(this), Math.max(100, Math.ceil(NetworkConfig.tickMillis / 5)));
    }
  }

  private async drainSyncQueue(): Promise<void> {
    if (this.syncInFlight) {
      await this.syncInFlight;
      return;
    }

    const syncPromise = this.processPendingSyncs();
    this.syncInFlight = syncPromise;
    try {
      await syncPromise;
    } finally {
      if (this.syncInFlight === syncPromise) {
        this.syncInFlight = undefined;
      }
    }
  }

  private async processPendingSyncs(): Promise<void> {
    while (this.pendingState) {
      const state = this.pendingState;
      this.pendingState = undefined;
      await this.runSync(state);
    }
  }

  private async runSync(state: IBotState | IBotStateStarting): Promise<void> {
    console.log('BotState: Updating bot state...', state);
    try {
      if (state.serverError) {
        this.botFns.setStatus(BotStatus.Broken);
        console.error('BotSyncer error:', state.serverError);
        return;
      } else if (state.isSyncing) {
        this.botFns.setStatus(BotStatus.ServerSyncing);
        this.botFns.setServerSyncProgress(state.syncProgress);
        return;
      } else if (!state.isReady) {
        this.botFns.setStatus(BotStatus.Starting);
        return;
      }

      const botState = state as IBotState;
      this.botState = botState;
      await this.updateBotState(botState);
      await this.syncServerState(botState);
      await this.syncCurrentBids();

      if (!this.isSyncingThePast) {
        this.botFns.setStatus(BotStatus.Ready);
        this.botFns.onEvent('updated-cohort-data', botState.currentFrameId);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isTransientConnectionError =
        message.includes('No response received from RPC endpoint') ||
        message.includes('BotWsClient') ||
        message.includes('request timed out') ||
        message.includes('heartbeat-timeout');

      if (isTransientConnectionError) {
        if (!this.botState) {
          this.botFns.setStatus(BotStatus.Starting);
        }
        console.warn('BotSyncer transient error:', e);
        return;
      }

      this.botFns.setStatus(BotStatus.Broken);
      console.error('BotSyncer error:', e);
    }
  }

  private get isRunnable(): boolean {
    try {
      return !this.isPaused && this.config.isServerInstalled;
    } catch (e) {
      return false;
    }
  }

  private async syncCurrentBids() {
    const client = await this.getClient();
    const activeBidsFile = await client.fetch(`/bids`);
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

  private async updateBotState(botState = this.botState): Promise<void> {
    this.botFns.setBotState(botState);

    if (botState.oldestFrameIdToSync > 0) {
      this.config.oldestFrameIdToSync = botState.oldestFrameIdToSync;
    }

    if (this.config.oldestFrameIdToSync > this.config.latestFrameIdProcessed) {
      this.config.latestFrameIdProcessed = this.config.oldestFrameIdToSync;
    }

    this.config.hasMiningSeats = botState.hasMiningSeats;
    this.config.hasMiningBids = botState.hasMiningBids;

    await this.config.save();
    const dbSyncProgress = await this.calculateDbSyncProgress(botState);

    if (dbSyncProgress < 100.0) {
      this.botFns.setStatus(BotStatus.DbSyncing);
      this.botFns.setDbSyncProgress(dbSyncProgress);
      await this.syncThePast(dbSyncProgress, botState);
    } else {
      this.botFns.setStatus(BotStatus.Ready);
      await this.syncCurrentFrame(botState);
    }
  }

  private async syncCurrentFrame(botState = this.botState): Promise<void> {
    const currentFrameId = botState.currentFrameId;
    const completedFrames = await this.db.framesTable.fetchExistingCompleteSince(currentFrameId - 10);

    for (let frameId = currentFrameId - 10; frameId <= currentFrameId; frameId++) {
      if (!completedFrames.includes(frameId)) {
        await this.syncDbFrame(frameId, botState);
      }
    }
  }

  private async syncThePast(progress: number, botState = this.botState): Promise<void> {
    if (this.isSyncingThePast) return;
    this.isSyncingThePast = true;

    const oldestFrameIdToSync = botState.oldestFrameIdToSync;
    const latestFrameIdProcessed = this.config.latestFrameIdProcessed;
    const currentFrameId = botState.currentFrameId;
    const currentTick = botState.currentTick;
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

    const syncPromise = (async () => {
      try {
        for (let frameId = startFrameToSync; frameId <= currentFrameId; frameId++) {
          await this.syncDbFrame(frameId, botState);
          progress = await this.calculateDbSyncProgress(botState);
          this.botFns.setDbSyncProgress(progress);
        }
      } finally {
        this.isSyncingThePast = false;
      }
    })();

    if (framesToSync < 2) {
      await syncPromise;
    }
  }

  public async syncDbFrame(frameId: number, botState = this.botState): Promise<void> {
    const client = await this.getClient();
    const earningsFile = await client.fetch(`/earnings`, frameId);
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

    const bidsFile = await this.fetchBidsFileFromCache({ cohortActivationFrameId: frameId }, botState.currentFrameId);
    const allMinersCount = bidsFile.allMinersCount;

    const botLastFrame = botState.currentFrameId - 1;
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
    const bidsFile = await this.fetchBidsFileFromCache({ cohortActivationFrameId });
    const biddingFrameProgress = this.calculateProgress(bidsFile.biddingFrameRewardTicksRemaining);
    if (biddingFrameProgress < 100.0) {
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
  private async fetchBidsFileFromCache(
    id: { cohortActivationFrameId: number },
    currentFrameId = this.botState.currentFrameId,
  ): Promise<IBidsFile> {
    const { cohortActivationFrameId } = id;
    let [timeoutId, bidsFile] = this.bidsFileCacheByActivationFrameId[cohortActivationFrameId] || [];

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (!bidsFile) {
      const client = await this.getClient();
      bidsFile = await client.fetch('/bids', cohortActivationFrameId - 1);
    }

    const isCurrentFrame = cohortActivationFrameId === currentFrameId;
    const millisecondsToCache = isCurrentFrame ? 1e3 : 10 * NetworkConfig.rewardTicksPerFrame;

    timeoutId = setTimeout(() => {
      delete this.bidsFileCacheByActivationFrameId[cohortActivationFrameId];
    }, millisecondsToCache) as unknown as number;

    this.bidsFileCacheByActivationFrameId[cohortActivationFrameId] = [timeoutId, bidsFile];

    return bidsFile;
  }

  private async syncServerState(botState = this.botState): Promise<void> {
    const latestBitcoinBlockNumbers = botState.bitcoinBlockNumbers;
    const latestArgonBlockNumbers = botState.argonBlockNumbers;
    const savedState = await this.db.syncStateTable.get(SyncStateKeys.Server);

    const hasBitcoinChanges =
      savedState?.bitcoinLocalNodeBlockNumber !== latestBitcoinBlockNumbers.localNode ||
      savedState?.bitcoinMainNodeBlockNumber !== latestBitcoinBlockNumbers.mainNode;
    const hasArgonChanges =
      savedState?.argonLocalNodeBlockNumber !== latestArgonBlockNumbers.localNode ||
      savedState?.argonMainNodeBlockNumber !== latestArgonBlockNumbers.mainNode;
    const botLastActivityDate = botState.botLastActiveDate;
    const hasBotActivityChanges = botLastActivityDate?.getTime() !== savedState?.botActivityLastUpdatedAt?.getTime();

    if (!hasBotActivityChanges && !hasBitcoinChanges && !hasArgonChanges) {
      return;
    }
    let bitcoinLastUpdatedAt = savedState?.bitcoinBlocksLastUpdatedAt;
    if (hasBitcoinChanges) {
      bitcoinLastUpdatedAt = new Date(latestBitcoinBlockNumbers.localNodeBlockTime * 1000);
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
      latestFrameId: botState.currentFrameId,
      argonBlocksLastUpdatedAt,
      argonLocalNodeBlockNumber: latestArgonBlockNumbers.localNode,
      argonMainNodeBlockNumber: latestArgonBlockNumbers.mainNode,
      bitcoinLocalNodeBlockNumber: latestBitcoinBlockNumbers.localNode,
      bitcoinMainNodeBlockNumber: latestBitcoinBlockNumbers.mainNode,
      bitcoinBlocksLastUpdatedAt: bitcoinLastUpdatedAt,
      botActivityLastUpdatedAt: botLastActivityDate || savedState?.botActivityLastUpdatedAt || new Date(),
      botActivityLastBlockNumber: botState.botLastActiveBlockNumber ?? savedState?.botActivityLastBlockNumber ?? 0,
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
