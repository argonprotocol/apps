import {
  type Accountset,
  CohortBidder,
  createBidderParams,
  type IBiddingRules,
  MainchainClients,
  MiningBids,
} from '@argonprotocol/commander-core';
import { type Storage } from './Storage.ts';
import { type History, SeatReductionReason } from './History.ts';

/**
 * Creates a bidding process. Between each cohort, it will ask the callback for parameters for the next cohort.
 * @param accountset
 * @param storage
 * @param biddingRules
 */
export class AutoBidder {
  public readonly miningBids: MiningBids;
  private cohortBiddersByActivationFrameId = new Map<number, CohortBidder>();
  private isStopped: boolean = false;
  private unsubscribe?: () => void;

  constructor(
    readonly accountset: Accountset,
    readonly mainchainClients: MainchainClients,
    readonly storage: Storage,
    readonly history: History,
    private biddingRules: IBiddingRules,
  ) {
    this.miningBids = new MiningBids(accountset.client);
  }

  async start(localRpcUrl: string): Promise<void> {
    await this.accountset.registerKeys(localRpcUrl);
    const { unsubscribe } = await this.miningBids.onCohortChange({
      onBiddingStart: this.onBiddingStart.bind(this),
      onBiddingEnd: this.onBiddingEnd.bind(this),
    });
    this.unsubscribe = unsubscribe;
  }

  async stop() {
    if (this.isStopped) return;
    this.isStopped = true;
    console.log('AUTOBIDDER STOPPING');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const key of this.cohortBiddersByActivationFrameId.keys()) {
      await this.onBiddingEnd(key, true);
    }
    console.log('AUTOBIDDER STOPPED');
  }

  private async onBiddingEnd(cohortActivationFrameId: number, isShuttingDown = false): Promise<void> {
    await this.cohortBiddersByActivationFrameId.get(cohortActivationFrameId)?.stop(!isShuttingDown);
    this.cohortBiddersByActivationFrameId.delete(cohortActivationFrameId);
    console.log('Bidding stopped', { cohortActivationFrameId });
  }

  private async onBiddingStart(cohortActivationFrameId: number) {
    if (this.isStopped) return;
    const latestAccruedMicrogonProfits =
      (await this.storage.earningsFile(cohortActivationFrameId - 1).get())?.accruedMicrogonProfits ??
      (await this.storage.earningsFile(cohortActivationFrameId - 2).get())?.accruedMicrogonProfits ??
      0n;
    const latestAccruedMicronotProfits =
      (await this.storage.earningsFile(cohortActivationFrameId - 1).get())?.accruedMicronotProfits ??
      (await this.storage.earningsFile(cohortActivationFrameId - 2).get())?.accruedMicronotProfits ??
      0n;

    const params = await createBidderParams(cohortActivationFrameId, this.mainchainClients, this.biddingRules, {
      microgons: latestAccruedMicrogonProfits,
      micronots: latestAccruedMicronotProfits,
    });
    if (params.maxSeats === 0) return;

    const cohortBiddingFrameId = cohortActivationFrameId - 1;
    const bidsFileData = await this.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId).get();
    console.log(`Bidding for frame ${cohortActivationFrameId} started`, {
      hasStartingStats: !!bidsFileData,
      seatGoal: params.maxSeats,
    });

    const subaccounts: { index: number; isRebid: boolean; address: string }[] = [];
    if (bidsFileData && bidsFileData.winningBids.length) {
      const miningAccounts = await this.accountset.loadRegisteredMiners(this.accountset.client);
      for (const winningBid of bidsFileData.winningBids) {
        if (typeof winningBid.subAccountIndex !== 'number') continue;
        const account = miningAccounts.find(x => x.address === winningBid.address);
        if (account) {
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

    const cohortBidder = new CohortBidder(this.accountset, cohortActivationFrameId, subaccounts, params, {
      onBidParamsAdjusted: args => {
        const { availableBalanceForBids, availableMicronots, blockNumber, reason, tick, maxSeats, winningBidCount } =
          args;
        const seatsInPlay = Math.max(maxSeats, winningBidCount);
        const translatedReason =
          reason === 'max-bid-too-low'
            ? SeatReductionReason.MaxBidTooLow
            : reason === 'max-budget-too-low'
              ? SeatReductionReason.MaxBudgetTooLow
              : SeatReductionReason.InsufficientFunds;

        this.history.handleSeatFluctuation({
          tick,
          blockNumber,
          newMaxSeats: seatsInPlay,
          reason: translatedReason,
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
    });
    if (this.isStopped) return;
    this.cohortBiddersByActivationFrameId.set(cohortActivationFrameId, cohortBidder);
    await this.history.initCohort(cohortActivationFrameId, cohortBidder.myAddresses);
    await cohortBidder.start();
  }
}
