import BigNumber from 'bignumber.js';
import { Mining } from './Mining.js';
import { MiningFrames } from './MiningFrames.js';
import { PriceIndex } from './PriceIndex.js';
import { bigIntMax, bigIntMin, bigNumberToBigInt } from './utils.js';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { type IBiddingRules, SeatGoalInterval, SeatGoalType } from './interfaces/index.js';

export default class BiddingCalculatorData {
  public microgonsToMineThisSeat: bigint = 0n;
  public micronotsToMineThisSeat: bigint = 0n;
  public micronotsRequiredForBid: bigint = 0n;

  public microgonsInCirculation: bigint = 0n;

  public previousDayHighBid: bigint = 0n;
  public previousDayMidBid: bigint = 0n;
  public previousDayLowBid: bigint = 0n;

  public estimatedTransactionFee: bigint = BigInt(0.1 * MICROGONS_PER_ARGON);

  public microgonExchangeRateTo: { USD: bigint; ARGNOT: bigint } = { USD: BigInt(0), ARGNOT: BigInt(0) };

  public maxPossibleMiningSeatCount: number = 0;
  public nextCohortSize: number = 0;
  public allowedBidIncrementMicrogons = 10_000n;

  private loadedFrameIdPromise?: Promise<number>;

  constructor(private mining: Mining) {}

  getEpochSeatGoalCount(rules: IBiddingRules): number {
    if (rules.seatGoalType === SeatGoalType.MaxPercent || rules.seatGoalType === SeatGoalType.MinPercent) {
      return Math.floor((rules.seatGoalPercent / 100) * this.maxPossibleMiningSeatCount);
    }
    let seats = rules.seatGoalCount;
    if (rules.seatGoalInterval === SeatGoalInterval.Frame) {
      seats *= 10; // 10 frames per epoch
    }
    return seats;
  }

  public async load(): Promise<void> {
    const mining = this.mining;
    const priceIndex = new PriceIndex(mining.clients);
    const frameId = await this.mining.getCurrentFrameId();
    const loadedFrameId = await this.loadedFrameIdPromise;
    if (frameId === loadedFrameId) {
      return;
    }
    this.loadedFrameIdPromise = new Promise<number>(async (resolve, reject) => {
      try {
        console.info('Loading latest BiddingCalculatorData at frame', frameId);
        const tickAtStartOfNextCohort = await mining.getTickAtStartOfNextCohort();
        const tickAtEndOfNextCohort = tickAtStartOfNextCohort + MiningFrames.ticksPerCohort;

        const activeMinersCount = await mining.getActiveMinersCount();
        const nextCohortSize = await mining.getNextCohortSize();
        this.nextCohortSize = nextCohortSize;
        const retiringCohortSize = await mining.getRetiringCohortSize();
        const maxPossibleMinersInNextEpoch = activeMinersCount + nextCohortSize - retiringCohortSize;

        const previousDayWinningBids = await mining.fetchPreviousDayWinningBidAmounts();
        this.previousDayHighBid = previousDayWinningBids.length > 0 ? bigIntMax(...previousDayWinningBids) : 0n;
        this.previousDayLowBid = previousDayWinningBids.length > 0 ? bigIntMin(...previousDayWinningBids) : 0n;
        this.previousDayMidBid = bigNumberToBigInt(
          BigNumber(this.previousDayHighBid).plus(this.previousDayLowBid).dividedBy(2),
        );

        const microgonsMinedPerBlock = await mining.fetchMicrogonsMinedPerBlockDuringNextCohort();
        this.microgonsToMineThisSeat =
          (microgonsMinedPerBlock * BigInt(MiningFrames.ticksPerCohort)) / BigInt(maxPossibleMinersInNextEpoch);
        this.microgonsInCirculation = await priceIndex.fetchMicrogonsInCirculation();
        this.micronotsRequiredForBid = await mining.getMicronotsRequiredForBid();

        const micronotsMinedDuringNextCohort = await mining.getMinimumMicronotsMinedDuringTickRange(
          tickAtStartOfNextCohort,
          tickAtEndOfNextCohort,
        );
        this.micronotsToMineThisSeat = micronotsMinedDuringNextCohort / BigInt(maxPossibleMinersInNextEpoch);

        this.microgonExchangeRateTo = await priceIndex.fetchMicrogonExchangeRatesTo();
        this.maxPossibleMiningSeatCount = maxPossibleMinersInNextEpoch;
        const client = await mining.clients.prunedClientOrArchivePromise;
        this.allowedBidIncrementMicrogons = client.consts.miningSlot.bidIncrements.toBigInt();
        resolve(frameId);
      } catch (error) {
        console.error('Error initializing BiddingCalculatorData', error);
        reject(error);
      }
    });

    await this.loadedFrameIdPromise;
  }
}
