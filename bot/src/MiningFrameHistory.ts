import {
  BotActivityType,
  type ArgonApi,
  type IHistoryFile,
  type IMiningFrameDetail,
  Mining,
  MiningFrames,
  MainchainClients,
  Accountset,
} from '@argonprotocol/apps-core';
import { type Storage } from './Storage.ts';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';

/**
 * Live frames: queries chain directly, not persisted.
 * Historical frames: reads from miningFrameFile cache, falls back to chain
 * queries at the historical block, persists once finalized.
 */
export class MiningFrameHistory {
  constructor(
    private readonly storage: Storage,
    private readonly accountset: Accountset,
    private readonly mainchainClients: MainchainClients,
    private readonly miningFrames: MiningFrames,
    private readonly blockWatch: BlockWatch,
    private readonly getCurrentFrameId: () => number,
  ) {}

  public async getDetail(frameId: number): Promise<IMiningFrameDetail> {
    const currentFrameId = this.getCurrentFrameId();
    if (frameId >= currentFrameId) {
      return this.getLiveDetail(frameId);
    }
    return this.getHistoricalDetail(frameId);
  }

  public getFinalizedFrameId(): number {
    const finalizedHeader = this.blockWatch?.finalizedBlockHeader;
    if (!finalizedHeader?.tick) return 0;

    const headerFrameId = finalizedHeader.frameId ?? this.miningFrames.getForTick(finalizedHeader.tick);
    return Math.max(0, headerFrameId - 1);
  }

  private async getLiveDetail(frameId: number): Promise<IMiningFrameDetail> {
    const miningFrameFile = this.storage.miningFrameFile(frameId);
    const persisted = (await miningFrameFile.exists()) ? await miningFrameFile.get() : null;

    const mining = new Mining(this.mainchainClients);
    const api = await this.mainchainClients.prunedClientOrArchivePromise;

    const [rawWinningBids, slots, totalBidCount, expectedAuctionCloseTick, auctionSeatCount] = await Promise.all([
      Mining.fetchWinningBids(api),
      Mining.fetchMiningSeats(this.accountset.fundingAccountId, api),
      api.query.miningSlot.historicalBidsPerSlot().then(h => h[0]?.bidsCount ?? 0),
      mining.fetchTickAtStartOfAuctionClosing(api),
      api.query.miningSlot.nextCohortSize(),
    ]);
    const winningBids = rawWinningBids.map(({ managedByAddress: _, ...bid }) => bid);

    return {
      frameId,
      totalBidCount,
      auctionSeatCount: auctionSeatCount ?? undefined,
      myLastBidMicrogons: persisted?.myLastBidMicrogons,
      auctionCloseTick: persisted?.auctionCloseTick,
      expectedAuctionCloseTick,
      winningBids,
      slots: this.attachSeatStartingFrameIds(frameId, slots),
    };
  }

  private async getHistoricalDetail(frameId: number): Promise<IMiningFrameDetail> {
    const finalizedFrameId = this.getFinalizedFrameId();
    const isFinalized = frameId <= finalizedFrameId;
    const miningFrameFile = this.storage.miningFrameFile(frameId);

    if (isFinalized && (await miningFrameFile.exists())) {
      const cached = await miningFrameFile.get();
      if (cached.auctionSeatCount !== undefined && this.hasCompleteSlots(cached.slots)) {
        return cached;
      }
    }

    const detail = await this.buildHistoricalDetail(frameId);

    if (frameId <= finalizedFrameId) {
      await miningFrameFile.mutate(x => {
        Object.assign(x, detail);
      });
    }

    return detail;
  }

