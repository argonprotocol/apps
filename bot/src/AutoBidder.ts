import {
  type Accountset,
  CohortBidder,
  type IBidderParams,
  type IBiddingRules,
  MainchainClients,
  Mining,
  MiningFrames,
} from '@argonprotocol/apps-core';
import { type Storage } from './Storage.ts';
import { type History } from './History.ts';
import BiddingCalculatorData from '@argonprotocol/apps-core/src/BiddingCalculatorData.ts';
import BiddingCalculator from '@argonprotocol/apps-core/src/BiddingCalculator.ts';

/**
 * Creates a bidding process. Between each cohort, it will ask the callback for parameters for the next cohort.
 * @param accountset
 * @param storage
 * @param biddingRules
 */
export class AutoBidder {
  public readonly mining: Mining;
  public get currentBidder(): CohortBidder | undefined {
    return this.cohortBiddersByActivationFrameId.get(this.nextCohortActivationFrameId ?? 0);
  }
  public get previousBidder(): CohortBidder | undefined {
    if (!this.nextCohortActivationFrameId) return undefined;
    return this.cohortBiddersByActivationFrameId.get(this.nextCohortActivationFrameId - 1);
  }
  private cohortBiddersByActivationFrameId = new Map<number, CohortBidder>();
  private nextCohortActivationFrameId: number | null = null;
  private isStopped: boolean = false;
  private unsubscribe?: () => void;
  private biddingCalculator?: BiddingCalculator;
  private onUpdatedFn?: () => void;
  private localRpcUrl?: string;
  private hasRegisteredKeys = false;

