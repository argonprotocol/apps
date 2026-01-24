import { calculateAPY } from './utils.js';
import { Currency, UnitOfMeasurement } from './Currency.js';
import type { Mining } from './Mining.js';

export class GlobalMiningStats {
  private mining: Mining;
  private currency: Currency;

  public activeSeatCount = 0;
  public aggregatedBidCosts = 0n;
  public aggregatedBlockRewards = 0n;
  public averageAPY: number = 0;

  public activeBidCosts = 0n;
  public activeBlockRewards = 0n;
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

    const aggregateBlockRewards = await this.mining.fetchAggregateBlockRewards();
    this.aggregatedBidCosts = await this.mining.fetchAggregateBidCosts();
    this.aggregatedBlockRewards = this.calculateBlockRewards(aggregateBlockRewards);
    this.averageAPY = calculateAPY(this.aggregatedBidCosts, this.aggregatedBlockRewards);

    const lastFrameBlockRewards = await this.mining.fetchLastFrameBlockRewards();
    this.activeBidCosts = await this.mining.fetchLastFramesBidCosts() * 10n;
    this.activeBlockRewards = this.calculateBlockRewards(lastFrameBlockRewards) * 10n;
    this.activeAPY = calculateAPY(this.activeBidCosts, this.activeBlockRewards);
  }

  private calculateBlockRewards(blockRewards: { micronots: bigint, microgons: bigint}): bigint {
    const valueOfMicronots = this.currency.convertMicronotTo(blockRewards.micronots, UnitOfMeasurement.Microgon);
    return blockRewards.microgons + valueOfMicronots;
  }
}
