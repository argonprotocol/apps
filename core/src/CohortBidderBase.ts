import { runtimeClient, type LiveQueryRecord } from '@argonprotocol/runtime-client';
import { ExtrinsicError, formatArgons, hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import type { Accountset } from './Accountset.js';
import type { ArgonClient } from './MainchainClients.js';
import type { BlockWatch, IBlockHeaderInfo } from './BlockWatch.js';
import type { MiningFrames } from './MiningFrames.js';
import type { IBidPlanBid, IBidPlanSubaccount } from './BidPlan.js';
import { createDeferred } from './Deferred.js';
import { TransactionEvents } from './TransactionEvents.js';
import type { TxResult } from './TxResult.js';

export interface ICohortBid extends IBidPlanBid {
  bidAtTick: number;
}

export interface ICohortBiddingOptions {
  minBid: bigint;
  maxBid: bigint;
  maxSeats?: number;
  tipPerTransaction?: bigint;
}

export type IBidReductionReason = 'max-bid-too-low' | 'insufficient-argon-balance' | 'insufficient-argonot-balance';

export interface ICohortBidCapacity {
  tick: number;
  blockNumber: number;
  maxSeats: number;
  winningBidCount: number;
  reason: IBidReductionReason | undefined;
  availableBalanceForBids: bigint;
  availableMicronots: bigint;
}

export interface ICohortBidderCallbacks {
  loadBidMaxima?(): Promise<Record<string, bigint>>;
  onBidMaximaPrepared?(maxima: Record<string, bigint>): Promise<void>;
  onBidsUpdated?(args: {
    bids: ICohortBid[];
    atBlockNumber: number;
    tick: number;
    isReloadingInitialState: boolean;
  }): void;
  onBidParamsAdjusted?(args: ICohortBidCapacity): void;
  onBidsSubmitted?(args: {
    tick: number;
    blockNumber: number;
    microgonsPerSeat: bigint;
    maxMicrogonsPerSeat?: bigint;
    txFeePlusTip: bigint;
    submittedCount: number;
  }): void;
  onBidsRejected?(args: {
    tick: number;
    blockNumber: number;
    microgonsPerSeat: bigint;
    maxMicrogonsPerSeat?: bigint;
    submittedCount: number;
    rejectedCount: number;
    bidError: ExtrinsicError;
  }): void;
  onFinalizedBidActivityError?(error: Error): void;
}

export interface ICohortBidAttempt {
  txResult: TxResult;
  tip: bigint;
  deathBlock: number;
  microgonsPerSeat: bigint;
  maxMicrogonsPerSeat?: bigint;
  subaccounts: string[];
  inclusion?: { blockHash: string; blockNumber: number };
  needsReplacement?: boolean;
}

export abstract class CohortBidderBase<
  Options extends ICohortBiddingOptions = ICohortBiddingOptions,
  Bid extends ICohortBid = ICohortBid,
> {
  public onUpdatedFn?: () => void;
  public latestUpdateDate?: Date;
  public latestBlockNumber = 0;

  public isBiddingOpen = true;
  public txFees = 0n;
  public bidsAttempted = 0;
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
  public myWinningBids: ICohortBid[] = [];
  public botCapital?: { microgons: bigint; micronots: bigint };

  public readonly myAddresses: Set<string>;
  public readonly currentBids: { atBlockNumber: number; atTick: number; mostRecentBidTick: number; bids: Bid[] } = {
    bids: [],
    atBlockNumber: 0,
    atTick: 0,
    mostRecentBidTick: 0,
  };

  protected pendingRequest?: Promise<void>;
  protected pendingFinalizations = new Set<Promise<void>>();
  protected activeBidAttempt?: ICohortBidAttempt;
  protected lastBidAttempt?: ICohortBidAttempt;
  protected headerGeneration = 0;
  protected nextCohortSize?: number;
  protected micronotsPerSeat = 0n;
  protected minIncrement = 10_000n;
  protected lastBidsHash?: string;

  private unsubscribe?: () => void;
  private stopDeferred = createDeferred<void>(false);

  constructor(
    public accountset: Accountset,
    public miningFrames: MiningFrames,
    public cohortStartingFrameId: number,
    public subaccounts: IBidPlanSubaccount[],
    public options: Options,
    public callbacks?: ICohortBidderCallbacks,
    private readonly name = `BIDDER #${cohortStartingFrameId}`,
  ) {
    this.myAddresses = new Set(subaccounts.map(account => account.address));
  }

  public get client(): ArgonClient {
    return this.blockWatch.subscriptionClient;
  }

  public get pendingBidTxResult() {
    return this.activeBidAttempt?.txResult;
  }

  public get isBidInProgress() {
    return !!this.pendingRequest || (!!this.activeBidAttempt && !this.activeBidAttempt.inclusion);
  }

  public get isStopping() {
    return this.stopDeferred.isRunning || this.stopDeferred.isSettled;
  }

  public get currentAuctionSeatCount() {
    return this.nextCohortSize;
  }

  public get currentAuctionMicronotsPerSeat() {
    return this.nextCohortSize === undefined ? undefined : this.micronotsPerSeat;
  }

  public get seatGoalCount() {
    return this.options.maxSeats ?? this.subaccounts.length;
  }

  protected get blockWatch(): BlockWatch {
    return this.miningFrames.blockWatch;
  }

  public async start() {
    await this.blockWatch.start();
    await this.miningFrames.load();

    this.minIncrement = this.client.consts.miningSlot.bidIncrements;
    this.options.minBid -= this.options.minBid % this.minIncrement;
    this.options.maxBid -= this.options.maxBid % this.minIncrement;

    this.nextCohortSize = await this.client.query.miningSlot.nextCohortSize();
    this.micronotsPerSeat = await this.client.query.miningSlot.argonotsPerMiningSeat();
    this.subaccounts.length = Math.min(this.subaccounts.length, this.nextCohortSize);
    await this.initialize();

    this.unsubscribe = this.blockWatch.events.on('best-blocks', headers => {
      if (this.isStopping) return;
      void this.onHeader(headers.at(-1)!, false).catch(error => this.error('Could not refresh auction:', error));
    });
    await this.onHeader(this.blockWatch.bestBlockHeader, true);
  }

  public async stop(waitForFinalBids = true, shutdownSignal?: AbortSignal): Promise<ICohortBid[]> {
    if (this.isStopping) {
      await this.stopDeferred.promise;
      return this.myWinningBids;
    }

    this.isBiddingOpen = false;
    this.nextBid = undefined;

    waitForFinalBids &&= !shutdownSignal?.aborted;
    if (waitForFinalBids && (this.blockWatch.finalizedBlockHeader.frameId ?? 0) < this.cohortStartingFrameId) {
      const blockWatch = this.blockWatch;
      const activation = createDeferred<void>();
      const unsubscribe = blockWatch.events.on('finalized', headers => {
        if ((headers.at(-1)!.frameId ?? 0) >= this.cohortStartingFrameId) activation.resolve();
      });

      const onShutdown = () => activation.resolve();
      shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
      try {
        // Keep processing headers until committed bids have finished their reveal window.
        await Promise.race([activation.promise, this.stopDeferred.promise]);
        waitForFinalBids &&= !shutdownSignal?.aborted;
      } finally {
        unsubscribe();
        shutdownSignal?.removeEventListener('abort', onShutdown);
      }
    }

    if (this.isStopping) {
      await this.stopDeferred.promise;
      return this.myWinningBids;
    }

    this.stopDeferred.setIsRunning(true);
    this.unsubscribe?.();
    try {
      await this.pendingRequest;

      if (waitForFinalBids) {
        await Promise.all(this.pendingFinalizations);

        const finalizedHash = await this.client.rpc.chain.getFinalizedHead();
        const api = runtimeClient(await this.client.at(finalizedHash));
        const winners = (await api.query.miningSlot.minersByCohort(this.cohortStartingFrameId)) ?? [];
        this.myWinningBids = winners
          .filter(bid => this.ownsFinalizedWinner(bid))
          .map(bid => ({
            address: bid.accountId,
            bidMicrogons: bid.bid,
            micronotsStaked: bid.argonots,
            bidAtTick: this.currentBids.atTick,
          }));
      }

      this.onUpdatedFn?.();
      this.onUpdatedFn = undefined;
    } finally {
      this.stopDeferred.resolve();
    }

    return this.myWinningBids;
  }

  protected trackReceipt(result: TxResult, deathBlock: number, attempt?: ICohortBidAttempt): Promise<void> {
    this.startBidMortalityFallback(result, deathBlock);

    let finalization: Promise<void>;
    if (attempt) {
      this.activeBidAttempt = attempt;
      finalization = this.observeBidAttempt(attempt);
    } else {
      finalization = result.waitForFinalizedBlock
        .catch(() => undefined)
        .then(() => {
          if (result.isFinalized) this.txFees += result.finalFee ?? 0n;
          this.onUpdatedFn?.();
        });
    }

    this.pendingFinalizations.add(finalization);
    void finalization.finally(() => this.pendingFinalizations.delete(finalization));

    return finalization;
  }

  protected async observeBidAttempt(attempt: ICohortBidAttempt): Promise<void> {
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
        this.onUpdatedFn?.();
      }

      this.log('Bid attempt ended before canonical finalization', {
        nonce: txResult.extrinsic.nonce,
        reason: txResult.submissionError ? 'submission' : 'inclusion',
      });
    }
  }

  protected async awaitFinalization(attempt: ICohortBidAttempt) {
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
        this.onUpdatedFn?.();
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
        pendingBid.seatsWon = this.countWinningSeats(attempt, successfulBids);
      }

      if (this.activeBidAttempt === attempt) {
        this.activeBidAttempt = undefined;
      }
      this.txFees += txResult.finalFee ?? 0n;

      // If inclusion could not be published earlier, refresh after finalization too.
      if (successfulBids === 0 && !this.activeBidAttempt) this.lastBidsHash = undefined;
      this.onUpdatedFn?.();

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
          seatsWon: this.countWinningSeats(attempt, successfulBids),
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
        error: bidError?.message,
      });

      if (bidError) {
        try {
          this.callbacks?.onBidsRejected?.({
            tick: bidAtTick,
            blockNumber,
            microgonsPerSeat,
            maxMicrogonsPerSeat: attempt.maxMicrogonsPerSeat,
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
            maxMicrogonsPerSeat: attempt.maxMicrogonsPerSeat,
            txFeePlusTip: txResult.finalFee ?? 0n,
            submittedCount,
          });
        } catch (error) {
          this.error('Error in onBidsSubmitted callback:', error);
        }
      }

      this.onUpdatedFn?.();
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

  protected async reconcileBidAttempt(header: IBlockHeaderInfo): Promise<boolean> {
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

    const inclusionHeader = await this.blockWatch.getHeader({ blockHash: canonicalHash, blockNumber });
    if (this.activeBidAttempt !== attempt || headerGeneration !== this.headerGeneration) return false;

    const bidAtTick = inclusionHeader.tick;
    const { txResult, microgonsPerSeat, subaccounts } = attempt;
    const successfulBids = txResult.batchInterruptedIndex ?? (txResult.extrinsicError ? 0 : subaccounts.length);

    attempt.inclusion = { blockHash: canonicalHash, blockNumber };
    attempt.needsReplacement = false;
    this.lastBid = {
      submittedAtTick: bidAtTick,
      microgonsPerSeat,
      seats: subaccounts.length,
      seatsWon: this.countWinningSeats(attempt, successfulBids),
      isFinalized: false,
      expectedFinalizationTick: bidAtTick + 5,
    };
    this.lastBidAttempt = attempt;

    // A fully rejected batch leaves bid storage unchanged; refresh it on the next header.
    if (successfulBids === 0) this.lastBidsHash = undefined;
    this.onUpdatedFn?.();

    return false;
  }

  protected clearOrphanedBid(attempt: ICohortBidAttempt): void {
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
      this.onUpdatedFn?.();
    }
  }

  protected publishBids(bids: Bid[], blockNumber: number, tick: number, isReloadingInitialState: boolean) {
    this.currentBids.bids = bids;
    this.currentBids.atBlockNumber = blockNumber;
    this.currentBids.atTick = tick;
    this.currentBids.mostRecentBidTick = Math.max(0, ...bids.map(bid => bid.bidAtTick));
    this.myWinningBids = bids.filter(bid => this.myAddresses.has(bid.address));

    this.callbacks?.onBidsUpdated?.({
      bids,
      atBlockNumber: blockNumber,
      tick: this.currentBids.mostRecentBidTick,
      isReloadingInitialState,
    });
    this.onUpdatedFn?.();
  }

  protected initialize(): Promise<void> {
    return Promise.resolve();
  }

  protected abstract onHeader(header: IBlockHeaderInfo, isFirstLoad: boolean): Promise<void>;

  protected abstract countWinningSeats(attempt: ICohortBidAttempt, successfulBids: number): number;

  protected ownsFinalizedWinner(bid: NonNullable<LiveQueryRecord<'miningSlot', 'minersByCohort'>>[number]): boolean {
    return this.myAddresses.has(bid.accountId);
  }

  private startBidMortalityFallback(result: TxResult, deathBlock: number): void {
    // A silent status subscription can miss inclusion; reconcile the signed hash on chain after expiry.
    let recoveryStarted = false;
    const recoverAfterExpiry = () => {
      if (recoveryStarted || result.isFinalized || result.submissionError) return;

      recoveryStarted = true;
      unsubscribeBest();
      void this.recoverExpiredBidReceipt(result, deathBlock);
    };

    const unsubscribeBest = this.blockWatch.events.on('best-blocks', headers => {
      if (headers.at(-1)!.blockNumber >= deathBlock) recoverAfterExpiry();
    });

    if (this.blockWatch.bestBlockHeader.blockNumber >= deathBlock) recoverAfterExpiry();
    void result.waitForFinalizedBlock.catch(() => undefined).finally(unsubscribeBest);
  }

  private async recoverExpiredBidReceipt(result: TxResult, deathBlock: number): Promise<void> {
    let inclusion: Awaited<ReturnType<typeof TransactionEvents.findByExtrinsicHash>>;
    try {
      inclusion = await this.retryBidReceiptRead(() =>
        TransactionEvents.findByExtrinsicHash({
          blockWatch: this.blockWatch,
          extrinsicHash: result.extrinsic.signedHash,
          searchStartBlockHeight: result.extrinsic.submittedAtBlockNumber,
          bestBlockHeight: deathBlock,
        }),
      );
    } catch (error) {
      this.error('Could not verify bid inclusion after RPC retries; inspect chain RPC and reconcile the auction:', {
        nonce: result.extrinsic.nonce,
        submittedBlock: result.extrinsic.submittedAtBlockNumber,
        deathBlock,
        error,
      });
      if (!result.isFinalized && !result.submissionError) {
        result.submissionError = new Error('Bid inclusion could not be verified after RPC retries');
      }
      return;
    }

    if (result.isFinalized || result.submissionError) return;
    if (!inclusion) {
      this.log('Bid inclusion not found before deadline; inspect pool propagation, nonce, and auction state', {
        nonce: result.extrinsic.nonce,
        submittedBlock: result.extrinsic.submittedAtBlockNumber,
        deathBlock,
      });
      result.submissionError = new Error('Bid transaction expired before block inclusion');
      return;
    }

    try {
      await result.setSeenInBlock(this.client, {
        blockHash: hexToU8a(inclusion.blockHash),
        blockNumber: inclusion.blockNumber,
        events: inclusion.extrinsicEvents,
        extrinsicIndex: inclusion.extrinsicIndex,
      });
    } catch (error) {
      this.error('Could not process recovered bid inclusion; inspect the included block and RPC events:', {
        nonce: result.extrinsic.nonce,
        includedBlock: inclusion.blockNumber,
        error,
      });
      if (!result.isFinalized && !result.submissionError) {
        result.submissionError = new Error('Recovered bid transaction could not be processed');
      }
      return;
    }

    if (result.isFinalized || result.submissionError) return;
    this.log('Recovered bid transaction after its status subscription went silent', {
      nonce: result.extrinsic.nonce,
      submittedBlock: result.extrinsic.submittedAtBlockNumber,
      deathBlock,
      includedBlock: inclusion.blockNumber,
    });

    const { blockNumber, blockHash } = inclusion;
    let checkingFinalization = false;
    const checkFinalization = async (finalizedHeight: number) => {
      if (checkingFinalization || finalizedHeight < blockNumber) return;
      if (result.isFinalized || result.submissionError) return;

      checkingFinalization = true;
      try {
        const finalizedHash = await this.retryBidReceiptRead(() => this.blockWatch.getFinalizedHash(blockNumber));
        if (result.isFinalized || result.submissionError) return;

        if (finalizedHash !== blockHash) {
          result.submissionError = new Error('Recovered bid transaction was reorged before finalization');
          return;
        }

        await result.setFinalized(this.client);
      } catch (error) {
        this.error('Could not verify recovered bid finalization after RPC retries; inspect chain RPC:', {
          nonce: result.extrinsic.nonce,
          includedBlock: blockNumber,
          error,
        });
        if (!result.isFinalized && !result.submissionError) {
          result.submissionError = new Error('Recovered bid finalization could not be verified after RPC retries');
        }
      } finally {
        checkingFinalization = false;
      }
    };

    const unsubscribeFinalized = this.blockWatch.events.on('finalized', headers => {
      void checkFinalization(headers.at(-1)!.blockNumber);
    });
    void result.waitForFinalizedBlock.catch(() => undefined).finally(unsubscribeFinalized);

    await checkFinalization(this.blockWatch.finalizedBlockHeader.blockNumber);
  }

  private async retryBidReceiptRead<T>(read: () => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await read();
      } catch (error) {
        if (retry >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 1_000 * 2 ** retry));
      }
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
