import { MINING_BID_PROXY_FEE_FLOAT, type Accountset } from './Accountset.js';
import { ExtrinsicError, formatArgons, hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import type { ArgonClient } from './MainchainClients.js';
import { BlockWatch, type IBlockHeaderInfo } from './BlockWatch.js';
import type { MiningFrames } from './MiningFrames.js';
import { createDeferred } from './Deferred.js';
import { planBidWithFeeEstimate, type IBidPlanBid, type IBidPlanSubaccount } from './BidPlan.js';
import { TransactionEvents } from './TransactionEvents.js';
import type { TxResult } from './TxResult.js';
import { TxSubmitter } from './TxSubmitter.js';

interface IBidDetail extends IBidPlanBid {
  bidAtTick: number;
}

// Substrate mortal-era periods are powers of two, so 8 is the safe period closest to ten blocks.
const DEFAULT_BID_MORTALITY_BLOCKS = 8;
const MINIMUM_BID_MORTALITY_BLOCKS = 4;
const REPLACEMENT_TIP_INCREMENT = 100_000n;

interface IBidAttempt {
  txResult: TxResult;
  tip: bigint;
  deathBlock: number;
  microgonsPerSeat: bigint;
  subaccounts: string[];
  inclusion?: { blockHash: string; blockNumber: number };
  needsReplacement?: boolean;
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
  public get pendingBidTxResult(): TxResult | undefined {
    return this.activeBidAttempt?.txResult;
  }
  public isBiddingOpen = true;

  public get isBidInProgress(): boolean {
    return !!this.pendingRequest || (!!this.activeBidAttempt && !this.activeBidAttempt.inclusion);
  }
  public get isStopping(): boolean {
    return this.stopDeferred.isRunning || this.stopDeferred.isSettled;
  }

  public txFees = 0n;
  public bidsAttempted = 0;
  public myWinningBids: IBidDetail[] = [];
  public botCapital?: { microgons: bigint; micronots: bigint };
  public readonly myAddresses = new Set<string>();

  public get currentAuctionSeatCount(): number | undefined {
    return this.nextCohortSize;
  }

  public get currentAuctionMicronotsPerSeat(): bigint | undefined {
    return this.nextCohortSize === undefined ? undefined : this.micronotsPerSeat;
  }

  public get seatGoalCount(): number {
    return this.subaccounts.length;
  }

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
  private lastReportedReductionReason?: IBidReductionReason;
  private lastReportedBotCapital?: { microgons: bigint; micronots: bigint };

  private pendingRequest: Promise<any> | undefined;
  private pendingFinalizations = new Set<Promise<void>>();
  private activeBidAttempt?: IBidAttempt;
  private lastBidAttempt?: IBidAttempt;
  private stopDeferred = createDeferred<void>(false);
  private minIncrement = 10_000n;
  private ticksBeforeVrfClose = 30;

  private nextCohortSize?: number;
  private micronotsPerSeat!: bigint;

  private lastBidsHash: string | undefined;
  private bidsForNextSlotCohortKey!: string;
  private bidPlanGeneration = 0;
  private headerGeneration = 0;
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
      onFinalizedBidActivityError?(error: Error): void;
    },
    name?: string,
  ) {
    this.subaccounts.forEach(x => {
      this.myAddresses.add(x.address);
    });
    this.lastLoggedSeatsInBudget = subaccounts.length;
    this.name = name ?? `BIDDER #${cohortStartingFrameId}`;
  }

  public async start() {
    await this.blockWatch.start();
    const client = this.client;
    this.minIncrement = client.consts.miningSlot.bidIncrements;
    this.bidsForNextSlotCohortKey = client.query.miningSlot.bidsForNextSlotCohort.key();
    this.ticksBeforeVrfClose = await client.query.miningSlot.miningConfig().then(x => x.ticksBeforeBidEndForVrfClose);
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
      seatCount: this.subaccounts.length,
    });

    this.nextCohortSize = await client.query.miningSlot.nextCohortSize();
    this.micronotsPerSeat = await client.query.miningSlot.argonotsPerMiningSeat();
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

  public async stop(waitForFinalBids = true, shutdownSignal?: AbortSignal): Promise<CohortBidder['myWinningBids']> {
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
      waitForFinalBids &&= !shutdownSignal?.aborted;
      if (waitForFinalBids && (this.blockWatch.finalizedBlockHeader.frameId ?? 0) < this.cohortStartingFrameId) {
        this.log('Waiting for finalized cohort activation', this.cohortStartingFrameId);
        const activation = createDeferred<void>();
        const unsubscribe = this.blockWatch.events.on('finalized', headers => {
          if ((headers.at(-1)!.frameId ?? 0) >= this.cohortStartingFrameId) activation.resolve();
        });
        const onShutdown = () => activation.resolve();
        shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
        try {
          await activation.promise;
          waitForFinalBids &&= !shutdownSignal?.aborted;
        } finally {
          unsubscribe();
          shutdownSignal?.removeEventListener('abort', onShutdown);
        }
      }
      void (await this.pendingRequest);
      if (waitForFinalBids) {
        // wait for any pending finalization to finish updating stats
        await Promise.all(this.pendingFinalizations);

        const stopBlockHash = await this.client.rpc.chain.getFinalizedHead();
        const stopApi = await this.client.at(stopBlockHash);
        const blockNumber = await stopApi.query.system.number();
        const cohortWinners = (await stopApi.query.miningSlot.minersByCohort(this.cohortStartingFrameId)) ?? [];
        this.myWinningBids = cohortWinners
          .filter(
            x => x.externalFundingAccount !== null && this.accountset.fundingAccountId === x.externalFundingAccount,
          )
          .map(x => {
            return {
              address: x.accountId,
              micronotsStaked: x.argonots,
              bidMicrogons: x.bid,
              bidAtTick: this.currentBids.atTick,
            };
          });
        this.log('Bidder stopped', {
          cohortStartingFrameId: this.cohortStartingFrameId,
          blockNumber,
          winningSeatCount: this.myWinningBids.length,
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
    const headerGeneration = ++this.headerGeneration;
    const client = this.client;
    // check if the header is for the next frame
    const currentFrameId = header.frameId!;
    const blockNumber = header.blockNumber;
    this.latestBlockNumber = blockNumber;
    this.latestUpdateDate = new Date();

    if (currentFrameId + 1 !== this.cohortStartingFrameId) {
      return;
    }
    const wasReorged = await this.reconcileBidAttempt(header);
    if (headerGeneration !== this.headerGeneration) return;
    const tick = header.tick;
    // check if it changed first
    const latestCohortBidsHash = await client.rpc.state
      .getStorageHash(this.bidsForNextSlotCohortKey, header.blockHash)
      .then(x => x.toHex());
    if (headerGeneration !== this.headerGeneration) return;

    if (this.lastBidsHash !== latestCohortBidsHash) {
      const previousBidsHash = this.lastBidsHash;
      try {
        const clientAt = await client.at(header.blockHash);
        const rawBids = await clientAt.query.miningSlot.bidsForNextSlotCohort();
        if (headerGeneration !== this.headerGeneration) return;

        this.lastBidsHash = latestCohortBidsHash;
        this.updateBidList(rawBids ?? [], blockNumber, tick, isFirstLoad);

        await this.planNextBid(header.frameRewardTicksRemaining!);
        if (headerGeneration !== this.headerGeneration) return;
        // Other bidders change the live auction even when our own bid plan stays unchanged.
        this.broadcastUpdates();
      } catch (error) {
        if (this.lastBidsHash === latestCohortBidsHash) {
          this.lastBidsHash = previousBidsHash;
        }
        throw error;
      }
    } else {
      const events = await this.blockWatch.getEvents(header);
      if (headerGeneration !== this.headerGeneration) return;
      const fundingBalanceChanged = events.some(({ event }) => {
        if (event.section !== 'balances' && event.section !== 'ownership') return false;

        return Object.values(event.data).includes(this.accountset.fundingAccountId);
      });

      if (fundingBalanceChanged || wasReorged) {
        await this.planNextBid(header.frameRewardTicksRemaining!);
        if (headerGeneration !== this.headerGeneration) return;
      }
    }

    if (this.nextBid && this.nextBid.bidAtTick <= header.tick) {
      if (!this.pendingRequest) {
        this.pendingRequest = this.submitNextBid();
        this.broadcastUpdates();
      }
    }
  }

  private async planNextBid(frameRewardTicksRemaining: number) {
    const planGeneration = ++this.bidPlanGeneration;
    if (this.isStopping) return;

    if (this.pendingRequest) {
      this.log(`Current bid is still in progress at block #${this.latestBlockNumber}, skipping this check`);
      return;
    }

    const lastBid = this.lastBid;
    const lastBidTick = lastBid?.submittedAtTick ?? 0;
    if (
      (lastBid?.seatsWon ?? 0) > 0 &&
      this.lastBidAttempt?.inclusion &&
      this.currentBids.atBlockNumber < this.lastBidAttempt.inclusion.blockNumber
    ) {
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
    if (this.isStopping || planGeneration !== this.bidPlanGeneration) return;
    let accountMicronots = await this.accountset.accountMicronots();
    if (this.isStopping || planGeneration !== this.bidPlanGeneration) return;

    this.botCapital = {
      microgons: accountBalance + myWinningBids.reduce((total, bid) => total + bid.bidMicrogons, 0n),
      micronots: accountMicronots + myWinningBids.reduce((total, bid) => total + bid.micronotsStaked, 0n),
    };

    if (myWinningBids.length >= this.subaccounts.length) {
      const didClearNextBid = this.setNextBid(undefined);
      const botCapitalChanged =
        this.botCapital.microgons !== this.lastReportedBotCapital?.microgons ||
        this.botCapital.micronots !== this.lastReportedBotCapital?.micronots;
      if (botCapitalChanged) {
        this.lastReportedBotCapital = this.botCapital;
        if (!didClearNextBid) this.broadcastUpdates();
      }
      this.log(`No updates needed at block #${blockNumber}. Winning all remaining seats (${myWinningBids.length}).`);
      return;
    }

    this.log(
      `Checking bids for cohort ${this.cohortStartingFrameId} at block ${this.latestBlockNumber}, Still trying for seats: ${this.subaccounts.length}. Currently winning ${myWinningBids.length} bids.`,
    );

    accountBalance -= this.options.sidelinedWalletMicrogons ?? 0n;
    if (accountBalance <= 0n) accountBalance = 0n;

    accountMicronots -= this.options.sidelinedWalletMicronots ?? 0n;
    if (accountMicronots < 0n) accountMicronots = 0n;

    let tip = this.options.tipPerTransaction ?? 0n;
    const pendingAttempt = this.activeBidAttempt;
    if (pendingAttempt && !pendingAttempt.inclusion) {
      tip = TxSubmitter.replacementTip(pendingAttempt.tip, REPLACEMENT_TIP_INCREMENT);
    }

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
    // 3. report changes in the number of seats the current capital can support
    if (totalSeatsAfterBid < myWinningBids.length || totalSeatsAfterBid < this.lastLoggedSeatsInBudget) {
      this.log(
        `Can only afford ${totalSeatsAfterBid} seats with next bid of ${formatArgons(nextBidAmount)} at block #${blockNumber}`,
      );
    }
    this.safeRecordParamsAdjusted({
      tick: bidsAtTick,
      blockNumber,
      maxSeats: totalSeatsAfterBid,
      winningBidCount: myWinningBids.length,
      reason: reductionReason,
      availableBalanceForBids,
      availableMicronots,
    });

    if (this.accountset.isProxy && bidsets[0].estimatedFeePlusTip > MINING_BID_PROXY_FEE_FLOAT) {
      this.log('Mining bid exceeds the proxy sponsor fee limit');
      this.setNextBid(undefined);
      return;
    }

    if (totalSeatsAfterBid > myWinningBids.length && accountsToBidWith.length > 0) {
      const lastBidTick = this.lastBid?.submittedAtTick ?? 0;
      let nextBidSubmissionTick = Math.max(lastBidTick + this.options.bidDelay, bidsAtTick);

      if (
        frameRewardTicksRemaining <= this.ticksBeforeVrfClose ||
        (this.lastBid && myWinningBids.length < (this.lastBid.seatsWon ?? 0)) ||
        (pendingAttempt && !pendingAttempt.inclusion)
      ) {
        nextBidSubmissionTick = bidsAtTick;
      }

      if (
        pendingAttempt &&
        !pendingAttempt.inclusion &&
        !pendingAttempt.needsReplacement &&
        pendingAttempt.microgonsPerSeat === nextBidAmount &&
        pendingAttempt.subaccounts.toString() === accountsToBidWith.map(x => x.address).toString()
      ) {
        this.setNextBid(undefined);
        return;
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
          bidAmount: formatArgons(nextBidAmount),
          seatCount: accountsToBidWith.length,
          bidAtTick: nextBidSubmissionTick,
          tip: tip.toString(),
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

  private async reconcileBidAttempt(header: IBlockHeaderInfo): Promise<boolean> {
    const attempt = this.activeBidAttempt;
    if (!attempt || attempt.txResult.isFinalized || attempt.txResult.submissionError) return false;

    const { blockHash, blockNumber } = attempt.txResult;
    if (!blockHash || blockNumber === undefined) {
      if (!attempt.inclusion) return false;
      this.clearOrphanedBid(attempt);
      return true;
    }
    if (blockNumber > header.blockNumber) return false;

    // An InBlock status can refer to a fork. Publish only while its block is canonical.
    const headerGeneration = this.headerGeneration;
    let canonicalHash: string;
    if (blockNumber <= this.blockWatch.finalizedBlockHeader.blockNumber) {
      canonicalHash = await this.blockWatch.getFinalizedHash(blockNumber);
    } else {
      const watchedHeader = this.blockWatch.latestHeaders.find(x => x.blockNumber === blockNumber);
      canonicalHash = watchedHeader?.blockHash ?? (await this.client.rpc.chain.getBlockHash(blockNumber)).toHex();
    }
    if (headerGeneration !== this.headerGeneration) return false;

    if (canonicalHash !== u8aToHex(blockHash)) {
      this.clearOrphanedBid(attempt);
      return true;
    }

    if (this.activeBidAttempt !== attempt) return false;
    if (this.lastBidAttempt === attempt && attempt.inclusion?.blockHash === canonicalHash) return false;

    const bidAtTick = await this.blockWatch.getHeader({ blockHash: canonicalHash, blockNumber }).then(x => x.tick);
    if (this.activeBidAttempt !== attempt || headerGeneration !== this.headerGeneration) return false;

    const { txResult, microgonsPerSeat, subaccounts } = attempt;
    const successfulBids = txResult.batchInterruptedIndex ?? (txResult.extrinsicError ? 0 : subaccounts.length);

    attempt.inclusion = { blockHash: canonicalHash, blockNumber };
    attempt.needsReplacement = false;
    this.lastBid = {
      submittedAtTick: bidAtTick,
      microgonsPerSeat,
      seats: subaccounts.length,
      seatsWon: successfulBids,
      isFinalized: false,
      expectedFinalizationTick: bidAtTick + 5,
    };
    this.lastBidAttempt = attempt;
    // A fully rejected batch leaves bid storage unchanged; refresh it on the next header.
    if (successfulBids === 0) this.lastBidsHash = undefined;
    this.broadcastUpdates();
    return false;
  }

  private clearOrphanedBid(attempt: IBidAttempt): void {
    if (!attempt.needsReplacement) {
      this.log('Bid inclusion was reorged; repricing with its unconsumed nonce', {
        nonce: attempt.txResult.extrinsic.nonce,
        deathBlock: attempt.deathBlock,
      });
    }
    attempt.inclusion = undefined;
    attempt.needsReplacement = true;
    if (this.lastBidAttempt === attempt) {
      this.lastBid = undefined;
      this.lastBidAttempt = undefined;
      this.broadcastUpdates();
    }
  }

  private async submitNextBid() {
    const nextBid = this.nextBid;

    if (!nextBid) {
      this.log('No next bid planned, skipping submission.');
      return;
    }
    this.setNextBid(undefined);

    try {
      const { microgonsPerSeat, subaccounts } = nextBid;
      this.log(`Submitting bids for cohort ${this.cohortStartingFrameId}`, {
        frameId: this.cohortStartingFrameId,
        blockNumber: this.latestBlockNumber,
        microgonsPerSeat: formatArgons(microgonsPerSeat),
        seatCount: subaccounts.length,
      });
      this.bidsAttempted += subaccounts.length;
      const submitter = await this.accountset.createMiningBidTx({
        subaccounts: subaccounts.map(x => ({ address: x })),
        bidAmount: microgonsPerSeat,
      });

      const bestBlockHeader = this.blockWatch.bestBlockHeader;
      let mortalityBlocks = DEFAULT_BID_MORTALITY_BLOCKS;
      if (bestBlockHeader.frameRewardTicksRemaining! <= DEFAULT_BID_MORTALITY_BLOCKS) {
        mortalityBlocks = MINIMUM_BID_MORTALITY_BLOCKS;
      }
      const pendingAttempt = this.activeBidAttempt;
      let replacement: Parameters<TxSubmitter['signMortal']>[0]['replacement'];
      if (pendingAttempt && !pendingAttempt.inclusion) {
        replacement = {
          pendingResult: pendingAttempt.txResult,
          pendingTip: pendingAttempt.tip,
          minimumTipIncrease: REPLACEMENT_TIP_INCREMENT,
        };
      }

      const { signedTx, birthBlock, deathBlock, tip } = await submitter.signMortal({
        blockWatch: this.blockWatch,
        bestBlockNumber: bestBlockHeader.blockNumber,
        validForBlocks: mortalityBlocks,
        tip: this.options.tipPerTransaction ?? 0n,
        replacement,
      });

      // Signing can take several blocks. Recheck the auction before sending these signed bytes.
      const currentHeader = this.blockWatch.bestBlockHeader;
      if (
        currentHeader.blockNumber >= deathBlock ||
        currentHeader.frameId !== bestBlockHeader.frameId ||
        currentHeader.frameId! + 1 !== this.cohortStartingFrameId
      ) {
        throw new Error('Bid auction or signing deadline advanced before submission');
      }
      const currentApi = await submitter.client.at(currentHeader.blockHash);
      const [biddingOpen, nextFrameId] = await Promise.all([
        currentApi.query.miningSlot.isNextSlotBiddingOpen(),
        currentApi.query.miningSlot.nextFrameId(),
      ]);
      if (!biddingOpen || nextFrameId !== this.cohortStartingFrameId) {
        throw new Error('Bid auction closed before submission');
      }

      if (this.blockWatch.bestBlockHeader.blockHash !== currentHeader.blockHash) {
        throw new Error('Bid auction advanced while checking submission eligibility');
      }

      const txResult = await submitter.submitSigned(signedTx, {
        txStatusCallback: status => {
          if (
            status.isReady ||
            status.isFuture ||
            status.isBroadcast ||
            status.isRetracted ||
            status.isUsurped ||
            status.isDropped ||
            status.isInvalid
          ) {
            this.log('Bid transaction status', { status: status.type, nonce: signedTx.nonce.toNumber(), deathBlock });
          }
        },
      });
      const attempt: IBidAttempt = {
        txResult,
        tip,
        deathBlock,
        microgonsPerSeat,
        subaccounts,
      };
      this.activeBidAttempt = attempt;
      this.log('Bid submitted', { nonce: txResult.extrinsic.nonce, birthBlock, deathBlock, tip: tip.toString() });

      this.startBidMortalityFallback(txResult, deathBlock);
      const finalization = this.observeBidAttempt(attempt);
      this.pendingFinalizations.add(finalization);
      void finalization.finally(() => this.pendingFinalizations.delete(finalization));
    } catch (err) {
      this.error(`Error bidding for cohort ${this.cohortStartingFrameId}:`, err);
      this.lastBidsHash = undefined;
    } finally {
      await new Promise(setImmediate);
      this.pendingRequest = undefined;
      try {
        await this.planNextBid(this.blockWatch.bestBlockHeader.frameRewardTicksRemaining!);
      } catch (error) {
        this.lastBidsHash = undefined;
        this.error('Error planning the next bid after a submission attempt:', error);
      }
      this.broadcastUpdates();
    }
  }

  private async observeBidAttempt(attempt: IBidAttempt): Promise<void> {
    const { txResult } = attempt;
    try {
      const inclusionError = await txResult.waitForInFirstBlock.then(() => undefined).catch((error: Error) => error);
      if (!txResult.blockHash || txResult.blockNumber === undefined) {
        throw inclusionError ?? new Error('Bid transaction did not report block inclusion');
      }

      try {
        await this.reconcileBidAttempt(this.blockWatch.bestBlockHeader);
      } catch (error) {
        this.error('Error checking canonical bid inclusion; retrying on the next header:', error);
      }

      await this.awaitFinalization(attempt);
    } catch {
      if (this.activeBidAttempt === attempt) {
        this.activeBidAttempt = undefined;
        if (this.lastBidAttempt === attempt) {
          this.lastBid = undefined;
          this.lastBidAttempt = undefined;
        }
        this.lastBidsHash = undefined;
        this.broadcastUpdates();
      }
      this.log('Bid attempt ended before canonical finalization', {
        nonce: txResult.extrinsic.nonce,
        reason: txResult.submissionError ? 'submission' : 'inclusion',
      });
    }
  }

  private startBidMortalityFallback(txResult: TxResult, deathBlock: number): void {
    let started = false;
    let isCheckingFinalizedBlock = false;
    let unsubscribeFinalized: (() => void) | undefined;
    const cleanup = () => {
      unsubscribeBest();
      unsubscribeFinalized?.();
    };
    const failTransaction = (error: Error) => {
      if (txResult.isFinalized || txResult.submissionError) return;
      txResult.submissionError = error;
    };
    const retryRead = async <T>(read: () => Promise<T>): Promise<T> => {
      for (let retry = 0; ; retry += 1) {
        try {
          return await read();
        } catch (error) {
          if (retry >= 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 1_000 * 2 ** retry));
        }
      }
    };
    const recover = async () => {
      if (started || txResult.isFinalized || txResult.submissionError) return;

      started = true;
      unsubscribeBest();
      let transaction: Awaited<ReturnType<typeof TransactionEvents.findByExtrinsicHash>>;
      try {
        transaction = await retryRead(() =>
          TransactionEvents.findByExtrinsicHash({
            blockWatch: this.blockWatch,
            extrinsicHash: txResult.extrinsic.signedHash,
            searchStartBlockHeight: txResult.extrinsic.submittedAtBlockNumber,
            bestBlockHeight: deathBlock,
          }),
        );
      } catch (error) {
        this.error('Could not verify bid inclusion after RPC retries; inspect chain RPC and reconcile the auction:', {
          nonce: txResult.extrinsic.nonce,
          submittedBlock: txResult.extrinsic.submittedAtBlockNumber,
          deathBlock,
          error,
        });
        failTransaction(new Error('Bid inclusion could not be verified after RPC retries'));
        return;
      }

      if (txResult.isFinalized || txResult.submissionError) return;
      if (!transaction) {
        this.log('Bid inclusion not found before deadline; inspect pool propagation, nonce, and auction state', {
          nonce: txResult.extrinsic.nonce,
          submittedBlock: txResult.extrinsic.submittedAtBlockNumber,
          deathBlock,
        });
        failTransaction(new Error('Bid transaction expired before block inclusion'));
        return;
      }

      try {
        await txResult.setSeenInBlock(this.client, {
          blockHash: hexToU8a(transaction.blockHash),
          blockNumber: transaction.blockNumber,
          events: transaction.extrinsicEvents,
          extrinsicIndex: transaction.extrinsicIndex,
        });
      } catch (error) {
        this.error('Could not process recovered bid inclusion; inspect the included block and RPC events:', {
          nonce: txResult.extrinsic.nonce,
          includedBlock: transaction.blockNumber,
          error,
        });
        failTransaction(new Error('Recovered bid transaction could not be processed'));
        return;
      }

      if (txResult.isFinalized || txResult.submissionError) return;
      this.log('Recovered bid transaction after its status subscription went silent', {
        nonce: txResult.extrinsic.nonce,
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
          const finalizedHash = await retryRead(() => this.blockWatch.getFinalizedHash(transaction.blockNumber));
          if (txResult.isFinalized || txResult.submissionError) return;
          if (finalizedHash !== transaction.blockHash) {
            failTransaction(new Error('Recovered bid transaction was reorged before finalization'));
            return;
          }
          await txResult.setFinalized(this.client);
        } catch (error) {
          this.error('Could not verify recovered bid finalization after RPC retries; inspect chain RPC:', {
            nonce: txResult.extrinsic.nonce,
            includedBlock: transaction.blockNumber,
            error,
          });
          failTransaction(new Error('Recovered bid finalization could not be verified after RPC retries'));
        } finally {
          isCheckingFinalizedBlock = false;
        }
      };

      unsubscribeFinalized = this.blockWatch.events.on('finalized', headers => {
        void finalizeRecoveredTransaction(headers.at(-1)!.blockNumber);
      });
      await finalizeRecoveredTransaction(this.blockWatch.finalizedBlockHeader.blockNumber);
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

  private async awaitFinalization(attempt: IBidAttempt) {
    const { txResult, microgonsPerSeat, subaccounts } = attempt;
    const submittedCount = subaccounts.length;
    try {
      const bidError = await txResult.waitForFinalizedBlock.then(() => undefined).catch((x: ExtrinsicError) => x);
      if (!txResult.isFinalized) {
        if (this.activeBidAttempt !== attempt) return;
        this.activeBidAttempt = undefined;
        if (this.lastBidAttempt === attempt) {
          this.lastBid = undefined;
          this.lastBidAttempt = undefined;
        }
        this.lastBidsHash = undefined;
        this.broadcastUpdates();
        return;
      }
      const successfulBids =
        txResult.batchInterruptedIndex ?? (bidError || txResult.extrinsicError ? 0 : submittedCount);

      const blockNumber = txResult.blockNumber;
      const blockHash = txResult.blockHash ? u8aToHex(txResult.blockHash) : undefined;
      const inclusion = attempt.inclusion;
      const isPublishedInclusion =
        this.lastBidAttempt === attempt && inclusion?.blockHash === blockHash && inclusion?.blockNumber === blockNumber;
      const pendingBid = isPublishedInclusion ? this.lastBid : undefined;
      if (pendingBid) {
        pendingBid.isFinalized = true;
        pendingBid.seatsWon = successfulBids;
      }

      if (this.activeBidAttempt === attempt) {
        this.activeBidAttempt = undefined;
      }
      this.txFees += txResult.finalFee ?? 0n;

      // If inclusion could not be published earlier, refresh after finalization too.
      if (successfulBids === 0 && !this.activeBidAttempt) this.lastBidsHash = undefined;
      this.broadcastUpdates();

      if (blockNumber === undefined || !blockHash) {
        throw new Error('Finalized bid is missing its inclusion block identity');
      }
      let bidAtTick = pendingBid?.submittedAtTick;
      if (bidAtTick === undefined) {
        const block = { blockNumber, blockHash };
        try {
          bidAtTick = (await this.blockWatch.getHeader(block)).tick;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 500));
          bidAtTick = (await this.blockWatch.getHeader(block)).tick;
        }
      }

      const newerCanonicalBid =
        this.lastBidAttempt !== attempt &&
        this.lastBidAttempt?.inclusion !== undefined &&
        this.lastBidAttempt.inclusion.blockNumber >= blockNumber;
      if (!pendingBid && !newerCanonicalBid) {
        this.lastBid = {
          submittedAtTick: bidAtTick,
          microgonsPerSeat,
          seats: submittedCount,
          seatsWon: successfulBids,
          isFinalized: true,
          expectedFinalizationTick: bidAtTick,
        };
        this.lastBidAttempt = attempt;
        attempt.inclusion = { blockHash, blockNumber };
      }

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
    } catch (err) {
      this.error('Could not record finalized bid activity; inspect the inclusion block and reconcile bot history:', {
        nonce: txResult.extrinsic.nonce,
        includedBlock: txResult.blockNumber,
        error: err,
      });
      if (txResult.isFinalized) {
        // History needs the inclusion tick, so report a finalized bid that could not be recorded.
        try {
          this.callbacks?.onFinalizedBidActivityError?.(
            new Error(
              `Finalized bid at block ${txResult.blockNumber ?? 'unknown'} could not be recorded; reconcile bot history.`,
            ),
          );
        } catch (callbackError) {
          this.error('Could not publish the finalized bid history error:', callbackError);
        }
      }
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

  private updateBidList(
    rawBids: NonNullable<HistoricalQueryRecord<'miningSlot', 'bidsForNextSlotCohort'>>,
    blockNumber: number,
    tick: number,
    isReloadingInitialState = false,
  ) {
    try {
      let mostRecentBidTick = 0;
      const bids = rawBids.map(rawBid => {
        const bidAtTick = rawBid.bidAtTick;
        mostRecentBidTick = Math.max(bidAtTick, mostRecentBidTick);
        return {
          address: rawBid.accountId,
          micronotsStaked: rawBid.argonots,
          bidMicrogons: rawBid.bid,
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
    if (
      args.maxSeats === this.lastLoggedSeatsInBudget &&
      args.reason === this.lastReportedReductionReason &&
      this.botCapital?.microgons === this.lastReportedBotCapital?.microgons &&
      this.botCapital?.micronots === this.lastReportedBotCapital?.micronots
    ) {
      return;
    }

    try {
      this.callbacks?.onBidParamsAdjusted?.(args);
      this.lastLoggedSeatsInBudget = args.maxSeats;
      this.lastReportedReductionReason = args.reason;
      this.lastReportedBotCapital = this.botCapital;
      this.broadcastUpdates();
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
