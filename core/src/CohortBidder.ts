import type { Accountset } from './Accountset.js';
import {
  type ArgonClient,
  type ArgonPrimitivesBlockSealMiningRegistration,
  Bool,
  ExtrinsicError,
  formatArgons,
  getTickFromHeader,
  type Header,
  u64,
  Vec,
} from '@argonprotocol/mainchain';
import { MiningFrames } from './MiningFrames.js';

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
  public get client(): ArgonClient {
    return this.accountset.client;
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

  private unsubscribe?: () => void;
  private lastLoggedSeatsInBudget: number;

  private pendingRequest: Promise<any> | undefined;
  private isStopped = false;
  private minIncrement = 10_000n;

  private nextCohortSize?: number;
  private micronotsPerSeat!: bigint;

  private lastBidTick: number = 0;
  private latestBlockNumber: number = 0;

  private evaluateInterval?: NodeJS.Timeout;
  private hasStartedCheckingBids = false;
  private lastBidsHash: string | undefined;
  private bidsForNextSlotCohortKey!: string;
  private readonly name: string;

  constructor(
    public accountset: Accountset,
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
    this.name =
      name ??
      `${accountset.txSubmitterPair.address.substring(0, 6)}...${accountset.txSubmitterPair.address.slice(-4)} #${cohortStartingFrameId}`;
  }

  public async start() {
    const client = this.client;
    this.minIncrement = client.consts.miningSlot.bidIncrements.toBigInt();
    this.bidsForNextSlotCohortKey = client.query.miningSlot.bidsForNextSlotCohort.key();
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

    // check the current header in case we started late
    const header = await client.rpc.chain.getHeader();
    await this.onHeader(header, true);
    this.unsubscribe = await client.rpc.chain.subscribeNewHeads(async header => {
      if (this.isStopped) return;
      await this.onHeader(header, false);
    });
  }

  public async stop(waitForFinalBids = true): Promise<CohortBidder['myWinningBids']> {
    if (this.isStopped) return this.myWinningBids;
    this.isStopped = true;
    clearInterval(this.evaluateInterval);
    this.log('Stopping bidder for cohort', this.cohortStartingFrameId);
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    if (!waitForFinalBids) {
      return this.myWinningBids;
    }
    const client = this.client;
    const [nextFrameId, isBiddingOpen] = await client.queryMulti<[u64, Bool]>([
      client.query.miningSlot.nextFrameId as any,
      client.query.miningSlot.isNextSlotBiddingOpen,
    ]);
    if (nextFrameId.toNumber() === this.cohortStartingFrameId && isBiddingOpen.isTrue) {
      this.log('Bidding is still open, waiting for it to close');
      await new Promise<void>(async resolve => {
        const unsub = await client.query.miningSlot.isNextSlotBiddingOpen(isOpen => {
          if (isOpen.isFalse) {
            unsub();
            resolve();
          }
        });
      });
    }
    // wait for any pending request to finish updating stats
    void (await this.pendingRequest);

    const currentFrameId = await client.query.miningSlot.nextFrameId();
    let blockNumber: number;
    // go back to last block with this cohort
    if (currentFrameId.toNumber() > this.cohortStartingFrameId) {
      blockNumber = (await client.query.miningSlot.frameStartBlockNumbers().then(x => x[0]?.toNumber())) - 1;
    } else {
      blockNumber = await client.query.system.number().then(x => x.toNumber());
    }

    const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
    const header = await client.rpc.chain.getHeader(blockHash);
    await this.onHeader(header, false);
    this.log('Bidder stopped', {
      cohortStartingFrameId: this.cohortStartingFrameId,
      blockNumber,
      winningBids: this.myWinningBids,
    });

    return this.myWinningBids;
  }

  private async onHeader(header: Header, isFirstLoad: boolean): Promise<void> {
    const client = this.client;
    // check if the header is for the next frame
    const clientAt = await client.at(header.hash);
    const nextFrameId = await clientAt.query.miningSlot.nextFrameId();
    const blockNumber = header.number.toNumber();
    this.latestBlockNumber = blockNumber;

    if (nextFrameId.toNumber() === this.cohortStartingFrameId) {
      const tick = getTickFromHeader(client, header);
      // check if it changed first
      const latestHash = await client.rpc.state
        .getStorageHash(this.bidsForNextSlotCohortKey, header.hash)
        .then(x => x.toHex());
      if (this.lastBidsHash !== latestHash) {
        this.lastBidsHash = latestHash;
        const rawBids = await clientAt.query.miningSlot.bidsForNextSlotCohort();
        this.updateBidList(rawBids, blockNumber, tick!, isFirstLoad);
      } else {
        this.log('No changes to bids list at block #', blockNumber);
      }
      if (!this.hasStartedCheckingBids) {
        this.hasStartedCheckingBids = true;
        // reset schedule to the tick changes
        this.scheduleEvaluation();
        void this.checkWinningBids();
      }
    }
  }

  private async checkWinningBids() {
    if (this.isStopped) return;

    // don't process two bids at the same time
    if (this.pendingRequest) {
      this.log(`Current bid is still in progress at block #${this.latestBlockNumber}, skipping this check`);
      return;
    }

    // if we submitted a bid more recently than the max bid tick, hold off
    if (this.currentBids.mostRecentBidTick < this.lastBidTick) {
      this.log(`Waiting for bids more recent than our last attempt.`, {
        ownAttemptedBidTick: this.lastBidTick,
        liveBidsTick: this.currentBids.mostRecentBidTick,
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
      const nextBid = this.clampBid(bidMicrogons + this.options.bidIncrement);

      if (nextBid >= bidMicrogons + this.minIncrement && !beatableBids.includes(nextBid)) {
        beatableBids.push(nextBid);
      }
    }
    beatableBids.sort((a, b) => Number(a - b));

    let accountBalance = await this.accountset.submitterBalance();
    accountBalance -= this.options.sidelinedWalletMicrogons ?? 0n;
    if (accountBalance <= 0n) accountBalance = 0n;
    let accountMicronots = await this.accountset.submitterMicronots();
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
        // shrink to affordable bids
        if (bidPrice > 0n) {
          const maxBids = Math.floor(Number(availableBalanceForBids / bidPrice));
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
      bidAmount: nextBid,
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
        `Can only afford ${totalSeatsAfterBid} seats with next bid of ${formatArgons(nextBid)} at block #${blockNumber}`,
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
      this.log(`Beatable bid price point found.`, {
        ...bidsets[0],
        accountsToBidWith: accountsToBidWith.map(x => x.index),
        currentlyWinning: myWinningBids.length,
        blockNumber,
      });
      this.pendingRequest = this.submitBids(nextBid, accountsToBidWith);
    }
  }

  private async submitBids(microgonsPerSeat: bigint, subaccounts: { address: string }[]) {
    try {
      this.bidsAttempted += subaccounts.length;
      const submitter = await this.accountset.createMiningBidTx({
        subaccounts,
        bidAmount: microgonsPerSeat,
      });
      const tip = this.options.tipPerTransaction ?? 0n;
      const txResult = await submitter.submit({
        tip,
        useLatestNonce: true,
      });

      const bidError = await txResult.finalizedPromise.then(() => undefined).catch((x: ExtrinsicError) => x);

      const client = this.client;
      const api = txResult.includedInBlock ? await client.at(txResult.includedInBlock) : client;

      this.lastBidTick = await api.query.ticks.currentTick().then(x => x.toNumber());
      const blockNumber = await api.query.system.number().then(x => x.toNumber());
      const bidAtTick = this.lastBidTick;

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

      const successfulBids = txResult.batchInterruptedIndex ?? subaccounts.length;

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
      this.pendingRequest = undefined;
      // always delay after submitting
      this.scheduleEvaluation();
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

  private scheduleEvaluation() {
    if (this.isStopped) return;
    const millisPerTick = MiningFrames.tickMillis;
    const delayTicks = Math.max(this.options.bidDelay, 1);
    const randomDelay = Math.floor(Math.random() * millisPerTick);
    const delay = delayTicks * millisPerTick + randomDelay;

    if (this.evaluateInterval) clearInterval(this.evaluateInterval);
    this.log(`Scheduling next evaluation in ${delay}ms`);
    this.evaluateInterval = setInterval(
      () => this.checkWinningBids().catch(err => this.error('Error checking winning bids', err)),
      delay,
    );
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
