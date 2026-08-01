import type { Accountset } from './Accountset.js';
import {
  type ArgonClient,
  type ArgonPrimitivesBlockSealMiningRegistration,
  ExtrinsicError,
  formatArgons,
  hexToU8a,
  type TxResult,
  Vec,
} from '@argonprotocol/mainchain';
import { subscribeToFinalizedStorageChanges } from './StorageSubscriber.js';
import { BlockWatch, type IBlockHeaderInfo } from './BlockWatch.js';
import type { MiningFrames } from './MiningFrames.js';
import { createDeferred, type IDeferred } from './Deferred.js';
import { JsonExt } from './JsonExt.js';
import { planBidWithFeeEstimate, type IBidPlanBid, type IBidPlanSubaccount } from './BidPlan.js';
import { TransactionEvents } from './TransactionEvents.js';
import type { IManualBidRequest } from './interfaces/IBotApiSpec.js';
import { bigIntMax } from './utils.js';

interface IBidDetail extends IBidPlanBid {
  bidAtTick: number;
}

// Substrate mortal-era periods are powers of two, so 8 is the safe period closest to ten blocks.
const DEFAULT_BID_MORTALITY_BLOCKS = 8;
const MINIMUM_BID_MORTALITY_BLOCKS = 4;

export interface ICohortBidderOptions {
  minBid: bigint;
  maxBid: bigint;
  sidelinedWalletMicrogons?: bigint;
  sidelinedWalletMicronots?: bigint;
  bidIncrement: bigint;
  bidDelay: number;
  tipPerTransaction?: bigint;
}

export class CohortBidder {
  public onUpdatedFn?: () => void;
  public get client(): ArgonClient {
    return this.blockWatch.subscriptionClient;
  }

  public latestUpdateDate?: Date;
  public latestBlockNumber: number = 0;

  public nextBid?: {
    microgonsPerSeat: bigint;
    subaccounts: string[];
    alreadyWinningSeats: number;
    bidAtTick: number;
    tip: bigint;
  };
  public lastBid?: {
    submittedAtTick: number;
    expectedFinalizationTick: number;
    isFinalized: boolean;
    microgonsPerSeat: bigint;
    seats: number;
    seatsWon?: number;
  };
  public pendingBidTxResult: TxResult | undefined;
  public isBiddingOpen = true;
  public isPaused = false;
  public get isStopping(): boolean {
    return this.stopDeferred.isRunning || this.stopDeferred.isSettled;
  }

  public txFees = 0n;
  public bidsAttempted = 0;
  public myWinningBids: IBidDetail[] = [];
  public readonly myAddresses = new Set<string>();

  public readonly currentBids: {
    atBlockNumber: number;
    atTick: number;
    mostRecentBidTick: number;
    bids: IBidDetail[];
  } = {
    bids: [],
    mostRecentBidTick: 0,
    atTick: 0,
    atBlockNumber: 0,
  };

  private get blockWatch(): BlockWatch {
    return this.miningFrames.blockWatch;
  }

  private unsubscribe?: () => void;
  private lastLoggedSeatsInBudget: number;

  private pendingRequest: Promise<any> | undefined;
  private pendingManualBid?: {
    requestKey: string;
    completion: IDeferred<void>;
  };
  private pendingFinalizations = new Set<Promise<void>>();
  private stopDeferred = createDeferred<void>(false);
  private minIncrement = 10_000n;
  private ticksBeforeVrfClose = 30;

  private nextCohortSize?: number;
  private micronotsPerSeat!: bigint;

  private lastBidsHash: string | undefined;
  private bidsForNextSlotCohortKey!: string;
  private bidPlanGeneration = 0;
  private readonly name: string;

  constructor(
    public accountset: Accountset,
    public miningFrames: MiningFrames,
    public cohortStartingFrameId: number,
    public subaccounts: IBidPlanSubaccount[],
    public options: ICohortBidderOptions,
    public callbacks?: {
      onBidsUpdated?(args: {
        bids: IBidDetail[];
        atBlockNumber: number;
        tick: number;
        isReloadingInitialState: boolean;
      }): void;
      onBidParamsAdjusted?(args: {
        tick: number;
        blockNumber: number;
        maxSeats: number;
        winningBidCount: number;
        reason: IBidReductionReason | undefined;
        availableBalanceForBids: bigint;
        availableMicronots: bigint;
      }): void;
      onBidsSubmitted?(args: {
        tick: number;
        blockNumber: number;
        microgonsPerSeat: bigint;
        txFeePlusTip: bigint;
        submittedCount: number;
      }): void;
      onBidsRejected?(args: {
        tick: number;
        blockNumber: number;
        microgonsPerSeat: bigint;
        submittedCount: number;
        rejectedCount: number;
        bidError: ExtrinsicError;
      }): void;
    },
    name?: string,
  ) {
    this.subaccounts.forEach(x => {
      this.myAddresses.add(x.address);
    });
    this.lastLoggedSeatsInBudget = subaccounts.length;
    this.name = name ?? `BIDDER_${accountset.txSubmitterPair.address.substring(0, 5)} #${cohortStartingFrameId}`;
  }

