import type { Accountset } from './Accountset.js';
import {
  type ArgonClient,
  type ArgonPrimitivesBlockSealMiningRegistration,
  ExtrinsicError,
  formatArgons,
  type TxResult,
  Vec,
} from '@argonprotocol/mainchain';
import { subscribeToFinalizedStorageChanges } from './StorageSubscriber.js';
import { BlockWatch, type IBlockHeaderInfo } from './BlockWatch.js';
import type { MiningFrames } from './MiningFrames.js';
import { createDeferred } from './Deferred.js';
import { JsonExt } from './JsonExt.js';

interface IBidDetail {
  address: string;
  micronotsStaked: bigint;
  bidMicrogons: bigint;
  bidAtTick: number;
}

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
  private stopDeferred = createDeferred<void>(false);
  private minIncrement = 10_000n;
  private ticksBeforeVrfClose = 30;

  private nextCohortSize?: number;
  private micronotsPerSeat!: bigint;

  private lastBidsHash: string | undefined;
  private bidsForNextSlotCohortKey!: string;
  private readonly name: string;

  constructor(
    public accountset: Accountset,
    public miningFrames: MiningFrames,
    public cohortStartingFrameId: number,
    public subaccounts: { index: number; isRebid: boolean; address: string }[],
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
        // wait for any pending request to finish updating stats
        void (await this.pendingRequest);

        let lastFrameHeader: IBlockHeaderInfo;
        // go back to last block with this cohort
        if (this.miningFrames.currentFrameId >= this.cohortStartingFrameId) {
          const blockNumberInLastFrame = this.miningFrames.framesById[this.cohortStartingFrameId].firstBlockNumber! - 1;
          lastFrameHeader = await this.blockWatch.getHeader(blockNumberInLastFrame);
        } else {
          lastFrameHeader = this.blockWatch.bestBlockHeader;
        }
        await this.onHeader(lastFrameHeader, false);
        this.log('Bidder stopped', {
          cohortStartingFrameId: this.cohortStartingFrameId,
          blockNumber: lastFrameHeader.blockNumber,
          winningBids: this.myWinningBids,
        });
      }
      this.onUpdatedFn = undefined;
    } finally {
      this.stopDeferred.resolve();
    }

    return this.myWinningBids;
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
      this.lastBidsHash = latestCohortBidsHash;
      const clientAt = await client.at(header.blockHash);
      const rawBids = await clientAt.query.miningSlot.bidsForNextSlotCohort();
      this.updateBidList(rawBids, blockNumber, tick, isFirstLoad);

      await this.planNextBid(header.frameRewardTicksRemaining);
    }

    if (this.nextBid && this.nextBid.bidAtTick <= header.tick) {
      this.pendingRequest ??= this.submitNextBid();
    }
  }

  private async planNextBid(frameRewardTicksRemaining = 1440) {
    if (this.isStopping) return;

    // don't process two bids at the same time
    if (this.pendingRequest) {
      this.log(`Current bid is still in progress at block #${this.latestBlockNumber}, skipping this check`);
      return;
    }

    // if our latest bid is more recent than the current bids, wait
    if (this.currentBids.mostRecentBidTick < (this.lastBid?.submittedAtTick ?? 0)) {
      this.log(`Waiting for bids more recent than our last attempt.`, {
        ownAttemptedBidTick: this.lastBid?.submittedAtTick,
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
      this.log(`No updates needed at block #${blockNumber}. Winning all remaining seats (${myWinningBids.length}).`);
      return;
    }

    this.log(
      `Checking bids for cohort ${this.cohortStartingFrameId} at block ${this.latestBlockNumber}, Still trying for seats: ${this.subaccounts.length}. Currently winning ${myWinningBids.length} bids.`,
    );

    const myWinningAddresses = new Set(myWinningBids.map(x => x.address));
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

    let accountBalance = await this.accountset.submitterBalance();
    accountBalance -= this.options.sidelinedWalletMicrogons ?? 0n;
    if (accountBalance <= 0n) accountBalance = 0n;
    let accountMicronots = await this.accountset.accountMicronots();
    accountMicronots -= this.options.sidelinedWalletMicronots ?? 0n;
    if (accountMicronots < 0n) accountMicronots = 0n;

    const tip = this.options.tipPerTransaction ?? 0n;

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

    this.subaccounts.sort((a, b) => {
      const isWinningA = myWinningAddresses.has(a.address);
      const isWinningB = myWinningAddresses.has(b.address);
      if (isWinningA && !isWinningB) return -1;
      if (!isWinningA && isWinningB) return 1;

      if (a.isRebid && !b.isRebid) return -1;
      if (!a.isRebid && b.isRebid) return 1;
      return a.index - b.index;
    });

    const bidsets = await Promise.all(
      beatableBids.map(async bidPrice => {
        const feeEstimate = await this.estimateFee(bidPrice, tip);
        const estimatedFeePlusTip = feeEstimate + tip;

        let availableBalanceForBids = accountBalance - estimatedFeePlusTip;
        let alreadySpentMicrogons = 0n;
        let availableMicronots = accountMicronots;
        let alreadySpentMicronots = 0n;

        let accountStayingWinner = 0;
        const accountsToBidWith = this.subaccounts.filter(y => {
          const bid = myWinningBids.find(b => b.address === y.address);
          if (!bid) return true;
          if (bid.bidMicrogons >= bidPrice) {
            accountStayingWinner += 1;
            alreadySpentMicrogons += bid.bidMicrogons;
            alreadySpentMicronots += bid.micronotsStaked;
            return false;
          } else {
            // rebid this account
            availableBalanceForBids += bid.bidMicrogons;
            availableMicronots += bid.micronotsStaked;
            return true;
          }
        });

        const bidsToReplace = bids.filter(x => x.bidMicrogons < bidPrice).length;
        const emptyBids = this.nextCohortSize! - bids.length;
        const availableBidsToReplace = bidsToReplace + emptyBids;

        let reductionReason: IBidReductionReason | undefined;
        if (accountsToBidWith.length > availableBidsToReplace) {
          accountsToBidWith.length = availableBidsToReplace;
          reductionReason = 'max-bid-too-low';
        }
        // shrink to affordable micronots
        const totalMicronotsNeeded = BigInt(accountsToBidWith.length) * this.micronotsPerSeat;
        if (totalMicronotsNeeded > availableMicronots) {
          const maxSeats = Math.floor(Number(availableMicronots / this.micronotsPerSeat));
          if (accountsToBidWith.length > maxSeats) {
            this.log('Reducing bids due to nsf micronots', {
              maxSeats,
              availableMicronots,
              accountsToBidWith: accountsToBidWith.length,
            });
            accountsToBidWith.length = maxSeats;
            reductionReason = 'insufficient-argonot-balance';
          }
        }
        // can't afford any bids
        if (availableBalanceForBids < 0n) {
          availableBalanceForBids = 0n;
          accountsToBidWith.length = 0;
          reductionReason = 'insufficient-argon-balance';
        }
        // shrink to affordable bids
        else if (bidPrice > 0n) {
          let maxBids = Math.floor(Number(availableBalanceForBids / bidPrice));
          if (maxBids < 0) maxBids = 0;
          if (accountsToBidWith.length > maxBids) {
            accountsToBidWith.length = maxBids;
            reductionReason = 'insufficient-argon-balance';
          }
        }
        return {
          bidAmount: bidPrice,
          accountsToBidWith,
          totalSeatsAfterBid: accountStayingWinner + accountsToBidWith.length,
          availableBalanceForBids,
          availableMicronots,
          estimatedFeePlusTip,
          reductionReason,
        };
      }),
    );
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
      if (frameRewardTicksRemaining !== undefined && frameRewardTicksRemaining <= this.ticksBeforeVrfClose) {
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
      this.setNextBid(undefined);
    }
  }

  private setNextBid(nextBid: CohortBidder['nextBid']): boolean {
    const hasDiff = JsonExt.stringify(this.nextBid) !== JsonExt.stringify(nextBid);
    if (!hasDiff) return false;
    this.nextBid = nextBid;
    this.broadcastUpdates();
    return true;
  }

  private async submitNextBid() {
    try {
      const nextBid = this.nextBid;
      if (!nextBid) {
        this.log('No next bid planned, skipping submission.');
        return;
      }
      this.nextBid = undefined;

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
      const txResult = await submitter.submit({
        tip,
        useLatestNonce: true,
      });
      this.pendingBidTxResult = txResult;
      const client = this.client;
      this.lastBid = {
        submittedAtTick: this.blockWatch.bestBlockHeader.tick,
        microgonsPerSeat,
        seats: subaccounts.length,
        isFinalized: false,
        expectedFinalizationTick: this.blockWatch.bestBlockHeader.tick + 5,
      };
      this.broadcastUpdates();

      const bidError = await txResult.waitForFinalizedBlock.then(() => undefined).catch((x: ExtrinsicError) => x);

      const api = txResult.blockHash ? await client.at(txResult.blockHash) : client;

      const blockNumber: number = txResult.blockNumber ?? (await api.query.system.number().then(x => x.toNumber()));
      const bidAtTick = await api.query.ticks.currentTick().then(x => x.toNumber());
      // always track this so we don't bid again before getting newer results
      this.lastBid.isFinalized = true;

      const successfulBids = txResult.batchInterruptedIndex ?? subaccounts.length;
      this.lastBid.seatsWon = successfulBids;
      this.broadcastUpdates();

      try {
        this.callbacks?.onBidsSubmitted?.({
          tick: bidAtTick,
          blockNumber,
          microgonsPerSeat,
          txFeePlusTip: txResult.finalFee ?? 0n,
          submittedCount: subaccounts.length,
        });
      } catch (error) {
        this.error('Error in onBidsSubmitted callback:', error);
      }

      this.txFees += txResult.finalFee ?? 0n;

      this.log('Result of bids for cohort', {
        frameId: this.cohortStartingFrameId,
        successfulBids,
        bidsPlaced: subaccounts.length,
        bidPerSeat: formatArgons(microgonsPerSeat),
        bidAtTick,
        bidAtBlockNumber: blockNumber,
      });

      if (bidError) {
        try {
          this.callbacks?.onBidsRejected?.({
            tick: bidAtTick,
            blockNumber,
            microgonsPerSeat,
            submittedCount: subaccounts.length,
            rejectedCount: subaccounts.length - successfulBids,
            bidError,
          });
        } catch (error) {
          this.error('Error in onBidsRejected callback:', error);
        }
        throw bidError;
      }
    } catch (err) {
      this.error(`Error bidding for cohort ${this.cohortStartingFrameId}:`, err);
    } finally {
      // have to yield to be able to overwrite pendingRequest
      await new Promise(setImmediate);
      this.pendingRequest = undefined;
      this.pendingBidTxResult = undefined;
    }
  }

  private clampBid(bid: bigint) {
    if (bid < this.options.minBid) return this.options.minBid;
    if (bid > this.options.maxBid) return this.options.maxBid;
    return bid;
  }

  private async estimateFee(nextBid: bigint, tip: bigint): Promise<bigint> {
    const fakeTx = await this.accountset.createMiningBidTx({
      subaccounts: this.subaccounts,
      bidAmount: nextBid,
    });
    return await fakeTx.feeEstimate(tip);
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
