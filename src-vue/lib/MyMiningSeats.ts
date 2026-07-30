import BigNumber from 'bignumber.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  calculateMiningRewardProjection,
  createDeferred,
  Currency as CurrencyBase,
  IDeferred,
  type IMiningBid,
  type IMiningCohort,
  type IMiningCohortFinancial,
  type IMiningSummary,
  type IWinningBid,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { IDashboardFrameStats, IDashboardGlobalStats } from '../interfaces/IMiningSeatStats';
import { Db } from './Db';
import { Config } from './Config';
import { botEmitter } from './Bot';
import { ensureOnlyOneInstance, getPercent, logStartupTiming, percentOf } from './Utils';
import { IServerStateRecord } from '../interfaces/db/IServerStateRecord.ts';
import { Currency } from './Currency.ts';
import { SyncStateKeys } from './db/SyncStateTable.ts';
import { createMiningCohortFinancialPosition } from './financials/MyMiningSeats.ts';
import { FinancialCacheTypes, MiningSummaryCacheScope } from './db/FinancialCacheTable.ts';

dayjs.extend(utc);

interface IMyMiningSeats {
  seatCount: number;
  microgonsBidTotal: bigint;
  micronotsStakedTotal: bigint;
  microgonsMinedTotal: bigint;
  micronotsMinedTotal: bigint;
  microgonsMintedTotal: bigint;
  microgonsToBeMined: bigint;
  microgonsToBeMinted: bigint;
  micronotsToBeMined: bigint;
  microgonValueRemaining: bigint;
}

interface IMyMiningBids {
  bidCount: number;
  microgonsBidTotal: bigint;
  micronotsStakedTotal: bigint;
}

export class MyMiningSeats {
  public latestFrameId: number;
  public activeFrames: number;
  public selectedFrameId!: number;

  public activeSeats: IMyMiningSeats;
  public pendingBids: IMyMiningBids;

  public allWinningBids: (IWinningBid & { micronotsStakedPerSeat: bigint })[];
  public currentFrameBids: IMiningBid[];
  public miningCohorts: IMiningCohortFinancial[];
  public financialRevision: number;

  public global: IDashboardGlobalStats;
  public frames: IDashboardFrameStats[];

  public serverState: IServerStateRecord;

  public isLoaded: boolean;
  public isLoadedPromise: Promise<void>;

  private isLoadedDeferred!: IDeferred<void>;
  private loadPromise?: Promise<void>;
  private serverStateRefreshPromise?: Promise<void>;
  private miningCohortsById = new Map<number, IMiningCohortFinancial>();
  private miningSummary?: IMiningSummary;

  public db!: Db;

  private config!: Config;
  private dbPromise: Promise<Db>;

  private dashboardSubscribers: number = 0;
  private dashboardHasUpdates: boolean = true;

  private activitySubscribers: number = 0;
  private activityHasUpdates: boolean = true;

  public readonly currency: Currency;
  public readonly miningFrames: MiningFrames;

