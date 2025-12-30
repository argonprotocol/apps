import type { MainchainClients } from './MainchainClients.js';
import {
  type ApiDecoration,
  type ArgonClient,
  type Bool,
  FIXED_U128_DECIMALS,
  fromFixedNumber,
  type u64,
} from '@argonprotocol/mainchain';
import { bigIntMax, bigIntMin, bigNumberToBigInt } from './utils.js';
import type { IWinningBid } from './interfaces/index.js';
import type { IMiningIndex } from './Accountset.ts';
import { NetworkConfig } from './NetworkConfig.js';
import BigNumber from 'bignumber.js';

const MAXIMUM_ARGONOT_PRORATA_PERCENT = 0.8;
const ARGONOTS_PERCENT_ADJUSTMENT_DAMPER = 1.2;

export class Mining {
  public get prunedClientOrArchivePromise(): Promise<ArgonClient> {
    return this.clients.prunedClientPromise ?? this.clients.archiveClientPromise;
  }

  constructor(public readonly clients: MainchainClients) {}

  public async getRecentSeatSummaries(
    api?: ApiDecoration<'promise'>,
  ): Promise<{ biddingFrameId: number; seats: number; lowestWinningBid: bigint; highestWinningBid: bigint }[]> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const bidsPerFrame = await client.query.miningSlot.minersByCohort.entries();

    const summaries = [];
    for (const [frameIdRaw, cohortData] of bidsPerFrame) {
      const bids = cohortData.map(x => x.bid.toBigInt());
      const lowestWinningBid = bigIntMin(...bids);
      const highestWinningBid = bigIntMax(...bids);
      summaries.push({
        biddingFrameId: Number(frameIdRaw.toHuman()) - 1,
        seats: cohortData.length,
        lowestWinningBid,
        highestWinningBid,
      });
    }

