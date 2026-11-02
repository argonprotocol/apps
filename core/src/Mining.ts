import type {
  ArgonApi,
  ArgonClient,
  ArgonCurrentQueryClient,
  ArgonQueryClient,
  MainchainClients,
} from './MainchainClients.js';
import type { PreviousRuntimeSpec } from './runtimeCompatibility.js';
import type { LiveQueryRecord } from '@argonprotocol/runtime-client';
import { bigIntMax, bigIntMin, bigNumberToBigInt, numericToAlpha } from './utils.js';
import type { IWinningBid } from './interfaces/index.js';
import { BotActivityType, type IHistoryFile } from './interfaces/IHistoryFile.js';
import type { IMiningIndex } from './Accountset.ts';
import { NetworkConfig } from './NetworkConfig.js';
import { Currency } from './Currency.js';
import { BlockWatch } from './BlockWatch.js';

const MAXIMUM_ARGONOT_PRORATA_PERCENT = 0.8;
const ARGONOTS_PERCENT_ADJUSTMENT_DAMPER = 1.2;
const MINIMUM_MINING_SEATS_PER_SLOT = 10;

export interface IMiningSeat {
  id: string;
  index: number;
  slotId: number;
  miner: IMiningSeatMiner | null;
  bid: IMiningSlotBid | null;
}

export interface IMiningSeatMiner {
  startingFrameId: number;
  address: string;
  isOurs: boolean;
  bidAmount: bigint;
  micronotsStaked?: bigint;
}

export interface IMiningSlotBid {
  startingFrameId: number;
  slotId: number;
  address: string;
  bidAmount: bigint;
  micronotsStaked?: bigint;
}

export interface IMiningSlot {
  slotId: number;
  seats: IMiningSeat[];
}

export interface IMiningCohortStats {
  startingFrameId: number;
  seatCount: number;
  bidCosts: bigint;
  micronotsStaked: bigint;
  blockRewards: {
    microgons: bigint;
    micronots: bigint;
  };
  entryArgonotPrice: bigint;
  /** Scheduled rewards estimated from observed wins, plus actual expansion minting. */
  frameRewards: {
    frameId: number;
    microgons: bigint;
    micronots: bigint;
    argonotPrice: bigint;
  }[];
}

export class Mining {
  private readonly historicalSnapshots = new Map<number, Promise<ArgonApi>>();
  private readonly historicalArgonotPrices = new Map<number, Promise<bigint>>();
  private readonly frameRewardHistory = new Map<
    number,
    {
      lastBlockNumber: number;
      rewardsByCohort: Map<number, { microgons: bigint; micronots: bigint }>;
    }
  >();

  public get prunedClientOrArchivePromise(): Promise<ArgonClient> {
    return this.clients.prunedClientPromise ?? this.clients.archiveClientPromise;
  }

  constructor(public readonly clients: MainchainClients) {}

  public static async usesRangeBidding(client: ArgonCurrentQueryClient, frameId: number): Promise<boolean> {
    if (!('auctionRulesStartAt' in client.query.miningSlot)) return false;

    const firstRangeFrame = await client.query.miningSlot.auctionRulesStartAt();
    if (firstRangeFrame === null) throw new Error('Mining auction activation is unavailable');

    return frameId >= firstRangeFrame;
  }

  public static createBidTx(
    client: ArgonClient,
    options: {
      bidAmount: bigint;
      keys: Parameters<ArgonClient['tx']['miningSlot']['bid']>[1];
      address: string;
      frameId?: number;
      maxHash?: string;
    },
  ) {
    const { bidAmount, keys, address, frameId, maxHash } = options;
    const bid = client.tx.miningSlot.bid as
      | ArgonClient['tx']['miningSlot']['bid']
      | PreviousRuntimeSpec.Transactions<'promise'>['miningSlot']['bid'];
    if (bid.meta.args.length === 5) {
      return (bid as ArgonClient['tx']['miningSlot']['bid'])(
        bidAmount,
        keys,
        address,
        frameId ?? null,
        maxHash ?? null,
      );
    }
    return (bid as PreviousRuntimeSpec.Transactions<'promise'>['miningSlot']['bid'])(bidAmount, keys, address);
  }

  public static async fetchBidMaxima(
    client: ArgonCurrentQueryClient,
    bids: NonNullable<LiveQueryRecord<'miningSlot', 'bidsForNextSlotCohort'>>,
  ) {
    const standingBids = await client.query.miningSlot.standingBids.multi(bids.map(bid => bid.accountId));
    if (!standingBids) throw new Error('Standing mining bids are unavailable');

    const funders = [...new Set(bids.map(bid => bid.externalFundingAccount ?? bid.accountId))];
    const accounts = await client.query.system.account.multi(funders);
    const available = new Map<string, bigint>();
    for (const [index, account] of accounts.entries()) {
      available.set(funders[index], this.availableBidBalance(account, client.consts.balances.existentialDeposit));
    }

    const offers = bids.map((bid, index) => ({ bid, standing: standingBids[index], index }));
    offers.sort((a, b) => {
      const blockOrder = (a.standing?.submittedAt ?? 0) - (b.standing?.submittedAt ?? 0);
      if (blockOrder !== 0) return blockOrder;
      return (a.standing?.position ?? a.index) - (b.standing?.position ?? b.index);
    });

    const increment = client.consts.miningSlot.bidIncrements;
    const maxima = new Map<string, { maxMicrogons: bigint; fundedMaxMicrogons: bigint }>();

    // Match funded_standing_offers: shared wallets fund older commitments first.
    for (const { bid, standing } of offers) {
      const funder = bid.externalFundingAccount ?? bid.accountId;
      const free = available.get(funder)!;
      const maxMicrogons = standing?.max ?? bid.bid;
      const extra = bigIntMin(bigIntMax(maxMicrogons - bid.bid, 0n), (free / increment) * increment);

      maxima.set(bid.accountId, { maxMicrogons, fundedMaxMicrogons: bid.bid + extra });
      available.set(funder, free - extra);
    }

    return maxima;
  }