  constructor(dbPromise: Promise<Db>, config: Config, currency: Currency, miningFrames: MiningFrames) {
    ensureOnlyOneInstance(this.constructor);

    this.isLoaded = false;

    this.allWinningBids = [];
    this.currentFrameBids = [];
    this.miningCohorts = [];
    this.financialRevision = 0;

    this.miningFrames = miningFrames;
    this.latestFrameId = miningFrames.currentFrameId;
    this.selectedFrameId = miningFrames.currentFrameId;
    this.activeFrames = 0;

    this.activeSeats = {
      seatCount: 0,
      microgonsBidTotal: 0n,
      micronotsStakedTotal: 0n,
      microgonsMinedTotal: 0n,
      micronotsMinedTotal: 0n,
      microgonsMintedTotal: 0n,
      microgonsToBeMined: 0n,
      microgonsToBeMinted: 0n,
      micronotsToBeMined: 0n,
      microgonValueRemaining: 0n,
    };

    this.pendingBids = {
      bidCount: 0,
      microgonsBidTotal: 0n,
      micronotsStakedTotal: 0n,
    };

    this.global = {
      seatsTotal: 0,
      framesCompleted: 0,
      framesRemaining: 0,
      framedCost: 0n,
      microgonsBidTotal: 0n,
      transactionFeesTotal: 0n,
      micronotsMinedTotal: 0n,
      microgonsMinedTotal: 0n,
      microgonsMintedTotal: 0n,
      microgonValueOfRewards: 0n,
    };

    this.frames = [];
    this.serverState = {
      argonBlocksLastUpdatedAt: null as any,
      argonLocalNodeBlockNumber: 0,
      argonMainNodeBlockNumber: 0,
      bitcoinBlocksLastUpdatedAt: null as any,
      bitcoinLocalNodeBlockNumber: 0,
      bitcoinMainNodeBlockNumber: 0,
      botActivityLastUpdatedAt: null as any,
      botActivityLastBlockNumber: 0,
      latestFrameId: 0,
    };

    this.dbPromise = dbPromise;
    this.config = config;
    this.currency = currency;

    this.isLoadedDeferred = createDeferred<void>(false);
    this.isLoadedPromise = this.isLoadedDeferred.promise;
    void this.isLoadedPromise.catch(() => undefined);
  }

  public get prevFrameId(): number | null {
    const newFrameId = this.selectedFrameId - 1;
    if (newFrameId < 1) return null;
    return newFrameId;
  }

  public get nextFrameId(): number | null {
    const newFrameId = this.selectedFrameId + 1;
    if (newFrameId > this.latestFrameId) return null;
    return newFrameId;
  }

  public selectFrameId(frameId: number, skipDashboardUpdate: boolean = false) {
    this.selectedFrameId = frameId;
    if (skipDashboardUpdate) return;

    this.updateDashboard().catch(console.error);
  }

  public getCohortsByIds(ids: readonly number[]): IMiningCohort[] {
    return ids.flatMap(id => {
      const cohort = this.miningCohortsById.get(id);
      return cohort ? [cohort] : [];
    });
  }

  public async load() {
    if (this.isLoaded) return this.isLoadedPromise;
    if (this.loadPromise) return await this.loadPromise;
    if (this.isLoadedDeferred.isRejected) {
      this.isLoadedDeferred = createDeferred<void>(false);
      this.isLoadedPromise = this.isLoadedDeferred.promise;
      void this.isLoadedPromise.catch(() => undefined);
    }

    this.loadPromise = (async () => {
      const loadStartedAt = performance.now();
      let stage = 'config.isLoadedPromise';

      try {
        await this.config.isLoadedPromise;
        const configReadyAt = performance.now();

        stage = 'dbPromise';
        this.db = await this.dbPromise;
        const dbReadyAt = performance.now();

        stage = 'currency.load';
        await this.currency.load();
        const currencyReadyAt = performance.now();

        const initialFrameId = this.latestFrameId;
        stage = 'miningFrames.load';
        await this.miningFrames.load();
        const miningFramesReadyAt = performance.now();

        this.latestFrameId = this.miningFrames.currentFrameId;
        if (this.selectedFrameId === initialFrameId) {
          this.selectedFrameId = this.latestFrameId;
        }

        stage = 'mining-summary-cache';
        try {
          this.miningSummary = await this.db.financialCacheTable.get(
            FinancialCacheTypes.MiningSummary,
            MiningSummaryCacheScope,
          );
        } catch (error) {
          this.miningSummary = undefined;
          console.warn('[MyMiningSeats] Unable to restore cached mining summary', error);
        }

        stage = 'post-load-updates';
        if (this.miningSummary) {
          this.applyMiningSummary(this.miningSummary);
        }
        await this.updateServerState();
        this.financialRevision += 1;

        botEmitter.on('updated-mining-summary', async summary => {
          if (this.serverStateRefreshPromise) await this.serverStateRefreshPromise;
          this.applyMiningSummary(summary);
          this.financialRevision += 1;
          if (this.isSubscribedToDashboard) {
            await this.updateDashboard();
            this.dashboardHasUpdates = false;
          } else {
            this.dashboardHasUpdates = true;
          }
        });

        botEmitter.on('updated-server-state', async () => {
          await this.updateServerState();
          this.activityHasUpdates = false;
        });

        this.isLoaded = true;
        this.isLoadedDeferred.resolve();
        logStartupTiming({
          milestone: 'mining-seats-ready',
          startedAt: loadStartedAt,
          details: {
            configMs: Math.round(configReadyAt - loadStartedAt),
            dbMs: Math.round(dbReadyAt - configReadyAt),
            currencyMs: Math.round(currencyReadyAt - dbReadyAt),
            miningFramesMs: Math.round(miningFramesReadyAt - currencyReadyAt),
            positionsMs: Math.round(performance.now() - miningFramesReadyAt),
          },
        });
      } catch (error) {
        this.isLoadedDeferred.reject(error as Error);
        console.error(
          `[MyMiningSeats] Load failed at ${stage} after ${Math.round(performance.now() - loadStartedAt)}ms`,
          error,
        );
        throw error;
      } finally {
        this.loadPromise = undefined;
      }
    })();

    return await this.loadPromise;
  }

