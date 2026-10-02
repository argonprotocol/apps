import {
  AccountMiners,
  type Accountset,
  type ArgonApi,
  Currency,
  findRuntimeModuleError,
  groupEventsByExtrinsic,
  type IBlock,
  type IBotStateFile,
  type IMiningIndex,
  type ISubaccountMiner,
  type IWinningBid,
  MainchainClients,
  Mining,
  MiningFrames,
} from '@argonprotocol/apps-core';
import type { HistoricalEvent } from '@argonprotocol/runtime-client/events';
import type {
  BlockWatch,
  IBlockHeaderInfo,
  RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core/src/BlockWatch.ts';
import type { Storage } from './Storage.ts';
import { readdir } from 'node:fs/promises';

/** Captures mining facts for one block; BlockSync owns replay order and checkpoints. */
export class MiningCapture {
  private accountMiners!: AccountMiners;
  private readonly mining: Mining;
  private readonly currency: Currency;
  private lastExchangeRateDate?: Date;
  private lastExchangeRateFrameId?: number;

  constructor(
    private readonly accountset: Accountset,
    private readonly storage: Storage,
    mainchainClients: MainchainClients,
    private readonly miningFrames: MiningFrames,
  ) {
    this.mining = new Mining(mainchainClients);
    this.currency = new Currency(mainchainClients);
  }

  public async restore(api: ArgonApi): Promise<void> {
    let miners: (ISubaccountMiner & { seat: IMiningIndex })[];
    // Recovery can begin before runtime 125, when seats were indexed individually.
    const indexedMiners =
      api.query?.miningSlot && 'activeMinersByIndex' in api.query.miningSlot
        ? await api.query.miningSlot.activeMinersByIndex.entries()
        : null;
    if (indexedMiners) {
      const nextCohortId = await api.query.miningSlot.nextCohortId();
      miners = [];
      for (const [key, member] of indexedMiners) {
        if (!member || member.externalFundingAccount !== this.accountset.fundingAccountId) continue;
        const subAccount = this.accountset.subAccountsByAddress[member.accountId];
        if (!subAccount) continue;
        const frameId = member.cohortFrameId ?? Number(member.cohortId);
        miners.push({
          address: member.accountId,
          subaccountIndex: subAccount.index ?? -1,
          seat: { startingFrameId: frameId, index: key.args[0], bidAmount: member.bid ?? 0n },
          isLastDay: nextCohortId !== null && nextCohortId - frameId === 10,
        });
      }
    } else {
      miners = (await this.accountset.loadRegisteredMiners(api)).filter(
        (miner): miner is ISubaccountMiner & { seat: IMiningIndex } => miner.seat !== undefined,
      );
    }
    this.accountMiners = new AccountMiners(this.accountset, miners);
  }

  public async rewindAfter(checkpoint: Pick<IBlockHeaderInfo, 'blockNumber' | 'frameId' | 'tick'>): Promise<void> {
    const { blockNumber, frameId, tick } = checkpoint;
    const checkpointFrameId = frameId ?? this.miningFrames.getForTick(tick);
    // Transition rewards and fees belong to the previous frame. Older finalized files are untouched.
    const firstAffectedFrame = Math.max(0, checkpointFrameId - 1);

    for (const filename of await readdir(this.storage.botEarningsDir)) {
      const match = /^frame-(\d+)\.json$/.exec(filename);
      if (!match) continue;
      const storedFrameId = Number(match[1]);
      if (storedFrameId < firstAffectedFrame) continue;

      await this.storage.earningsFile(storedFrameId).mutate(earnings => {
        let changed = false;
        for (const number of Object.keys(earnings.earningsByBlock)) {
          const earningsBlockNumber = Number(number);
          if (earningsBlockNumber <= blockNumber) continue;
          delete earnings.earningsByBlock[earningsBlockNumber];
          changed = true;
        }
        if (earnings.lastBlockNumber <= blockNumber) return changed;

        if (earnings.firstBlockNumber > blockNumber) {
          // This entire file came from the abandoned suffix. Replay will initialize it again.
          earnings.firstBlockNumber = 0;
          earnings.lastBlockNumber = 0;
          earnings.microgonToUsd = [];
          earnings.microgonToBtc = [];
          earnings.microgonToArgonot = [];
        } else {
          // Keep the canonical prefix of a frame that straddles the checkpoint.
          earnings.lastBlockNumber = blockNumber;
        }
        return true;
      });
    }

    for (const filename of await readdir(this.storage.botBidsDir)) {
      const match = /^frame-(\d+)-(\d+)\.json$/.exec(filename);
      if (!match) continue;
      const biddingFrameId = Number(match[1]);
      const activationFrameId = Number(match[2]);
      if (biddingFrameId < firstAffectedFrame) continue;

      const bidsFile = this.storage.bidsFile(biddingFrameId, activationFrameId);
      if ((await bidsFile.get()).lastBlockNumber > blockNumber) {
        // Clear winners before their completion marker so a failed write can retry this cleanup.
        await this.storage.miningFrameFile(biddingFrameId).mutate(frame => {
          frame.winningBids = [];
          frame.slots = [];
          frame.totalBidCount = 0;
          if ((frame.auctionCloseTick ?? 0) > tick) delete frame.auctionCloseTick;
        });
      }

      await bidsFile.mutate(bids => {
        let changed = false;
        for (const number of Object.keys(bids.transactionFeesByBlock)) {
          const feeBlockNumber = Number(number);
          if (feeBlockNumber <= blockNumber) continue;
          delete bids.transactionFeesByBlock[feeBlockNumber];
          changed = true;
        }
        if (bids.lastBlockNumber > blockNumber) {
          // Zero means unavailable to BotSyncer until replay captures the replacement auction.
          bids.lastBlockNumber = 0;
          bids.seatCountWon = 0;
          bids.microgonsBidTotal = 0n;
          bids.argonotPriceAtBid = 0n;
          bids.micronotsStakedPerSeat = 0n;
          bids.microgonsToBeMinedPerBlock = 0n;
          bids.allMinersCount = 0;
          changed = true;
        }
        return changed;
      });
    }
  }

  public async processBlock(
    block: IBlock,
    blockEvents: Pick<Awaited<ReturnType<BlockWatch['getEventsWithSpec']>>, 'api' | 'events'>,
  ): Promise<Pick<IBotStateFile, 'hasMiningBids' | 'hasMiningSeats'>> {
    const { api, events } = blockEvents;
    const blockNumber = block.number;
    const cohortEarningsAtFrameId = await this.accountMiners.onBlock(
      block,
      events.map(x => x.event),
    );
    const tick = block.tick;
    const tickDate = MiningFrames.getTickDate(tick);
    const currentFrameId = block.frameId ?? this.miningFrames.getForTick(tick);
    const isFrameChange = block.isNewFrame ?? this.miningFrames.isFirstFrameTick(tick);
    await this.miningFrames.waitForFrameId(currentFrameId);

    // The previous miners earn the rewards for the frame transition.
    const earningsFrameId = Math.max(0, isFrameChange ? currentFrameId - 1 : currentFrameId);
    let microgonExchangeRateTo = events.some(
      ({ event, phase }) =>
        phase.type === 'Finalization' && event.section === 'miningSlot' && event.method === 'NewMiners',
    )
      ? await this.currency.fetchMainchainRates(api, { updateOffchainRates: false })
      : undefined;

    const { hasMiningBids, hasMiningSeats } = await this.syncBidding(
      api,
      currentFrameId,
      earningsFrameId,
      block,
      events,
      microgonExchangeRateTo?.ARGNOT,
    );
    let sampledExchangeRate = false;
    await this.storage.earningsFile(earningsFrameId).mutate(async x => {
      const replayingStoredBlock = x.lastBlockNumber >= blockNumber;
      x.frameFirstTick = this.miningFrames.getTickStart(earningsFrameId);
      x.frameRewardTicksRemaining = this.miningFrames.getFrameRewardTicksRemaining(earningsFrameId);
      x.firstBlockNumber ||= blockNumber;
      x.lastBlockNumber = blockNumber;

      const secondsSinceLastExchangeRate = this.lastExchangeRateDate
        ? (new Date().getTime() - this.lastExchangeRateDate.getTime()) / 1000
        : null;
      const checkedExchangeRateThisHour = secondsSinceLastExchangeRate !== null && secondsSinceLastExchangeRate < 3600;
      const checkedExchangeRateThisFrame = this.lastExchangeRateFrameId === earningsFrameId;

      if (!replayingStoredBlock && (!checkedExchangeRateThisFrame || !checkedExchangeRateThisHour)) {
        microgonExchangeRateTo ??= await this.currency.fetchMainchainRates(api);
        x.microgonToUsd.push(microgonExchangeRateTo.USD);
        x.microgonToBtc.push(microgonExchangeRateTo.BTC);
        x.microgonToArgonot.push(microgonExchangeRateTo.ARGNOT);
        sampledExchangeRate = true;
      }

      const cohortEarnings = Object.entries(cohortEarningsAtFrameId);
      const authoredEarnings = cohortEarnings.find(([, earnings]) => earnings.argonsMined || earnings.argonotsMined);
      const miningEarnings = authoredEarnings ?? cohortEarnings[0];
      if (miningEarnings) {
        // Block rewards belong to its author; mint payouts belong to all of our active seats.
        const microgonsMintedByCohort: Record<number, bigint> = {};
        let microgonsMinted = 0n;
        for (const [cohortId, earnings] of cohortEarnings) {
          if (!earnings.argonsMinted) continue;
          microgonsMintedByCohort[Number(cohortId)] = earnings.argonsMinted;
          microgonsMinted += earnings.argonsMinted;
        }

        x.earningsByBlock[blockNumber] = {
          blockHash: block.hash,
          authorCohortActivationFrameId: Number(miningEarnings[0]),
          authorAddress: block.author,
          blockMinedAt: tickDate.toString(),
          microgonFeesCollected: authoredEarnings ? ((await api.query.blockRewards.blockFees()) ?? 0n) : 0n,
          micronotsMined: miningEarnings[1].argonotsMined,
          microgonsMined: miningEarnings[1].argonsMined,
          microgonsMinted,
          microgonsMintedByCohort,
        };
      } else {
        // there's a chance we've re-orged and the block is not a mining block anymore, so clear it
        delete x.earningsByBlock[blockNumber];
      }
    });
    if (sampledExchangeRate) {
      this.lastExchangeRateDate = new Date();
      this.lastExchangeRateFrameId = earningsFrameId;
    }

    if (isFrameChange) {
      // Rewards for this transition went to the prior frame; initialize the new file for later blocks.
      await this.storage.earningsFile(currentFrameId).mutate(x => {
        x.frameRewardTicksRemaining = this.miningFrames.getFrameRewardTicksRemaining(currentFrameId);
        x.frameFirstTick = this.miningFrames.getTickStart(currentFrameId);
        x.firstBlockNumber ||= blockNumber;
        x.lastBlockNumber = blockNumber;
      });
    }

    return { hasMiningBids, hasMiningSeats };
  }

  private async syncBidding(
    api: ArgonApi,
    currentFrameId: number,
    biddingFrameId: number,
    block: IBlock,
    events: readonly RuntimeSystemEventRecord[],
    argonotPriceAtBid?: bigint,
  ): Promise<{ hasMiningBids: boolean; hasMiningSeats: boolean }> {
    const blockNumber = block.number;

    let biddingTransactionFees = 0n;
    let hasMiningBids = false;
    let hasMiningSeats = false;

    for (const { extrinsicIndex, extrinsicEvents } of groupEventsByExtrinsic(events)) {
      if (extrinsicIndex === undefined) continue;
      for (const event of extrinsicEvents) {
        biddingTransactionFees += this.extractOwnPaidTransactionFee(api, event, extrinsicEvents);
      }
    }

    for (const { event, phase } of events) {
      if (
        event.section === 'miningSlot' &&
        event.method === 'SlotBidderAdded' &&
        this.accountset.subAccountsByAddress[event.data.accountId]
      ) {
        hasMiningBids = true;
      }

      if (phase.type === 'Finalization' && event.section === 'miningSlot' && event.method === 'MiningBidsClosed') {
        const closedFrameId = event.data.frameId;
        if (closedFrameId === undefined) continue;

        const historicalBidsPerSlot = await api.query.miningSlot.historicalBidsPerSlot();
        const latestHistoricalBidStats = historicalBidsPerSlot[0];

        await this.storage.miningFrameFile(closedFrameId).mutate(x => {
          x.auctionCloseTick = block.tick;
          x.totalBidCount = latestHistoricalBidStats?.bidsCount ?? x.totalBidCount;
        });
      }

      if (phase.type === 'Finalization' && event.section === 'miningSlot' && event.method === 'NewMiners') {
        let activationFrameIdOfNewCohort = event.data.frameId ?? event.data.cohortFrameId;
        if (activationFrameIdOfNewCohort === undefined && event.data.cohortId !== undefined) {
          activationFrameIdOfNewCohort = Number(event.data.cohortId);
        }
        if (activationFrameIdOfNewCohort === undefined) continue;

        console.log(
          `[BlockSync] New miners event for frame #${activationFrameIdOfNewCohort} (${event.data.newMiners.length} miners added).`,
        );
        const { newMiners } = event.data;
        const biddingFrameIdOfNewCohort = activationFrameIdOfNewCohort - 1;
        const historicalBidsPerSlot = await api.query.miningSlot.historicalBidsPerSlot();
        const latestClosedBidStats = historicalBidsPerSlot[1];
        const activeMiners = await api.query.miningSlot.activeMinersCount();
        const lastBidsFile = this.storage.bidsFile(biddingFrameIdOfNewCohort, activationFrameIdOfNewCohort);
        argonotPriceAtBid ??= await this.currency
          .fetchMainchainRates(api, { updateOffchainRates: false })
          .then(x => x.ARGNOT);
        const winningBids: (IWinningBid & { micronotsStakedPerSeat: bigint })[] = [];
        await lastBidsFile.mutate(async x => {
          x.seatCountWon = 0;
          x.microgonsBidTotal = 0n;
          x.argonotPriceAtBid = argonotPriceAtBid;
          x.biddingFrameRewardTicksRemaining = 0;
          x.lastBlockNumber = blockNumber;
          x.allMinersCount = activeMiners;

          if (x.microgonsToBeMinedPerBlock === 0n) {
            x.microgonsToBeMinedPerBlock = await this.mining.fetchMicrogonsPerBlockForMiner(
              api,
              activationFrameIdOfNewCohort,
            );
          }

          let bidPosition = 0;
          let ourMicronotsStaked = 0n;
          for (const miner of newMiners) {
            if (!('bid' in miner)) continue;
            const address = miner.accountId;
            const microgonsPerSeat = miner.bid;
            const lastBidAtTick = 'bidAtTick' in miner ? miner.bidAtTick : undefined;
            const ourSubAccount = this.accountset.subAccountsByAddress[address];
            if (ourSubAccount) {
              hasMiningSeats = true;
              x.seatCountWon += 1;
              x.microgonsBidTotal += microgonsPerSeat;
              ourMicronotsStaked += miner.argonots;
            }
            winningBids.push({
              address,
              subAccountIndex: ourSubAccount?.index,
              lastBidAtTick,
              bidPosition,
              microgonsPerSeat,
              micronotsStakedPerSeat: miner.argonots,
            });
            bidPosition++;
          }
          x.micronotsStakedPerSeat = x.seatCountWon ? ourMicronotsStaked / BigInt(x.seatCountWon) : 0n;
        });
        // The completed auction's winner list belongs to mining-frame history, not the bid totals file.
        await this.storage.miningFrameFile(biddingFrameIdOfNewCohort).mutate(x => {
          x.auctionCloseTick ??= block.tick;
          x.totalBidCount ||= latestClosedBidStats?.bidsCount ?? 0;
          x.winningBids = winningBids;
        });
      }
    }

    const feeBidsFile = this.storage.bidsFile(biddingFrameId, biddingFrameId + 1);

    // Closed cohorts get their totals from NewMiners; sample live cohort terms only at the current frame.
    if (currentFrameId >= this.miningFrames.currentFrameId) {
      const currentCohortActivationFrameId = currentFrameId + 1;
      const currentBidsFile = this.storage.bidsFile(currentFrameId, currentCohortActivationFrameId);
      await currentBidsFile.mutate(async x => {
        if (x.micronotsStakedPerSeat === 0n) {
          x.micronotsStakedPerSeat = await (api.query.miningSlot.argonotsPerMiningSeat() ?? Promise.resolve(0n));
        }
        if (x.microgonsToBeMinedPerBlock === 0n) {
          x.microgonsToBeMinedPerBlock = await this.mining.fetchMicrogonsPerBlockForMiner(
            api,
            currentCohortActivationFrameId,
          );
        }
        x.biddingFrameRewardTicksRemaining = this.miningFrames.getFrameRewardTicksRemaining(currentFrameId);
        x.lastBlockNumber = blockNumber;
      });
    }

    // Keep fees by block so replay can replace or remove a reorged fee; BotSyncer sums these for cohort cost.
    await feeBidsFile.mutate(x => {
      if (biddingTransactionFees > 0n) {
        x.transactionFeesByBlock[blockNumber] = biddingTransactionFees;
      } else {
        delete x.transactionFeesByBlock[blockNumber];
      }
    });
    return { hasMiningBids, hasMiningSeats };
  }

  private extractOwnPaidTransactionFee(
    api: ArgonApi,
    event: HistoricalEvent,
    extrinsicEvents: readonly HistoricalEvent[],
  ): bigint {
    if (event.section !== 'transactionPayment' || event.method !== 'TransactionFeePaid') return 0n;

    const { who: feePayer, actualFee } = event.data;
    if (feePayer !== this.accountset.fundingAccountId && feePayer !== this.accountset.txSubmitterPair.address) {
      return 0n;
    }
    const isMiningTx = extrinsicEvents.some(event => {
      let dispatchError;
      if (event.section === 'utility' && event.method === 'BatchInterrupted') {
        dispatchError = event.data.error;
      }
      if (event.section === 'system' && event.method === 'ExtrinsicFailed') {
        dispatchError = event.data.dispatchError;
      }
      const decoded = dispatchError ? findRuntimeModuleError(api, dispatchError) : undefined;
      if (decoded?.section === 'miningSlot') return true;
      if (event.section === 'miningSlot' && event.method === 'SlotBidderAdded') return true;
    });
    return isMiningTx ? actualFee : 0n;
  }
}