  public static availableBidBalance(account: LiveQueryRecord<'system', 'account'>, existentialDeposit: bigint): bigint {
    let untouchable = bigIntMax(account.data.frozen - account.data.reserved, 0n);
    if (account.data.free > 0n && account.providers === 1) {
      untouchable = bigIntMax(untouchable, existentialDeposit);
    }

    return bigIntMax(account.data.free - untouchable, 0n);
  }

  public async getRecentSeatSummaries(
    api?: ArgonQueryClient,
  ): Promise<{ biddingFrameId: number; seats: number; lowestWinningBid: bigint; highestWinningBid: bigint }[]> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const bidsPerFrame = (await client.query.miningSlot.minersByCohort.entries()) ?? [];

    const summaries = [];
    for (const [frameIdRaw, cohortData] of bidsPerFrame) {
      const bids = cohortData.map(x => x.bid);
      const lowestWinningBid = bigIntMin(...bids);
      const highestWinningBid = bigIntMax(...bids);
      summaries.push({
        biddingFrameId: Number(frameIdRaw.args[0]) - 1,
        seats: cohortData.length,
        lowestWinningBid,
        highestWinningBid,
      });
    }

    return summaries.sort((a, b) => b.biddingFrameId - a.biddingFrameId);
  }

  public async fetchAggregateBlockRewards(api?: ArgonQueryClient): Promise<{
    microgons: bigint;
    micronots: bigint;
  }> {
    const cohorts = await this.fetchProjectedCohortStats(api);
    return cohorts.reduce(
      (rewards, cohort) => {
        rewards.microgons += cohort.blockRewards.microgons;
        rewards.micronots += cohort.blockRewards.micronots;
        return rewards;
      },
      { microgons: 0n, micronots: 0n },
    );
  }

  public async fetchActiveCohortStats(api?: ArgonQueryClient): Promise<IMiningCohortStats[]> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const cohorts = await this.fetchProjectedCohortStats(client);
    if (cohorts.length === 0) return [];

    const [nextFrameId, frameStartBlocks, blockNumber, currentTick, remainingTicks, activeMiners, latestPrice] =
      await Promise.all([
        this.fetchNextFrameId(client),
        client.query.miningSlot.frameStartBlockNumbers(),
        client.query.system.number(),
        this.fetchCurrentTick(client),
        this.fetchFrameRewardTicksRemaining(client),
        this.fetchActiveMinersCount(client),
        this.readArgonotPrice(client),
      ]);
    if (!frameStartBlocks) throw new Error('Mining frame boundaries are unavailable');
    const currentFrameId = nextFrameId - 1;
    const firstFrameId = Math.min(...cohorts.map(cohort => cohort.startingFrameId));
    const frames = [...frameStartBlocks]
      .sort((a, b) => b - a)
      .map((firstBlockNumber, index) => ({ frameId: currentFrameId - index, firstBlockNumber }))
      .filter(frame => frame.frameId >= firstFrameId)
      .reverse();
    if (frames[0]?.frameId !== firstFrameId) throw new Error('Active mining cohort history is incomplete');

    const history = new Map<
      number,
      {
        entryPrice: bigint;
        price: bigint;
        rewards: Map<number, { microgons: bigint; micronots: bigint }>;
      }
    >();
    await Promise.all(
      frames.map(async (frame, index) => {
        const lastBlockNumber = frames[index + 1]?.firstBlockNumber
          ? frames[index + 1].firstBlockNumber - 1
          : blockNumber;
        const [entryPrice, rewards, price] = await Promise.all([
          this.getHistoricalArgonotPrice(frame.firstBlockNumber),
          this.estimateFrameRewards({
            frameId: frame.frameId,
            firstBlockNumber: frame.firstBlockNumber,
            lastBlockNumber,
          }),
          frame.frameId < currentFrameId ? this.getHistoricalArgonotPrice(lastBlockNumber) : latestPrice,
        ]);
        history.set(frame.frameId, {
          entryPrice,
          price,
          rewards,
        });
      }),
    );

    // Finalized frame facts are immutable. Keep only the active terms' history.
    const firstBlockNumber = frames[0].firstBlockNumber;
    for (const cache of [this.historicalSnapshots, this.historicalArgonotPrices]) {
      for (const key of cache.keys()) if (key < firstBlockNumber - 1) cache.delete(key);
    }
    for (const frameId of this.frameRewardHistory.keys()) {
      if (frameId < firstFrameId) this.frameRewardHistory.delete(frameId);
    }

    const ticksPerFrame = NetworkConfig.rewardTicksPerFrame;
    const nextFrameTick = currentTick + remainingTicks;
    return await Promise.all(
      cohorts.map(async cohort => {
        const entry = history.get(cohort.startingFrameId);
        if (!entry) throw new Error(`No entry price for mining cohort ${cohort.startingFrameId}`);
        const frameRewards: IMiningCohortStats['frameRewards'] = [];
        const argonReward = await this.fetchMicrogonsPerBlockForMiner(client, cohort.startingFrameId);
        for (
          let frameId = cohort.startingFrameId;
          frameId < cohort.startingFrameId + NetworkConfig.framesPerCohort;
          frameId += 1
        ) {
          const frame = history.get(frameId);
          const estimated = frame?.rewards.get(cohort.startingFrameId);
          let microgons = estimated?.microgons ?? 0n;
          let micronots = estimated?.micronots ?? 0n;
          if (frameId >= currentFrameId) {
            const startingTick =
              frameId === currentFrameId ? currentTick : nextFrameTick + (frameId - currentFrameId - 1) * ticksPerFrame;
            const ticks = frameId === currentFrameId ? remainingTicks : ticksPerFrame;
            const argonotRewards = await this.minimumMicronotsMinedDuringTickRange(
              startingTick,
              startingTick + ticks,
              client,
            );
            microgons += (argonReward * BigInt(ticks) * BigInt(cohort.seatCount)) / BigInt(activeMiners);
            micronots += (argonotRewards * BigInt(cohort.seatCount)) / BigInt(activeMiners);
          }
          frameRewards.push({ frameId, microgons, micronots, argonotPrice: frame?.price ?? latestPrice });
        }
        return { ...cohort, entryArgonotPrice: entry.entryPrice, frameRewards };
      }),
    );
  }

  public async fetchLastFrameBlockRewards(api?: ArgonQueryClient): Promise<{
    microgons: bigint;
    micronots: bigint;
  }> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const blockRewards = (await client.query.blockRewards.blockRewardsByCohort()) ?? [];
    const nextCohortId = Number(blockRewards.at(-1)?.[0] ?? 1);
    const currentCohortId = nextCohortId - 1;

    const currentTick = await this.fetchCurrentTick(api);
    const ticksBetweenFrames = NetworkConfig.rewardTicksPerFrame;
    const ticksElapsedThisFrame = ticksBetweenFrames - (await this.fetchFrameRewardTicksRemaining(api));

    const rewards = { microgons: 0n, micronots: 0n };
    if (!blockRewards.length) return rewards;

    const [cohortId, blockReward] = blockRewards.at(-1)!;
    const fullRotationsSinceCohortStart = currentCohortId - Number(cohortId);
    const ticksSinceCohortStart = fullRotationsSinceCohortStart * ticksBetweenFrames + ticksElapsedThisFrame;
    const startingTick = currentTick - ticksSinceCohortStart;
    const endingTick = startingTick + NetworkConfig.ticksPerCohort;
    const microgonsMinedInCohort = (blockReward * BigInt(NetworkConfig.ticksPerCohort)) / 10n;
    const micronotsMinedInCohort =
      (await this.minimumMicronotsMinedDuringTickRange(startingTick, endingTick, api)) / 10n;
    rewards.microgons += microgonsMinedInCohort;
    rewards.micronots += micronotsMinedInCohort;

    return rewards;
  }

  public async fetchPreviousDayWinningBidAmounts(api?: ArgonQueryClient): Promise<bigint[]> {
    const startingFrameId = (await this.fetchNextFrameId(api)) - 1;
    let frameIdToCheck = startingFrameId;
    while (true) {
      // We must loop backwards until we find a frame with winning bids
      if (frameIdToCheck < startingFrameId - 10 || frameIdToCheck <= 0) {
        // We've checked the last 10 frames and found no winning bids, so we're done
        return [];
      }
      const winningBids = await this.fetchWinningBidAmountsForFrame(frameIdToCheck, api);
      if (winningBids.length > 0) {
        return winningBids;
      }
      frameIdToCheck--;
    }
  }

  public async fetchFrameRewardTicksRemaining(api?: ArgonQueryClient): Promise<number> {
    const client = api ?? (await this.clients.prunedClientOrArchivePromise);
    return (await client.query.miningSlot.frameRewardTicksRemaining()) ?? 0;
  }

  public async fetchTickAtStartOfNextCohort(api?: ArgonQueryClient): Promise<number> {
    const currentTick = await this.fetchCurrentTick(api);
    const remainingFrameTicks = await this.fetchFrameRewardTicksRemaining(api);
    return currentTick + remainingFrameTicks;
  }

  public async fetchTickAtStartOfAuctionClosing(api?: ArgonQueryClient): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const tickAtStartOfNextCohort = await this.fetchTickAtStartOfNextCohort(api);
    const miningConfig = await client.query.miningSlot.miningConfig();
    const ticksBeforeBidEndForVrfClose =
      'ticksBeforeBidEndForVrfClose' in miningConfig
        ? miningConfig.ticksBeforeBidEndForVrfClose
        : miningConfig.blocksBeforeBidEndForVrfClose;
    return tickAtStartOfNextCohort - (ticksBeforeBidEndForVrfClose ?? 0);
  }

  public async fetchCurrentMiningSeats(managedByAccount: string): Promise<IMiningSlot[]> {
    const client = await this.clients.prunedClientOrArchivePromise;
    return await Mining.fetchMiningSeats(managedByAccount, client);
  }

  public static async fetchMiningSeats(managedByAccount: string, api: ArgonQueryClient): Promise<IMiningSlot[]> {
    const [cohorts, bidsForNextSlotCohort, nextCohortSize, nextFrameId] = await Promise.all([
      api.query.miningSlot.minersByCohort.entries(),
      api.query.miningSlot.bidsForNextSlotCohort(),
      api.query.miningSlot.nextCohortSize(),
      api.query.miningSlot.nextFrameId(),
    ]);
    if (!cohorts || !bidsForNextSlotCohort || nextCohortSize === null || nextFrameId === null) return [];

    const totalSlotCount = 10;
    const nextAuctionSlotId = nextFrameId % totalSlotCount;
    const bidsBySlotId = new Map<number, IMiningSlotBid[]>();
    for (const bid of bidsForNextSlotCohort) {
      const startingFrameId = 'startingFrameId' in bid ? bid.startingFrameId : bid.cohortFrameId;
      const slotId = startingFrameId % totalSlotCount;
      const bids = bidsBySlotId.get(slotId) ?? [];
      bids.push({
        startingFrameId,
        slotId,
        address: bid.accountId,
        bidAmount: bid.bid,
        micronotsStaked: bid.argonots,
      });
      bidsBySlotId.set(slotId, bids);
    }

    const slots: IMiningSlot[] = [];
    const processedSlotIds = new Set<number>();
    for (const [key, cohort] of cohorts) {
      const startingFrameId = key.args[0];
      const slotId = startingFrameId % totalSlotCount;
      processedSlotIds.add(slotId);
      const seats: IMiningSeat[] = [];
      for (const [index, member] of cohort.entries()) {
        const address = member.accountId;
        const isOurs = member.externalFundingAccount === managedByAccount;
        const bidAmount = member.bid;
        const micronotsStaked = member.argonots;
        const id = `${numericToAlpha(slotId)}${index + 1}`;
        seats.push({
          id,
          index,
          slotId,
          miner: { startingFrameId, address, isOurs, bidAmount, micronotsStaked },
          bid: null,
        });
      }

      const bids = bidsBySlotId.get(slotId) ?? [];
      const alignedSeats: IMiningSeat[] = [];
      const nextAuctionSeatCount = slotId === nextAuctionSlotId ? nextCohortSize : 0;
      const totalSeats = Math.max(nextAuctionSeatCount, seats.length, bids.length);
      for (let i = 0; i < totalSeats; i += 1) {
        const existingSeat = seats[i];
        alignedSeats.push({
          id: existingSeat?.id ?? `${numericToAlpha(slotId)}${i + 1}`,
          index: existingSeat?.index ?? i,
          slotId,
          miner: existingSeat?.miner ?? null,
          bid: bids[i] ?? null,
        });
      }

      alignedSeats.sort((a, b) => a.index - b.index);

      slots.push({ slotId, seats: alignedSeats });
    }

    for (let slotId = 0; slotId < totalSlotCount; slotId += 1) {
      if (processedSlotIds.has(slotId)) continue;
      const bids = bidsBySlotId.get(slotId) ?? [];
      const nextAuctionSeatCount = slotId === nextAuctionSlotId ? nextCohortSize : 0;
      slots.push({
        slotId,
        seats: Array.from({ length: Math.max(nextAuctionSeatCount, bids.length) }, (_, index) => ({
          id: `${numericToAlpha(slotId)}${index + 1}`,
          index,
          slotId,
          miner: null,
          bid: bids[index] ?? null,
        })),
      });
    }

    slots.sort((a, b) => Number(a.slotId) - Number(b.slotId));
    return normalizeMiningSeatSlots(slots, nextAuctionSlotId);
  }

  public static summarizeBidHistory(history: IHistoryFile | undefined, networkBidCount?: number) {
    if (!history?.activities.length) {
      // An empty network auction proves zero accepted bids, but not zero rejected attempts.
      if (networkBidCount === 0) return { acceptedBidCount: 0 };
      return;
    }

    let submittedBidCount = 0;
    let acceptedBidCount = 0;
    let maximumMicrogons: bigint | undefined;
    for (const activity of history.activities) {
      if (activity.type !== BotActivityType.BidsSubmitted && activity.type !== BotActivityType.BidsRejected) continue;
      submittedBidCount += activity.data.submittedCount;
      let acceptedCount = activity.data.submittedCount;
      if (activity.type === BotActivityType.BidsRejected) acceptedCount -= activity.data.rejectedCount;
      if (acceptedCount <= 0) continue;

      acceptedBidCount += acceptedCount;
      const amount = activity.data.maxMicrogonsPerSeat ?? activity.data.microgonsPerSeat;
      if (maximumMicrogons === undefined || amount > maximumMicrogons) maximumMicrogons = amount;
    }
    return { submittedBidCount, acceptedBidCount, maximumMicrogons };
  }

  public static async fetchWinningBids(
    api: ArgonQueryClient,
  ): Promise<(IWinningBid & { managedByAddress?: string; micronotsStakedPerSeat: bigint })[]> {
    const nextCohort = await api.query.miningSlot.bidsForNextSlotCohort();
    return (nextCohort ?? []).map((c, i) => {
      const address = c.accountId;
      const subAccountIndex = undefined;
      const lastBidAtTick = c.bidAtTick;
      const bidPosition = i;
      const microgonsPerSeat = c.bid;
      const micronotsStakedPerSeat = c.argonots;
      const managedByAddress = c.externalFundingAccount ?? undefined;
      return {
        address,
        subAccountIndex,
        lastBidAtTick,
        bidPosition,
        microgonsPerSeat,
        micronotsStakedPerSeat,
        managedByAddress,
      };
    });
  }

  public static async fetchMiningSeatsForAccount(
    managedByAccount: string,
    api: ArgonQueryClient,
  ): Promise<{ [address: string]: { seat: IMiningIndex; isLastDay: boolean } }> {
    const addressToMiningIndex: { [address: string]: { seat: IMiningIndex; isLastDay: boolean } } = {};
    const cohorts = await api.query.miningSlot.minersByCohort.entries();
    const nextFrameId = await api.query.miningSlot.nextFrameId();
    if (!cohorts || nextFrameId === null) return addressToMiningIndex;

    for (const [key, cohort] of cohorts) {
      const frameId = key.args[0];
      for (const [index, member] of cohort.entries()) {
        if (member.externalFundingAccount !== managedByAccount) continue;
        const address = member.accountId;
        addressToMiningIndex[address] = {
          seat: {
            startingFrameId: frameId,
            index,
            bidAmount: member.bid,
          },
          isLastDay: nextFrameId - frameId === 10,
        };
      }
    }
    return addressToMiningIndex;
  }

  public async fetchWinningBidAmountsForFrame(frameId: number, api?: ArgonQueryClient): Promise<bigint[]> {
    if (frameId < 1) return [];
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const winningBids = await client.query.miningSlot.minersByCohort(frameId);
    return winningBids?.map(bid => bid.bid) ?? [];
  }

  public async onCohortChange(options: {
    onBiddingStart?: (cohortStartingFrameId: number) => Promise<void>;
    onBiddingEnd?: (cohortStartingFrameId: number) => Promise<void>;
  }): Promise<{ unsubscribe: () => void }> {
    const { onBiddingStart, onBiddingEnd } = options;
    const client = await this.clients.prunedClientOrArchivePromise;
    let openCohortStartingFrameId = 0;
    const unsubscribe = await client.queryMulti(
      [client.query.miningSlot.isNextSlotBiddingOpen, client.query.miningSlot.nextFrameId],
      ([isBiddingOpen, nextFrameId]) => {
        if (isBiddingOpen) {
          if (openCohortStartingFrameId !== 0) {
            void onBiddingEnd?.(openCohortStartingFrameId);
          }
          openCohortStartingFrameId = nextFrameId;
          void onBiddingStart?.(nextFrameId);
        } else {
          void onBiddingEnd?.(nextFrameId);
          openCohortStartingFrameId = 0;
        }
      },
    );
    return { unsubscribe };
  }

  public async fetchNextFrameId(api?: ArgonQueryClient): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const nextFrameId = await client.query.miningSlot.nextFrameId();
    if (nextFrameId === null) throw new Error('Mining frame storage is unavailable');
    return nextFrameId;
  }

  public async fetchCurrentTick(api?: ArgonQueryClient): Promise<number> {
    const client = api ?? (await this.clients.prunedClientOrArchivePromise);
    return client.query.ticks.currentTick();
  }

  public async getNextEpochMaxMiners(api?: ArgonQueryClient): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const nextFrameId = await this.fetchNextFrameId(api);
    const nextCohortSize = await this.fetchNextCohortSize(api);
    const scheduledChanges = await client.query.miningSlot.scheduledCohortSizeChangeByFrame();
    const scheduledChangesByFrame: { [frameId: number]: number } = {};
    for (const [rawFrameId, newCohortSize] of Object.entries(scheduledChanges ?? {})) {
      const frameId = Number(rawFrameId);
      scheduledChangesByFrame[frameId] = newCohortSize;
    }
    let maxMiners = 0;
    let nextSize = nextCohortSize;
    for (let i = nextFrameId; i < nextFrameId + 10; i++) {
      if (scheduledChangesByFrame[i]) {
        nextSize = scheduledChangesByFrame[i];
      }
      maxMiners += nextSize;
    }
    return maxMiners;
  }

  public async fetchNextCohortSize(api?: ArgonQueryClient): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const nextCohortSize = await client.query.miningSlot.nextCohortSize();
    if (nextCohortSize === null) throw new Error('Mining cohort storage is unavailable');
    return nextCohortSize;
  }

  public async fetchActiveMinersCount(api?: ArgonQueryClient): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    return (await client.query.miningSlot.activeMinersCount()) ?? 0;
  }

  public async fetchAggregateBidCosts(api?: ArgonQueryClient): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const bidsPerFrame = (await client.query.miningSlot.minersByCohort.entries()) ?? [];

    let aggregateBidCosts = 0n;
    for (const [_, cohortData] of bidsPerFrame) {
      aggregateBidCosts += cohortData.reduce((acc, bid) => acc + bid.bid, 0n);
    }

    return aggregateBidCosts;
  }

  public async fetchAggregateMicronotsStaked(api?: ArgonQueryClient): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const minersByCohort = (await client.query.miningSlot.minersByCohort.entries()) ?? [];

    return minersByCohort.reduce((total, [_, cohort]) => {
      return total + cohort.reduce((cohortTotal, miner) => cohortTotal + miner.argonots, 0n);
    }, 0n);
  }

  public async fetchLastFramesBidCosts(api?: ArgonQueryClient): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const bidsPerFrame = (await client.query.miningSlot.minersByCohort.entries()) ?? [];

    let calculatedBidCosts = 0n;
    let calculatedFrameId = 0;
    for (const [frameIdRaw, cohortData] of bidsPerFrame) {
      const frameId = Number(frameIdRaw.args[0]);
      if (frameId < calculatedFrameId) continue;
      calculatedFrameId = frameId;
      calculatedBidCosts = cohortData.reduce((acc, bid) => acc + bid.bid, 0n);
    }

    return calculatedBidCosts;
  }

  public async fetchCurrentMicronotsForBid(api?: ArgonQueryClient): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    return (await client.query.miningSlot.argonotsPerMiningSeat()) ?? 0n;
  }

  public async fetchMaximumMicronotsForBid(api?: ArgonQueryClient): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const ownershipCirculation = await client.query.ownership.totalIssuance();
    const currentMaxMiners = await this.getNextEpochMaxMiners(api);
    const baseOwnershipTokens = ownershipCirculation / BigInt(currentMaxMiners);
    const maxValue = Math.ceil(MAXIMUM_ARGONOT_PRORATA_PERCENT * Number(baseOwnershipTokens));

    return BigInt(maxValue);
  }

  public async fetchMaximumMicronotsForEndOfEpochBid(api?: ArgonQueryClient): Promise<bigint> {
    const currentMicronots = await this.fetchCurrentMicronotsForBid(api);

    const adjustmentFactorNumerator = BigInt(ARGONOTS_PERCENT_ADJUSTMENT_DAMPER * 100);
    const adjustmentFactorDenominator = 100n;
    const compoundedNumerator = adjustmentFactorNumerator ** 10n;
    const compoundedDenominator = adjustmentFactorDenominator ** 10n;
    const adjustedMicronots = (currentMicronots * compoundedNumerator) / compoundedDenominator;

    const maximumPossible = await this.fetchMaximumMicronotsForBid(api);
    const maximumMicronots = Math.min(Number(adjustedMicronots), Number(maximumPossible));

    return BigInt(maximumMicronots);
  }

  public async fetchMicrogonsMinedPerBlockDuringNextCohort(api?: ArgonQueryClient): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    return this.fetchMicrogonsPerBlockForMiner(client);
  }

  public async fetchMicrogonsPerBlockForMiner(api: ArgonQueryClient, frameId?: number): Promise<bigint> {
    frameId ??= await this.fetchNextFrameId(api);
    if (frameId <= 1) {
      return this.getMiningRewardCut(api.consts.blockRewards.startingArgonsPerBlock, api);
    }
    const microgonsPerBlockByCohort = (await api.query.blockRewards.blockRewardsByCohort()) ?? [];
    for (const [cohortFrameActivationId, blockReward] of microgonsPerBlockByCohort) {
      if (Number(cohortFrameActivationId) === frameId) {
        return this.getMiningRewardCut(blockReward, api);
      }
    }
    throw new Error(`No block reward found for cohort starting at frame ID ${frameId}`);
  }

  public async getMiningRewardCut(microgons: bigint, api?: ArgonQueryClient): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const minerPercent = client.consts.blockRewards.minerPayoutPercent;
    return bigNumberToBigInt(minerPercent.times(microgons));
  }

  public async minimumMicronotsMinedDuringTickRange(
    tickStart: number,
    tickEnd: number,
    api?: ArgonQueryClient,
  ): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const { halvingBeginTicks, halvingTicks, incrementalGrowth, startingOwnershipTokensPerBlock } =
      client.consts.blockRewards;
    const [incrementAmount, incrementTicks, finalReward] = incrementalGrowth;
    const genesisTick = BigInt(NetworkConfig.get().genesisTick);
    const halvingStart = BigInt(halvingBeginTicks);
    const halvingInterval = BigInt(halvingTicks);
    const endingTick = BigInt(tickEnd);
    let totalRewards = 0n;

    // The runtime changes the per-block amount at elapsed-tick boundaries, independently
    // of mining frame rotation. Sum each constant-rate span and round the miner cut per block.
    for (let tick = BigInt(tickStart); tick < endingTick; ) {
      const elapsedTicks = tick - genesisTick;
      let rewardsPerBlock: bigint;
      let ticksUntilChange: bigint;
      if (elapsedTicks < halvingStart) {
        rewardsPerBlock = startingOwnershipTokensPerBlock + (elapsedTicks / incrementTicks) * incrementAmount;
        ticksUntilChange = bigIntMin(halvingStart - elapsedTicks, incrementTicks - (elapsedTicks % incrementTicks));
      } else {
        const ticksAfterHalving = elapsedTicks - halvingStart;
        const halvings = ticksAfterHalving / halvingInterval;
        rewardsPerBlock = finalReward / (halvings + 1n);
        ticksUntilChange = halvingInterval - (ticksAfterHalving % halvingInterval);
      }
      const nextTick = bigIntMin(endingTick, tick + ticksUntilChange);
      totalRewards += (await this.getMiningRewardCut(rewardsPerBlock, client)) * (nextTick - tick);
      tick = nextTick;
    }
    return totalRewards;
  }

  private async fetchProjectedCohortStats(
    api?: ArgonQueryClient,
  ): Promise<Omit<IMiningCohortStats, 'entryArgonotPrice' | 'frameRewards'>[]> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const [blockRewardsResult, minersByCohortResult, activeMiners] = await Promise.all([
      client.query.blockRewards.blockRewardsByCohort(),
      client.query.miningSlot.minersByCohort.entries(),
      this.fetchActiveMinersCount(client),
    ]);
    const blockRewards = blockRewardsResult ?? [];
    const minersByCohort = minersByCohortResult ?? [];
    const nextCohortId = Number(blockRewards.at(-1)?.[0] ?? 1);
    const currentCohortId = nextCohortId - 1;

    if (activeMiners === 0) return [];

    const currentTick = await this.fetchCurrentTick(client);
    const ticksBetweenFrames = NetworkConfig.rewardTicksPerFrame;
    const ticksElapsedThisFrame = ticksBetweenFrames - (await this.fetchFrameRewardTicksRemaining(client));
    const blockRewardsByCohort = new Map(blockRewards.map(([cohortId, reward]) => [Number(cohortId), reward]));

    const cohorts: Omit<IMiningCohortStats, 'entryArgonotPrice' | 'frameRewards'>[] = [];
    for (const [cohortIdRaw, cohort] of minersByCohort) {
      if (cohort.length === 0) continue;

      const cohortId = Number(cohortIdRaw.args[0]);
      const blockReward = blockRewardsByCohort.get(cohortId);
      const blockRewards = { microgons: 0n, micronots: 0n };
      if (blockReward) {
        const fullRotationsSinceCohortStart = currentCohortId - cohortId;
        const ticksSinceCohortStart = fullRotationsSinceCohortStart * ticksBetweenFrames + ticksElapsedThisFrame;
        const startingTick = currentTick - ticksSinceCohortStart;
        const endingTick = startingTick + NetworkConfig.ticksPerCohort;
        const seatCount = BigInt(cohort.length);
        const scheduledMicrogons = await this.getMiningRewardCut(
          blockReward * BigInt(NetworkConfig.ticksPerCohort),
          client,
        );
        const scheduledMicronots = await this.minimumMicronotsMinedDuringTickRange(startingTick, endingTick, client);

        blockRewards.microgons = (scheduledMicrogons * seatCount) / BigInt(activeMiners);
        blockRewards.micronots = (scheduledMicronots * seatCount) / BigInt(activeMiners);
      }

      cohorts.push({
        startingFrameId: cohortId,
        seatCount: cohort.length,
        bidCosts: cohort.reduce((total, miner) => total + miner.bid, 0n),
        micronotsStaked: cohort.reduce((total, miner) => total + miner.argonots, 0n),
        blockRewards,
      });
    }

    return cohorts;
  }

  /**
   * Shared, read-only estimates from finalized frame boundaries. Observed wins use
   * scheduled ARGN payouts and the elapsed interval's average ARGNOT payout. Notebook
   * reductions, pauses, and mint failures are not reconstructed. Expansion minting and
   * the pre-rotation activation payout remain actual amounts. Missing inputs fail the
   * refresh rather than publishing incomplete income.
   */
  private async estimateFrameRewards({
    frameId,
    firstBlockNumber,
    lastBlockNumber,
  }: {
    frameId: number;
    firstBlockNumber: number;
    lastBlockNumber: number;
  }): Promise<Map<number, { microgons: bigint; micronots: bigint }>> {
    const cached = this.frameRewardHistory.get(frameId);
    if (cached?.lastBlockNumber === lastBlockNumber) return cached.rewardsByCohort;

    const [api, firstApi, beforeApi] = await Promise.all([
      this.getHistoricalSnapshot(lastBlockNumber),
      this.getHistoricalSnapshot(firstBlockNumber),
      this.getHistoricalSnapshot(firstBlockNumber - 1),
    ]);
    const [
      scoringByCohort,
      blockRewards,
      mintedByCohort,
      beforeMinted,
      beforeCohorts,
      activationPayouts,
      firstTick,
      lastTick,
    ] = await Promise.all([
      api.query.miningSlot.minerNonceScoringByCohort(),
      api.query.blockRewards.blockRewardsByCohort(),
      api.query.mint.miningMintPerCohort(),
      beforeApi.query.mint.miningMintPerCohort(),
      beforeApi.query.miningSlot.minersByCohort.entries(),
      firstApi.query.blockRewards.payoutsByBlock(firstBlockNumber),
      firstApi.query.ticks.currentTick(),
      api.query.ticks.currentTick(),
    ]);
    if (!scoringByCohort || !blockRewards || !mintedByCohort || !beforeMinted || !beforeCohorts) {
      throw new Error('Mining frame statistics are unavailable');
    }

    const rewards = new Map<number, { microgons: bigint; micronots: bigint }>();
    const argonsByCohort = new Map(blockRewards.map(([id, reward]) => [Number(id), reward]));
    const elapsedTicks = lastTick - firstTick + 1;
    const scheduledMicronots = await this.minimumMicronotsMinedDuringTickRange(firstTick, lastTick + 1, api);
    for (const [id, miners] of Object.entries(scoringByCohort)) {
      const cohortId = Number(id);
      const wins = BigInt(miners.reduce((total, miner) => total + miner.blocksWonInFrame, 0));
      if (wins === 0n) continue;
      const blockReward =
        argonsByCohort.get(cohortId) ?? (cohortId <= 1 ? api.consts.blockRewards.startingArgonsPerBlock : undefined);
      if (blockReward === undefined) throw new Error(`No block reward found for mining cohort ${cohortId}`);
      rewards.set(cohortId, {
        microgons: (await this.getMiningRewardCut(blockReward, api)) * wins,
        micronots: (scheduledMicronots * wins) / BigInt(elapsedTicks),
      });
    }
    for (const [id, total] of Object.entries(mintedByCohort)) {
      const cohortId = Number(id);
      const amounts = rewards.get(cohortId) ?? { microgons: 0n, micronots: 0n };
      amounts.microgons += total - (beforeMinted[id] ?? 0n);
      rewards.set(cohortId, amounts);
    }

    // Scoring resets after the activation block is credited to the previous seats.
    // Read only that block's payout, correlating before rotation even when a miner renews.
    for (const payout of activationPayouts) {
      if (payout.rewardType.type !== 'Miner') continue;
      const matchingCohorts = beforeCohorts.filter(([, members]) =>
        members.some(member => member.authorityKeys.blockSealAuthority === payout.blockSealAuthority),
      );
      let cohortId =
        payout.blockSealAuthority && matchingCohorts.length === 1 ? matchingCohorts[0][0].args[0] : undefined;
      if (cohortId === undefined) {
        const archive = await this.clients.archiveClientPromise;
        const hash = await archive.rpc.chain.getBlockHash(firstBlockNumber);
        const author = BlockWatch.readHeader(await archive.rpc.chain.getHeader(hash)).author;
        cohortId = beforeCohorts.find(([, members]) => members.some(member => member.accountId === author))?.[0]
          .args[0];
      }
      if (cohortId === undefined) continue;
      const amounts = rewards.get(cohortId) ?? { microgons: 0n, micronots: 0n };
      amounts.microgons += payout.argons;
      amounts.micronots += payout.ownership;
      rewards.set(cohortId, amounts);
    }

    // Recompute absolute frame counters on refresh; an older concurrent read cannot
    // replace the cached result for a newer finalized head.
    const latest = this.frameRewardHistory.get(frameId);
    if (!latest || latest.lastBlockNumber < lastBlockNumber) {
      this.frameRewardHistory.set(frameId, { lastBlockNumber, rewardsByCohort: rewards });
    }
    return rewards;
  }

  private async getHistoricalSnapshot(blockNumber: number): Promise<ArgonApi> {
    let snapshot = this.historicalSnapshots.get(blockNumber);
    if (!snapshot) {
      snapshot = (async () => {
        const archive = await this.clients.archiveClientPromise;
        const blockHash = (await archive.rpc.chain.getBlockHash(blockNumber)).toHex();
        return await archive.at(blockHash);
      })();
      this.historicalSnapshots.set(blockNumber, snapshot);
      while (this.historicalSnapshots.size > NetworkConfig.framesPerCohort * 3) {
        const oldest = this.historicalSnapshots.keys().next().value;
        if (oldest !== undefined) this.historicalSnapshots.delete(oldest);
      }
      void snapshot.catch(() => {
        if (this.historicalSnapshots.get(blockNumber) === snapshot) this.historicalSnapshots.delete(blockNumber);
      });
    }
    return await snapshot;
  }

  private async getHistoricalArgonotPrice(blockNumber: number): Promise<bigint> {
    let price = this.historicalArgonotPrices.get(blockNumber);
    if (!price) {
      price = this.getHistoricalSnapshot(blockNumber).then(snapshot => this.readArgonotPrice(snapshot));
      this.historicalArgonotPrices.set(blockNumber, price);
      void price.catch(() => {
        if (this.historicalArgonotPrices.get(blockNumber) === price) this.historicalArgonotPrices.delete(blockNumber);
      });
    }
    return await price;
  }

  private async readArgonotPrice(api: ArgonQueryClient): Promise<bigint> {
    const price = await Currency.fetchPriceIndex(api);
    if (!price.argonotUsdPrice || !price.argonUsdTargetPrice || price.argonUsdTargetPrice.lte(0)) {
      throw new Error('ARGNOT price is unavailable for mining returns');
    }
    return bigNumberToBigInt(price.argonotUsdPrice.dividedBy(price.argonUsdTargetPrice).times(1_000_000));
  }
}

export function normalizeMiningSeatSlots(slots: IMiningSlot[], auctionSlotId: number): IMiningSlot[] {
  let changed = false;
  const normalized = slots.map(slot => {
    let seatCount = Math.max(MINIMUM_MINING_SEATS_PER_SLOT, slot.seats.length);
    if (slot.slotId !== auctionSlotId) {
      seatCount = MINIMUM_MINING_SEATS_PER_SLOT;
      for (let index = slot.seats.length - 1; index >= 0; index -= 1) {
        if (slot.seats[index].miner || slot.seats[index].bid) {
          seatCount = Math.max(MINIMUM_MINING_SEATS_PER_SLOT, index + 1);
          break;
        }
      }
    }

    if (seatCount === slot.seats.length) return slot;

    changed = true;

    return {
      ...slot,
      seats: Array.from(
        { length: seatCount },
        (_, index) =>
          slot.seats[index] ?? {
            id: `${numericToAlpha(slot.slotId)}${index + 1}`,
            index,
            slotId: slot.slotId,
            miner: null,
            bid: null,
          },
      ),
    };
  });

  return changed ? normalized : slots;
}