  public async subscribeToDashboard(): Promise<void> {
    this.dashboardSubscribers++;
    if (this.dashboardSubscribers > 1) return;

    await this.isLoadedDeferred.promise;

    if (this.dashboardHasUpdates) {
      this.dashboardHasUpdates = false;
      await this.updateDashboard();
    }
  }

  public async subscribeToActivity(): Promise<void> {
    this.activitySubscribers++;
    if (this.activitySubscribers > 1) return;

    await this.isLoadedDeferred.promise;

    if (this.activityHasUpdates) {
      this.activityHasUpdates = false;
      await this.updateServerState();
    }
  }

  public async unsubscribeFromDashboard(): Promise<void> {
    this.dashboardSubscribers--;
    if (this.dashboardSubscribers < 0) this.dashboardSubscribers = 0;
  }

  public async unsubscribeFromActivity(): Promise<void> {
    this.activitySubscribers--;
    if (this.activitySubscribers < 0) this.activitySubscribers = 0;
  }

  public async refresh(): Promise<void> {
    await this.isLoadedDeferred.promise;

    if (this.miningSummary) {
      this.applyMiningSummary(this.miningSummary);
    }
    await this.updateServerState();
    this.financialRevision += 1;
    await this.updateDashboard();

    this.dashboardHasUpdates = false;
    this.activityHasUpdates = false;
  }

  private get isSubscribedToDashboard(): boolean {
    return this.dashboardSubscribers > 0;
  }

  private async updateDashboard(): Promise<void> {
    if (!this.miningSummary) return;

    const globalStats = this.miningSummary.global;
    const frames = this.buildDashboardFrameStats(this.miningSummary.frames);
    this.global = {
      ...globalStats,
      microgonValueOfRewards: Currency.microgonValueOfMiningRewards({
        microgonsMined: globalStats.microgonsMinedTotal,
        microgonsMinted: globalStats.microgonsMintedTotal,
        micronotsMined: globalStats.micronotsMinedTotal,
        argonotPrice: this.currency.microgonsPer.ARGNOT,
      }),
    };
    this.frames = frames;
  }

  private async updateServerState(): Promise<void> {
    this.serverStateRefreshPromise ??= this.db.syncStateTable
      .get(SyncStateKeys.Server)
      .then(state => {
        if (state) this.serverState = state;
      })
      .finally(() => {
        this.serverStateRefreshPromise = undefined;
      });
    await this.serverStateRefreshPromise;
  }

