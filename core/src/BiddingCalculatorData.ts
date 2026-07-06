import BigNumber from 'bignumber.js';
import { Mining } from './Mining.js';
import { Currency } from './Currency.js';
import { bigIntMax, bigIntMin, bigNumberToBigInt, percentOf } from './utils.js';
import { type ArgonClient, MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { type IBiddingRules, SeatGoalInterval, SeatGoalType } from './interfaces/index.js';
import { NetworkConfig } from './NetworkConfig.js';
import type { MiningFrames } from './MiningFrames.ts';

const MINING_BID_COLLATERAL_MULTIPLE_SPEC_VERSION = 154;

export default class BiddingCalculatorData {
  public microgonsToMineThisSeat: bigint = 0n;
  public micronotsToMineThisSeat: bigint = 0n;

  public currentMicronotsForBid: bigint = 0n;
  public maximumMicronotsForBid: bigint = 0n;

  public microgonsInCirculation: bigint = 0n;

  public previousDayHighBid: bigint = 0n;
  public previousDayMidBid: bigint = 0n;
  public previousDayLowBid: bigint = 0n;

  public estimatedTransactionFee: bigint = BigInt(0.1 * MICROGONS_PER_ARGON);

  public microgonExchangeRateTo: { USD: bigint; ARGNOT: bigint } = { USD: BigInt(0), ARGNOT: BigInt(0) };

  public maxPossibleMiningSeatCount: number = 0;
  public nextCohortSize: number = 0;
  public allowedBidIncrementMicrogons = 10_000n;

  public get client(): Promise<ArgonClient> {
    return this.mining.clients.prunedClientOrArchivePromise;
  }

  public loadingFrameId: number | undefined;

  public loadedFrameIdPromise?: Promise<number>;

  constructor(
    public mining: Mining,
    public miningFrames: MiningFrames,
  ) {}

  public getMaxFrameSeats(rules: IBiddingRules): number {
    const maxSeats = this.nextCohortSize;

    if (rules.seatGoalType === SeatGoalType.Max) {
      return rules.seatGoalCount || 0;
    }

    if (rules.seatGoalType === SeatGoalType.MaxPercent) {
      return Math.floor((maxSeats * (rules.seatGoalPercent || 0)) / 100);
    }

    return maxSeats;
  }

  public getEpochSeatGoalCount(rules: IBiddingRules): number {
    if (rules.seatGoalType === SeatGoalType.MaxPercent || rules.seatGoalType === SeatGoalType.MinPercent) {
      return Math.floor((rules.seatGoalPercent / 100) * this.maxPossibleMiningSeatCount);
    }
    let seats = rules.seatGoalCount;
    if (rules.seatGoalInterval === SeatGoalInterval.Frame) {
      seats *= 10; // 10 frames per epoch
    }
    return seats;
  }

  public async load(biddingFrameId: number): Promise<void> {
    if (this.loadingFrameId !== biddingFrameId) {
      this.loadingFrameId = biddingFrameId;
      // wait for any previous load to finish
      void (await this.loadedFrameIdPromise);
      this.loadedFrameIdPromise = new Promise<number>(async (resolve, reject) => {
        try {
          const mining = this.mining;
          await this.miningFrames.waitForFrameId(biddingFrameId);

          let api = await this.miningFrames.blockWatch.getCurrentApi();

          const nextFrameId = await this.mining.fetchNextFrameId(api);
          if (biddingFrameId !== nextFrameId - 1) {
            // need to go back to the start of the bidding frame
            const frame = this.miningFrames.framesById[biddingFrameId];
            const frameStartBlockHash = frame.firstBlockHash;
            const frameStartBlockNumber = frame.firstBlockNumber;
            if (!frameStartBlockHash || frameStartBlockNumber == null) {
              throw new Error(`No starting block for frame ${biddingFrameId}`);
            }
            api = await this.miningFrames.clientAt({
              blockHash: frameStartBlockHash,
              blockNumber: frameStartBlockNumber,
            });
          }

          const currency = new Currency(mining.clients);
          const tickAtStartOfNextCohort = await mining.fetchTickAtStartOfNextCohort(api);
          const tickAtEndOfNextCohort = tickAtStartOfNextCohort + NetworkConfig.ticksPerCohort;

          this.nextCohortSize = await mining.fetchNextCohortSize(api);
          const maxPossibleMinersInNextEpoch = await mining.getNextEpochMaxMiners(api);

          const previousDayWinningBids = await mining.fetchPreviousDayWinningBidAmounts(api);
          this.previousDayHighBid = previousDayWinningBids.length > 0 ? bigIntMax(...previousDayWinningBids) : 0n;
          this.previousDayLowBid = previousDayWinningBids.length > 0 ? bigIntMin(...previousDayWinningBids) : 0n;
          this.previousDayMidBid = bigNumberToBigInt(
            BigNumber(this.previousDayHighBid).plus(this.previousDayLowBid).dividedBy(2),
          );

          const microgonsMinedPerBlock = await mining.fetchMicrogonsMinedPerBlockDuringNextCohort(api);
          this.microgonsToMineThisSeat =
            (microgonsMinedPerBlock * BigInt(NetworkConfig.ticksPerCohort)) / BigInt(maxPossibleMinersInNextEpoch);
          this.microgonsInCirculation = await currency.fetchMicrogonsInCirculation(api);

          const biddingFrameSpecVersion =
            this.miningFrames.framesById[biddingFrameId]?.firstBlockSpecVersion ??
            api.runtimeVersion.specVersion.toNumber();
          this.currentMicronotsForBid = await mining.fetchCurrentMicronotsForBid(api);
          if (biddingFrameSpecVersion >= MINING_BID_COLLATERAL_MULTIPLE_SPEC_VERSION) {
            this.maximumMicronotsForBid = percentOf(this.currentMicronotsForBid, 120, true);
          } else {
            this.maximumMicronotsForBid = await mining.fetchMaximumMicronotsForEndOfEpochBid(api);
          }

          const micronotsMinedDuringNextCohort = await mining.minimumMicronotsMinedDuringTickRange(
            tickAtStartOfNextCohort,
            tickAtEndOfNextCohort,
            api,
          );
          this.micronotsToMineThisSeat = micronotsMinedDuringNextCohort / BigInt(maxPossibleMinersInNextEpoch);

          this.microgonExchangeRateTo = await currency.fetchMainchainRates(api);
          this.maxPossibleMiningSeatCount = maxPossibleMinersInNextEpoch;
          this.allowedBidIncrementMicrogons = api.consts.miningSlot.bidIncrements.toBigInt();
          resolve(biddingFrameId);
        } catch (error) {
          console.error('Error initializing BiddingCalculatorData', error);
          reject(error);
        }
      });
    }

    await this.loadedFrameIdPromise;
  }
}
