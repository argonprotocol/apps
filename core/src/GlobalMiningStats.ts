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
    this.aggregatedBidCosts = await this.mining.fetchAggregateBidCosts();

    const blockRewards = await this.mining.getAggregateBlockRewards();
    const valueOfMicronots = this.currency.convertMicronotTo(blockRewards.micronots, UnitOfMeasurement.Microgon);
    this.aggregatedBlockRewards = blockRewards.microgons + valueOfMicronots;
    this.averageAPY = calculateAPY(this.aggregatedBidCosts, this.aggregatedBlockRewards);
  }
}
