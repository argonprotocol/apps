import { MINING_BID_PROXY_FEE_FLOAT, type Accountset } from './Accountset.js';
import type { ArgonCurrentQueryClient } from './MainchainClients.js';
import type { IBlockHeaderInfo } from './BlockWatch.js';
import { Mining } from './Mining.js';
import { bigIntMax, bigIntMin } from './utils.js';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { hexToU8a } from '@argonprotocol/mainchain';
import { TransactionEvents } from './TransactionEvents.js';
import {
  CohortBidderBase,
  type ICohortBid,
  type ICohortBiddingOptions,
  type ICohortBidAttempt,
  type ICohortBidCapacity,
  type IBidReductionReason,
} from './CohortBidderBase.js';

type RangeBid = ICohortBid & { maxMicrogons: bigint; fundedMaxMicrogons: bigint };

const BID_REVEAL_DELAY_BLOCKS = 3;

export class RangeCohortBidder extends CohortBidderBase<ICohortBiddingOptions, RangeBid> {
  private revealAttempt?: Pick<ICohortBidAttempt, 'txResult' | 'tip' | 'inclusion'>;
  private lastReportedCapacity?: ICohortBidCapacity;
  private bidMaxima: Record<string, bigint> = {};

  public updateBiddingOptions(options: ICohortBiddingOptions, subaccounts: RangeCohortBidder['subaccounts']): void {
    this.options = { ...options };
    this.options.minBid -= this.options.minBid % this.minIncrement;
    this.options.maxBid -= this.options.maxBid % this.minIncrement;
    this.subaccounts = subaccounts.slice(0, this.nextCohortSize);
    for (const account of this.subaccounts) this.myAddresses.add(account.address);
    this.headerGeneration += 1;
    this.nextBid = undefined;
    this.lastReportedCapacity = undefined;
    this.onUpdatedFn?.();
  }

  protected async initialize() {
    this.bidMaxima = (await this.callbacks?.loadBidMaxima?.()) ?? {};
  }

  protected countWinningSeats(attempt: ICohortBidAttempt): number {
    return this.myWinningBids.filter(bid => attempt.subaccounts.includes(bid.address)).length;
  }

  protected async onHeader(header: IBlockHeaderInfo, isFirstLoad: boolean) {
    if (this.isStopping) return;
    if (header.frameId! + 1 !== this.cohortStartingFrameId) return;

    const generation = ++this.headerGeneration;
    await this.reconcileBidAttempt(header);

    const api = runtimeClient(await this.client.at(header.blockHash));
    const [bids, pending, admissionClosed, biddingOpen] = await Promise.all([
      api.query.miningSlot.bidsForNextSlotCohort(),
      api.query.miningSlot.pendingBids.multi(Object.keys(this.accountset.subAccountsByAddress)),
      api.query.miningSlot.auctionAdmissionClosed(),
      api.query.miningSlot.isNextSlotBiddingOpen(),
    ]);
    if (!pending) throw new Error('Pending mining bids are unavailable');

    const maxima = await Mining.fetchBidMaxima(api, bids);
    if (this.isStopping || generation !== this.headerGeneration) return;

    const pendingBids = pending
      .filter(bid => bid !== null)
      .filter(bid => bid.frame === this.cohortStartingFrameId && bid.funding === this.accountset.fundingAccountId);
    for (const bid of pendingBids) {
      if (bid.maxHash && this.bidMaxima[bid.maxHash] !== undefined) this.myAddresses.add(bid.miner);
    }

    this.latestBlockNumber = header.blockNumber;
    this.latestUpdateDate = new Date();

    const currentBids = bids.map(bid => ({
      address: bid.accountId,
      bidMicrogons: bid.bid,
      micronotsStaked: bid.argonots,
      bidAtTick: bid.bidAtTick,
      ...maxima.get(bid.accountId)!,
    }));

    if (this.lastBid && this.lastBidAttempt) {
      const accounts = this.lastBidAttempt.subaccounts;
      this.lastBid.seatsWon = currentBids.filter(
        bid => this.myAddresses.has(bid.address) && accounts.includes(bid.address),
      ).length;
    }
    this.publishBids(currentBids, header.blockNumber, header.tick, isFirstLoad);

    if (this.pendingRequest) return;

    if (pendingBids.length > 0) {
      this.nextBid = undefined;
      const canReveal = await this.reconcileReveal(header);
      if (this.isStopping || generation !== this.headerGeneration) return;

      if (canReveal) {
        this.pendingRequest = this.revealMaxima(pendingBids, header).finally(() => {
          this.pendingRequest = undefined;
          this.onUpdatedFn?.();
        });
      }
      return;
    }

    if (!this.isBiddingOpen || !biddingOpen || admissionClosed) {
      this.nextBid = undefined;
      return;
    }

    if (this.activeBidAttempt && !this.activeBidAttempt.inclusion) return;

    await this.planBid(header, generation, api);
    if (this.isStopping || generation !== this.headerGeneration) return;
    if (!this.isBiddingOpen || !this.nextBid) return;

    this.pendingRequest = this.submitBid(header).finally(() => {
      this.pendingRequest = undefined;
      this.onUpdatedFn?.();
    });
  }