    return summaries.sort((a, b) => b.biddingFrameId - a.biddingFrameId);
  }

  public async getAggregateBlockRewards(api?: ApiDecoration<'promise'>): Promise<{
    microgons: bigint;
    micronots: bigint;
  }> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const blockRewards = await client.query.blockRewards.blockRewardsByCohort();
    const nextCohortId = blockRewards.pop()?.[0].toNumber() ?? 1;
    const currentCohortId = nextCohortId - 1;

    const currentTick = await this.fetchCurrentTick(api);
    const ticksBetweenFrames = NetworkConfig.rewardTicksPerFrame;
    const ticksElapsedThisFrame = ticksBetweenFrames - (await this.fetchFrameRewardTicksRemaining(api));

    const rewards = { microgons: 0n, micronots: 0n };

    for (const [cohortId, blockReward] of blockRewards) {
      const fullRotationsSinceCohortStart = currentCohortId - cohortId.toNumber();
      const ticksSinceCohortStart = fullRotationsSinceCohortStart * ticksBetweenFrames + ticksElapsedThisFrame;
      const startingTick = currentTick - ticksSinceCohortStart;
      const endingTick = startingTick + NetworkConfig.ticksPerCohort;
      const microgonsMinedInCohort = (blockReward.toBigInt() * BigInt(NetworkConfig.ticksPerCohort)) / 10n;
      const micronotsMinedInCohort =
        (await this.minimumMicronotsMinedDuringTickRange(startingTick, endingTick, api)) / 10n;
      rewards.microgons += microgonsMinedInCohort;
      rewards.micronots += micronotsMinedInCohort;
    }

    return rewards;
  }

  public async fetchPreviousDayWinningBidAmounts(api?: ApiDecoration<'promise'>): Promise<bigint[]> {
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

  public async fetchFrameRewardTicksRemaining(api?: ApiDecoration<'promise'>): Promise<number> {
    const client = api ?? (await this.clients.prunedClientOrArchivePromise);
    return client.query.miningSlot.frameRewardTicksRemaining().then(x => x.toNumber());
  }

  public async fetchTickAtStartOfNextCohort(api?: ApiDecoration<'promise'>): Promise<number> {
    const currentTick = await this.fetchCurrentTick(api);
    const remainingFrameTicks = await this.fetchFrameRewardTicksRemaining(api);
    return currentTick + remainingFrameTicks;
  }

  public async fetchTickAtStartOfAuctionClosing(api?: ApiDecoration<'promise'>): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const tickAtStartOfNextCohort = await this.fetchTickAtStartOfNextCohort(api);
    const ticksBeforeBidEndForVrfClose = (
      await client.query.miningSlot.miningConfig()
    ).ticksBeforeBidEndForVrfClose.toNumber();
    return tickAtStartOfNextCohort - ticksBeforeBidEndForVrfClose;
  }

  public static async fetchWinningBids(
    api: ApiDecoration<'promise'>,
  ): Promise<(IWinningBid & { managedByAddress?: string; micronotsStakedPerSeat: bigint })[]> {
    const nextCohort = await api.query.miningSlot.bidsForNextSlotCohort();
    return nextCohort.map((c, i) => {
      const address = c.accountId.toHuman();
      const subAccountIndex = undefined;
      const lastBidAtTick = c.bidAtTick.toNumber();
      const bidPosition = i;
      const microgonsPerSeat = c.bid.toBigInt();
      const micronotsStakedPerSeat = c.argonots.toBigInt();
      const managedByAddress = c.externalFundingAccount.isSome ? c.externalFundingAccount.value.toHuman() : undefined;
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

  public static async fetchMiningSeats(
    managedByAccount: string,
    api: ApiDecoration<'promise'>,
  ): Promise<{ [address: string]: { seat: IMiningIndex; isLastDay: boolean } }> {
    const addressToMiningIndex: { [address: string]: { seat: IMiningIndex; isLastDay: boolean } } = {};
    const cohorts = await api.query.miningSlot.minersByCohort.entries();
    const nextFrameId = (await api.query.miningSlot.nextFrameId()).toNumber();

    for (const [key, cohort] of cohorts) {
      const frameId = key.args[0].toNumber();
      for (const [index, member] of cohort.entries()) {
        if (member.externalFundingAccount.isNone) {
          continue;
        }
        if (member.externalFundingAccount.value.toHuman() === managedByAccount) {
          const address = member.accountId.toHuman();
          addressToMiningIndex[address] = {
            seat: {
              startingFrameId: frameId,
              index,
              bidAmount: member.bid.toBigInt(),
            },
            isLastDay: nextFrameId - frameId === 10,
          };
        }
      }
    }
    return addressToMiningIndex;
  }

  public async fetchWinningBidAmountsForFrame(frameId: number, api?: ApiDecoration<'promise'>): Promise<bigint[]> {
    if (frameId < 1) return [];
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const winningBids = await client.query.miningSlot.minersByCohort(frameId);
    return winningBids.map(bid => bid.bid.toBigInt());
  }

  public async onCohortChange(options: {
    onBiddingStart?: (cohortStartingFrameId: number) => Promise<void>;
    onBiddingEnd?: (cohortStartingFrameId: number) => Promise<void>;
  }): Promise<{ unsubscribe: () => void }> {
    const { onBiddingStart, onBiddingEnd } = options;
    const client = await this.clients.prunedClientOrArchivePromise;
    let openCohortStartingFrameId = 0;
    const unsubscribe = await client.queryMulti<[Bool, u64]>(
      [client.query.miningSlot.isNextSlotBiddingOpen as any, client.query.miningSlot.nextFrameId as any],
      ([isBiddingOpen, rawNextCohortStartingFrameId]) => {
        const nextFrameId = rawNextCohortStartingFrameId.toNumber();

        if (isBiddingOpen.isTrue) {
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

  public async fetchNextFrameId(api?: ApiDecoration<'promise'>): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const nextFrameId = await client.query.miningSlot.nextFrameId();
    return nextFrameId.toNumber();
  }

  public async fetchCurrentTick(api?: ApiDecoration<'promise'>): Promise<number> {
    const client = api ?? (await this.clients.prunedClientOrArchivePromise);
    return (await client.query.ticks.currentTick()).toNumber();
  }

  public async getNextEpochMaxMiners(api?: ApiDecoration<'promise'>): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const nextFrameId = await this.fetchNextFrameId(api);
    const nextCohortSize = await this.fetchNextCohortSize(api);
    const scheduledChanges = await client.query.miningSlot.scheduledCohortSizeChangeByFrame();
    const scheduledChangesByFrame: { [frameId: number]: number } = {};
    for (const [rawFrameId, newCohortSize] of scheduledChanges) {
      const frameId = rawFrameId.toNumber();
      scheduledChangesByFrame[frameId] = newCohortSize.toNumber();
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

  public async fetchNextCohortSize(api?: ApiDecoration<'promise'>): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    return (await client.query.miningSlot.nextCohortSize()).toNumber();
  }

  public async fetchActiveMinersCount(api?: ApiDecoration<'promise'>): Promise<number> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const activeMiners = (await client.query.miningSlot.activeMinersCount()).toNumber();
    return Math.max(activeMiners, 100);
  }

  public async fetchAggregateBidCosts(api?: ApiDecoration<'promise'>): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const bidsPerFrame = await client.query.miningSlot.minersByCohort.entries();

    let aggregateBidCosts = 0n;
    for (const [_, cohortData] of bidsPerFrame) {
      aggregateBidCosts += cohortData.reduce((acc, bid) => acc + bid.bid.toBigInt(), 0n);
    }

    return aggregateBidCosts;
  }

  public async fetchCurrentMicronotsForBid(api?: ApiDecoration<'promise'>): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    return await client.query.miningSlot.argonotsPerMiningSeat().then(x => x.toBigInt());
  }

  public async fetchMaximumMicronotsForBid(api?: ApiDecoration<'promise'>): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const ownershipCirculation = await client.query.ownership.totalIssuance().then(x => x.toBigInt());
    const currentMaxMiners = await this.getNextEpochMaxMiners(api);
    const baseOwnershipTokens = ownershipCirculation / BigInt(currentMaxMiners);
    const maxValue = Math.ceil(MAXIMUM_ARGONOT_PRORATA_PERCENT * Number(baseOwnershipTokens));

    return BigInt(maxValue);
  }

  public async fetchMaximumMicronotsForEndOfEpochBid(api?: ApiDecoration<'promise'>): Promise<bigint> {
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

  public async fetchMicrogonsMinedPerBlockDuringNextCohort(api?: ApiDecoration<'promise'>): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    return this.fetchMicrogonsPerBlockForMiner(client);
  }

  public async fetchMicrogonsPerBlockForMiner(api: ApiDecoration<'promise'>, frameId?: number): Promise<bigint> {
    frameId ??= await this.fetchNextFrameId(api);
    if (frameId <= 1) {
      return api.consts.blockRewards.startingArgonsPerBlock.toBigInt();
    }
    const minerPercent = fromFixedNumber(api.consts.blockRewards.minerPayoutPercent.toBigInt(), FIXED_U128_DECIMALS);
    const microgonsPerBlockByCohort = await api.query.blockRewards.blockRewardsByCohort();
    for (const [cohortFrameActivationId, blockReward] of microgonsPerBlockByCohort) {
      if (cohortFrameActivationId.toNumber() === frameId) {
        return bigNumberToBigInt(minerPercent.times(blockReward.toBigInt()));
      }
    }
    throw new Error(`No block reward found for cohort starting at frame ID ${frameId}`);
  }

  public async minimumBlockRewardsAtTick(
    currentTick: number,
    api?: ApiDecoration<'promise'>,
  ): Promise<{ rewardsPerBlock: bigint; amountToMinerPercent: BigNumber; ticksSinceGenesis: number }> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const halvingStartTick = client.consts.blockRewards.halvingBeginTicks.toNumber();
    const ticksSinceGenesis = this.getTicksSinceGenesis(currentTick);
    const [incrementAmount, incrementTicks, maxMicrogonsPerBlock] = client.consts.blockRewards.incrementalGrowth;
    const blockRewardMax = maxMicrogonsPerBlock.toBigInt();
    const incrementIntervalTicks = incrementTicks.toNumber();
    const increasePerIntervalMicrogons = incrementAmount.toBigInt();

    const initialReward = 500_000n; // Initial microgons reward per block
    const amountToMiner = fromFixedNumber(
      client.consts.blockRewards.minerPayoutPercent.toBigInt(),
      FIXED_U128_DECIMALS,
    );

    // Calculate the number of intervals
    let reward = blockRewardMax;
    if (ticksSinceGenesis < halvingStartTick) {
      const numIntervals = Math.floor(ticksSinceGenesis / incrementIntervalTicks);

      // Calculate the current reward per block
      const currentReward = initialReward + BigInt(numIntervals) * increasePerIntervalMicrogons;
      reward = bigIntMin(currentReward, blockRewardMax);
    }
    return { rewardsPerBlock: reward, amountToMinerPercent: amountToMiner, ticksSinceGenesis };
  }

  public async minimumMicronotsMinedDuringTickRange(
    tickStart: number,
    tickEnd: number,
    api?: ApiDecoration<'promise'>,
  ): Promise<bigint> {
    const client = api ?? (await this.prunedClientOrArchivePromise);
    const halvingStartTick = client.consts.blockRewards.halvingBeginTicks.toNumber();
    const halvingTicks = client.consts.blockRewards.halvingTicks.toNumber();
    // eslint-disable-next-line prefer-const
    let { rewardsPerBlock, amountToMinerPercent } = await this.minimumBlockRewardsAtTick(tickStart, api);
    const [incrementAmount, incrementTicks, maxMicrogonsPerBlock] = client.consts.blockRewards.incrementalGrowth;
    const blockRewardMax = maxMicrogonsPerBlock.toBigInt();
    const incrementIntervalTicks = incrementTicks.toNumber();
    const increasePerIntervalMicrogons = incrementAmount.toBigInt();

    let totalRewards = 0n;
    for (let i = tickStart; i < tickEnd; i++) {
      // Update rewardsPerBlock at each frame
      if (i % NetworkConfig.rewardTicksPerFrame === 0) {
        const elapsedTicks = this.getTicksSinceGenesis(i);
        if (elapsedTicks >= halvingStartTick) {
          const halvings = Math.floor((elapsedTicks - halvingStartTick) / halvingTicks);
          rewardsPerBlock = BigInt(Math.floor(Number(blockRewardMax) / (halvings + 1)));
        } else if (elapsedTicks % incrementIntervalTicks === 0) {
          rewardsPerBlock += increasePerIntervalMicrogons;
          rewardsPerBlock = bigIntMin(rewardsPerBlock, blockRewardMax);
        }
      }
      totalRewards += rewardsPerBlock;
    }
    return bigNumberToBigInt(amountToMinerPercent.times(totalRewards));
  }

  private getTicksSinceGenesis(currentTick: number): number {
    const { genesisTick } = NetworkConfig.get();
    return currentTick - genesisTick;
  }
}