  constructor(
    private readonly accountset: Accountset,
    private readonly mainchainClients: MainchainClients,
    private readonly storage: Storage,
    private readonly history: History,
    private biddingRules: IBiddingRules | null,
    private readonly miningFrames: MiningFrames,
  ) {
    this.mining = new Mining(this.mainchainClients);
    if (this.biddingRules) {
      this.biddingCalculator = new BiddingCalculator(
        new BiddingCalculatorData(this.mining, this.miningFrames),
        this.biddingRules,
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
    const { unsubscribe } = await this.mining.onCohortChange({
      onBiddingStart: this.onBiddingStart.bind(this),
      onBiddingEnd: this.onBiddingEnd.bind(this),
    });
    this.unsubscribe = unsubscribe;

    if (!this.biddingRules || !this.biddingCalculator) {
      return;
    }

    if (!this.hasRegisteredKeys) {
      await this.accountset.registerKeys(this.localRpcUrl);
      this.hasRegisteredKeys = true;
    }

    await this.biddingCalculator.load();
  }

  public async stop() {
    if (this.isStopped) return;
    this.isStopped = true;
    console.log('AUTOBIDDER STOPPING');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const cohortActivationFrameId of [...this.cohortBiddersByActivationFrameId.keys()]) {
      await this.onBiddingEnd(cohortActivationFrameId, false);
    }
    this.biddingCalculator?.unload();
    this.onUpdatedFn = undefined;
    this.cohortBiddersByActivationFrameId.clear();
    console.log('AUTOBIDDER STOPPED');
  }

  public async updateBiddingRules(biddingRules: IBiddingRules | null): Promise<void> {
    this.biddingRules = biddingRules;

    if (!this.biddingRules) {
      this.biddingCalculator?.unload();
      this.biddingCalculator = undefined;
      for (const cohortActivationFrameId of [...this.cohortBiddersByActivationFrameId.keys()]) {
        await this.onBiddingEnd(cohortActivationFrameId, false);
      }
      return;
    }

    this.biddingCalculator?.unload();
    this.biddingCalculator = new BiddingCalculator(
      new BiddingCalculatorData(this.mining, this.miningFrames),
      this.biddingRules,
    );

    if (!this.unsubscribe || !this.localRpcUrl) {
      return;
    }

    if (!this.hasRegisteredKeys) {
      await this.accountset.registerKeys(this.localRpcUrl);
      this.hasRegisteredKeys = true;
    }

    await this.biddingCalculator.load();
    await this.reloadActiveCohort();
  }

  private async createBidderParams(cohortActivationFrameId: number): Promise<IBidderParams> {
    if (!this.biddingCalculator || !this.biddingRules) {
      throw new Error('Bidding rules are not configured.');
    }

    await this.biddingCalculator.data.load(cohortActivationFrameId - 1);
    this.biddingCalculator.calculateBidAmounts();
    const calculator = this.biddingCalculator;

    const minBid = calculator.startingBidAmountOverride ?? calculator.startingBidAmount;
    const maxBid = calculator.maximumBidAmountOverride ?? calculator.maximumBidAmount;

    const maxSeats = calculator.data.getMaxFrameSeats(this.biddingRules);

    const bidDelay = this.biddingRules.rebiddingDelay || 0;
    const bidIncrement = this.biddingRules.rebiddingIncrementBy || 1n;

    return {
      minBid,
      maxBid,
      maxSeats,
      bidDelay,
      bidIncrement,
      sidelinedWalletMicrogons: this.biddingRules.sidelinedMicrogons,
      sidelinedWalletMicronots: this.biddingRules.sidelinedMicronots,
    };
  }

  private async onBiddingEnd(cohortActivationFrameId: number, waitForFinalBids = true): Promise<void> {
    const cohortBidder = this.cohortBiddersByActivationFrameId.get(cohortActivationFrameId);
    if (!cohortBidder) return;

    cohortBidder.isBiddingOpen = false;
    await cohortBidder.stop(waitForFinalBids);
    this.cohortBiddersByActivationFrameId.delete(cohortActivationFrameId);
    if (this.nextCohortActivationFrameId === cohortActivationFrameId) {
      this.nextCohortActivationFrameId = null;
    }
    console.log('Bidding stopped', { cohortActivationFrameId });
  }

  private async onBiddingStart(cohortActivationFrameId: number) {
    if (this.isStopped || !this.biddingRules || !this.biddingCalculator) return;

    try {
      const params = await this.createBidderParams(cohortActivationFrameId);
      console.log('Bidder params', params);
      if (params.maxSeats === 0) return;

      const cohortBiddingFrameId = cohortActivationFrameId - 1;
      const bidsFileData = await this.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId).get();
      console.log(`Bidding for frame ${cohortActivationFrameId} started`, {
        hasStartingStats: !!bidsFileData,
        seatGoal: params.maxSeats,
      });

      const subaccounts: { index: number; isRebid: boolean; address: string }[] = [];
      if (bidsFileData && bidsFileData.winningBids.length) {
        for (const winningBid of bidsFileData.winningBids) {
          if (typeof winningBid.subAccountIndex !== 'number') continue;
          if (this.accountset.subAccountsByAddress[winningBid.address]) {
            subaccounts.push({
              index: winningBid.subAccountIndex,
              isRebid: true,
              address: winningBid.address,
            });
          }
        }
      }
      // check if we need to add more seats
      if (subaccounts.length < params.maxSeats) {
        const neededSeats = params.maxSeats - subaccounts.length;
        const added = await this.accountset.getAvailableMinerAccounts(neededSeats);
        subaccounts.push(...added);
      }

      const cohortBidder = new CohortBidder(
        this.accountset,
        this.miningFrames,
        cohortActivationFrameId,
        subaccounts,
        params,
        {
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
            });
          },
          onBidsSubmitted: args => {
            const { tick, blockNumber, microgonsPerSeat, submittedCount, txFeePlusTip } = args;
            this.history.handleBidsSubmitted({
              tick,
              blockNumber,
              microgonsPerSeat,
              submittedCount,
              txFeePlusTip,
              frameId: cohortActivationFrameId,
            });
          },
          onBidsRejected: args => {
            const { tick, blockNumber, bidError, microgonsPerSeat, rejectedCount, submittedCount } = args;
            this.history.handleBidsRejected({
              tick,
              blockNumber,
              bidError,
              microgonsPerSeat,
              rejectedCount,
              submittedCount,
              frameId: cohortActivationFrameId,
            });
          },
        },
      );
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
      await cohortBidder.start();
    } catch (err) {
      console.error('Error starting bidding for cohort', cohortActivationFrameId, err);
    }
  }

  private async reloadActiveCohort(): Promise<void> {
    const client = await this.mainchainClients.prunedClientOrArchivePromise;
    const isBiddingOpen = await client.query.miningSlot.isNextSlotBiddingOpen();
    if (isBiddingOpen.isFalse) {
      for (const cohortActivationFrameId of [...this.cohortBiddersByActivationFrameId.keys()]) {
        await this.onBiddingEnd(cohortActivationFrameId, false);
      }
      return;
    }

    const cohortActivationFrameId = await this.mining.fetchNextFrameId(client);
    await this.onBiddingEnd(cohortActivationFrameId, false);
    await this.onBiddingStart(cohortActivationFrameId);
  }
}