  private async planBid(header: IBlockHeaderInfo, generation: number, api: ArgonCurrentQueryClient) {
    const { minBid, maxBid } = this.options;
    const bids = this.currentBids.bids;
    const ownedBids = bids.filter(bid => this.myAddresses.has(bid.address));
    const ownedByAddress = new Map(ownedBids.map(bid => [bid.address, bid]));
    const seatGoal = Math.min(this.seatGoalCount, this.nextCohortSize!);
    const accounts = [...this.subaccounts].sort((a, b) => {
      if (a.isRebid !== b.isRebid) return a.isRebid ? -1 : 1;
      return a.index - b.index;
    });

    const replacements = accounts
      .filter(account => {
        const owned = ownedByAddress.get(account.address);
        return owned && owned.maxMicrogons < maxBid;
      })
      .slice(0, seatGoal);
    const newAccounts = accounts
      .filter(account => !ownedByAddress.has(account.address))
      .slice(0, Math.max(0, seatGoal - ownedBids.length));

    const emptySeats = Math.max(0, this.nextCohortSize! - bids.length);
    const beatableSeats = bids.filter(
      bid => !ownedByAddress.has(bid.address) && bid.fundedMaxMicrogons < maxBid,
    ).length;
    const newCandidates = newAccounts.slice(0, emptySeats + beatableSeats);
    const candidates = [...replacements, ...newCandidates];

    let openingBid = minBid;
    if (bids.length >= this.nextCohortSize!) {
      const fundedCutoff = bigIntMin(...bids.map(bid => bid.fundedMaxMicrogons));
      openingBid = bigIntMax(openingBid, fundedCutoff + this.minIncrement);
    }

    const fundingAccountId = this.accountset.fundingAccountId;
    const [account, ownership] = await Promise.all([
      api.query.system.account(fundingAccountId),
      api.query.ownership.account(fundingAccountId),
    ]);

    const balance = account.data.free;
    const availableMicronots = ownership.free;
    const botCapital = {
      microgons: balance + ownedBids.reduce((sum, bid) => sum + bid.bidMicrogons, 0n),
      micronots: availableMicronots + ownedBids.reduce((sum, bid) => sum + bid.micronotsStaked, 0n),
    };

    const committedBalance = ownedBids.reduce(
      (sum, bid) => sum + bigIntMax(bid.maxMicrogons - bid.bidMicrogons, 0n),
      0n,
    );

    let availableBalance = bigIntMax(
      Mining.availableBidBalance(account, api.consts.balances.existentialDeposit) - committedBalance,
      0n,
    );

    let reason: IBidReductionReason | undefined;
    let accountsToBid: typeof candidates = [];
    let bidCost = 0n;
    let stakeCost = 0n;
    if (openingBid > maxBid) {
      reason = 'max-bid-too-low';
    } else {
      if (newCandidates.length < newAccounts.length) reason = 'max-bid-too-low';

      for (const candidate of candidates) {
        const owned = ownedByAddress.get(candidate.address);
        const extraBid = maxBid - (owned?.maxMicrogons ?? 0n);
        const extraStake = owned ? 0n : this.micronotsPerSeat;
        if (stakeCost + extraStake > availableMicronots) {
          reason = 'insufficient-argonot-balance';
          continue;
        }
        if (bidCost + extraBid > availableBalance) {
          reason = 'insufficient-argon-balance';
          continue;
        }
        bidCost += extraBid;
        stakeCost += extraStake;
        accountsToBid.push(candidate);
      }
    }

    if (accountsToBid.length) {
      const tip = this.options.tipPerTransaction ?? 0n;
      const commitment = await this.accountset.createMiningBidTx({
        subaccounts: accountsToBid,
        bidAmount: openingBid,
        maxBid,
        frameId: this.cohortStartingFrameId,
      });
      const fees = [await commitment.feeEstimate(tip)];

      if (maxBid > openingBid) {
        const bidsToReveal = accountsToBid.map(({ address }) => {
          const { salt } = this.accountset.miningBidCommitment({
            address,
            bidAmount: openingBid,
            maxBid,
            frameId: this.cohortStartingFrameId,
          });
          return { address, maxBid, salt };
        });
        const reveal = await this.accountset.createMiningBidMaxTx({
          bids: bidsToReveal,
          frameId: this.cohortStartingFrameId,
        });
        fees.push(await reveal.feeEstimate(tip));
      }

      const transactionCost = fees.reduce((sum, fee) => sum + fee + tip, 0n);
      if (availableBalance < transactionCost) {
        accountsToBid = [];
        reason = 'insufficient-argon-balance';
      }

      availableBalance = bigIntMax(availableBalance - transactionCost, 0n);

      bidCost = 0n;
      accountsToBid = accountsToBid.filter(account => {
        const extraBid = maxBid - (ownedByAddress.get(account.address)?.maxMicrogons ?? 0n);
        if (bidCost + extraBid > availableBalance) {
          reason = 'insufficient-argon-balance';
          return false;
        }
        bidCost += extraBid;
        return true;
      });

      if (this.accountset.isProxy && fees.some(fee => fee + tip > MINING_BID_PROXY_FEE_FLOAT)) {
        accountsToBid = [];
      }
    }

    if (this.isStopping || generation !== this.headerGeneration) return;

    this.botCapital = botCapital;
    this.nextBid = undefined;

    const capacity = {
      tick: header.tick,
      blockNumber: header.blockNumber,
      winningBidCount: ownedBids.length,
      maxSeats: ownedBids.length + accountsToBid.filter(account => !ownedByAddress.has(account.address)).length,
      reason,
      availableBalanceForBids: availableBalance,
      availableMicronots,
    };

    const previous = this.lastReportedCapacity;
    if (
      !previous ||
      previous.maxSeats !== capacity.maxSeats ||
      previous.winningBidCount !== capacity.winningBidCount ||
      previous.reason !== capacity.reason ||
      previous.availableBalanceForBids !== capacity.availableBalanceForBids ||
      previous.availableMicronots !== capacity.availableMicronots
    ) {
      this.callbacks?.onBidParamsAdjusted?.(capacity);
      this.lastReportedCapacity = capacity;
    }

    if (accountsToBid.length) {
      this.nextBid = {
        microgonsPerSeat: openingBid,
        subaccounts: accountsToBid.map(account => account.address),
        alreadyWinningSeats: ownedBids.length,
        bidAtTick: header.tick,
        tip: this.options.tipPerTransaction ?? 0n,
      };
    }

    this.onUpdatedFn?.();
  }

