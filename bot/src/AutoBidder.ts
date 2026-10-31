import {
  type Accountset,
  CohortBidder,
  RangeCohortBidder,
  type CohortBidderBase,
  type IBidderParams,
  type IBiddingRules,
  MainchainClients,
  Mining,
  MiningFrames,
} from '@argonprotocol/apps-core';
import { type History } from './History.ts';
import BiddingCalculatorData from '@argonprotocol/apps-core/src/BiddingCalculatorData.ts';
import BiddingCalculator from '@argonprotocol/apps-core/src/BiddingCalculator.ts';

/** Manages auction bidders and applies bidding policy without interrupting pending reveals. */
export class AutoBidder {
  public readonly mining: Mining;

  public get currentBidder(): CohortBidderBase | undefined {
    return this.cohortBiddersByActivationFrameId.get(this.nextCohortActivationFrameId ?? 0);
  }
  public get previousBidder(): CohortBidderBase | undefined {
    if (!this.nextCohortActivationFrameId) return undefined;
    return this.cohortBiddersByActivationFrameId.get(this.nextCohortActivationFrameId - 1);
  }

  private cohortBiddersByActivationFrameId = new Map<number, CohortBidderBase>();
  private nextCohortActivationFrameId: number | null = null;
  private isStopped = false;
  private unsubscribe?: () => void;
  private unsubscribeFrame?: () => void;
  private biddingCalculator?: BiddingCalculator;
  private onUpdatedFn?: () => void;
  private localRpcUrl?: string;
  private hasRegisteredKeys = false;
  private lifecycleQueue = Promise.resolve();
  private readonly shutdownController = new AbortController();
  private pendingBiddingRetryTimeout?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly accountset: Accountset,
    private readonly mainchainClients: MainchainClients,
    private readonly history: History,
    biddingRules: IBiddingRules | null,
    private readonly miningFrames: MiningFrames,
  ) {
    this.mining = new Mining(this.mainchainClients);
    if (biddingRules) {
      this.biddingCalculator = new BiddingCalculator(
        new BiddingCalculatorData(this.mining, this.miningFrames),
        biddingRules,
      );
    }
  }

  public subscribeToUpdates(onUpdatedFn: () => void) {
    this.onUpdatedFn = onUpdatedFn;
    for (const bidder of this.cohortBiddersByActivationFrameId.values()) {
      bidder.onUpdatedFn = onUpdatedFn;
    }
  }

  public async start(localRpcUrl: string): Promise<void> {
    this.localRpcUrl = localRpcUrl;
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.unsubscribeFrame?.();
    const { unsubscribe } = await this.mining.onCohortChange({
      onBiddingStart: () => this.queueLifecycle(() => this.reloadActiveCohort()),
      onBiddingEnd: cohortActivationFrameId => this.queueLifecycle(() => this.onBiddingEnd(cohortActivationFrameId)),
    });
    this.unsubscribe = unsubscribe;
    this.unsubscribeFrame = this.miningFrames.events.on('on-frame', () => {
      if (this.isStopped) return;
      void this.queueLifecycle(() => this.reloadActiveCohort());
    });

    if (this.biddingCalculator) {
      if (!this.hasRegisteredKeys) {
        await this.accountset.registerKeys(this.localRpcUrl);
        this.hasRegisteredKeys = true;
      }
      await this.biddingCalculator.load();
    }
    await this.queueLifecycle(() => this.reloadActiveCohort());
  }

  public async stop() {
    if (this.isStopped) return;
    this.isStopped = true;
    this.shutdownController.abort();
    console.log('AUTOBIDDER STOPPING');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = undefined;
    if (this.pendingBiddingRetryTimeout) {
      clearTimeout(this.pendingBiddingRetryTimeout);
      this.pendingBiddingRetryTimeout = undefined;
    }
    await this.lifecycleQueue;
    await this.stopActiveBidders(false);
    this.biddingCalculator?.unload();
    this.onUpdatedFn = undefined;
    this.cohortBiddersByActivationFrameId.clear();
    console.log('AUTOBIDDER STOPPED');
  }

  public async updateBiddingRules(biddingRules: IBiddingRules | null): Promise<void> {
    await this.queueLifecycle(async () => {
      this.biddingCalculator?.unload();
      // Finish existing reveals while the next pricing policy loads, without admitting new bids.
      for (const bidder of this.cohortBiddersByActivationFrameId.values()) bidder.isBiddingOpen = false;

      if (biddingRules) {
        this.biddingCalculator = new BiddingCalculator(
          new BiddingCalculatorData(this.mining, this.miningFrames),
          biddingRules,
        );
      } else {
        this.biddingCalculator = undefined;
      }

      if (!this.unsubscribe || !this.localRpcUrl) {
        return;
      }

      try {
        if (this.biddingCalculator) {
          if (!this.hasRegisteredKeys) {
            await this.accountset.registerKeys(this.localRpcUrl);
            this.hasRegisteredKeys = true;
          }
          await this.biddingCalculator.load();
        }
        await this.reloadActiveCohort(true);
      } catch (error) {
        this.scheduleBiddingRetry();
        throw error;
      }
    });
  }

  private async reloadActiveCohort(refreshOptions = false): Promise<void> {
    if (this.isStopped) return;
    let cohortBidder: CohortBidderBase | undefined;
    try {
      const client = await this.mainchainClients.prunedClientOrArchivePromise;
      const isBiddingOpen = await client.query.miningSlot.isNextSlotBiddingOpen();
      const cohortActivationFrameId = await this.mining.fetchNextFrameId(client);
      if (this.isStopped) return;

      const existing = this.cohortBiddersByActivationFrameId.get(cohortActivationFrameId);
      if (existing && !refreshOptions) {
        existing.isBiddingOpen &&= isBiddingOpen;
        return;
      }

      // Disabling admission does not cancel commitments or their receipt tracking.
      if (!this.biddingCalculator && existing instanceof RangeCohortBidder && !existing.isStopping) {
        existing.isBiddingOpen = false;
        existing.updateBiddingOptions({ ...existing.options, maxSeats: 0 }, existing.subaccounts);
        return;
      }

      const pending = (await this.accountset.pendingMiningBids(client)).filter(
        bid => bid.frame === cohortActivationFrameId,
      );
      const preparedMaxima = await this.history.getBidMaxima(cohortActivationFrameId);
      const hasRevealWork = pending.length > 0 || Object.keys(preparedMaxima).length > 0;
      if (!isBiddingOpen && !hasRevealWork) {
        await this.stopActiveBidders(false);
        return;
      }
      if (!this.biddingCalculator && !hasRevealWork) {
        await this.stopActiveBidders(false);
        return;
      }

      if (this.accountset.isProxy) {
        const proxySetup = await this.accountset.planMiningBidProxySetup();
        if (proxySetup.kind !== 'ready') {
          console.log('Holding off bidding until mining bid proxy is ready', {
            cohortActivationFrameId,
            proxySetup: proxySetup.kind,
          });
          if (!existing) {
            this.history.initCohort(cohortActivationFrameId, new Set());
            this.onUpdatedFn?.();
          }
          this.scheduleBiddingRetry();
          return;
        }
        if (this.pendingBiddingRetryTimeout) {
          clearTimeout(this.pendingBiddingRetryTimeout);
          this.pendingBiddingRetryTimeout = undefined;
        }
      }

      let params: IBidderParams;
      if (this.biddingCalculator) {
        params = await this.createBidderParams(cohortActivationFrameId, this.biddingCalculator);
      } else {
        // A restarted bidder with saved commitments only needs to finish its reveals.
        params = { minBid: 0n, maxBid: 0n, maxSeats: 0, bidDelay: 0, bidIncrement: 0n };
      }
      if (this.isStopped) return;

      console.log('Bidder params', params);
      if (params.maxSeats === 0 && !hasRevealWork && !(existing instanceof RangeCohortBidder)) {
        await this.stopActiveBidders(false);
        if (this.isStopped) return;
        this.history.initCohort(cohortActivationFrameId, new Set());
        this.onUpdatedFn?.();
        return;
      }

      const miningSeatsAndBids = await this.accountset.miningSeatsAndBids();
      if (this.isStopped) return;

      console.log(`Bidding for frame ${cohortActivationFrameId} started`, {
        winningBids: miningSeatsAndBids.filter(x => x.hasWinningBid).length,
        seatGoal: params.maxSeats,
      });

      const subaccounts: { index: number; isRebid: boolean; address: string }[] = [];
      for (const winningBid of miningSeatsAndBids) {
        if (!winningBid.hasWinningBid || !Number.isInteger(winningBid.subaccountIndex)) continue;
        if (this.accountset.subAccountsByAddress[winningBid.address]) {
          subaccounts.push({
            index: winningBid.subaccountIndex,
            isRebid: true,
            address: winningBid.address,
          });
        }
      }
      for (const bid of pending) {
        if (subaccounts.some(account => account.address === bid.miner)) continue;
        const account = this.accountset.subAccountsByAddress[bid.miner];
        subaccounts.push({ index: account.index, address: bid.miner, isRebid: false });
      }
      if (subaccounts.length < params.maxSeats) {
        const neededSeats = params.maxSeats - subaccounts.length;
        // Pending commitments are not winning bids yet, so exclude them explicitly.
        const available = miningSeatsAndBids.filter(
          seat => !subaccounts.some(account => account.address === seat.address),
        );
        const added = await this.accountset.getAvailableMinerAccounts(neededSeats, available);
        subaccounts.push(...added);
      }
      if (this.isStopped) return;

      if (existing instanceof RangeCohortBidder && !existing.isStopping) {
        existing.isBiddingOpen = isBiddingOpen && params.maxSeats > 0;
        existing.updateBiddingOptions(params, subaccounts);
        return;
      }

      await this.stopActiveBidders(false);
      if (this.isStopped) return;

      cohortBidder = await CohortBidder.create(
        this.accountset,
        this.miningFrames,
        cohortActivationFrameId,
        subaccounts,
        params,
        {
          loadBidMaxima: async () => preparedMaxima,
          onBidMaximaPrepared: maxima => this.history.saveBidMaxima(cohortActivationFrameId, maxima),
          onBidParamsAdjusted: args => {
            const {
              availableBalanceForBids,
              availableMicronots,
              blockNumber,
              reason,
              tick,
              maxSeats,
              winningBidCount,
            } = args;
            const seatsInPlay = Math.max(maxSeats, winningBidCount);

            this.history.handleSeatFluctuation({
              tick,
              blockNumber,
              newMaxSeats: seatsInPlay,
              reason,
              availableMicrogons: availableBalanceForBids,
              availableMicronots,
              frameId: cohortActivationFrameId,
            });
          },
          onBidsUpdated: args => {
            const { tick, bids, atBlockNumber, isReloadingInitialState } = args;
            this.history.handleIncomingBids({
              tick,
              blockNumber: atBlockNumber,
              nextEntrants: bids,
              frameId: cohortActivationFrameId,
              isReloadingInitialState,
              seatGoalCount: cohortBidder?.seatGoalCount,
            });
          },
          onBidsSubmitted: args => {
            this.history.handleBidsSubmitted({
              ...args,
              frameId: cohortActivationFrameId,
            });
          },
          onBidsRejected: args => {
            this.history.handleBidsRejected({
              ...args,
              frameId: cohortActivationFrameId,
            });
          },
          onFinalizedBidActivityError: error => this.history.handleError(error, cohortActivationFrameId),
        },
      );
      if (this.isStopped) return;
      cohortBidder.bidsAttempted = await this.history.getSubmittedBidCount(cohortActivationFrameId);
      cohortBidder.isBiddingOpen = isBiddingOpen && params.maxSeats > 0;
      if (this.isStopped) return;
      cohortBidder.onUpdatedFn = this.onUpdatedFn;
      this.nextCohortActivationFrameId = cohortActivationFrameId;
      this.cohortBiddersByActivationFrameId.set(cohortActivationFrameId, cohortBidder);
      for (const activationFrameId of this.cohortBiddersByActivationFrameId.keys()) {
        // keep only the current and previous cohort bidders
        if (activationFrameId < cohortActivationFrameId - 1) {
          this.cohortBiddersByActivationFrameId.delete(activationFrameId);
        }
      }
      this.history.initCohort(cohortActivationFrameId, cohortBidder.myAddresses);
      this.onUpdatedFn?.();
      await cohortBidder.start();
      if (!isBiddingOpen) await this.onBiddingEnd(cohortActivationFrameId);
      if (this.pendingBiddingRetryTimeout) {
        clearTimeout(this.pendingBiddingRetryTimeout);
        this.pendingBiddingRetryTimeout = undefined;
      }
    } catch (error) {
      console.error('Could not reconcile the mining auction; retrying:', error);
      if (cohortBidder) {
        const frameId = cohortBidder.cohortStartingFrameId;
        if (this.cohortBiddersByActivationFrameId.get(frameId) === cohortBidder) {
          this.cohortBiddersByActivationFrameId.delete(frameId);
          this.nextCohortActivationFrameId = null;
        }
        await cohortBidder.stop(false).catch(cleanupError => {
          console.error('Error cleaning up failed cohort bidder', frameId, cleanupError);
        });
        this.history.initCohort(frameId, new Set());
        this.onUpdatedFn?.();
      }
      this.scheduleBiddingRetry();
    }
  }

  private async createBidderParams(
    cohortActivationFrameId: number,
    calculator: BiddingCalculator,
  ): Promise<IBidderParams> {
    const rules = calculator.biddingRules;
    await calculator.data.load(cohortActivationFrameId - 1);
    calculator.calculateBidAmounts();

    const minBid = calculator.startingBidAmountOverride ?? calculator.startingBidAmount;
    const maxBid = calculator.maximumBidAmountOverride ?? calculator.maximumBidAmount;

    const maxSeats = calculator.data.getMaxFrameSeats(rules);

    const bidDelay = rules.rebiddingDelay || 0;
    const bidIncrement = rules.rebiddingIncrementBy || 1n;

    return {
      minBid,
      maxBid,
      maxSeats,
      bidDelay,
      bidIncrement,
    };
  }

  private async onBiddingEnd(cohortActivationFrameId: number, waitForFinalBids = true): Promise<void> {
    const cohortBidder = this.cohortBiddersByActivationFrameId.get(cohortActivationFrameId);
    if (!cohortBidder) return;

    cohortBidder.isBiddingOpen = false;
    await cohortBidder.stop(waitForFinalBids, this.shutdownController.signal);
    if (this.isStopped) return;
    this.cohortBiddersByActivationFrameId.delete(cohortActivationFrameId);
    if (this.nextCohortActivationFrameId === cohortActivationFrameId) {
      this.nextCohortActivationFrameId = null;
    }
    this.history.initCohort(cohortActivationFrameId, new Set());
    this.onUpdatedFn?.();
    console.log('Bidding stopped', { cohortActivationFrameId });
  }

  private queueLifecycle(task: () => Promise<void>): Promise<void> {
    const queuedTask = this.lifecycleQueue.then(task, task);
    this.lifecycleQueue = queuedTask.catch(() => undefined);
    return queuedTask;
  }

  private scheduleBiddingRetry(): void {
    if (this.isStopped || this.pendingBiddingRetryTimeout) return;

    this.pendingBiddingRetryTimeout = setTimeout(() => {
      this.pendingBiddingRetryTimeout = undefined;
      void this.queueLifecycle(() => this.reloadActiveCohort(true)).catch(error => {
        console.error('Error retrying bidding setup', error);
        this.scheduleBiddingRetry();
      });
    }, 1_000);
  }

  private async stopActiveBidders(waitForFinalBids: boolean): Promise<void> {
    for (const cohortActivationFrameId of [...this.cohortBiddersByActivationFrameId.keys()]) {
      await this.onBiddingEnd(cohortActivationFrameId, waitForFinalBids);
    }
  }
}
