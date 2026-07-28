import {
  type IBidsFile,
  type IBotState,
  type IMiningBid,
  type IMiningCohortFrame,
  type IMiningSummary,
  type Mining,
  type MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import type { MiningDb } from './MiningDb.ts';
import type { Storage } from './Storage.ts';

type MiningSummaryState = Pick<
  IBotState,
  'currentFrameId' | 'finalizedFrameId' | 'oldestFrameIdToSync' | 'argonBlockNumbers' | 'earningsLastModifiedAt'
>;

export class MiningSummaryService {
  private refreshPromise: Promise<boolean> = Promise.resolve(false);
  private hasCompletedProjection = false;
  private lastRefreshedEarningsAt = 0;
  private lastRefreshedFrameId = -1;

  constructor(
    private readonly db: MiningDb,
    private readonly storage: Storage,
    private readonly mining: Mining,
    private readonly miningFrames: MiningFrames,
  ) {}

  public async getSummary(state: MiningSummaryState): Promise<IMiningSummary> {
    const isComplete = await this.refresh(state);
    if (!isComplete && !this.hasCompletedProjection) {
      throw new Error('Mining summary is still syncing.');
    }
    const currentBidsFile = await this.storage.bidsFile(state.currentFrameId, state.currentFrameId + 1).get();
    const { cohorts, global } = this.db.cohorts.fetchSummary();

    return {
      observedAt: new Date(),
      sourceBlockNumber: state.argonBlockNumbers.localNode,
      latestFrameId: state.currentFrameId,
      cohorts,
      frames: this.db.frames.fetchLast(),
      currentBids: this.toMiningBids(currentBidsFile),
      global,
    };
  }

  public async refresh(state: MiningSummaryState): Promise<boolean> {
    const refresh = this.refreshPromise
      .catch(() => false)
      .then(async () => {
        const earningsLastModifiedAt = state.earningsLastModifiedAt.getTime();
        if (
          this.hasCompletedProjection &&
          earningsLastModifiedAt === this.lastRefreshedEarningsAt &&
          state.currentFrameId === this.lastRefreshedFrameId
        ) {
          return true;
        }

        const isComplete = await this.refreshFrames(state);
        this.hasCompletedProjection ||= isComplete;
        if (isComplete) {
          this.lastRefreshedEarningsAt = earningsLastModifiedAt;
          this.lastRefreshedFrameId = state.currentFrameId;
        }
        return isComplete;
      });
    this.refreshPromise = refresh;
    return await refresh;
  }

  private async refreshFrames(state: MiningSummaryState): Promise<boolean> {
    // Frame zero has no preceding bidding frame, so BlockSync cannot create the bids journal needed to project it.
    const oldestFrameId = Math.max(1, state.oldestFrameIdToSync);
    if (state.currentFrameId < oldestFrameId) return true;

    const lastProcessedFrameId = this.db.frames.fetchLastProcessedFrame();
    const firstFrameId =
      lastProcessedFrameId !== undefined
        ? Math.max(oldestFrameId, Math.min(lastProcessedFrameId + 1, state.finalizedFrameId + 1))
        : oldestFrameId;
    const cohortIds = new Set(this.db.cohorts.fetchIds());
    for (let cohortId = firstFrameId; cohortId <= state.currentFrameId; cohortId++) {
      cohortIds.delete(cohortId);
    }

    let isComplete = true;
    for (let frameId = firstFrameId; frameId <= state.currentFrameId; frameId++) {
      const didSync = await this.syncFrame(frameId, state, cohortIds);
      if (!didSync) {
        isComplete = false;
        break;
      }
    }

    this.db.cohorts.updateProgress();
    for (const cohortId of this.db.cohorts.fetchCohortIdsMissingBidPrice()) {
      this.db.cohorts.setArgonotPriceAtBid(cohortId, this.findArgonotPrice(cohortId));
    }
    return isComplete;
  }

  private async syncFrame(frameId: number, state: MiningSummaryState, cohortIds: Set<number>): Promise<boolean> {
    const earningsStore = this.storage.earningsFile(frameId);
    const frameBidsStore = this.storage.bidsFile(frameId - 1, frameId);
    const [hasEarnings, hasFrameBids] = await Promise.all([earningsStore.exists(), frameBidsStore.exists()]);
    if (!hasEarnings || !hasFrameBids) return false;

    const [earningsFile, frameBids] = await Promise.all([earningsStore.get(), frameBidsStore.get()]);
    const progress = this.calculateProgress(earningsFile.frameRewardTicksRemaining);
    this.db.frames.insertOrUpdate({
      id: frameId,
      firstTick: earningsFile.frameFirstTick,
      rewardTicksRemaining: earningsFile.frameRewardTicksRemaining,
      firstBlockNumber: earningsFile.firstBlockNumber,
      lastBlockNumber: earningsFile.lastBlockNumber,
      microgonToUsd: earningsFile.microgonToUsd,
      microgonToBtc: earningsFile.microgonToBtc,
      microgonToArgonot: earningsFile.microgonToArgonot,
      accruedMicrogonProfits: earningsFile.accruedMicrogonProfits,
      accruedMicronotProfits: earningsFile.accruedMicronotProfits,
      progress,
    });

    const firstCohortId = Math.max(frameId - NetworkConfig.framesPerCohort, 1, state.oldestFrameIdToSync);
    const cohortEarnings = new Map<number, IMiningCohortFrame>();
    for (let cohortId = firstCohortId; cohortId <= frameId; cohortId++) {
      if (!cohortIds.has(cohortId)) {
        const wasStored = await this.syncCohort(cohortId, cohortId === frameId ? frameBids : undefined);
        if (!wasStored) return false;
        cohortIds.add(cohortId);
      }
      cohortEarnings.set(cohortId, {
        frameId,
        cohortId,
        blocksMinedTotal: 0,
        micronotsMinedTotal: 0n,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
        microgonFeesCollectedTotal: 0n,
      });
    }

    for (const earnings of Object.values(earningsFile.earningsByBlock)) {
      const rollup = cohortEarnings.get(earnings.authorCohortActivationFrameId);
      if (!rollup) continue;

      rollup.blocksMinedTotal += 1;
      rollup.microgonFeesCollectedTotal += earnings.microgonFeesCollected;
      rollup.microgonsMinedTotal += earnings.microgonsMined;
      rollup.microgonsMintedTotal += earnings.microgonsMinted;
      rollup.micronotsMinedTotal += earnings.micronotsMined;
    }

    const cohortFrameRecords = [...cohortEarnings.values()];
    this.db.cohortFrames.replaceForFrame(frameId, cohortFrameRecords);

    const { seatCountActive, seatCostTotalFramed } = this.db.cohorts.fetchActiveSeatData(frameId, progress);
    const totals = cohortFrameRecords.reduce(
      (result, cohort) => {
        result.blocksMinedTotal += cohort.blocksMinedTotal;
        result.micronotsMinedTotal += cohort.micronotsMinedTotal;
        result.microgonsMinedTotal += cohort.microgonsMinedTotal;
        result.microgonsMintedTotal += cohort.microgonsMintedTotal;
        result.microgonFeesCollectedTotal += cohort.microgonFeesCollectedTotal;
        return result;
      },
      {
        blocksMinedTotal: 0,
        micronotsMinedTotal: 0n,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
        microgonFeesCollectedTotal: 0n,
      },
    );

    this.db.frames.updateRollup({
      id: frameId,
      allMinersCount: frameBids.allMinersCount,
      seatCountActive,
      seatCostTotalFramed,
      ...totals,
      isProcessed: progress === 100 || frameId < state.currentFrameId - 1,
    });
    this.db.cohorts.setClosingArgonotPrice(
      frameId - NetworkConfig.framesPerCohort,
      earningsFile.microgonToArgonot[0] ?? 0n,
    );
    return true;
  }

  private async syncCohort(cohortId: number, existingBidsFile?: IBidsFile): Promise<boolean> {
    const bidsStore = this.storage.bidsFile(cohortId - 1, cohortId);
    if (!existingBidsFile && !(await bidsStore.exists())) return false;

    const bidsFile = existingBidsFile ?? (await bidsStore.get());
    if (this.calculateProgress(bidsFile.biddingFrameRewardTicksRemaining) < 100) return false;

    await this.miningFrames.waitForFrameId(cohortId);
    const cohortStartingTick = this.miningFrames.getTickStart(cohortId);
    const ticksPerCohort = BigInt(NetworkConfig.ticksPerCohort);
    const allMinersCount = BigInt(bidsFile.allMinersCount) || 1n;
    const microgonsToBeMinedPerSeat = (bidsFile.microgonsToBeMinedPerBlock * ticksPerCohort) / allMinersCount;
    const micronotsToBeMinedPerSeat =
      (await this.mining.minimumMicronotsMinedDuringTickRange(
        cohortStartingTick,
        cohortStartingTick + Number(ticksPerCohort),
      )) / allMinersCount;
    const transactionFeesTotal = Object.values(bidsFile.transactionFeesByBlock).reduce((total, fee) => total + fee, 0n);
    const microgonsBidPerSeat =
      bidsFile.seatCountWon > 0 ? bidsFile.microgonsBidTotal / BigInt(bidsFile.seatCountWon) : 0n;

    this.db.cohorts.insertOrUpdate({
      id: cohortId,
      transactionFeesTotal,
      micronotsStakedPerSeat: bidsFile.micronotsStakedPerSeat,
      microgonsBidPerSeat,
      seatCountWon: bidsFile.seatCountWon,
      microgonsToBeMinedPerSeat,
      micronotsToBeMinedPerSeat,
      argonotPriceAtBid: bidsFile.argonotPriceAtBid || this.findArgonotPrice(cohortId),
    });
    return true;
  }

  private findArgonotPrice(cohortId: number): bigint {
    const priceFrames = this.db.frames.fetchArgonotPricesAroundFrame(cohortId);
    let lastPriceBeforeBid = 0n;
    let firstPriceAfterBid = 0n;

    for (const frame of priceFrames) {
      const price = frame.microgonToArgonot.at(-1) ?? 0n;
      if (!price) continue;

      if (frame.id < cohortId) {
        lastPriceBeforeBid = price;
      } else if (!firstPriceAfterBid) {
        firstPriceAfterBid = price;
      }
    }
    return lastPriceBeforeBid || firstPriceAfterBid;
  }

  private toMiningBids(bidsFile: IBidsFile): IMiningBid[] {
    return bidsFile.winningBids.map((bid, bidPosition) => ({
      frameId: bidsFile.cohortBiddingFrameId,
      confirmedAtBlockNumber: bidsFile.lastBlockNumber,
      address: bid.address,
      subAccountIndex: bid.subAccountIndex,
      microgonsPerSeat: bid.microgonsPerSeat ?? 0n,
      micronotsStakedPerSeat: bidsFile.micronotsStakedPerSeat,
      bidPosition: bid.bidPosition ?? bidPosition,
      lastBidAtTick: bid.lastBidAtTick,
    }));
  }

  private calculateProgress(rewardTicksRemaining: number): number {
    if (rewardTicksRemaining <= 0) return 100;
    return Math.min(
      ((NetworkConfig.rewardTicksPerFrame - rewardTicksRemaining) / NetworkConfig.rewardTicksPerFrame) * 100,
      100,
    );
  }
}