  private applyMiningBids(frameBids: IMiningBid[]): void {
    this.currentFrameBids = frameBids;
    this.allWinningBids = frameBids.map(x => {
      return {
        address: x.address,
        subAccountIndex: x.subAccountIndex,
        lastBidAtTick: x.lastBidAtTick,
        bidPosition: x.bidPosition,
        microgonsPerSeat: x.microgonsPerSeat,
        micronotsStakedPerSeat: x.micronotsStakedPerSeat,
      };
    });

    const myWinningBids = this.allWinningBids.filter(bid => typeof bid.subAccountIndex === 'number');
    this.pendingBids.bidCount = myWinningBids.length;
    this.pendingBids.microgonsBidTotal = myWinningBids.reduce((acc, bid) => acc + (bid.microgonsPerSeat || 0n), 0n);
    this.pendingBids.micronotsStakedTotal = myWinningBids.reduce(
      (acc, bid) => acc + (bid.micronotsStakedPerSeat ?? 0n),
      0n,
    );
  }

  private applyMiningSummary(summary: IMiningSummary): void {
    const isOnLatestFrame = this.selectedFrameId === this.latestFrameId;
    this.miningSummary = summary;
    this.latestFrameId = summary.latestFrameId;
    if (isOnLatestFrame) this.selectFrameId(summary.latestFrameId, true);

    this.miningCohortsById.clear();
    for (const cohort of summary.cohorts) this.miningCohortsById.set(cohort.id, cohort);
    this.miningCohorts = summary.cohorts.filter(cohort => cohort.seatCountWon > 0);
    this.activeSeats = this.calculateActiveMiningSeats(this.miningCohorts);
    this.applyMiningBids(summary.currentBids);
  }

  private calculateActiveMiningSeats(cohorts: readonly IMiningCohortFinancial[]): IMyMiningSeats {
    let seatCount = 0;
    let microgonsBidTotal = 0n;
    let micronotsStakedTotal = 0n;
    let microgonsMinedTotal = 0n;
    let micronotsMinedTotal = 0n;
    let microgonsMintedTotal = 0n;
    let microgonsToBeMined = 0n;
    let microgonsToBeMinted = 0n;
    let micronotsToBeMined = 0n;
    let microgonValueRemaining = 0n;

    for (const cohort of cohorts) {
      if (cohort.id <= this.latestFrameId - NetworkConfig.framesPerCohort) continue;

      const position = createMiningCohortFinancialPosition({
        cohort,
        latestFrameId: this.latestFrameId,
        liveArgonotRateMicrogons: this.currency.microgonsPer.ARGNOT,
        frameDates: new Map([
          [cohort.id, this.miningFrames.getFrameDate(cohort.id)],
          [
            cohort.id + NetworkConfig.framesPerCohort,
            this.miningFrames.getFrameDate(cohort.id + NetworkConfig.framesPerCohort),
          ],
        ]),
      });

      microgonsMinedTotal += cohort.microgonsMinedTotal;
      micronotsMinedTotal += cohort.micronotsMinedTotal;
      microgonsMintedTotal += cohort.microgonsMintedTotal;

      const remainingRewards = this.calculateExpectedBlockRewards(
        cohort,
        100 - cohort.progress,
        this.currency.microgonsPer.ARGNOT,
      );
      seatCount += cohort.seatCountWon;
      const seatCost = cohort.microgonsBidPerSeat * BigInt(cohort.seatCountWon);
      microgonsBidTotal += seatCost;
      micronotsStakedTotal += cohort.micronotsStakedPerSeat * BigInt(cohort.seatCountWon);
      microgonsToBeMined += remainingRewards.microgonsToBeMined;
      microgonsToBeMinted += remainingRewards.microgonsToBeMinted;
      micronotsToBeMined += remainingRewards.micronotsToBeMined;

      microgonValueRemaining += position.remainingSeatValue;
    }

    return {
      seatCount,
      microgonsBidTotal,
      micronotsStakedTotal,
      microgonsMinedTotal,
      micronotsMinedTotal,
      microgonsMintedTotal,
      microgonsToBeMined,
      microgonsToBeMinted,
      micronotsToBeMined,
      microgonValueRemaining,
    };
  }

