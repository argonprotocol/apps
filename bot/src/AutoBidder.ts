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
  private readonly biddingCalculator: BiddingCalculator;
  private onUpdatedFn?: () => void;

  constructor(
    private readonly accountset: Accountset,
    private readonly mainchainClients: MainchainClients,
    private readonly storage: Storage,
    private readonly history: History,
    private biddingRules: IBiddingRules,
    private readonly miningFrames: MiningFrames,
  ) {
    this.mining = new Mining(this.mainchainClients);
    const calculatorData = new BiddingCalculatorData(this.mining, this.miningFrames);
    this.biddingCalculator = new BiddingCalculator(calculatorData, this.biddingRules);
  }

  public subscribeToUpdates(onUpdatedFn: () => void) {
    this.onUpdatedFn = onUpdatedFn;
    for (const bidder of this.cohortBiddersByActivationFrameId.values()) {
      bidder.onUpdatedFn = onUpdatedFn;
    }
  }

  public async start(localRpcUrl: string): Promise<void> {
    await this.accountset.registerKeys(localRpcUrl);
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    const { unsubscribe } = await this.mining.onCohortChange({
      onBiddingStart: this.onBiddingStart.bind(this),
      onBiddingEnd: this.onBiddingEnd.bind(this),
    });
    await this.biddingCalculator.load();
    this.unsubscribe = unsubscribe;
  }

  public async stop() {
    if (this.isStopped) return;
    this.isStopped = true;
    console.log('AUTOBIDDER STOPPING');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const key of this.cohortBiddersByActivationFrameId.keys()) {
      await this.onBiddingEnd(key, true);
    }
    this.onUpdatedFn = undefined;
    this.cohortBiddersByActivationFrameId.clear();
    console.log('AUTOBIDDER STOPPED');
  }

  private async createBidderParams(cohortActivationFrameId: number): Promise<IBidderParams> {
    await this.biddingCalculator.data.load(cohortActivationFrameId - 1);
    this.biddingCalculator.calculateBidAmounts();
    const calculator = this.biddingCalculator;

    const minBid = calculator.startingBidAmount;
    const maxBid = calculator.maximumBidAmount;

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

  private async onBiddingEnd(cohortActivationFrameId: number, isShuttingDown = false): Promise<void> {
    const cohortBidder = this.cohortBiddersByActivationFrameId.get(cohortActivationFrameId);
    if (cohortBidder) {
      cohortBidder.isBiddingOpen = false;
      await cohortBidder.stop(isShuttingDown);
      console.log('Bidding stopped', { cohortActivationFrameId });
    }
  }

  private async onBiddingStart(cohortActivationFrameId: number) {
    if (this.isStopped) return;

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
}
