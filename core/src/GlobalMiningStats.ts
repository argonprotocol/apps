import {
  calculateAggregateReturn,
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
} from './FinancialReturns.js';
import { Currency } from './Currency.js';
import type { IMiningCohortStats, Mining } from './Mining.js';
import { NetworkConfig } from './NetworkConfig.js';
import { bigNumberToBigInt } from './utils.js';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import type { PriceIndex } from '@argonprotocol/mainchain';

export interface IMiningFrameEstimate {
  frameId: number;
  blockNumber: number;
  blockHash: string;
  argonotPrice: bigint;
  micronotsPerSeat: bigint;
}

/** Even mining shares; mined ARGNOT is sold daily at that frame's opening price. */
export class GlobalMiningStats {
  protected readonly frameEstimates = new Map<number, IMiningFrameEstimate>();
  private frameEstimatesNeedSaving = false;

  public activeSeatCount = 0;
  public aggregatedBidCosts = 0n;
  public aggregatedBlockRewards = 0n;
  public investedCapital = 0n;
  public projectedProfit = 0n;
  public averageAPR = 0;
  public averageAPY = 0;
  public baseMicrogonRewardsPerBlock = 0n;
  public baseMicronotRewardsPerBlock = 0n;
  public activeBidCosts = 0n;
  public activeBlockRewards = 0n;
  public activeTDR = 0;
  public activeAPR = 0;
  public activeAPY = 0;
  public hasCurrentStats = false;
  public frameProgress = { completed: 0, total: 0 };

  constructor(
    protected readonly mining: Mining,
    private readonly currency: Currency,
  ) {}

  public async load(onProgress?: () => void): Promise<void> {
    await this.currency.load();
    await this.update(onProgress);
  }

  public async update(onProgress?: () => void): Promise<void> {
    this.frameProgress = { completed: 0, total: 0 };
    onProgress?.();
    await this.loadFrameEstimates();
    const client = await this.mining.prunedClientOrArchivePromise;
    const api = await client.at(await client.rpc.chain.getFinalizedHead());
    const [cohorts, nextFrameId, blockNumbers, mintedByCohort, priceIndex] = await Promise.all([
      this.mining.fetchProjectedCohortStats(api),
      this.mining.fetchNextFrameId(api),
      api.query.miningSlot.frameStartBlockNumbers(),
      api.query.mint.miningMintPerCohort(),
      Currency.fetchPriceIndex(api),
    ]);
    const currentFrameId = nextFrameId - 1;
    const currentPrice = this.argonotPriceAtTarget(priceIndex);

    if (cohorts.length) {
      if (!blockNumbers?.length) throw new Error('Mining frame boundaries are unavailable');
      const firstFrameId = Math.min(...cohorts.map(cohort => cohort.startingFrameId));
      const frames = [...blockNumbers].sort((a, b) => b - a).slice(0, currentFrameId - firstFrameId + 1);
      this.frameProgress = { completed: 0, total: frames.length };
      onProgress?.();
      const archive = await this.mining.clients.archiveClientPromise;
      for (const [index, blockNumber] of frames.entries()) {
        const frameId = currentFrameId - index;
        if (this.frameEstimates.get(frameId)?.blockNumber === blockNumber) {
          this.frameProgress = { completed: index + 1, total: frames.length };
          onProgress?.();
          continue;
        }

        const blockHash = (await client.rpc.chain.getBlockHash(blockNumber)).toHex();
        const frameApi = await archive.at(blockHash);
        const [price, tick, activeMiners] = await Promise.all([
          Currency.fetchPriceIndex(frameApi),
          this.mining.fetchCurrentTick(frameApi),
          this.mining.fetchActiveMinersCount(frameApi),
        ]);
        const micronots = await this.mining.minimumMicronotsMinedDuringTickRange(
          tick,
          tick + NetworkConfig.rewardTicksPerFrame,
          frameApi,
        );
        const argonotPrice = this.argonotPriceAtTarget(price);
        let micronotsPerSeat = 0n;
        if (activeMiners > 0) micronotsPerSeat = micronots / BigInt(activeMiners);
        this.frameEstimates.set(frameId, { frameId, blockNumber, blockHash, argonotPrice, micronotsPerSeat });
        this.frameEstimatesNeedSaving = true;
        this.frameProgress = { completed: index + 1, total: frames.length };
        onProgress?.();
      }
      for (const frameId of this.frameEstimates.keys()) {
        if (frameId < firstFrameId) {
          this.frameEstimates.delete(frameId);
          this.frameEstimatesNeedSaving = true;
        }
      }
    }

    const quote = projectMiningReturns({
      cohorts,
      frameEstimates: this.frameEstimates,
      currentFrameId,
      currentPrice,
      mintedByCohort,
    });
    Object.assign(this, quote);
    this.hasCurrentStats = true;
    if (this.frameEstimatesNeedSaving && (await this.saveFrameEstimates())) this.frameEstimatesNeedSaving = false;
  }