  private calculateExpectedBlockRewards(
    cohort: IMiningCohort,
    percentage: number,
    argonotPrice: bigint,
  ): {
    microgonsToBeMined: bigint;
    microgonsToBeMinted: bigint;
    micronotsToBeMined: bigint;
  } {
    const seats = BigInt(cohort.seatCountWon);
    const projection = calculateMiningRewardProjection({
      bidPrincipal: cohort.microgonsBidPerSeat * seats,
      microgonsPerTerm: cohort.microgonsToBeMinedPerSeat * seats,
      micronotsPerTerm: cohort.micronotsToBeMinedPerSeat * seats,
      argonotPrice,
      percentOfTerm: percentage,
    });

    return {
      microgonsToBeMined: projection.microgonsMined,
      microgonsToBeMinted: projection.microgonsMinted,
      micronotsToBeMined: projection.micronotsMined,
    };
  }

  private buildDashboardFrameStats(summaryFrames: IMiningSummary['frames']): IDashboardFrameStats[] {
    let previousArgonotPrice = this.currency.microgonsPer.ARGNOT;
    const lastYear = summaryFrames.map(frame => {
      const miningFrame = this.miningFrames.framesById[frame.id];
      const dateStart = miningFrame?.dateStart ?? MiningFrames.getTickDate(frame.firstTick);
      const argonotPrice = frame.microgonToArgonot.at(-1) || previousArgonotPrice;
      if (argonotPrice > 0n) previousArgonotPrice = argonotPrice;
      const microgonValueOfRewards = Currency.microgonValueOfMiningRewards({
        microgonsMined: frame.microgonsMinedTotal,
        microgonsMinted: frame.microgonsMintedTotal,
        micronotsMined: frame.micronotsMinedTotal,
        argonotPrice,
      });
      const profit = microgonValueOfRewards - frame.seatCostTotalFramed;

      return {
        id: frame.id,
        date: dayjs.utc(dateStart).format('YYYY-MM-DD'),
        firstTick: miningFrame?.frameStartTick ?? frame.firstTick,
        allMinersCount: frame.allMinersCount,
        seatCountActive: frame.seatCountActive,
        seatCostTotalFramed: frame.seatCostTotalFramed,
        blocksMinedTotal: frame.blocksMinedTotal,
        microgonToUsd: frame.microgonToUsd,
        microgonToArgonot: frame.microgonToArgonot,
        microgonsMinedTotal: frame.microgonsMinedTotal,
        microgonsMintedTotal: frame.microgonsMintedTotal,
        micronotsMinedTotal: frame.micronotsMinedTotal,
        microgonFeesCollectedTotal: frame.microgonFeesCollectedTotal,
        accruedMicrogonProfits: frame.accruedMicrogonProfits,
        microgonValueOfRewards,
        progress: frame.progress,
        profit: Number(profit),
        profitPct: getPercent(profit, frame.seatCostTotalFramed),
        score: 0,
        expected: {
          blocksMinedTotal: 0,
          micronotsMinedTotal: 0n,
          microgonsMinedTotal: 0n,
          microgonsMintedTotal: 0n,
          microgonValueOfRewards: 0n,
        },
      };
    });

    while (lastYear.length < 365) {
      const earliestRecord = lastYear[0];
      if (!earliestRecord) break;
      const previousDay = dayjs.utc(earliestRecord.date).subtract(1, 'day');
      if (previousDay.isBefore(dayjs.utc('2025-01-01'))) break;

      lastYear.unshift({
        id: earliestRecord.id - 1,
        date: previousDay.format('YYYY-MM-DD'),
        firstTick: earliestRecord.firstTick - NetworkConfig.rewardTicksPerFrame,
        allMinersCount: 0,
        seatCountActive: 0,
        seatCostTotalFramed: 0n,
        microgonToUsd: [0n],
        microgonToArgonot: [0n],
        blocksMinedTotal: 0,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
        micronotsMinedTotal: 0n,
        microgonFeesCollectedTotal: 0n,
        microgonValueOfRewards: 0n,
        progress: 0,
        profit: 0,
        profitPct: 0,
        accruedMicrogonProfits: 0n,
        score: 0,
        expected: {
          blocksMinedTotal: 0,
          micronotsMinedTotal: 0n,
          microgonsMinedTotal: 0n,
          microgonsMintedTotal: 0n,
          microgonValueOfRewards: 0n,
        },
      });
    }

    const earliestFrameId = lastYear[0]?.id ?? 0;
    const activeCohorts = this.miningCohorts.filter(
      cohort => cohort.id > earliestFrameId - NetworkConfig.framesPerCohort,
    );
    const cohortsById: { [id: number]: IMiningCohort } = {};
    for (const cohort of activeCohorts) {
      cohortsById[cohort.id] = cohort;
    }
    const framesById = new Map<number, IDashboardFrameStats>();

    this.activeFrames = 0;
    previousArgonotPrice = this.currency.microgonsPer.ARGNOT;
    for (const frame of lastYear) {
      const cohortAtFrame = cohortsById[frame.id];
      // count an active frame if we bid but didn't win any seats
      if (cohortAtFrame?.transactionFeesTotal > 0n || frame.seatCountActive > 0) {
        this.activeFrames++;
      }
      frame.expected = {
        blocksMinedTotal: 0,
        micronotsMinedTotal: 0n,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
        microgonValueOfRewards: 0n,
      };
      const frameArgonotPrice = frame.microgonToArgonot.at(-1) || previousArgonotPrice;
      for (let id = frame.id; id > frame.id - NetworkConfig.framesPerCohort; id--) {
        const cohort = cohortsById[id];
        if (!cohort) continue;
        const expectedCohortReturns = this.calculateExpectedBlockRewards(
          cohort,
          // Get one frame's share of the cohort rewards, times the frame progress.
          BigNumber(frame.progress).dividedBy(NetworkConfig.framesPerCohort).toNumber(),
          frameArgonotPrice,
        );
        const percentOfMiners = getPercent(cohort.seatCountWon, frame.allMinersCount);
        const elapsedTicks = percentOf(NetworkConfig.rewardTicksPerFrame, frame.progress);
        frame.expected.blocksMinedTotal += Number(percentOf(elapsedTicks, percentOfMiners));

        const { microgonsToBeMined, microgonsToBeMinted, micronotsToBeMined } = expectedCohortReturns;
        frame.expected.micronotsMinedTotal += micronotsToBeMined;
        frame.expected.microgonsMinedTotal += microgonsToBeMined;
        frame.expected.microgonsMintedTotal += microgonsToBeMinted;
        if (frameArgonotPrice) {
          frame.expected.microgonValueOfRewards += Currency.microgonValueOfMiningRewards({
            microgonsMined: microgonsToBeMined,
            microgonsMinted: microgonsToBeMinted,
            micronotsMined: micronotsToBeMined,
            argonotPrice: frameArgonotPrice,
          });
        }
      }

      if (frameArgonotPrice > 0n) previousArgonotPrice = frameArgonotPrice;
      framesById.set(frame.id, frame);
    }

    const maxProfitPct = Math.min(Math.max(...lastYear.map(x => x.profitPct)), 1_000);
    return [...framesById.values()].map(x => {
      let score = Math.min(x.profitPct, 1_000);
      if (score > 0) {
        score = (200 * score) / maxProfitPct;
      }
      return {
        ...x,
        score,
      };
    });
  }
}