  private async submitBid(header: IBlockHeaderInfo) {
    const bid = this.nextBid!;
    const options = this.options;
    const { maxBid } = options;
    this.nextBid = undefined;

    try {
      const submitter = await this.accountset.createMiningBidTx({
        subaccounts: bid.subaccounts.map(address => ({ address })),
        bidAmount: bid.microgonsPerSeat,
        maxBid,
        frameId: this.cohortStartingFrameId,
      });

      if (maxBid > bid.microgonsPerSeat) {
        const maxima: Record<string, bigint> = {};
        for (const address of bid.subaccounts) {
          const { maxHash } = this.accountset.miningBidCommitment({
            address,
            bidAmount: bid.microgonsPerSeat,
            maxBid,
            frameId: this.cohortStartingFrameId,
          });
          maxima[maxHash] = maxBid;
        }
        // The original maximum must survive settings changes and a crash after broadcast.
        await this.callbacks?.onBidMaximaPrepared?.(maxima);
        Object.assign(this.bidMaxima, maxima);
      }

      const { signedTx, deathBlock } = await submitter.signMortal({
        blockWatch: this.blockWatch,
        bestBlockNumber: header.blockNumber,
        validForBlocks: 8,
        tip: bid.tip,
      });

      const current = this.blockWatch.bestBlockHeader;
      if (this.isStopping || !this.isBiddingOpen) return;
      if (current.blockNumber >= deathBlock || current.frameId !== header.frameId) return;

      const api = runtimeClient(await this.client.at(current.blockHash));
      const [biddingOpen, admissionClosed, frameId] = await Promise.all([
        api.query.miningSlot.isNextSlotBiddingOpen(),
        api.query.miningSlot.auctionAdmissionClosed(),
        api.query.miningSlot.nextFrameId(),
      ]);
      if (!biddingOpen || admissionClosed) return;
      if (this.options !== options) return;
      if (frameId !== this.cohortStartingFrameId) return;
      if (this.blockWatch.bestBlockHeader.blockHash !== current.blockHash) return;

      // Sponsored commitment and reveal calls share a pool tag; reconcile their canonical receipts.
      const result = await submitter.submitSigned(signedTx, { disableAutomaticTxTracking: this.accountset.isProxy });
      this.bidsAttempted += bid.subaccounts.length;
      void this.trackReceipt(result, deathBlock, {
        txResult: result,
        tip: bid.tip,
        deathBlock,
        microgonsPerSeat: bid.microgonsPerSeat,
        maxMicrogonsPerSeat: maxBid,
        subaccounts: bid.subaccounts,
      });
    } catch (error) {
      this.error('Could not submit mining bids; retrying on the next header:', error);
    }
  }