  protected async loadFrameEstimates(): Promise<void> {
    return;
  }
  protected async saveFrameEstimates(): Promise<boolean> {
    return true;
  }

  private argonotPriceAtTarget(price: PriceIndex): bigint {
    if (!price.argonotUsdPrice || !price.argonUsdTargetPrice?.gt(0))
      throw new Error('ARGNOT price is unavailable for mining returns');
    return bigNumberToBigInt(price.argonotUsdPrice.div(price.argonUsdTargetPrice).times(1_000_000));
  }
}

/** Completed daily sales stay fixed; remaining days use today's rate and price. */
export function projectMiningReturns({
  cohorts,
  frameEstimates,
  currentFrameId,
  currentPrice,
  mintedByCohort,
}: {
  cohorts: readonly IMiningCohortStats[];
  frameEstimates: ReadonlyMap<number, IMiningFrameEstimate>;
  currentFrameId: number;
  currentPrice: bigint;
  mintedByCohort: HistoricalQueryRecord<'mint', 'miningMintPerCohort'> | null;
}) {
  const term = NetworkConfig.framesPerCohort;
  const today = frameEstimates.get(currentFrameId);
  let bidCosts = 0n;
  let stakeValue = 0n;
  let rewardValue = 0n;
  let scheduledArgons = 0n;
  let scheduledArgonots = 0n;
  let activeSeatCount = 0;
  for (const cohort of cohorts) {
    const entry = frameEstimates.get(cohort.startingFrameId);
    if (!entry || !today) throw new Error('Mining daily estimates are incomplete');
    activeSeatCount += cohort.seatCount;
    bidCosts += cohort.bidCosts;
    stakeValue += Currency.convertMicronotToMicrogonAtPrice(cohort.micronotsStaked, entry.argonotPrice);
    scheduledArgons += cohort.blockRewards.microgons;
    scheduledArgonots += cohort.blockRewards.micronots;
    rewardValue += cohort.blockRewards.microgons + (mintedByCohort?.[cohort.startingFrameId] ?? 0n);

    const endFrame = cohort.startingFrameId + term;
    for (let frameId = cohort.startingFrameId; frameId < endFrame; frameId++) {
      let day = today;
      let price = currentPrice;
      if (frameId < currentFrameId) {
        const completed = frameEstimates.get(frameId);
        if (!completed) throw new Error(`Mining estimate for frame ${frameId} is unavailable`);
        day = completed;
        price = completed.argonotPrice;
      }
      rewardValue += Currency.convertMicronotToMicrogonAtPrice(day.micronotsPerSeat * BigInt(cohort.seatCount), price);
    }
  }

  const returns = calculateAggregateReturn([
    { startingCapital: bidCosts + stakeValue, endingCapital: stakeValue + rewardValue },
  ]);
  const annualized = {
    startingValue: returns.eligibleCapitalInvested,
    endingValue: returns.eligibleCapitalInvested + returns.totalProfits,
    periodDays: term,
  };
  const apr = calculateAnnualPercentageRate(annualized);
  const apy = calculateAnnualPercentageYield(annualized);
  return {
    activeSeatCount,
    aggregatedBidCosts: bidCosts,
    aggregatedBlockRewards: rewardValue,
    investedCapital: returns.eligibleCapitalInvested,
    projectedProfit: returns.totalProfits,
    averageAPR: apr,
    averageAPY: apy,
    baseMicrogonRewardsPerBlock: scheduledArgons / BigInt(NetworkConfig.ticksPerCohort),
    baseMicronotRewardsPerBlock: scheduledArgonots / BigInt(NetworkConfig.ticksPerCohort),
    activeBidCosts: bidCosts,
    activeBlockRewards: rewardValue,
    activeTDR: returns.percent,
    activeAPR: apr,
    activeAPY: apy,
  };
}