  private async buildHistoricalDetail(frameId: number): Promise<IMiningFrameDetail> {
    const miningFrameFile = this.storage.miningFrameFile(frameId);
    const persisted = (await miningFrameFile.exists()) ? await miningFrameFile.get() : null;

    const frame = this.miningFrames.framesById[frameId];
    const needsSlots = !this.hasCompleteSlots(persisted?.slots);
    const auctionApiRequest = this.getHistoricalApi(frameId);
    let seatApiRequest: Promise<ArgonApi> | undefined;
    if (frame?.firstBlockHash && frame.firstBlockNumber != null) {
      seatApiRequest = this.miningFrames.clientAt({
        blockHash: frame.firstBlockHash,
        blockNumber: frame.firstBlockNumber,
      });
    }

    let lastBidRequest = Promise.resolve(persisted?.myLastBidMicrogons);
    if (persisted?.myLastBidMicrogons == null) {
      lastBidRequest = this.storage
        .historyFile(frameId + 1)
        .get()
        .then(history => this.extractMyLastBidMicrogons(history));
    }

    const [auctionApi, seatApi, myLastBidMicrogons] = await Promise.all([
      auctionApiRequest,
      seatApiRequest,
      lastBidRequest,
    ]);
    if (!auctionApi) throw new Error(`Auction history is unavailable for frame ${frameId}.`);

    const minersRequest = auctionApi.query.miningSlot.minersByCohort(frameId + 1);
    const bidCountsRequest = auctionApi.query.miningSlot.historicalBidsPerSlot();
    let seatsRequest: Promise<IMiningFrameDetail['slots']> | undefined;
    if (seatApi && needsSlots) {
      seatsRequest = Mining.fetchMiningSeats(this.accountset.fundingAccountId, seatApi);
    }

    const [miners, historicalBids, loadedSlots, auctionSeatCount] = await Promise.all([
      minersRequest,
      bidCountsRequest,
      seatsRequest,
      seatApi?.query.miningSlot.nextCohortSize(),
    ]);
    if (miners === null || !historicalBids?.[1]) {
      throw new Error(`Auction history is unavailable for frame ${frameId}.`);
    }

    const winningBids = miners.map((miner, bidPosition) => {
      let subAccountIndex: number | undefined;
      if (miner.externalFundingAccount === this.accountset.fundingAccountId) {
        subAccountIndex = this.accountset.subAccountsByAddress[miner.accountId]?.index;
      }

      return {
        address: miner.accountId,
        subAccountIndex,
        bidPosition,
        microgonsPerSeat: miner.bid,
        micronotsStakedPerSeat: miner.argonots,
      };
    });
    const totalBidCount = historicalBids[1].bidsCount;
    const auctionCloseTick =
      persisted?.auctionCloseTick ?? this.miningFrames.framesById[frameId + 1]?.firstBlockTick ?? undefined;
    let slots = loadedSlots ?? persisted?.slots ?? [];

    if (winningBids.length && slots.length) {
      slots = this.applyWinningBidsToAuctionSlot(frameId, slots, winningBids);
    }

    return {
      frameId,
      totalBidCount,
      auctionSeatCount: auctionSeatCount ?? undefined,
      myLastBidMicrogons,
      auctionCloseTick,
      winningBids,
      slots: this.attachSeatStartingFrameIds(frameId, slots),
    };
  }

  private async getHistoricalApi(frameId: number) {
    const nextFrame = this.miningFrames.framesById[frameId + 1];
    if (!nextFrame?.firstBlockHash || nextFrame.firstBlockNumber == null) {
      return null;
    }
    return this.miningFrames.clientAt({
      blockHash: nextFrame.firstBlockHash,
      blockNumber: nextFrame.firstBlockNumber,
    });
  }

  private extractMyLastBidMicrogons(historyFile: IHistoryFile): bigint | undefined {
    let lastBid: { tick: number; microgonsPerSeat: bigint } | undefined;
    for (const activity of historyFile.activities) {
      if (activity.type !== BotActivityType.BidsSubmitted && activity.type !== BotActivityType.BidsRejected) {
        continue;
      }
      const { microgonsPerSeat } = activity.data as { microgonsPerSeat: bigint };
      if (!lastBid || activity.tick >= lastBid.tick) {
        lastBid = { tick: activity.tick, microgonsPerSeat };
      }
    }
    return lastBid?.microgonsPerSeat;
  }

  private applyWinningBidsToAuctionSlot(
    frameId: number,
    slots: IMiningFrameDetail['slots'],
    winningBids: IMiningFrameDetail['winningBids'],
  ): IMiningFrameDetail['slots'] {
    const auctionSlotId = (frameId + 1) % 10;
    const auctionSlot = slots.find(s => s.slotId === auctionSlotId);
    if (!auctionSlot) return slots;

    const seats = auctionSlot.seats.map(seat => ({
      ...seat,
      bid: null as typeof seat.bid,
    }));
    const unassigned: (typeof seats)[number]['bid'][] = [];

    for (const bid of winningBids) {
      const slotBid = {
        startingFrameId: frameId + 1,
        slotId: auctionSlotId,
        address: bid.address,
        bidAmount: bid.microgonsPerSeat ?? 0n,
      };
      if (bid.bidPosition != null && bid.bidPosition >= 0 && bid.bidPosition < seats.length) {
        seats[bid.bidPosition].bid = slotBid;
      } else {
        unassigned.push(slotBid);
      }
    }

    for (const seat of seats) {
      if (seat.bid || !seat.miner?.address) continue;
      const idx = unassigned.findIndex(b => b!.address === seat.miner!.address);
      if (idx >= 0) seat.bid = unassigned.splice(idx, 1)[0];
    }

    for (const seat of seats) {
      if (!seat.bid && unassigned.length) seat.bid = unassigned.shift()!;
    }

    return slots.map(s => (s.slotId === auctionSlotId ? { ...s, seats } : s));
  }

  private hasCompleteSlots(slots?: IMiningFrameDetail['slots'] | null): boolean {
    return Boolean(
      slots?.length === 10 &&
        slots.every(slot => slot.seats.length > 0 && slot.seats.every(seat => 'startingFrameId' in seat)),
    );
  }

  private attachSeatStartingFrameIds(frameId: number, slots: IMiningFrameDetail['slots']): IMiningFrameDetail['slots'] {
    const totalSlotCount = 10;

    return slots.map(slot => {
      const startingFrameId = frameId - ((frameId - slot.slotId + totalSlotCount) % totalSlotCount);

      return {
        ...slot,
        seats: slot.seats.map(seat => ({
          ...seat,
          startingFrameId: seat.miner?.startingFrameId ?? startingFrameId,
        })),
      };
    });
  }
}
