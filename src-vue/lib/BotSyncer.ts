import { Config } from './Config';
import { Db } from './Db';
import { BotWsClient } from './BotWsClient.ts';
import {
  type IBidsFile,
  type IBotState,
  type IBotStateStarting,
  type IFrameEarningsRollup,
  type Mining,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { IBotEmitter } from './Bot';
import Installer from './Installer';
import { IBidEntry } from './db/FrameBidsTable.ts';
import type { CohortsTable } from './db/CohortsTable.ts';
import { SyncStateKeys } from './db/SyncStateTable.ts';
import type { ServerApiClient } from './ServerApiClient.ts';

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
  setDbHistoryError: (x: string | null) => void;
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
  private historicalRecovery?: {
    oldestFrameId: number;
    nextFrameId: number;
    processedFrames: Set<number>;
    firstMissingCohortId: number;
    completedFrameCount: number;
    progressFrameId: number;
    lastCompletedVersion?: string;
  };

  private miningFrames: MiningFrames;
  private botWsClient: BotWsClient | undefined;
  private botWsClientPromise: Promise<BotWsClient> | undefined;
  private isDisposed = false;
  private nextBotWsClientAttemptAt: number = 0;
  private lastStateRefreshAt: number = 0;
  private pendingState: IBotState | IBotStateStarting | undefined;
  private syncInFlight: Promise<void> | undefined;

  private bidsFileCacheByActivationFrameId: Record<number, [number, IBidsFile]> = {};

  constructor(
    config: Config,
    db: Db,
    installer: Installer,
    private readonly serverApiClient: ServerApiClient,
    private readonly mainchain: Mining,
    miningFrames: MiningFrames,
    botFn: IBotFns,
  ) {
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
    if (this.isDisposed) throw new Error('BotSyncer disposed');
    if (this.botWsClient) return this.botWsClient;
    if (Date.now() < this.nextBotWsClientAttemptAt) {
      throw new Error('Bot websocket connection is waiting before retrying.');
    }
    if (this.botWsClientPromise) {
      return await this.botWsClientPromise;
    }

    await this.config.isLoadedPromise;
    const connectStartedAt = Date.now();
    const isGatewayReady = await this.serverApiClient.isGatewayReady();
    if (!isGatewayReady) {
      await this.installer.refreshLocalGatewayPort();
    }

    this.botWsClientPromise = BotWsClient.connectToServerGateway(this.serverApiClient)
      .then(client => {
        if (this.isDisposed) {
          client.dispose();
          throw new Error('BotSyncer disposed');
        }

        this.botWsClient = client;
        this.nextBotWsClientAttemptAt = 0;

        client.events.on('/state', state => {
          this.pendingState = state;
          this.lastStateRefreshAt = Date.now();
          void this.drainSyncQueue();
        });
        client.events.on('ws:disconnected', () => {
          this.lastStateRefreshAt = 0;
        });

        return client;
      })
      .catch(error => {
        this.nextBotWsClientAttemptAt = Date.now() + 10_000;
        console.warn(`[BotSyncer] Server gateway connect failed after ${Date.now() - connectStartedAt}ms`, error);
        throw error;
      })
      .finally(() => {
        this.botWsClientPromise = undefined;
      });

    return await this.botWsClientPromise;
  }

  public async refresh(): Promise<void> {
    const client = await this.getClient();
    const state = await client.fetch('/state');
    await this.runSync(state);
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.isPaused = true;
    this.botWsClient?.dispose();
    this.botWsClient = undefined;
    this.botWsClientPromise = undefined;
    for (const [timeout] of Object.values(this.bidsFileCacheByActivationFrameId)) clearTimeout(timeout);
    this.bidsFileCacheByActivationFrameId = {};
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
        } catch {
          // Connection retries are throttled in getClient.
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
      } else if (state.isSyncing && !state.isReady) {
        this.botFns.setStatus(BotStatus.ServerSyncing);
        this.botFns.setServerSyncProgress(state.syncProgress);
        return;
      } else if (!state.isReady) {
        this.botFns.setStatus(BotStatus.Starting);
        return;
      }

      const botState = state as IBotState;
      this.botState = botState;
      if (botState.isSyncing) this.botFns.setServerSyncProgress(botState.syncProgress);
      await this.updateBotState(botState);
      await this.syncServerState(botState);
      await this.syncCurrentBids(botState);

      this.botFns.setBotState(botState);
      this.botFns.onEvent(
        botState.isSyncing || this.isSyncingThePast ? 'updated-current-bids' : 'updated-mining-state',
        botState.currentFrameId,
      );
      this.botFns.setStatus(BotStatus.Ready);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isWebSocketEventError = Boolean(e && typeof e === 'object' && 'isTrusted' in e);
      const isTransientConnectionError =
        isWebSocketEventError ||
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

  private async syncCurrentBids(state: IBotState): Promise<void> {
    console.log('BotSyncer: Syncing bids for bidding frame...', state.currentFrameId);
    await this.db.frameBidsTable.insertOrUpdate(
      state.currentFrameId,
      state.botLastActiveBlockNumber,
      [...state.winningBids.entries()].map(([bidPosition, bid]) => {
        return {
          subAccountIndex: bid.subAccountIndex,
          address: bid.address,
          lastBidAtTick: bid.lastBidAtTick,
          microgonsPerSeat: bid.microgonsPerSeat ?? 0n,
          micronotsStakedPerSeat: state.currentAuctionMicronotsPerSeat ?? 0n,
          bidPosition,
        } as IBidEntry;
      }),
    );
  }

  private async updateBotState(botState = this.botState): Promise<void> {
    if (botState.oldestFrameIdToSync > 0 || NetworkConfig.canFrameBeZero()) {
      this.config.oldestFrameIdToSync = botState.oldestFrameIdToSync;
    }

    // Account restore can already know about seats that have expired before bot replay reaches them.
    this.config.hasMiningSeats ||= botState.hasMiningSeats;
    this.config.hasMiningBids ||= botState.hasMiningBids || this.config.hasMiningSeats;

    await this.config.save();
    if (!botState.isSyncing) await this.syncThePast(botState);
  }

  private async syncThePast(botState = this.botState): Promise<void> {
    if (this.isSyncingThePast || this.isDisposed) return;
    const { oldestFrameIdToSync, currentFrameId } = botState;
    if (oldestFrameIdToSync === 0 && !NetworkConfig.canFrameBeZero()) return;
    const version = `${currentFrameId}:${String(botState.earningsLastModifiedAt)}:${botState.lastFinalizedProcessedBlockNumber}`;
    if (this.historicalRecovery?.oldestFrameId === oldestFrameIdToSync) {
      if (this.historicalRecovery.lastCompletedVersion === version) return;
    }
    this.isSyncingThePast = true;
    let firstUpdatedFrameId: number | undefined;
    const syncPromise = (async () => {
      try {
        const framesToSync = currentFrameId - oldestFrameIdToSync + 1;
        if (!this.historicalRecovery || this.historicalRecovery.oldestFrameId !== oldestFrameIdToSync) {
          const [processedFrameIds, existingCohortIds] = await Promise.all([
            this.db.framesTable.fetchProcessedFrameIdsSince(oldestFrameIdToSync, framesToSync),
            this.db.cohortsTable.fetchCohortIdsSince(oldestFrameIdToSync, framesToSync),
          ]);
          const processedFrames = new Set(processedFrameIds);
          const existingCohorts = new Set(existingCohortIds);
          let firstMissingCohortId = oldestFrameIdToSync;
          while (existingCohorts.has(firstMissingCohortId)) firstMissingCohortId += 1;
          this.historicalRecovery = {
            oldestFrameId: oldestFrameIdToSync,
            nextFrameId: oldestFrameIdToSync,
            processedFrames,
            firstMissingCohortId,
            completedFrameCount: processedFrameIds.filter(id => id < currentFrameId && existingCohorts.has(id)).length,
            progressFrameId: currentFrameId,
          };
        }
        const recovery = this.historicalRecovery;
        for (let frameId = recovery.progressFrameId; frameId < currentFrameId; frameId++) {
          if (recovery.processedFrames.has(frameId) && this.db.cohortsTable.state.storedCohorts[frameId]) {
            recovery.completedFrameCount += 1;
          }
        }
        recovery.progressFrameId = currentFrameId;
        let progress = this.calculateDbSyncProgress(botState);
        this.botFns.setDbSyncProgress(progress);
        let firstIncompleteFrameId: number | undefined;
        for (let frameId = recovery.nextFrameId; frameId <= currentFrameId; frameId++) {
          if (this.isDisposed || this.botState?.isSyncing) return;
          const requiresCohortCatchUp = frameId >= recovery.firstMissingCohortId;
          if (frameId < currentFrameId && recovery.processedFrames.has(frameId) && !requiresCohortCatchUp) {
            recovery.nextFrameId = firstIncompleteFrameId ?? frameId + 1;
            continue;
          }

          const wasComplete =
            frameId < currentFrameId &&
            recovery.processedFrames.has(frameId) &&
            this.db.cohortsTable.state.storedCohorts[frameId];
          try {
            await this.syncDbFrame(frameId, botState);
            firstUpdatedFrameId ??= frameId;
          } catch (error) {
            if (!(error instanceof MiningHistoryNotReadyError) || frameId < botState.finalizedFrameId - 1) {
              throw error;
            }
            // Recent files may still be publishing. Retry on the next update without a history warning.
            recovery.nextFrameId = firstIncompleteFrameId ?? frameId;
            this.botFns.setDbHistoryError(null);
            return;
          }
          this.botFns.setDbHistoryError(null);
          if (this.db.framesTable.state.processedFrames[frameId]) recovery.processedFrames.add(frameId);
          else recovery.processedFrames.delete(frameId);
          const isComplete =
            frameId < currentFrameId &&
            recovery.processedFrames.has(frameId) &&
            this.db.cohortsTable.state.storedCohorts[frameId];
          if (!wasComplete && isComplete) recovery.completedFrameCount += 1;
          if (wasComplete && !isComplete) recovery.completedFrameCount -= 1;
          if (frameId < currentFrameId && !isComplete) firstIncompleteFrameId ??= frameId;
          recovery.nextFrameId = firstIncompleteFrameId ?? frameId + 1;
          progress = this.calculateDbSyncProgress(botState);
          this.botFns.setDbSyncProgress(progress);
        }
        recovery.nextFrameId = firstIncompleteFrameId ?? currentFrameId;
        recovery.lastCompletedVersion = version;
        this.botFns.setDbHistoryError(null);
      } finally {
        this.isSyncingThePast = false;
        // Publish committed imports once, including a partial batch before an error.
        // A current-frame update only refreshes live positions; older frames require a history refresh.
        if (!this.isDisposed && firstUpdatedFrameId !== undefined) {
          this.botFns.onEvent(
            firstUpdatedFrameId < currentFrameId ? 'updated-cohort-history' : 'updated-mining-state',
            currentFrameId,
          );
        }
      }
    })();

    void syncPromise.catch(error => {
      if (this.isDisposed) return;
      this.botFns.setDbHistoryError(String(error));
      console.warn('BotSyncer background sync error:', error);
    });
  }

  public async syncDbFrame(frameId: number, botState = this.botState): Promise<void> {
    const client = await this.getClient();
    const earningsFile = await client.fetch('/earnings', frameId);
    if (!earningsFile.lastBlockNumber) {
      throw new MiningHistoryNotReadyError(`Earnings for frame ${frameId} have not been recovered yet.`);
    }
    const frameProgress = this.calculateProgress(earningsFile.frameRewardTicksRemaining);
    const firstActiveCohortId = Math.max(this.config.oldestFrameIdToSync, frameId - NetworkConfig.framesPerCohort + 1);
    const cohortIdsInDb = await this.db.cohortsTable.fetchCohortIdsSince(
      firstActiveCohortId,
      frameId - firstActiveCohortId + 1,
    );
    const earningsByCohortActivationFrameId: Record<number, IFrameEarningsRollup> = {};
    const cohortIdsToSync: number[] = [];
    for (let id = firstActiveCohortId; id <= frameId; id++) {
      // The activation block's winner list is provisional along with its earnings.
      if (!cohortIdsInDb.includes(id) || (id === frameId && !this.db.framesTable.state.processedFrames[id])) {
        cohortIdsToSync.push(id);
      }
      earningsByCohortActivationFrameId[id] = {
        lastBlockMinedAt: '',
        blocksMinedTotal: 0,
        microgonFeesCollectedTotal: 0n,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
        micronotsMinedTotal: 0n,
      };
    }
    // Fetch remote inputs before opening the transaction.
    const bidsFile = await this.fetchBidsFileFromCache({ cohortActivationFrameId: frameId }, botState.currentFrameId);
    const cohortsToSync = await Promise.all(
      cohortIdsToSync.map(id => this.fetchCohort(id, id === frameId ? bidsFile : undefined)),
    );
    const framePrice = earningsFile.microgonToArgonot.at(-1) ?? 0n;
    for (const cohort of cohortsToSync) cohort.argonotPriceAtBid ||= framePrice;

    for (const earnings of Object.values(earningsFile.earningsByBlock)) {
      const cohort = earningsByCohortActivationFrameId[earnings.authorCohortActivationFrameId];
      if (cohort && (earnings.microgonsMined || earnings.micronotsMined)) {
        cohort.blocksMinedTotal += 1;
        cohort.lastBlockMinedAt = earnings.blockMinedAt;
        cohort.microgonFeesCollectedTotal += earnings.microgonFeesCollected;
        cohort.microgonsMinedTotal += earnings.microgonsMined;
        cohort.micronotsMinedTotal += earnings.micronotsMined;
      }
      const mints = earnings.microgonsMintedByCohort ?? {
        [earnings.authorCohortActivationFrameId]: earnings.microgonsMinted,
      };
      for (const [cohortId, microgons] of Object.entries(mints)) {
        const recipient = earningsByCohortActivationFrameId[Number(cohortId)];
        if (!recipient) continue;
        recipient.microgonsMintedTotal += microgons;
      }
    }

    let blocksMinedTotal = 0;
    let micronotsMinedTotal = 0n;
    let microgonsMinedTotal = 0n;
    let microgonsMintedTotal = 0n;
    let microgonFeesCollectedTotal = 0n;
    for (const earnings of Object.values(earningsByCohortActivationFrameId)) {
      blocksMinedTotal += earnings.blocksMinedTotal;
      micronotsMinedTotal += earnings.micronotsMinedTotal;
      microgonsMinedTotal += earnings.microgonsMinedTotal;
      microgonsMintedTotal += earnings.microgonsMintedTotal;
      microgonFeesCollectedTotal += earnings.microgonFeesCollectedTotal;
    }

    if (this.isDisposed) throw new Error('BotSyncer disposed');
    await this.db.transaction(async db => {
      const [savedFrame] = await db.select<{ lastBlockNumber: number }[]>(
        'SELECT lastBlockNumber FROM Frames WHERE id = ?',
        [frameId],
      );
      if (savedFrame && savedFrame.lastBlockNumber > earningsFile.lastBlockNumber) {
        // A shorter canonical tip legitimately removes provisional earnings already imported here.
        const chainRewound = botState.lastProcessedBlockNumber < savedFrame.lastBlockNumber;
        if (!chainRewound) throw new Error(`Earnings for frame ${frameId} are older than the saved data.`);
      }
      await db.framesTable.insertOrUpdate({
        ...earningsFile,
        id: frameId,
        firstTick: earningsFile.frameFirstTick,
        rewardTicksRemaining: earningsFile.frameRewardTicksRemaining,
        progress: frameProgress,
      });
      for (const cohort of cohortsToSync) await db.cohortsTable.insertOrUpdate(cohort);
      for (const [cohortId, earnings] of Object.entries(earningsByCohortActivationFrameId)) {
        await db.cohortFramesTable.insertOrUpdate({
          frameId,
          cohortActivationFrameId: Number(cohortId),
          ...earnings,
        });
      }
      await db.cohortsTable.updateProgress();
      const { seatCountActive, seatCostTotalFramed } = await db.cohortsTable.fetchActiveSeatData(
        frameId,
        frameProgress,
      );
      await db.framesTable.update({
        id: frameId,
        allMinersCount: bidsFile.allMinersCount,
        seatCountActive,
        seatCostTotalFramed,
        blocksMinedTotal,
        micronotsMinedTotal,
        microgonsMinedTotal,
        microgonsMintedTotal,
        microgonFeesCollectedTotal,
        // A closed frame can still change on a fork until its last block is finalized.
        isProcessed:
          frameProgress === 100 && earningsFile.lastBlockNumber <= botState.lastFinalizedProcessedBlockNumber,
      });
      await db.cohortsTable.setArgonotPriceAtCompletion(
        frameId - NetworkConfig.framesPerCohort,
        earningsFile.microgonToArgonot[0] ?? 0n,
      );
    });
  }

  private async fetchCohort(
    cohortActivationFrameId: number,
    bidsFile?: IBidsFile,
  ): Promise<Parameters<CohortsTable['insertOrUpdate']>[0]> {
    bidsFile ??= await this.fetchBidsFileFromCache({ cohortActivationFrameId });
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
      const capturedArgonotPriceAtBid = bidsFile.argonotPriceAtBid;
      let argonotPriceAtBid = capturedArgonotPriceAtBid;
      if (!argonotPriceAtBid) {
        const priceFrames = await this.db.framesTable.fetchArgonotPricesNearFrame(cohortActivationFrameId);
        let firstPriceAfterBid = 0n;

        for (const frame of priceFrames) {
          const price = frame.microgonToArgonot.at(-1) ?? 0n;
          if (!price) continue;

          if (frame.id < cohortActivationFrameId) {
            argonotPriceAtBid = price;
          } else if (!firstPriceAfterBid) {
            firstPriceAfterBid = price;
          }
        }
        argonotPriceAtBid ||= firstPriceAfterBid;
      }

      return {
        id: cohortActivationFrameId,
        transactionFeesTotal,
        micronotsStakedPerSeat: bidsFile.micronotsStakedPerSeat,
        microgonsBidPerSeat,
        seatCountWon: bidsFile.seatCountWon,
        microgonsToBeMinedPerSeat,
        micronotsToBeMinedPerSeat,
        argonotPriceAtBid,
      };
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
    const cached = this.bidsFileCacheByActivationFrameId[cohortActivationFrameId];
    let timeoutId = cached?.[0];
    let bidsFile: IBidsFile | undefined = cached?.[1];

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Keep finalized snapshots cached; an activation fork can replace a pending cohort.
    if (!this.db.framesTable.state.processedFrames[cohortActivationFrameId]) bidsFile = undefined;
    if (!bidsFile) {
      const client = await this.getClient();
      bidsFile = await client.fetch('/bids', cohortActivationFrameId - 1);
    }

    if (!bidsFile.lastBlockNumber || bidsFile.biddingFrameRewardTicksRemaining > 0) {
      delete this.bidsFileCacheByActivationFrameId[cohortActivationFrameId];
      throw new MiningHistoryNotReadyError(`Bids for cohort ${cohortActivationFrameId} have not been recovered yet.`);
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

  private calculateDbSyncProgress(botState: IBotState | IBotStateStarting): number {
    const { oldestFrameIdToSync, currentFrameId, finalizedFrameId } = botState as IBotState;
    if (oldestFrameIdToSync === 0 && !NetworkConfig.canFrameBeZero()) {
      return 0.0;
    }

    // Exclude the newest closed finalized frame while its files are still being published.
    // Ordinary frame rollover and finality lag are not historical recovery.
    const recentFrameId = Math.min(currentFrameId, finalizedFrameId) - 1;
    const completedFramesExpected = recentFrameId - oldestFrameIdToSync;
    if (completedFramesExpected <= 0) return 100;
    const recentFrameIsComplete =
      this.historicalRecovery?.processedFrames.has(recentFrameId) &&
      this.db.cohortsTable.state.storedCohorts[recentFrameId];
    const completedFrames = (this.historicalRecovery?.completedFrameCount ?? 0) - (recentFrameIsComplete ? 1 : 0);
    return Math.min((completedFrames / completedFramesExpected) * 100, 100);
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

class MiningHistoryNotReadyError extends Error {}