  private async reconcileReveal(header: IBlockHeaderInfo): Promise<boolean> {
    const attempt = this.revealAttempt;
    if (!attempt || attempt.txResult.isFinalized || attempt.txResult.submissionError) return true;

    const generation = this.headerGeneration;
    const { txResult } = attempt;
    const inclusion = await TransactionEvents.findByExtrinsicHash({
      blockWatch: this.blockWatch,
      extrinsicHash: txResult.extrinsic.signedHash,
      searchStartBlockHeight: txResult.extrinsic.submittedAtBlockNumber,
      bestBlockHeight: header.blockNumber,
    });
    if (this.isStopping || generation !== this.headerGeneration) return false;
    if (this.blockWatch.bestBlockHeader.blockHash !== header.blockHash) return false;

    // An unseen transaction is still pending; a previously seen one has been reorged.
    if (!inclusion) return attempt.inclusion !== undefined;

    attempt.inclusion = { blockHash: inclusion.blockHash, blockNumber: inclusion.blockNumber };
    await txResult.setSeenInBlock(this.client, {
      blockHash: hexToU8a(inclusion.blockHash),
      blockNumber: inclusion.blockNumber,
      extrinsicIndex: inclusion.extrinsicIndex,
      events: inclusion.extrinsicEvents,
    });

    // Its nonce is consumed. Canonical pending storage selects only bids still needing a reveal.
    return true;
  }

  private async revealMaxima(pending: Awaited<ReturnType<Accountset['pendingMiningBids']>>, header: IBlockHeaderInfo) {
    const constants = this.client.consts.miningSlot;
    if (!('bidRevealBlocks' in constants)) throw new Error('Mining bid reveal configuration is unavailable');

    const bids: Parameters<Accountset['createMiningBidMaxTx']>[0]['bids'] = [];
    let lastRevealBlock = Number.MAX_SAFE_INTEGER;

    for (const bid of pending) {
      if (bid.frame !== this.cohortStartingFrameId || bid.funding !== this.accountset.fundingAccountId) continue;
      if (bid.max !== null || bid.maxHash === null) continue;

      const deadline = bid.block + constants.bidRevealBlocks;
      if (header.blockNumber < bid.block + BID_REVEAL_DELAY_BLOCKS) continue;
      if (header.blockNumber >= deadline) continue;
      const maxBid = this.bidMaxima[bid.maxHash] ?? this.options.maxBid;
      if (maxBid < bid.bid) continue;

      const commitment = this.accountset.miningBidCommitment({
        address: bid.miner,
        bidAmount: bid.bid,
        maxBid,
        frameId: bid.frame,
      });
      if (commitment.maxHash !== bid.maxHash) continue;

      bids.push({ address: bid.miner, maxBid, salt: commitment.salt });
      lastRevealBlock = Math.min(lastRevealBlock, deadline);
    }

    if (!bids.length) return;

    try {
      const submitter = await this.accountset.createMiningBidMaxTx({ bids, frameId: this.cohortStartingFrameId });
      const previous = this.revealAttempt;
      const { signedTx, deathBlock, tip } = await submitter.signMortal({
        blockWatch: this.blockWatch,
        bestBlockNumber: header.blockNumber,
        validForBlocks: lastRevealBlock + 1 - header.blockNumber,
        tip: this.options.tipPerTransaction ?? 0n,
        replacement: previous && {
          pendingResult: previous.txResult,
          pendingTip: previous.tip,
          minimumTipIncrease: 100_000n,
        },
      });

      const current = this.blockWatch.bestBlockHeader;
      if (this.isStopping) return;
      if (current.frameId !== header.frameId || current.blockNumber >= lastRevealBlock) return;

      const api = runtimeClient(await this.client.at(current.blockHash));
      const currentPending = await api.query.miningSlot.pendingBids.multi(bids.map(bid => bid.address));
      if (this.blockWatch.bestBlockHeader.blockHash !== current.blockHash) return;
      for (const [index, bid] of bids.entries()) {
        const original = pending.find(entry => entry.miner === bid.address)!;
        const latest = currentPending?.[index];
        if (!latest || latest.block !== original.block || latest.maxHash !== original.maxHash) return;
        if (latest.max !== null || current.blockNumber < latest.block + BID_REVEAL_DELAY_BLOCKS) return;
      }

      const result = await submitter.submitSigned(signedTx, { disableAutomaticTxTracking: this.accountset.isProxy });
      const attempt = { txResult: result, tip };
      this.revealAttempt = attempt;
      void this.trackReceipt(result, deathBlock).finally(() => {
        if (this.revealAttempt === attempt) this.revealAttempt = undefined;
      });
    } catch (error) {
      this.error('Could not reveal mining maxima; retrying within the reveal window:', error);
    }
  }
}
