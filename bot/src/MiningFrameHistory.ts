import {
  BotActivityType,
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
    private readonly getCurrentFrameId: () => Promise<number>,
  ) {}

  public async getDetail(frameId: number): Promise<IMiningFrameDetail> {
    const currentFrameId = await this.getCurrentFrameId();
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
    const api = await this.mainchainClients.archiveClientPromise;

    const [rawWinningBids, slots, totalBidCount, expectedAuctionCloseTick] = await Promise.all([
      Mining.fetchWinningBids(api),
      Mining.fetchMiningSeats(this.accountset.seedAddress, api),
      api.query.miningSlot.historicalBidsPerSlot().then(h => h[0]?.bidsCount.toNumber() ?? 0),
      mining.fetchTickAtStartOfAuctionClosing(api),
    ]);
    const winningBids = rawWinningBids.map(({ managedByAddress: _, ...bid }) => bid);

    return {
      frameId,
      totalBidCount,
      myLastBidMicrogons: persisted?.myLastBidMicrogons,
      auctionCloseTick: persisted?.auctionCloseTick,
      expectedAuctionCloseTick,
      winningBids,
      slots,
    };
  }

  private async getHistoricalDetail(frameId: number): Promise<IMiningFrameDetail> {
    const finalizedFrameId = this.getFinalizedFrameId();
    const isFinalized = frameId < finalizedFrameId;
    const miningFrameFile = this.storage.miningFrameFile(frameId);

    if (isFinalized && (await miningFrameFile.exists())) {
      const cached = await miningFrameFile.get();
      if (cached.winningBids.length && this.hasCompleteSlots(cached.slots)) {
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

    const api = await this.getHistoricalApi(frameId);

    let winningBids = persisted?.winningBids ?? [];
    if (!winningBids.length && api) {
      const cohortActivationFrameId = frameId + 1;
      const [miners, micronotsPerSeat] = await Promise.all([
        api.query.miningSlot.minersByCohort(cohortActivationFrameId),
        api.query.miningSlot.argonotsPerMiningSeat().then(x => x.toBigInt()),
      ]);
      winningBids = miners.map((miner, i) => {
        const address = miner.accountId.toHuman();
        const managedBy = miner.externalFundingAccount.isSome
          ? miner.externalFundingAccount.value.toHuman()
          : undefined;
        return {
          address,
          subAccountIndex:
            managedBy === this.accountset.seedAddress
              ? this.accountset.subAccountsByAddress[address]?.index
              : undefined,
          bidPosition: i,
          microgonsPerSeat: miner.bid.toBigInt(),
          micronotsStakedPerSeat: micronotsPerSeat,
        };
      });
    }

    let totalBidCount = persisted?.totalBidCount ?? 0;
    if (!totalBidCount && api) {
      const historical = await api.query.miningSlot.historicalBidsPerSlot();
      totalBidCount = historical[1]?.bidsCount.toNumber() ?? 0;
    }

    let auctionCloseTick = persisted?.auctionCloseTick;
    if (!auctionCloseTick) {
      auctionCloseTick = this.miningFrames.framesById[frameId + 1]?.firstBlockTick ?? undefined;
    }

    let myLastBidMicrogons = persisted?.myLastBidMicrogons;
    if (myLastBidMicrogons === undefined) {
      const historyFile = await this.storage.historyFile(frameId + 1).get();
      myLastBidMicrogons = this.extractMyLastBidMicrogons(historyFile);
    }

    let slots = persisted?.slots ?? [];
    if (!this.hasCompleteSlots(slots)) {
      const frame = this.miningFrames.framesById[frameId];
      if (frame?.firstBlockHash && frame.firstBlockNumber != null) {
        const frameApi = await this.miningFrames.clientAt({
          blockHash: frame.firstBlockHash,
          blockNumber: frame.firstBlockNumber,
        });
        slots = await Mining.fetchMiningSeats(this.accountset.seedAddress, frameApi);
      }
    }

    if (winningBids.length && slots.length) {
      slots = this.applyWinningBidsToAuctionSlot(frameId, slots, winningBids);
    }

    return {
      frameId,
      totalBidCount,
      myLastBidMicrogons,
      auctionCloseTick,
      winningBids,
      slots,
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
    const auctionSlot = slots.find((s: IMiningFrameDetail['slots'][number]) => s.slotId === auctionSlotId);
    if (!auctionSlot) return slots;

    const seats = auctionSlot.seats.map((seat: IMiningFrameDetail['slots'][number]['seats'][number]) => ({
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

    return slots.map((s: IMiningFrameDetail['slots'][number]) => (s.slotId === auctionSlotId ? { ...s, seats } : s));
  }

  private hasCompleteSlots(slots?: IMiningFrameDetail['slots'] | null): boolean {
    return Boolean(slots?.length === 10 && slots.every((s: IMiningFrameDetail['slots'][number]) => s.seats.length > 0));
  }
}
