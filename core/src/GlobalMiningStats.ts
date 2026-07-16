import {
  calculateAggregateReturn,
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
} from './FinancialReturns.js';
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
    const miningTermDays = (NetworkConfig.ticksPerCohort * NetworkConfig.tickMillis) / MILLISECONDS_PER_DAY;
    const client = await this.mining.prunedClientOrArchivePromise;
    const api = await client.at(await client.rpc.chain.getFinalizedHead());
    const [activeSeatCount, aggregateBlockRewards, aggregateBidCosts, aggregateMicronotsStaked] = await Promise.all([
      this.mining.fetchActiveMinersCount(api),
      this.mining.fetchAggregateBlockRewards(api),
      this.mining.fetchAggregateBidCosts(api),
      this.mining.fetchAggregateMicronotsStaked(api),
    ]);
    const markedStake = this.currency.convertMicronotTo(aggregateMicronotsStaked, UnitOfMeasurement.Microgon);
    const valueOfMicronots = this.currency.convertMicronotTo(
      aggregateBlockRewards.micronots,
      UnitOfMeasurement.Microgon,
    );
    const aggregateRewards = aggregateBlockRewards.microgons + valueOfMicronots;
    const aggregateReturn = calculateAggregateReturn([
      {
        startingCapital: aggregateBidCosts + markedStake,
        endingCapital: markedStake + aggregateRewards,
      },
    ]);
    const annualizedInput = {
      startingValue: aggregateReturn.eligibleCapitalInvested,
      endingValue: aggregateReturn.eligibleCapitalInvested + aggregateReturn.totalProfits,
      periodDays: miningTermDays,
    };

    this.activeSeatCount = activeSeatCount;
    this.aggregatedBidCosts = aggregateBidCosts;
    this.aggregatedBlockRewards = aggregateRewards;
    this.averageAPR = calculateAnnualPercentageRate(annualizedInput);
    this.averageAPY = calculateAnnualPercentageYield(annualizedInput);

    this.activeBidCosts = this.aggregatedBidCosts;
    this.activeBlockRewards = this.aggregatedBlockRewards;
    this.activeAPR = this.averageAPR;
    this.activeAPY = this.averageAPY;
  }
}