  public async start() {
    await this.blockWatch.start();
    const client = this.client;
    this.minIncrement = client.consts.miningSlot.bidIncrements.toBigInt();
    this.bidsForNextSlotCohortKey = client.query.miningSlot.bidsForNextSlotCohort.key();
    this.ticksBeforeVrfClose = await client.query.miningSlot
      .miningConfig()
      .then(x => x.ticksBeforeBidEndForVrfClose.toNumber());
    const minBidIncrement = this.options.minBid % this.minIncrement;
    if (minBidIncrement !== 0n) {
      this.options.minBid -= minBidIncrement;
      this.log(
        `Adjusting min bid to ${formatArgons(this.options.minBid)} to be a multiple of the minimum increment ${formatArgons(
          this.minIncrement,
        )}`,
      );
    }
    const maxBidIncrement = this.options.maxBid % this.minIncrement;
    if (maxBidIncrement !== 0n) {
      this.options.maxBid -= maxBidIncrement;
      this.log(
        `Adjusting max bid to ${formatArgons(this.options.maxBid)} to be a multiple of the minimum increment ${formatArgons(
          this.minIncrement,
        )}`,
      );
    }

    this.log(`Starting cohort ${this.cohortStartingFrameId} bidder`, {
      maxBid: formatArgons(this.options.maxBid),
      minBid: formatArgons(this.options.minBid),
      bidIncrement: formatArgons(this.options.bidIncrement),
      deactivatedBalanceMicrogons: formatArgons(this.options.sidelinedWalletMicrogons ?? 0n),
      deactivatedBalanceMicronots: formatArgons(this.options.sidelinedWalletMicronots ?? 0n),
      bidDelay: this.options.bidDelay,
      subaccounts: this.subaccounts,
    });

    this.nextCohortSize = await client.query.miningSlot.nextCohortSize().then(x => x.toNumber());
    this.micronotsPerSeat = await client.query.miningSlot.argonotsPerMiningSeat().then(x => x.toBigInt());
    if (this.subaccounts.length > this.nextCohortSize) {
      this.info(`Cohort size ${this.nextCohortSize} is less than provided subaccounts ${this.subaccounts.length}.`);
      this.subaccounts.length = this.nextCohortSize;
    }

    await this.blockWatch.start();
    await this.miningFrames.load();

    // check the current header in case we started late
    await this.onHeader(this.blockWatch.bestBlockHeader, true);
    this.unsubscribe = this.blockWatch.events.on('best-blocks', headers => {
      if (this.isStopping) return;
      void this.onHeader(headers.at(-1)!, false).catch(err => {
        this.error('Error processing new header in cohort bidder', err);
      });
    });
  }

