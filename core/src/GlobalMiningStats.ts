import {
  calculateAggregateReturn,
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
} from './FinancialReturns.js';
import { Currency } from './Currency.js';
import type { Mining } from './Mining.js';
import { NetworkConfig } from './NetworkConfig.js';

export class GlobalMiningStats {
  private mining: Mining;
  private currency: Currency;

  public activeSeatCount = 0;
  public aggregatedBidCosts = 0n;
  public aggregatedBlockRewards = 0n;
  public investedCapital = 0n;
  public projectedProfit = 0n;
  public averageAPR: number = 0;
  public averageAPY: number = 0;

  public baseMicrogonRewardsPerBlock = 0n;
  public baseMicronotRewardsPerBlock = 0n;

  public activeBidCosts = 0n;
  public activeBlockRewards = 0n;
  public activeTDR: number = 0;
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
    const client = await this.mining.prunedClientOrArchivePromise;
    const api = await client.at(await client.rpc.chain.getFinalizedHead());
    const [activeSeatCount, cohorts] = await Promise.all([
      this.mining.fetchActiveMinersCount(api),
      this.mining.fetchActiveCohortStats(api),
    ]);

    let aggregateBidCosts = 0n;
    let aggregateStakedValue = 0n;
    let aggregateRewardValue = 0n;
    const aggregateBlockRewards = { microgons: 0n, micronots: 0n };
    let totalCohortAPR = 0;
    let totalCohortAPY = 0;
    let totalCohortTDR = 0;
    let eligibleCohortCount = 0;

    for (const { bidCosts, micronotsStaked, blockRewards, entryArgonotPrice, frameRewards } of cohorts) {
      aggregateBidCosts += bidCosts;
      aggregateBlockRewards.microgons += blockRewards.microgons;
      aggregateBlockRewards.micronots += blockRewards.micronots;

      const markedStake = Currency.convertMicronotToMicrogonAtPrice(micronotsStaked, entryArgonotPrice);
      const rewardValue = frameRewards.reduce(
        (sum, frame) =>
          sum + frame.microgons + Currency.convertMicronotToMicrogonAtPrice(frame.micronots, frame.argonotPrice),
        0n,
      );
      aggregateStakedValue += markedStake;
      aggregateRewardValue += rewardValue;
      const startingValue = bidCosts + markedStake;
      if (startingValue <= 0n) continue;

      const endingValue = markedStake + rewardValue;
      const annualizedInput = { startingValue, endingValue, periodDays: NetworkConfig.framesPerCohort };
      totalCohortAPR += calculateAnnualPercentageRate(annualizedInput);
      totalCohortAPY += calculateAnnualPercentageYield(annualizedInput);
      totalCohortTDR += calculateAggregateReturn([
        { startingCapital: startingValue, endingCapital: endingValue },
      ]).percent;
      eligibleCohortCount += 1;
    }

    const aggregateReturn = calculateAggregateReturn([
      {
        startingCapital: aggregateBidCosts + aggregateStakedValue,
        endingCapital: aggregateStakedValue + aggregateRewardValue,
      },
    ]);

    this.activeSeatCount = activeSeatCount;
    this.aggregatedBidCosts = aggregateBidCosts;
    const blocksPerCohort = BigInt(NetworkConfig.ticksPerCohort);
    this.baseMicrogonRewardsPerBlock = aggregateBlockRewards.microgons / blocksPerCohort;
    this.baseMicronotRewardsPerBlock = aggregateBlockRewards.micronots / blocksPerCohort;
    this.aggregatedBlockRewards = aggregateRewardValue;
    this.investedCapital = aggregateReturn.eligibleCapitalInvested;
    this.projectedProfit = aggregateReturn.totalProfits;
    this.averageAPR = eligibleCohortCount > 0 ? totalCohortAPR / eligibleCohortCount : 0;
    this.averageAPY = eligibleCohortCount > 0 ? totalCohortAPY / eligibleCohortCount : 0;

    this.activeBidCosts = this.aggregatedBidCosts;
    this.activeBlockRewards = this.aggregatedBlockRewards;
    this.activeTDR = eligibleCohortCount > 0 ? totalCohortTDR / eligibleCohortCount : 0;
    this.activeAPR = this.averageAPR;
    this.activeAPY = this.averageAPY;
  }
}
