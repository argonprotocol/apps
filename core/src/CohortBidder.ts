import { MINING_BID_PROXY_FEE_FLOAT } from './Accountset.js';
import { formatArgons } from '@argonprotocol/mainchain';
import { runtimeClient, type HistoricalQueryRecord, type LiveQueryRecord } from '@argonprotocol/runtime-client';
import { RangeCohortBidder } from './RangeCohortBidder.js';
import { Mining } from './Mining.js';
import type { IBlockHeaderInfo } from './BlockWatch.js';
import { planBidWithFeeEstimate } from './BidPlan.js';
import { TxSubmitter } from './TxSubmitter.js';
import {
  CohortBidderBase,
  type ICohortBidAttempt,
  type ICohortBidCapacity,
  type ICohortBiddingOptions,
  type IBidReductionReason,
} from './CohortBidderBase.js';

export type { IBidReductionReason } from './CohortBidderBase.js';

const DEFAULT_BID_MORTALITY_BLOCKS = 8;
const MINIMUM_BID_MORTALITY_BLOCKS = 4;
const REPLACEMENT_TIP_INCREMENT = 100_000n;

export interface ICohortBidderOptions extends ICohortBiddingOptions {
  bidIncrement: bigint;
  bidDelay: number;
}

export class CohortBidder extends CohortBidderBase<ICohortBidderOptions> {
  public static async create(...args: ConstructorParameters<typeof CohortBidder>) {
    const [accountset, , frameId] = args;
    if (await Mining.usesRangeBidding(runtimeClient(accountset.client), frameId)) {
      return new RangeCohortBidder(...args);
    }
    return new CohortBidder(...args);
  }

  private lastLoggedSeatsInBudget = this.subaccounts.length;
  private lastReportedReductionReason?: IBidReductionReason;
  private lastReportedBotCapital?: { microgons: bigint; micronots: bigint };
  private ticksBeforeVrfClose = 30;
  private bidsForNextSlotCohortKey!: string;
  private bidPlanGeneration = 0;

  protected ownsFinalizedWinner(bid: NonNullable<LiveQueryRecord<'miningSlot', 'minersByCohort'>>[number]): boolean {
    return bid.externalFundingAccount === this.accountset.fundingAccountId;
  }

  protected async initialize() {
    this.bidsForNextSlotCohortKey = this.client.query.miningSlot.bidsForNextSlotCohort.key();

    const config = await this.client.query.miningSlot.miningConfig();
    this.ticksBeforeVrfClose = config.ticksBeforeBidEndForVrfClose;
  }

  protected countWinningSeats(_attempt: ICohortBidAttempt, successfulBids: number): number {
    return successfulBids;
  }

  protected async onHeader(header: IBlockHeaderInfo, isFirstLoad: boolean): Promise<void> {
    const headerGeneration = ++this.headerGeneration;
    const client = this.client;
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
    const bidsHash = await client.rpc.state.getStorageHash(this.bidsForNextSlotCohortKey, header.blockHash);
    if (headerGeneration !== this.headerGeneration) return;

    const latestCohortBidsHash = bidsHash.toHex();
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
        this.onUpdatedFn?.();
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

    if (!this.isBiddingOpen || !this.nextBid || this.nextBid.bidAtTick > header.tick) return;
    if (this.pendingRequest) return;

    this.pendingRequest = this.submitNextBid();
    this.onUpdatedFn?.();
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

    const accountBalance = await this.accountset.balance();
    if (this.isStopping || planGeneration !== this.bidPlanGeneration) return;
    const accountMicronots = await this.accountset.accountMicronots();
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
        if (!didClearNextBid) this.onUpdatedFn?.();
      }
      this.log(`No updates needed at block #${blockNumber}. Winning all remaining seats (${myWinningBids.length}).`);
      return;
    }

    this.log(
      `Checking bids for cohort ${this.cohortStartingFrameId} at block ${this.latestBlockNumber}, Still trying for seats: ${this.subaccounts.length}. Currently winning ${myWinningBids.length} bids.`,
    );

    let tip = this.options.tipPerTransaction ?? 0n;
    const pendingAttempt = this.activeBidAttempt;
    if (pendingAttempt && !pendingAttempt.inclusion) {
      tip = TxSubmitter.replacementTip(pendingAttempt.tip, REPLACEMENT_TIP_INCREMENT);
    }

    if (!beatableBids.length) {
      let lowestUnownedBid = BigInt(Number.MAX_SAFE_INTEGER);
      for (const { bidMicrogons, address } of bids) {
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
    this.onUpdatedFn?.();

    return true;
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
        frameId: this.cohortStartingFrameId,
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
      const attempt: ICohortBidAttempt = {
        txResult,
        tip,
        deathBlock,
        microgonsPerSeat,
        subaccounts,
      };
      this.log('Bid submitted', { nonce: txResult.extrinsic.nonce, birthBlock, deathBlock, tip: tip.toString() });

      void this.trackReceipt(txResult, deathBlock, attempt);
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
      this.onUpdatedFn?.();
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
      const bids = rawBids.map(rawBid => ({
        address: rawBid.accountId,
        micronotsStaked: rawBid.argonots,
        bidMicrogons: rawBid.bid,
        bidAtTick: rawBid.bidAtTick,
      }));

      this.publishBids(bids, blockNumber, tick, isReloadingInitialState);
    } catch (err) {
      this.error('Error processing updated bids list:', err);
    }
  }

  private safeRecordParamsAdjusted(args: ICohortBidCapacity) {
    const { maxSeats, reason } = args;
    if (
      maxSeats === this.lastLoggedSeatsInBudget &&
      reason === this.lastReportedReductionReason &&
      this.botCapital?.microgons === this.lastReportedBotCapital?.microgons &&
      this.botCapital?.micronots === this.lastReportedBotCapital?.micronots
    ) {
      return;
    }

    try {
      this.callbacks?.onBidParamsAdjusted?.(args);
      this.lastLoggedSeatsInBudget = maxSeats;
      this.lastReportedReductionReason = reason;
      this.lastReportedBotCapital = this.botCapital;
      this.onUpdatedFn?.();
    } catch (err) {
      this.error('Error in onBidParamsAdjusted callback:', err);
    }
  }
}