  public async stop(waitForFinalBids = true): Promise<CohortBidder['myWinningBids']> {
    if (this.isStopping) {
      await this.stopDeferred.promise;
      return this.myWinningBids;
    }

    try {
      this.stopDeferred.setIsRunning(true);
      this.log('Stopping bidder for cohort', this.cohortStartingFrameId);
      if (this.unsubscribe) {
        this.unsubscribe();
      }
      this.nextBid = undefined;
      if (waitForFinalBids) {
        const finalizedBlock = this.blockWatch.finalizedBlockHeader;
        // will be set on all finalized blocks
        const finalizedFrameId = finalizedBlock.frameId!;
        // if still on last frame, wait for next
        if (finalizedFrameId < this.cohortStartingFrameId) {
          // wait for the finalized block to the be the next frame or later
          const finalizedClient = await this.client.at(finalizedBlock.blockHash);
          const isBiddingOpen = await finalizedClient.query.miningSlot.isNextSlotBiddingOpen();
          if (isBiddingOpen.isTrue) {
            this.log('Bidding is still open, waiting for it to close');
            // we need to wait for either of these things to be true
            await new Promise<void>(async resolve => {
              const unsub = await subscribeToFinalizedStorageChanges(this.client, [
                {
                  key: this.client.query.miningSlot.isNextSlotBiddingOpen.key(),
                  handler: async api => {
                    const isOpen = await api.query.miningSlot.isNextSlotBiddingOpen();
                    this.log('miningSlot.isNextSlotBiddingOpen changed', isOpen.toHuman());
                    if (isOpen.isFalse) {
                      unsub.unsubscribe();
                      resolve();
                    }
                  },
                },
                {
                  key: this.client.query.miningSlot.nextFrameId.key(),
                  handler: async api => {
                    const frameId = await api.query.miningSlot.nextFrameId();
                    this.log('miningSlot.nextFrameId changed', frameId.toNumber());
                    if (frameId.toNumber() > this.cohortStartingFrameId) {
                      unsub.unsubscribe();
                      resolve();
                    }
                  },
                },
              ]);
            });
          }
        }
        // wait for any pending request and finalization to finish updating stats
        void (await this.pendingRequest);
        await Promise.all(this.pendingFinalizations);

        const stopBlockHash = await this.client.rpc.chain.getFinalizedHead();
        const stopApi = await this.client.at(stopBlockHash);
        const blockNumber = await stopApi.query.system.number().then(x => x.toNumber());
        const cohortWinners = await stopApi.query.miningSlot.minersByCohort(this.cohortStartingFrameId);
        this.myWinningBids = cohortWinners
          .filter(
            x =>
              x.externalFundingAccount.isSome &&
              this.accountset.fundingAccountId === x.externalFundingAccount.value.toHuman(),
          )
          .map(x => {
            return {
              address: x.accountId.toHuman(),
              micronotsStaked: x.argonots.toBigInt(),
              bidMicrogons: x.bid.toBigInt(),
              bidAtTick: this.currentBids.atTick,
            };
          });
        this.log('Bidder stopped', {
          cohortStartingFrameId: this.cohortStartingFrameId,
          blockNumber,
          winningBids: this.myWinningBids,
        });
      }
      this.onUpdatedFn = undefined;
    } finally {
      this.stopDeferred.resolve();
    }

    return this.myWinningBids;
  }

