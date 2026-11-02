import {
  calculateAggregateReturn,
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
} from './FinancialReturns.js';
import { Currency } from './Currency.js';
import type { Mining } from './Mining.js';
import { NetworkConfig } from './NetworkConfig.js';

/**
 * Network return estimates over each active cohort's full term. Elapsed rewards
 * combine observed wins at scheduled rates with actual expansion minting; remaining
 * rewards are projected. Completed-frame prices and entry stake values stay fixed.
 */
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
    }

    const aggregateReturn = calculateAggregateReturn([
      {
        startingCapital: aggregateBidCosts + aggregateStakedValue,
        endingCapital: aggregateStakedValue + aggregateRewardValue,
      },
    ]);
    const annualizedInput = {
      startingValue: aggregateReturn.eligibleCapitalInvested,
      endingValue: aggregateReturn.eligibleCapitalInvested + aggregateReturn.totalProfits,
      periodDays: NetworkConfig.framesPerCohort,
    };

    this.activeSeatCount = activeSeatCount;
    this.aggregatedBidCosts = aggregateBidCosts;
    const blocksPerCohort = BigInt(NetworkConfig.ticksPerCohort);
    this.baseMicrogonRewardsPerBlock = aggregateBlockRewards.microgons / blocksPerCohort;
    this.baseMicronotRewardsPerBlock = aggregateBlockRewards.micronots / blocksPerCohort;
    this.aggregatedBlockRewards = aggregateRewardValue;
    this.investedCapital = aggregateReturn.eligibleCapitalInvested;
    this.projectedProfit = aggregateReturn.totalProfits;
    this.averageAPR = calculateAnnualPercentageRate(annualizedInput);
    this.averageAPY = calculateAnnualPercentageYield(annualizedInput);

    this.activeBidCosts = this.aggregatedBidCosts;
    this.activeBlockRewards = this.aggregatedBlockRewards;
    this.activeTDR = aggregateReturn.percent;
    this.activeAPR = this.averageAPR;
    this.activeAPY = this.averageAPY;
  }
}
