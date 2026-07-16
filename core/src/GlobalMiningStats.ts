import { calculateAnnualPercentageRate, calculateAnnualPercentageYield } from './FinancialReturns.js';
import { Currency, UnitOfMeasurement } from './Currency.js';
import type { Mining } from './Mining.js';
import { NetworkConfig } from './NetworkConfig.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export class GlobalMiningStats {
  private mining: Mining;
  private currency: Currency;

  public activeSeatCount = 0;
  public aggregatedBidCosts = 0n;
  public aggregatedBlockRewards = 0n;
  public averageAPR: number = 0;
  public averageAPY: number = 0;

  public activeBidCosts = 0n;
  public activeBlockRewards = 0n;
  public activeAPR: number = 0;
  public activeAPY: number = 0;

  constructor(mining: Mining, currency: Currency) {
    this.mining = mining;
    this.currency = currency;
  }

  public async load() {
    await this.currency.load();
    await this.update();
  }

  public async update() {
    this.activeSeatCount = await this.mining.fetchActiveMinersCount();
    const miningTermDays = (NetworkConfig.ticksPerCohort * NetworkConfig.tickMillis) / MILLISECONDS_PER_DAY;
    const framesPerMiningTerm = BigInt(NetworkConfig.framesPerCohort);

    const aggregateBlockRewards = await this.mining.fetchAggregateBlockRewards();
    this.aggregatedBidCosts = await this.mining.fetchAggregateBidCosts();
    this.aggregatedBlockRewards = this.calculateBlockRewards(aggregateBlockRewards);
    this.averageAPR = calculateAnnualPercentageRate({
      startingValue: this.aggregatedBidCosts,
      endingValue: this.aggregatedBlockRewards,
      periodDays: miningTermDays,
    });
    this.averageAPY =
      this.aggregatedBlockRewards === 0n
        ? 0
        : calculateAnnualPercentageYield({
            startingValue: this.aggregatedBidCosts,
            endingValue: this.aggregatedBlockRewards,
            periodDays: miningTermDays,
          });

    const lastFrameBlockRewards = await this.mining.fetchLastFrameBlockRewards();
    this.activeBidCosts = (await this.mining.fetchLastFramesBidCosts()) * framesPerMiningTerm;
    this.activeBlockRewards = this.calculateBlockRewards(lastFrameBlockRewards) * framesPerMiningTerm;
    this.activeAPR = calculateAnnualPercentageRate({
      startingValue: this.activeBidCosts,
      endingValue: this.activeBlockRewards,
      periodDays: miningTermDays,
    });
    this.activeAPY =
      this.activeBlockRewards === 0n
        ? 0
        : calculateAnnualPercentageYield({
            startingValue: this.activeBidCosts,
            endingValue: this.activeBlockRewards,
            periodDays: miningTermDays,
          });
  }

  private calculateBlockRewards(blockRewards: { micronots: bigint; microgons: bigint }): bigint {
    const valueOfMicronots = this.currency.convertMicronotTo(blockRewards.micronots, UnitOfMeasurement.Microgon);
    return blockRewards.microgons + valueOfMicronots;
  }
}
