import { type IBidderParams, type IBiddingRules, SeatGoalType } from './interfaces/index.js';
import BiddingCalculator from './BiddingCalculator.js';
import BiddingCalculatorData from './BiddingCalculatorData.js';
import type { MainchainClients } from './MainchainClients.js';
import { Mining } from './Mining.js';

export default async function createBidderParams(
  _cohortId: number,
  mainchainClients: MainchainClients,
  biddingRules: IBiddingRules,
): Promise<IBidderParams> {
  const mining = new Mining(mainchainClients);

  const calculatorData = new BiddingCalculatorData(mining);
  const calculator = new BiddingCalculator(calculatorData, biddingRules);
  await calculator.load();

  const helper = new Helper(biddingRules, calculator);

  const minBid = calculator.startingBidAmount;
  const maxBid = calculator.maximumBidAmount;

  const maxSeats = await helper.getMaxSeats();

  const bidDelay = biddingRules.rebiddingDelay || 0;
  const bidIncrement = biddingRules.rebiddingIncrementBy || 1n;
  const bidderParams: IBidderParams = {
    minBid,
    maxBid,
    maxSeats,
    bidDelay,
    bidIncrement,
    sidelinedWalletMicrogons: biddingRules.sidelinedMicrogons,
    sidelinedWalletMicronots: biddingRules.sidelinedMicronots,
  };
  console.log('Bidder params', bidderParams);
  return bidderParams;
}

export class Helper {
  private readonly biddingRules: IBiddingRules;
  private readonly calculator: BiddingCalculator;

  constructor(biddingRules: IBiddingRules, calculator: BiddingCalculator) {
    this.biddingRules = biddingRules;
    this.calculator = calculator;
  }

  public async getMaxSeats() {
    await this.calculator.load();

    const maxSeats = this.calculator.data.nextCohortSize;

    if (this.biddingRules.seatGoalType === SeatGoalType.Max) {
      return this.biddingRules.seatGoalCount || 0;
    }
    if (this.biddingRules.seatGoalType === SeatGoalType.MaxPercent) {
      return Math.floor((maxSeats * (this.biddingRules.seatGoalPercent || 0)) / 100);
    }

    return maxSeats;
  }

  public getMaxBalance(defaultMaxBalance: bigint): bigint {
    return defaultMaxBalance;
  }
}