  public async submitManualBid(request: IManualBidRequest): Promise<void> {
    const requestKey = JsonExt.stringify(request);
    let pendingManualBidWaits = 0;

    while (this.pendingManualBid) {
      if (pendingManualBidWaits >= 2) {
        throw new Error('manual-bid-busy');
      }

      pendingManualBidWaits += 1;
      const pendingManualBid = this.pendingManualBid;
      try {
        await pendingManualBid.completion.promise;
      } catch (error) {
        if (pendingManualBid.requestKey === requestKey) throw error;
      }
      await new Promise(setImmediate);

      if (pendingManualBid.requestKey === requestKey) return;
    }

    const completion = createDeferred<void>();
    void completion.promise.catch(() => undefined);
    this.pendingManualBid = { requestKey, completion };

    try {
      if (this.isStopping) throw new Error('bidder-stopping');
      if (!this.isBiddingOpen) throw new Error('bidding-closed');
      if (request.microgonsPerSeat % this.minIncrement !== 0n) throw new Error('invalid-bid-increment');

      if (this.pendingRequest) {
        await this.pendingRequest;
        await new Promise(setImmediate);
      }

      const lastBidTick = this.lastBid?.submittedAtTick ?? 0;
      const waitStartedAt = Date.now();
      while (this.currentBids.mostRecentBidTick < lastBidTick) {
        if (this.isStopping) throw new Error('bidder-stopping');
        if (Date.now() - waitStartedAt > 15_000) throw new Error('waiting-for-bid-results');
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      const { accountBalance, accountMicronots, tip } = await this.getBidBalances();
      const subaccounts = [...this.subaccounts];
      const seenAddresses = new Set(subaccounts.map(x => x.address));
      if (subaccounts.length < request.seats) {
        const availableAccounts = await this.accountset.getAvailableMinerAccounts(
          Math.max(request.seats, this.nextCohortSize ?? request.seats),
        );
        for (const account of availableAccounts) {
          if (seenAddresses.has(account.address)) continue;

          subaccounts.push(account);
          seenAddresses.add(account.address);
          if (subaccounts.length >= request.seats) break;
        }
      }

      const { plan } = await planBidWithFeeEstimate({
        ...request,
        nextCohortSize: this.nextCohortSize!,
        micronotsPerSeat: this.micronotsPerSeat,
        accountBalance,
        accountMicronots,
        allWinningBids: this.currentBids.bids,
        myWinningBids: this.myWinningBids,
        subaccounts,
        tip,
        estimateFee: (accounts, bidAmount, feeTip) => this.estimateFee(bidAmount, accounts, feeTip),
      });

      if (plan.reason || !plan.accountsToBidWith.length) {
        throw new Error(plan.reason ?? 'manual-bid-rejected');
      }

      this.bidPlanGeneration += 1;
      this.setNextBid({
        microgonsPerSeat: request.microgonsPerSeat,
        bidAtTick: this.blockWatch.bestBlockHeader.tick,
        subaccounts: plan.accountsToBidWith.map(x => x.address),
        alreadyWinningSeats: plan.seatsAfterBid - plan.accountsToBidWith.length,
        tip,
      });
      this.pendingRequest = this.submitNextBid(true);
      await this.pendingRequest;
      completion.resolve();
    } catch (error) {
      completion.reject(error);
      throw error;
    } finally {
      if (this.pendingManualBid?.completion === completion) {
        this.pendingManualBid = undefined;
      }
      if (!this.isPaused && !this.isStopping) {
        void this.planNextBid(this.blockWatch.bestBlockHeader.frameRewardTicksRemaining!).catch(error => {
          this.error('Error resuming bid planning after a manual bid:', error);
        });
      }
    }
  }

  public pauseBidding(): void {
    if (this.isPaused) return;

    this.isPaused = true;
    this.bidPlanGeneration += 1;
    this.setNextBid(undefined);
  }

  public resumeBidding(): void {
    if (!this.isPaused) return;

    this.isPaused = false;
    void this.planNextBid(this.blockWatch.bestBlockHeader.frameRewardTicksRemaining!).catch(error => {
      this.error('Error resuming bid planning:', error);
    });
  }

  private broadcastUpdates() {
    this.onUpdatedFn?.();
  }

  private async onHeader(header: IBlockHeaderInfo, isFirstLoad: boolean): Promise<void> {
    const client = this.client;
    // check if the header is for the next frame
    const currentFrameId = header.frameId!;
    const blockNumber = header.blockNumber;
    this.latestBlockNumber = blockNumber;
    this.latestUpdateDate = new Date();

    if (currentFrameId + 1 !== this.cohortStartingFrameId) {
      return;
    }
    const tick = header.tick;
    // check if it changed first
    const latestCohortBidsHash = await client.rpc.state
      .getStorageHash(this.bidsForNextSlotCohortKey, header.blockHash)
      .then(x => x.toHex());

    if (this.lastBidsHash !== latestCohortBidsHash) {
      const previousBidsHash = this.lastBidsHash;
      try {
        const clientAt = await client.at(header.blockHash);
        const rawBids = await clientAt.query.miningSlot.bidsForNextSlotCohort();

        this.lastBidsHash = latestCohortBidsHash;
        this.updateBidList(rawBids, blockNumber, tick, isFirstLoad);

        await this.planNextBid(header.frameRewardTicksRemaining!);
      } catch (error) {
        if (this.lastBidsHash === latestCohortBidsHash) {
          this.lastBidsHash = previousBidsHash;
        }
        throw error;
      }
    }

    if (!this.isPaused && !this.pendingManualBid && this.nextBid && this.nextBid.bidAtTick <= header.tick) {
      this.pendingRequest ??= this.submitNextBid();
    }
  }

  private async planNextBid(frameRewardTicksRemaining: number) {
    const planGeneration = ++this.bidPlanGeneration;
    if (this.isStopping) return;
    if (this.isPaused) {
      this.setNextBid(undefined);
      return;
    }

    // don't process two bids at the same time
    if (this.pendingRequest || this.pendingManualBid) {
      this.log(`Current bid is still in progress at block #${this.latestBlockNumber}, skipping this check`);
      return;
    }

    // if our latest bid is more recent than the current bids, wait
    const lastBid = this.lastBid;
    const lastBidTick = lastBid?.submittedAtTick ?? 0;
    if ((lastBid?.seatsWon ?? 0) > 0 && this.currentBids.mostRecentBidTick < lastBidTick) {
      this.log(`Waiting for bids more recent than our last attempt.`, {
        ownAttemptedBidTick: lastBidTick,
        mostRecentBidTick: this.currentBids.mostRecentBidTick,
        latestBlockNumber: this.latestBlockNumber,
      });
      return;
    }
    const bids = [...this.currentBids.bids];
    const bidsAtTick = this.currentBids.atTick;
    const blockNumber = this.currentBids.atBlockNumber;
    const myWinningBids = bids.filter(x => this.myAddresses.has(x.address));
    if (myWinningBids.length >= this.subaccounts.length) {
      this.setNextBid(undefined);
      this.log(`No updates needed at block #${blockNumber}. Winning all remaining seats (${myWinningBids.length}).`);
      return;
    }

    this.log(
      `Checking bids for cohort ${this.cohortStartingFrameId} at block ${this.latestBlockNumber}, Still trying for seats: ${this.subaccounts.length}. Currently winning ${myWinningBids.length} bids.`,
    );

    const beatableBids: bigint[] = [];
    if (bids.length < this.nextCohortSize!) {
      beatableBids.push(this.clampBid(0n));
    }
    for (const { bidMicrogons } of bids) {
      if (this.options.minBid > bidMicrogons && !beatableBids.includes(this.options.minBid)) {
        beatableBids.push(this.options.minBid);
      }
      const nextBid = this.clampBid(bidMicrogons + this.options.bidIncrement);

      if (nextBid >= bidMicrogons + this.minIncrement && !beatableBids.includes(nextBid)) {
        beatableBids.push(nextBid);
      }
    }
    beatableBids.sort((a, b) => Number(a - b));

    const { accountBalance, accountMicronots, tip } = await this.getBidBalances();
    if (this.isStopping || planGeneration !== this.bidPlanGeneration) return;

    if (!beatableBids.length) {
      let lowestUnownedBid = BigInt(Number.MAX_SAFE_INTEGER);
      for (const { bidMicrogons, address } of bids) {
        lowestUnownedBid ??= bidMicrogons;
        if (!this.myAddresses.has(address) && bidMicrogons < lowestUnownedBid) {
          lowestUnownedBid = bidMicrogons;
        }
      }
      this.log(`Can't beat any price points with current params`, {
        minimumBidIncrement: formatArgons(this.minIncrement),
        lowestWinningBid: formatArgons(lowestUnownedBid),
        maxBid: formatArgons(this.options.maxBid),
      });
      this.setNextBid(undefined);
      this.safeRecordParamsAdjusted({
        tick: bidsAtTick,
        blockNumber,
        maxSeats: 0,
        winningBidCount: myWinningBids.length,
        reason: 'max-bid-too-low',
        availableBalanceForBids: accountBalance - 50_000n - tip,
        availableMicronots: accountMicronots,
      });
      return;
    }

    const bidsets = await Promise.all(
      beatableBids.map(async bidPrice => {
        const { plan, feeEstimate, availableBalanceForBids, availableMicronots } = await planBidWithFeeEstimate({
          microgonsPerSeat: bidPrice,
          seats: this.subaccounts.length,
          nextCohortSize: this.nextCohortSize!,
          micronotsPerSeat: this.micronotsPerSeat,
          accountBalance,
          accountMicronots,
          allWinningBids: bids,
          myWinningBids,
          subaccounts: this.subaccounts,
          tip,
          estimateFee: (subaccounts, bidAmount, feeTip) => this.estimateFee(bidAmount, subaccounts, feeTip),
        });
        let reductionReason: IBidReductionReason | undefined;
        if (
          plan.reason === 'max-bid-too-low' ||
          plan.reason === 'insufficient-argon-balance' ||
          plan.reason === 'insufficient-argonot-balance'
        ) {
          reductionReason = plan.reason;
        }

        return {
          bidAmount: bidPrice,
          accountsToBidWith: plan.accountsToBidWith,
          totalSeatsAfterBid: plan.seatsAfterBid,
          availableBalanceForBids,
          availableMicronots,
          estimatedFeePlusTip: feeEstimate + tip,
          reductionReason,
        };
      }),
    );
    if (this.isStopping || planGeneration !== this.bidPlanGeneration) return;

    bidsets.sort((a, b) => {
      // prioritize more seats, then lower bid
      const seatDiff = b.totalSeatsAfterBid - a.totalSeatsAfterBid;
      if (seatDiff !== 0) return seatDiff;
      return Number(a.bidAmount - b.bidAmount);
    });

    const {
      bidAmount: nextBidAmount,
      accountsToBidWith,
      totalSeatsAfterBid,
      availableBalanceForBids,
      availableMicronots,
      reductionReason,
    } = bidsets[0];
    // 3. if we have more seats than we can afford, we need to remove some
    if (totalSeatsAfterBid < myWinningBids.length || totalSeatsAfterBid < this.lastLoggedSeatsInBudget) {
      this.lastLoggedSeatsInBudget = totalSeatsAfterBid;
      this.log(
        `Can only afford ${totalSeatsAfterBid} seats with next bid of ${formatArgons(nextBidAmount)} at block #${blockNumber}`,
      );
      this.safeRecordParamsAdjusted({
        tick: bidsAtTick,
        blockNumber,
        maxSeats: totalSeatsAfterBid,
        winningBidCount: myWinningBids.length,
        reason: reductionReason,
        availableBalanceForBids,
        availableMicronots,
      });
    }

    if (totalSeatsAfterBid > myWinningBids.length && accountsToBidWith.length > 0) {
      const lastBidTick = this.lastBid?.submittedAtTick ?? 0;
      let nextBidSubmissionTick = Math.max(lastBidTick + this.options.bidDelay, bidsAtTick);

      // if we are close to VRF close, bid immediately
      if (frameRewardTicksRemaining <= this.ticksBeforeVrfClose) {
        nextBidSubmissionTick = bidsAtTick;
      }

      const nextBid = {
        microgonsPerSeat: nextBidAmount,
        bidAtTick: nextBidSubmissionTick,
        subaccounts: accountsToBidWith.map(x => x.address),
        alreadyWinningSeats: myWinningBids.length,
        tip,
      };
      if (this.setNextBid(nextBid)) {
        this.log(`Beatable bid price point found.`, {
          ...bidsets[0],
          ...nextBid,
          blockNumber,
        });
      }
    } else {
      this.log(`No bid planned.`, {
        totalSeatsAfterBid,
        myWinningBidsCount: myWinningBids.length,
        accountsToBidWithCount: accountsToBidWith.length,
        bestBidAmount: formatArgons(nextBidAmount),
        accountBalance: formatArgons(accountBalance),
        availableBalanceForBids: formatArgons(availableBalanceForBids),
        availableMicronots: formatArgons(availableMicronots),
        reductionReason,
        blockNumber,
      });
      this.setNextBid(undefined);
    }
  }

  private setNextBid(nextBid: CohortBidder['nextBid']): boolean {
    const hasDiff =
      this.nextBid?.bidAtTick !== nextBid?.bidAtTick ||
      this.nextBid?.microgonsPerSeat !== nextBid?.microgonsPerSeat ||
      this.nextBid?.subaccounts.toString() !== nextBid?.subaccounts.toString();
    if (!hasDiff) return false;
    this.nextBid = nextBid;
    this.broadcastUpdates();
    return true;
  }

  private async submitNextBid(rethrowOnError: boolean = false) {
    const nextBid = this.nextBid;

    if (!nextBid) {
      this.log('No next bid planned, skipping submission.');
      return;
    }
    this.setNextBid(undefined);

    try {
      const { microgonsPerSeat, subaccounts, tip } = nextBid;
      this.log(`Submitting bids for cohort ${this.cohortStartingFrameId}`, {
        frameId: this.cohortStartingFrameId,
        blockNumber: this.latestBlockNumber,
        microgonsPerSeat: formatArgons(microgonsPerSeat),
        subaccounts,
      });
      this.bidsAttempted += subaccounts.length;
      const submitter = await this.accountset.createMiningBidTx({
        subaccounts: subaccounts.map(x => ({ address: x })),
        bidAmount: microgonsPerSeat,
      });
      const bestBlockHeader = this.blockWatch.bestBlockHeader;
      const mortalityBlocks =
        bestBlockHeader.frameRewardTicksRemaining! <= DEFAULT_BID_MORTALITY_BLOCKS
          ? MINIMUM_BID_MORTALITY_BLOCKS
          : DEFAULT_BID_MORTALITY_BLOCKS;
      const era = submitter.client.registry.createType('ExtrinsicEra', {
        current: bestBlockHeader.blockNumber,
        period: mortalityBlocks,
      });
      const signedTx = await submitter.sign({
        blockHash: bestBlockHeader.blockHash,
        era,
        tip,
        useLatestNonce: true,
      });
      const txResult = await submitter.submitSigned(signedTx);
      const deathBlock = signedTx.era.asMortalEra.death(txResult.extrinsic.submittedAtBlockNumber);
      this.startBidMortalityFallback(txResult, deathBlock);
      this.pendingBidTxResult = txResult;
      const client = this.client;

      const inclusionError = await txResult.waitForInFirstBlock.then(() => undefined).catch((error: Error) => error);
      if (!txResult.blockHash) {
        throw inclusionError ?? new Error('Bid transaction did not report block inclusion');
      }

      const api = txResult.blockHash ? await client.at(txResult.blockHash) : client;
      const bidAtTick = await api.query.ticks.currentTick().then(x => x.toNumber());
      const successfulBids = txResult.batchInterruptedIndex ?? (txResult.extrinsicError ? 0 : subaccounts.length);
      this.lastBid = {
        submittedAtTick: bidAtTick,
        microgonsPerSeat,
        seats: subaccounts.length,
        seatsWon: successfulBids,
        isFinalized: false,
        expectedFinalizationTick: bidAtTick + 5,
      };
      this.broadcastUpdates();

      const finalization = this.awaitFinalization(txResult, microgonsPerSeat, subaccounts.length, rethrowOnError);
      const trackedFinalization = finalization.catch(() => undefined);
      this.pendingFinalizations.add(trackedFinalization);
      void trackedFinalization.finally(() => this.pendingFinalizations.delete(trackedFinalization));
      if (rethrowOnError) await finalization;
    } catch (err) {
      this.error(`Error bidding for cohort ${this.cohortStartingFrameId}:`, err);
      if (rethrowOnError) throw err;
    } finally {
      await new Promise(setImmediate);
      this.pendingRequest = undefined;
      this.pendingBidTxResult = undefined;
      try {
        await this.planNextBid(this.blockWatch.bestBlockHeader.frameRewardTicksRemaining!);
      } catch (error) {
        this.lastBidsHash = undefined;
        this.error('Error planning the next bid after a submission attempt:', error);
      }
    }
  }

  private startBidMortalityFallback(txResult: TxResult, deathBlock: number): void {
    let hasSearched = false;
    let isCheckingFinalizedBlock = false;
    let unsubscribeFinalized: (() => void) | undefined;
    const cleanup = () => {
      unsubscribeBest();
      unsubscribeFinalized?.();
    };
    const failTransaction = (error: unknown) => {
      if (txResult.isFinalized || txResult.submissionError) return;

      txResult.submissionError = error instanceof Error ? error : new Error(String(error));
    };
    const recover = async () => {
      unsubscribeBest();
      if (hasSearched || txResult.isFinalized || txResult.submissionError) return;

      hasSearched = true;

      try {
        const transaction = await TransactionEvents.findByExtrinsicHash({
          blockWatch: this.blockWatch,
          extrinsicHash: txResult.extrinsic.signedHash,
          searchStartBlockHeight: txResult.extrinsic.submittedAtBlockNumber,
          bestBlockHeight: deathBlock,
        });
        if (txResult.isFinalized || txResult.submissionError) return;
        if (!transaction) {
          this.log('Bid transaction mortality reached', {
            transactionHash: txResult.extrinsic.signedHash,
            submittedBlock: txResult.extrinsic.submittedAtBlockNumber,
            deathBlock,
          });
          txResult.submissionError = new Error('Bid transaction expired before block inclusion');
          return;
        }

        await txResult.setSeenInBlock({
          blockHash: hexToU8a(transaction.blockHash),
          blockNumber: transaction.blockNumber,
          events: transaction.extrinsicEvents,
          extrinsicIndex: transaction.extrinsicIndex,
        });
        this.log('Recovered bid transaction after its status subscription went silent', {
          transactionHash: txResult.extrinsic.signedHash,
          submittedBlock: txResult.extrinsic.submittedAtBlockNumber,
          deathBlock,
          includedBlock: transaction.blockNumber,
        });

        const finalizeRecoveredTransaction = async (finalizedHeight: number) => {
          if (
            isCheckingFinalizedBlock ||
            finalizedHeight < transaction.blockNumber ||
            txResult.isFinalized ||
            txResult.submissionError
          ) {
            return;
          }

          isCheckingFinalizedBlock = true;
          try {
            const finalizedHash = await this.blockWatch.getFinalizedHash(transaction.blockNumber);
            if (txResult.isFinalized || txResult.submissionError) return;

            if (finalizedHash !== transaction.blockHash) {
              failTransaction(new Error('Recovered bid transaction was reorged before finalization'));
              return;
            }

            await txResult.setFinalized();
          } catch (error) {
            failTransaction(error);
          } finally {
            isCheckingFinalizedBlock = false;
          }
        };

        if (txResult.isFinalized || txResult.submissionError) return;

        unsubscribeFinalized = this.blockWatch.events.on('finalized', headers => {
          void finalizeRecoveredTransaction(headers.at(-1)!.blockNumber);
        });
        await finalizeRecoveredTransaction(this.blockWatch.finalizedBlockHeader.blockNumber);
      } catch (error) {
        this.error('Error recovering bid transaction at mortality', error);
        failTransaction(error);
      }
    };
    const unsubscribeBest = this.blockWatch.events.on('best-blocks', headers => {
      if (headers.at(-1)!.blockNumber >= deathBlock) {
        void recover();
      }
    });

    if (this.blockWatch.bestBlockHeader.blockNumber >= deathBlock) {
      void recover();
    }
    void txResult.waitForFinalizedBlock.catch(() => undefined).finally(cleanup);
  }

  private async awaitFinalization(
    txResult: TxResult,
    microgonsPerSeat: bigint,
    submittedCount: number,
    rethrowOnError: boolean = false,
  ) {
    const pendingBid = this.lastBid;

    try {
      const bidError = await txResult.waitForFinalizedBlock.then(() => undefined).catch((x: ExtrinsicError) => x);
      const client = this.client;
      const api = txResult.blockHash ? await client.at(txResult.blockHash) : client;
      const blockNumber: number = txResult.blockNumber ?? (await api.query.system.number().then(x => x.toNumber()));
      const bidAtTick = await api.query.ticks.currentTick().then(x => x.toNumber());
      const successfulBids =
        txResult.batchInterruptedIndex ?? (bidError || txResult.extrinsicError ? 0 : submittedCount);

      if (pendingBid) {
        pendingBid.isFinalized = true;
        pendingBid.seatsWon = successfulBids;
      }
      this.txFees += txResult.finalFee ?? 0n;

      this.log('Finalized bids for cohort', {
        frameId: this.cohortStartingFrameId,
        successfulBids,
        bidsPlaced: submittedCount,
        bidPerSeat: formatArgons(microgonsPerSeat),
        bidAtTick,
        bidAtBlockNumber: blockNumber,
        hasError: !!bidError,
      });

      if (bidError) {
        try {
          this.callbacks?.onBidsRejected?.({
            tick: bidAtTick,
            blockNumber,
            microgonsPerSeat,
            submittedCount,
            rejectedCount: submittedCount - successfulBids,
            bidError,
          });
        } catch (error) {
          this.error('Error in onBidsRejected callback:', error);
        }
      } else {
        try {
          this.callbacks?.onBidsSubmitted?.({
            tick: bidAtTick,
            blockNumber,
            microgonsPerSeat,
            txFeePlusTip: txResult.finalFee ?? 0n,
            submittedCount,
          });
        } catch (error) {
          this.error('Error in onBidsSubmitted callback:', error);
        }
      }

      this.broadcastUpdates();
      if (bidError && rethrowOnError) throw bidError;
    } catch (err) {
      this.error('Error awaiting bid finalization:', err);
      if (rethrowOnError) throw err;
    }
  }

  private clampBid(bid: bigint) {
    if (bid < this.options.minBid) return this.options.minBid;
    if (bid > this.options.maxBid) return this.options.maxBid;
    return bid;
  }

  private async estimateFee(nextBid: bigint, subaccounts: { address: string }[], tip: bigint): Promise<bigint> {
    if (!subaccounts.length) return 0n;

    const fakeTx = await this.accountset.createMiningBidTx({
      subaccounts,
      bidAmount: nextBid,
    });
    return await fakeTx.feeEstimate(tip);
  }

  private async getBidBalances() {
    const [submitterBalance, stakedMicronots] = await Promise.all([
      this.accountset.submitterBalance(),
      this.accountset.accountMicronots(),
    ]);

    return {
      accountBalance: bigIntMax(submitterBalance - (this.options.sidelinedWalletMicrogons ?? 0n), 0n),
      accountMicronots: bigIntMax(stakedMicronots - (this.options.sidelinedWalletMicronots ?? 0n), 0n),
      tip: this.options.tipPerTransaction ?? 0n,
    };
  }

  private updateBidList(
    rawBids: Vec<ArgonPrimitivesBlockSealMiningRegistration>,
    blockNumber: number,
    tick: number,
    isReloadingInitialState = false,
  ) {
    try {
      let mostRecentBidTick = 0;
      const bids = rawBids.map(rawBid => {
        const bidAtTick = rawBid.bidAtTick.toNumber();
        mostRecentBidTick = Math.max(bidAtTick, mostRecentBidTick);
        return {
          address: rawBid.accountId.toHuman(),
          micronotsStaked: rawBid.argonots.toBigInt(),
          bidMicrogons: rawBid.bid.toBigInt(),
          bidAtTick,
        };
      });

      this.currentBids.bids = bids;
      this.currentBids.mostRecentBidTick = mostRecentBidTick;
      this.currentBids.atTick = tick;
      this.currentBids.atBlockNumber = blockNumber;
      this.myWinningBids = bids.filter(x => this.myAddresses.has(x.address));
      if (!isReloadingInitialState) {
        this.log(`Now winning ${this.myWinningBids.length} bids at block #${blockNumber}`);
      }
      this.callbacks?.onBidsUpdated?.({
        bids,
        atBlockNumber: blockNumber,
        tick: mostRecentBidTick,
        isReloadingInitialState,
      });
    } catch (err) {
      this.error('Error processing updated bids list:', err);
    }
  }

  private safeRecordParamsAdjusted(args: {
    tick: number;
    blockNumber: number;
    winningBidCount: number;
    maxSeats: number;
    reason: IBidReductionReason | undefined;
    availableBalanceForBids: bigint;
    availableMicronots: bigint;
  }) {
    try {
      this.callbacks?.onBidParamsAdjusted?.(args);
    } catch (err) {
      this.error('Error in onBidParamsAdjusted callback:', err);
    }
  }

  protected log(text: string, ...args: any[]): void {
    console.log(`[${this.name}] ${text}`, ...args);
  }

  protected info(text: string, ...args: any[]): void {
    console.info(`[${this.name}] ${text}`, ...args);
  }

  protected error(text: string, ...args: any[]): void {
    console.error(`[${this.name}] ${text}`, ...args);
  }
}

export type IBidReductionReason = 'max-bid-too-low' | 'insufficient-argon-balance' | 'insufficient-argonot-balance';
