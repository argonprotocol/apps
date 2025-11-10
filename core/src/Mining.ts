import type { MainchainClients } from './MainchainClients.js';
import { type ApiDecoration, type ArgonClient, FIXED_U128_DECIMALS, fromFixedNumber } from '@argonprotocol/mainchain';
import { bigIntMax, bigIntMin, bigNumberToBigInt } from './utils.js';
import { MiningFrames } from './MiningFrames.js';
import type { IWinningBid } from './interfaces/index.js';

export const BLOCK_REWARD_INCREASE_PER_INTERVAL = BigInt(1_000);
export const BLOCK_REWARD_MAX = BigInt(5_000_000);
export const BLOCK_REWARD_INTERVAL = 118;

const MAXIMUM_ARGONOT_PRORATA_PERCENT = 0.80;
const ARGONOTS_PERCENT_ADJUSTMENT_DAMPER = 1.20;

export class Mining {
  public get prunedClientOrArchivePromise(): Promise<ArgonClient> {
    return this.clients.prunedClientPromise ?? this.clients.archiveClientPromise;
  }

  constructor(public readonly clients: MainchainClients) {}

  public async getRecentSeatSummaries(): Promise<
    { biddingFrameId: number; seats: number; lowestWinningBid: bigint; highestWinningBid: bigint }[]
  > {
    const client = await this.prunedClientOrArchivePromise;
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

  public async getAggregateBlockRewards(): Promise<{
    microgons: bigint;
    micronots: bigint;
  }> {
    const client = await this.prunedClientOrArchivePromise;
    const blockRewards = await client.query.blockRewards.blockRewardsByCohort();
    const nextCohortId = blockRewards.pop()?.[0].toNumber() ?? 1;
    const currentCohortId = nextCohortId - 1;

    const currentTick = await this.getCurrentTick();
    const tickAtStartOfCurrentSlot = await this.getTickAtStartOfCurrentSlot();
    const ticksElapsedToday = currentTick - tickAtStartOfCurrentSlot;

    const rewards = { microgons: 0n, micronots: 0n };

    for (const [cohortId, blockReward] of blockRewards) {
      const fullRotationsSinceCohortStart = currentCohortId - cohortId.toNumber();
      const ticksSinceCohortStart =
        fullRotationsSinceCohortStart * MiningFrames.getConfig().ticksBetweenFrames + ticksElapsedToday;
      const startingTick = currentTick - ticksSinceCohortStart;
      const endingTick = startingTick + MiningFrames.ticksPerCohort;
      const microgonsMinedInCohort = (blockReward.toBigInt() * BigInt(MiningFrames.ticksPerCohort)) / 10n;
      const micronotsMinedInCohort =
        (await this.getMinimumMicronotsMinedDuringTickRange(startingTick, endingTick)) / 10n;
      rewards.microgons += microgonsMinedInCohort;
      rewards.micronots += micronotsMinedInCohort;
    }

    return rewards;
  }

  public async getNextSlotRange(): Promise<[number, number]> {
    const client = await this.prunedClientOrArchivePromise;
    const nextSlotRangeBytes = await client.rpc.state.call('MiningSlotApi_next_slot_era', '');
    const nextSlotRangeRaw = client.createType('(u64, u64)', nextSlotRangeBytes);
    return [nextSlotRangeRaw[0].toNumber(), nextSlotRangeRaw[1].toNumber()];
  }

  public async fetchPreviousDayWinningBidAmounts(): Promise<bigint[]> {
    const startingFrameId = MiningFrames.calculateCurrentFrameIdFromSystemTime();
    let frameIdToCheck = startingFrameId;
    while (true) {
      // We must loop backwards until we find a frame with winning bids
      if (frameIdToCheck < startingFrameId - 10 || frameIdToCheck <= 0) {
        // We've checked the last 10 frames and found no winning bids, so we're done
        return [];
      }
      const winningBids = await this.fetchWinningBidAmountsForFrame(frameIdToCheck);
      if (winningBids.length > 0) {
        return winningBids;
      }
      frameIdToCheck--;
    }
  }

  public async getTickAtStartOfNextCohort(): Promise<number> {
    return (await this.getNextSlotRange())[0];
  }

  public async getTickAtStartOfAuctionClosing(): Promise<number> {
    const client = await this.prunedClientOrArchivePromise;
    const tickAtStartOfNextCohort = await this.getTickAtStartOfNextCohort();
    const ticksBeforeBidEndForVrfClose = (
      await client.query.miningSlot.miningConfig()
    ).ticksBeforeBidEndForVrfClose.toNumber();
    return tickAtStartOfNextCohort - ticksBeforeBidEndForVrfClose;
  }

  public async getTickAtStartOfCurrentSlot(): Promise<number> {
    const tickAtStartOfNextCohort = await this.getTickAtStartOfNextCohort();
    return tickAtStartOfNextCohort - MiningFrames.ticksPerFrame;
  }

  public async fetchWinningBids(): Promise<(IWinningBid & { micronotsStakedPerSeat: bigint })[]> {
    const client = await this.prunedClientOrArchivePromise;
    const nextCohort = await client.query.miningSlot.bidsForNextSlotCohort();
    return nextCohort.map((c, i): IWinningBid & { micronotsStakedPerSeat: bigint } => {
      const address = c.accountId.toHuman();
      const subAccountIndex = undefined;
      const lastBidAtTick = c.bidAtTick.toNumber();
      const bidPosition = i;
      const microgonsPerSeat = c.bid.toBigInt();
      const micronotsStakedPerSeat = c.argonots.toBigInt();
      return { address, subAccountIndex, lastBidAtTick, bidPosition, microgonsPerSeat, micronotsStakedPerSeat };
    });
  }

  public async fetchWinningBidAmountsForFrame(frameId: number): Promise<bigint[]> {
    if (frameId < 1) return [];
    const client = await this.prunedClientOrArchivePromise;
    const winningBids = await client.query.miningSlot.minersByCohort(frameId);
    return winningBids.map(bid => bid.bid.toBigInt());
  }

  public async fetchMicrogonsMinedPerBlockDuringNextCohort(): Promise<bigint> {
    const client = await this.prunedClientOrArchivePromise;
    return await client.query.blockRewards.argonsPerBlock().then(x => x.toBigInt());
  }

  public async getNextCohortSize(): Promise<number> {
    const client = await this.prunedClientOrArchivePromise;
    return (await client.query.miningSlot.nextCohortSize()).toNumber();
  }

  public async getRetiringCohortSize(): Promise<number> {
    const client = await this.prunedClientOrArchivePromise;
    const nextFrameId = await client.query.miningSlot.nextFrameId();
    const rollingCohortId = nextFrameId.toNumber() - 10;
    if (rollingCohortId < 1) return 0;
    return await client.query.miningSlot.minersByCohort(rollingCohortId).then(x => x.length);
  }

  public async getActiveMinersCount(): Promise<number> {
    const client = await this.prunedClientOrArchivePromise;
    const activeMiners = (await client.query.miningSlot.activeMinersCount()).toNumber();
    return Math.max(activeMiners, 100);
  }

  public async getAggregateBidCosts(): Promise<bigint> {
    const client = await this.prunedClientOrArchivePromise;
    const bidsPerFrame = await client.query.miningSlot.minersByCohort.entries();

    let aggregateBidCosts = 0n;
    for (const [_, cohortData] of bidsPerFrame) {
      aggregateBidCosts += cohortData.reduce((acc, bid) => acc + bid.bid.toBigInt(), 0n);
    }

    return aggregateBidCosts;
  }

  public async getCurrentMicronotsForBid(): Promise<bigint> {
    const client = await this.prunedClientOrArchivePromise;
    return await client.query.miningSlot.argonotsPerMiningSeat().then(x => x.toBigInt());
  }

  public async getMaximumMicronotsForBid(): Promise<bigint> {
    const client = await this.prunedClientOrArchivePromise;
    const ownershipCirculation = await client.query.ownership.totalIssuance().then(x => x.toBigInt());
    const nextCohortSize = await this.getNextCohortSize();
    const currentMaxMiners = nextCohortSize * 10;
    const baseOwnershipTokens = ownershipCirculation / BigInt(currentMaxMiners);
    const maxValue = Math.ceil(MAXIMUM_ARGONOT_PRORATA_PERCENT *  Number(baseOwnershipTokens));

    return BigInt(maxValue);
  }

  public async getMaximumMicronotsForEndOfEpochBid(): Promise<bigint> {
    const currentMicronots = await this.getCurrentMicronotsForBid();

    const adjustmentFactorNumerator = BigInt(ARGONOTS_PERCENT_ADJUSTMENT_DAMPER * 100);
    const adjustmentFactorDenominator = 100n;
    const compoundedNumerator = adjustmentFactorNumerator ** 10n;
    const compoundedDenominator = adjustmentFactorDenominator ** 10n;
    const adjustedMicronots = (currentMicronots * compoundedNumerator) / compoundedDenominator;

    const maximumPossible = await this.getMaximumMicronotsForBid();
    const maximumMicronots = Math.min(Number(adjustedMicronots), Number(maximumPossible));

    return BigInt(maximumMicronots);
  }

  public async getMicrogonsPerBlockForMiner(api: ApiDecoration<'promise'>) {
    const minerPercent = fromFixedNumber(api.consts.blockRewards.minerPayoutPercent.toBigInt(), FIXED_U128_DECIMALS);
    const microgonsPerBlock = await api.query.blockRewards.argonsPerBlock().then(x => x.toBigInt());
    return bigNumberToBigInt(minerPercent.times(microgonsPerBlock));
  }

  public async minimumBlockRewardsAtTick(
    currentTick: number,
  ): Promise<{ rewardsPerBlock: bigint; amountToMinerPercent: BigNumber; ticksSinceGenesis: number }> {
    const client = await this.prunedClientOrArchivePromise;
    const ticksSinceGenesis = await this.getTicksSinceGenesis(currentTick);
    const initialReward = 500_000n; // Initial microgons reward per block
    const amountToMiner = fromFixedNumber(
      client.consts.blockRewards.minerPayoutPercent.toBigInt(),
      FIXED_U128_DECIMALS,
    );

    // Calculate the number of intervals
    const numIntervals = Math.floor(ticksSinceGenesis / BLOCK_REWARD_INTERVAL);

    // Calculate the current reward per block
    const currentReward = initialReward + BigInt(numIntervals) * BLOCK_REWARD_INCREASE_PER_INTERVAL;
    const reward = bigIntMin(currentReward, BLOCK_REWARD_MAX);
    return { rewardsPerBlock: reward, amountToMinerPercent: amountToMiner, ticksSinceGenesis };
  }

  public async getMinimumMicronotsMinedDuringTickRange(tickStart: number, tickEnd: number): Promise<bigint> {
    const client = await this.prunedClientOrArchivePromise;
    const halvingStartTick = client.consts.blockRewards.halvingBeginTick.toNumber();
    const halvingTicks = client.consts.blockRewards.halvingTicks.toNumber();
    // eslint-disable-next-line prefer-const
    let { rewardsPerBlock, amountToMinerPercent } = await this.minimumBlockRewardsAtTick(tickStart);
    let totalRewards = 0n;
    for (let i = tickStart; i < tickEnd; i++) {
      const elapsedTicks = await this.getTicksSinceGenesis(i);
      if (elapsedTicks >= halvingStartTick) {
        const halvings = Math.floor((elapsedTicks - halvingStartTick) / halvingTicks);
        rewardsPerBlock = BigInt(Math.floor(Number(BLOCK_REWARD_MAX) / (halvings + 1)));
      } else if (elapsedTicks % BLOCK_REWARD_INTERVAL === 0) {
        rewardsPerBlock += BLOCK_REWARD_INCREASE_PER_INTERVAL;
        rewardsPerBlock = bigIntMin(rewardsPerBlock, BLOCK_REWARD_MAX);
      }
      totalRewards += rewardsPerBlock;
    }
    return bigNumberToBigInt(amountToMinerPercent.times(totalRewards));
  }

  public async onTick(callback: (tick: number) => Promise<void> | void): Promise<{ unsubscribe: () => void }> {
    const client = await this.prunedClientOrArchivePromise;
    const unsubscribe = await client.query.ticks.currentTick(async tick => {
      try {
        await callback(tick.toNumber());
      } catch (err) {
        console.error(`Error in onTick(${tick.toNumber()}) callback:`, err);
      }
    });
    return { unsubscribe };
  }

  public async onFrameId(callback: (frameId: number) => Promise<void> | void): Promise<{ unsubscribe: () => void }> {
    const client = await this.prunedClientOrArchivePromise;
    const unsubscribe = await client.query.miningSlot.nextFrameId(async frameId => {
      const currentFrameId = frameId.toNumber() - 1;
      try {
        await callback(currentFrameId);
      } catch (err) {
        console.error(`Error in onFrameId(${currentFrameId}) callback:`, err);
      }
    });
    return { unsubscribe };
  }

  public async getCurrentFrameId(): Promise<number> {
    const client = await this.prunedClientOrArchivePromise;
    const nextFrameId = await client.query.miningSlot.nextFrameId();
    return nextFrameId.toNumber() - 1; // Subtract 1 to get the current frame ID
  }

  public async getCurrentTick(): Promise<number> {
    const client = await this.prunedClientOrArchivePromise;
    return (await client.query.ticks.currentTick()).toNumber();
  }

  private async getTicksSinceGenesis(currentTick: number): Promise<number> {
    const { genesisTick } = MiningFrames.getConfig();
    return currentTick - genesisTick;
  }
}
