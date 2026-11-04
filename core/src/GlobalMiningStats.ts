import {
  calculateAggregateReturn,
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
} from './FinancialReturns.js';
import { Currency } from './Currency.js';
import type { IMiningCohortStats, Mining } from './Mining.js';
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

  public hasCurrentStats = false;
  public cohortProgress = { completed: 0, total: 0 };
  public provisionalReturns?: { apr: number; apy: number; microgonRevenue: bigint };

  constructor(mining: Mining, currency: Currency) {
    this.mining = mining;
    this.currency = currency;
  }

  public async load(onProgress?: () => void) {
    await this.currency.load();
    await this.update(onProgress);
  }

  public async update(onProgress?: () => void) {
    const client = await this.mining.prunedClientOrArchivePromise;
    const api = await client.at(await client.rpc.chain.getFinalizedHead());
    const activeSeatCount = await this.mining.fetchActiveMinersCount(api);
    const cohorts = await this.mining.fetchActiveCohortStats(api, progress => {
      this.activeSeatCount = progress.activeSeatCount;
      this.activeBidCosts = progress.activeBidCosts;
      this.hasCurrentStats = true;
      this.cohortProgress = { completed: progress.cohorts.length, total: progress.totalCohorts };
      if (progress.cohorts.length > 0) {
        const returns = this.calculateReturns(progress.cohorts);
        this.provisionalReturns = {
          apr: returns.averageAPR,
          apy: returns.averageAPY,
          microgonRevenue: returns.aggregatedBlockRewards,
        };
      }
      onProgress?.();
    });

    this.activeSeatCount = activeSeatCount;
    Object.assign(this, this.calculateReturns(cohorts));
    this.hasCurrentStats = true;
    this.cohortProgress = { completed: cohorts.length, total: cohorts.length };
  }

  private calculateReturns(cohorts: readonly IMiningCohortStats[]) {
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

    const blocksPerCohort = BigInt(NetworkConfig.ticksPerCohort);
    const averageAPR = calculateAnnualPercentageRate(annualizedInput);
    const averageAPY = calculateAnnualPercentageYield(annualizedInput);
    return {
      aggregatedBidCosts: aggregateBidCosts,
      baseMicrogonRewardsPerBlock: aggregateBlockRewards.microgons / blocksPerCohort,
      baseMicronotRewardsPerBlock: aggregateBlockRewards.micronots / blocksPerCohort,
      aggregatedBlockRewards: aggregateRewardValue,
      investedCapital: aggregateReturn.eligibleCapitalInvested,
      projectedProfit: aggregateReturn.totalProfits,
      averageAPR,
      averageAPY,
      activeBidCosts: aggregateBidCosts,
      activeBlockRewards: aggregateRewardValue,
      activeTDR: aggregateReturn.percent,
      activeAPR: averageAPR,
      activeAPY: averageAPY,
    };
  }
}
