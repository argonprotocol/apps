import {
  type Accountset,
  CohortBidder,
  createBidderParams,
  type IBiddingRules,
  MainchainClients,
  Mining,
} from '@argonprotocol/apps-core';
import { type Storage } from './Storage.ts';
import { type History } from './History.ts';

/**
 * Creates a bidding process. Between each cohort, it will ask the callback for parameters for the next cohort.
 * @param accountset
 * @param storage
 * @param biddingRules
 */
export class AutoBidder {
  public readonly mining: Mining;
  private cohortBiddersByActivationFrameId = new Map<number, CohortBidder>();
  private isStopped: boolean = false;
  private unsubscribe?: () => void;

  constructor(
    private readonly accountset: Accountset,
    private readonly mainchainClients: MainchainClients,
    private readonly storage: Storage,
    private readonly history: History,
    private biddingRules: IBiddingRules,
  ) {
    this.mining = new Mining(mainchainClients);
  }
  public async start(localRpcUrl: string): Promise<void> {
    await this.accountset.registerKeys(localRpcUrl);
    const { unsubscribe } = await this.mining.onCohortChange({
      onBiddingStart: this.onBiddingStart.bind(this),
      onBiddingEnd: this.onBiddingEnd.bind(this),
    });
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
    console.log('AUTOBIDDER STOPPED');
  }

  private async onBiddingEnd(cohortActivationFrameId: number, isShuttingDown = false): Promise<void> {
    await this.cohortBiddersByActivationFrameId.get(cohortActivationFrameId)?.stop(!isShuttingDown);
    this.cohortBiddersByActivationFrameId.delete(cohortActivationFrameId);
    console.log('Bidding stopped', { cohortActivationFrameId });
  }

  private async onBiddingStart(cohortActivationFrameId: number) {
    if (this.isStopped) return;
    const params = await createBidderParams(cohortActivationFrameId, this.mainchainClients, this.biddingRules);
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

    const cohortBidder = new CohortBidder(this.accountset, cohortActivationFrameId, subaccounts, params, {
      onBidParamsAdjusted: args => {
        const { availableBalanceForBids, availableMicronots, blockNumber, reason, tick, maxSeats, winningBidCount } =
          args;
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
    });
    if (this.isStopped) return;
    this.cohortBiddersByActivationFrameId.set(cohortActivationFrameId, cohortBidder);
    await this.history.initCohort(cohortActivationFrameId, cohortBidder.myAddresses);
    await cohortBidder.start();
  }
}
