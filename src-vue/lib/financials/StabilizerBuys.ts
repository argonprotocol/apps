import BigNumber from 'bignumber.js';
import {
  BitcoinLock,
  bigNumberToBigInt,
  calculateAnnualPercentageYield,
  getPercent,
  percentOf,
  SATOSHIS_PER_BITCOIN,
  type ICapitalFlow,
  type StabilizerBuy,
} from '@argonprotocol/apps-core';
import type { PriceIndex } from '@argonprotocol/mainchain';
import type { BitcoinLiquid } from '../BitcoinLiquid.ts';
import type IArgonUniswapData from '../../../core/src/interfaces/IArgonUniswapData.ts';
import type { StabilizerBuyPurchases } from '../StabilizerBuyPurchases.ts';
import {
  createFinancialPosition,
  type IFinancialGroupSummary,
  type IStabilizerBuyFinancialPosition,
} from '../../interfaces/IFinancialPosition.ts';
import { calculatePositionReturn } from './index.ts';
import type { StabilizerBuys } from '../StabilizerBuys.ts';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyFrameRewards,
  type IStabilizerBuyEstimate,
  type IStabilizerBuyRecord,
} from '../../interfaces/IStabilizerBuyPurchase.ts';

/** Current storage owns claims; the domain records principal releases and reward payments. */
export function createStabilizerBuyFinancialPositions(
  snapshot: StabilizerBuys['snapshot'],
): IStabilizerBuyFinancialPosition[] {
  const {
    accountAddress,
    buys,
    frameRewards,
    positions: livePositions,
    payableReward,
    hasPendingHistoryGap,
  } = snapshot;
  const rewardsByFrame = new Map(frameRewards.map(rewards => [rewards.admissionFrame, rewards]));
  const liveByFrame = new Map(livePositions.map(position => [position.admissionFrame, position]));

  const frameIds = new Set([...rewardsByFrame.keys(), ...liveByFrame.keys()]);
  for (const buy of buys) {
    if (buy.admissionFrame !== undefined) frameIds.add(buy.admissionFrame);
  }

  // Eligible buys share the frame's reward. Direct deliveries retain their individual return.
  const groups = new Map<number | string, typeof buys>();
  for (const frame of [...frameIds].sort((a, b) => a - b)) groups.set(frame, []);

  for (const buy of buys) {
    const hasFailedFee =
      buy.status === StabilizerBuyStatus.Failed &&
      ((buy.usdcApprovalFeeWei ?? 0n) > 0n || (buy.ethereumFeeWei ?? 0n) > 0n);
    if (buy.admissionFrame === undefined && buy.purchaseArgonRecognitionBlockNumber === undefined && !hasFailedFee)
      continue;

    const id = buy.admissionFrame ?? buy.id;
    const purchases = groups.get(id) ?? [];
    purchases.push(buy);
    groups.set(id, purchases);
  }

  const recordedReward = frameRewards.reduce(
    (sum, rewards) => sum + (rewards.payout ? 0n : (rewards.awardedReward ?? 0n)),
    0n,
  );
  const rewardsMatch = recordedReward === payableReward;
  const positions: IStabilizerBuyFinancialPosition[] = [];

  for (const [id, purchases] of groups) {
    let admissionFrame: number | undefined;
    let rewards: IStabilizerBuyFrameRewards | undefined;
    let currentPrincipal = 0n;
    if (typeof id === 'number') {
      admissionFrame = id;
      rewards = rewardsByFrame.get(id);
      currentPrincipal = liveByFrame.get(id)?.heldPrincipal ?? 0n;
    }

    const isUnframed = admissionFrame === undefined;
    const unpaidReward = rewards?.payout ? 0n : (rewards?.awardedReward ?? 0n);
    let currentValue = currentPrincipal;
    if (rewardsMatch) currentValue += unpaidReward;

    let returnIsComplete = purchases.length > 0;
    if (!isUnframed && (!rewardsMatch || hasPendingHistoryGap)) returnIsComplete = false;

    const capitalFlows: ICapitalFlow[] = [];
    let principal = 0n;
    let settledCapitalValue = 0n;
    let disposedPrincipal = 0n;
    let startedAt: number | undefined;
    let endedAt = rewards?.payout?.blockTime;

    for (const buy of purchases) {
      principal += buy.principal ?? 0n;

      const occurredAt =
        buy.purchasedAt?.getTime() ??
        buy.ethereumSubmittedAt?.getTime() ??
        buy.usdcApprovalSubmittedAt?.getTime() ??
        buy.purchaseArgonRecognitionBlockTime?.getTime() ??
        buy.createdAt.getTime();
      startedAt = Math.min(startedAt ?? occurredAt, occurredAt);

      if (isUnframed && buy.purchaseArgonRecognitionBlockNumber !== undefined) {
        settledCapitalValue += buy.principal ?? 0n;
        disposedPrincipal += buy.principal ?? 0n;
        endedAt = buy.purchaseArgonRecognitionBlockTime?.getTime();
        if (buy.ineligibleReason === undefined && !buy.purchaseAdmissionFailure) returnIsComplete = false;
      } else if (isUnframed) {
        endedAt = buy.updatedAt.getTime();
      } else if (buy.liquidRepaymentEvent) {
        const repayment = buy.liquidRepaymentEvent;
        // A repayment transfers capital to the Liquid; it is not a wallet credit or reward.
        settledCapitalValue += repayment.microgonsBurned + (buy.releasedPrincipal ?? 0n);
        disposedPrincipal += buy.principal ?? 0n;
        endedAt = Math.max(endedAt ?? 0, repayment.blockTime, buy.purchaseArgonReleaseBlockTime?.getTime() ?? 0);
        if (repayment.microgonsBurned !== buy.principal && buy.purchaseArgonReleaseBlockNumber === undefined)
          returnIsComplete = false;
      } else if (buy.purchaseArgonReleaseBlockNumber !== undefined) {
        settledCapitalValue += buy.releasedPrincipal ?? buy.principal ?? 0n;
        disposedPrincipal += buy.principal ?? 0n;
        endedAt = Math.max(endedAt ?? 0, buy.purchaseArgonReleaseBlockTime!.getTime());
      }

      if (buy.spentMicrogons !== undefined && buy.ethereumFeeMicrogons !== undefined) {
        capitalFlows.push({
          amount: buy.spentMicrogons + buy.ethereumFeeMicrogons,
          occurredAt,
        });
      } else {
        returnIsComplete = false;
      }

      if (buy.usdcApprovalFeeMicrogons === undefined) {
        returnIsComplete = false;
      } else if (buy.usdcApprovalFeeMicrogons > 0n) {
        capitalFlows.push({
          amount: buy.usdcApprovalFeeMicrogons,
          occurredAt: buy.usdcApprovalSubmittedAt?.getTime() ?? occurredAt,
        });
      }
    }

    if (principal - disposedPrincipal !== currentPrincipal) returnIsComplete = false;

    for (const fee of [...purchases.flatMap(buy => buy.argonFees), ...(rewards?.bidFees ?? [])]) {
      if (fee.isAmbiguous) {
        returnIsComplete = false;
        continue;
      }

      capitalFlows.push({ amount: fee.amount, occurredAt: fee.blockTime });
    }

    let investedCost: bigint | undefined;
    if (returnIsComplete) investedCost = capitalFlows.reduce((sum, flow) => sum + flow.amount, 0n);

    const isCompleted =
      isUnframed || (currentPrincipal === 0n && unpaidReward === 0n && rewards?.awardedReward !== undefined);
    let positionId = `stabilizer:${accountAddress}:${id}`;
    if (!isUnframed) positionId = `stabilizer:${accountAddress}:frame:${id}`;

    positions.push(
      createFinancialPosition(
        'stabilizer-buy',
        {
          id: positionId,
          label: 'Stabilizer Buy',
          admissionFrame,
          lifecycle: isCompleted ? 'completed' : 'held',
          startedAt,
          endedAt: isCompleted ? endedAt : undefined,
          capitalFlows,
          returnIsComplete,
        },
        {
          currentValue,
          investedCost,
          paidIncome:
            (rewards?.paidReward ?? 0n) +
            (rewards?.repaymentRewards ?? []).reduce((sum, reward) => sum + reward.amount, 0n),
          settledPrincipalValue: settledCapitalValue,
        },
      ),
    );
  }

  if (!rewardsMatch) {
    positions.push(
      createFinancialPosition(
        'stabilizer-buy',
        {
          id: `stabilizer:${accountAddress}:unattributed-reward`,
          label: 'Stabilizer bonuses',
          lifecycle: 'held',
          returnIsComplete: false,
        },
        { currentValue: payableReward, paidIncome: 0n },
      ),
    );
  }

  return positions;
}

/** A buy's APY annualizes its net proceeds over the agreed term, including while it awaits payout. */
export function calculateStabilizerBuyReturn({
  position,
  group,
  periodDays,
  expectedReward,
  potentialLiquidBonus = 0n,
}: {
  position: IStabilizerBuyFinancialPosition;
  group: IFinancialGroupSummary;
  periodDays?: number;
  expectedReward?: bigint;
  potentialLiquidBonus?: bigint;
}) {
  let projectedPosition = position;
  if (expectedReward !== undefined && position.currentValue !== undefined) {
    projectedPosition = { ...position, currentValue: position.currentValue + expectedReward };
  }
  const result = calculatePositionReturn([projectedPosition], group);
  if (position.admissionFrame !== undefined) delete result.apy;

  const maximumReturnAmount =
    result.returnAmount === undefined ? undefined : result.returnAmount + potentialLiquidBonus;
  let maximumApy = result.apy;
  if (periodDays && periodDays > 0 && result.investedCost > 0n && result.returnAmount !== undefined) {
    result.apy = calculateAnnualPercentageYield({
      startingValue: result.investedCost,
      endingValue: result.investedCost + result.returnAmount,
      periodDays,
    });
    maximumApy = calculateAnnualPercentageYield({
      startingValue: result.investedCost,
      endingValue: result.investedCost + maximumReturnAmount!,
      periodDays,
    });
  }
  return {
    ...result,
    isEstimated: expectedReward !== undefined || potentialLiquidBonus > 0n,
    potentialLiquidBonus,
    maximumReturnAmount,
    maximumApy,
  };
}

/** Historical entries model deployed capital, not a wallet's ability to capture every opportunity. */
export function projectHistoricalStabilizerBuys({
  history,
  fees,
  market,
  availableUsdc,
}: {
  history: IArgonUniswapData;
  fees: NonNullable<Awaited<ReturnType<StabilizerBuyPurchases['estimateHistoricalFees']>>>;
  market: Pick<
    NonNullable<StabilizerBuys['data']['market']>,
    'matchingRate' | 'auctionInclusionPercent' | 'purchaseHoldFrames'
  >;
  availableUsdc: bigint;
}) {
  if (!history.rewardFunding || !market.matchingRate || !market.auctionInclusionPercent) return;

  const { prices, ethereumFeeWei, bidFee } = fees;
  if (!prices.ethereumUsdPrice) return;

  const ethereumFee = BigNumber(ethereumFeeWei)
    .times(prices.ethereumUsdPrice)
    .div(prices.argonUsdTargetPrice)
    .div(1e12);
  const feePerBuy = ethereumFee.plus(bidFee);
  const newFunding = BigNumber(history.rewardFunding.averageArgonsPerFrame).times(1e6);
  let reserve = BigNumber(0);
  let invested = BigNumber(0);
  let principal = BigNumber(0);
  let reward = BigNumber(0);

  for (const day of history.days) {
    reserve = reserve.plus(newFunding);
    if (!day.buyCount) continue;

    const spent = BigNumber(day.costInTargetArgons).times(1e6);
    const purchased = BigNumber(day.argonBought).times(1e6);
    const matchingBasis = BigNumber.maximum(0, purchased.minus(spent))
      .times(market.matchingRate)
      .integerValue(BigNumber.ROUND_FLOOR);
    const inclusionLimit = matchingBasis.times(market.auctionInclusionPercent).integerValue(BigNumber.ROUND_FLOOR);
    const budget = BigNumber.minimum(reserve, inclusionLimit);

    reserve = reserve.minus(budget);
    reward = reward.plus(budget);
    invested = invested.plus(spent).plus(feePerBuy.times(day.buyCount));
    principal = principal.plus(purchased);
  }

  if (invested.lte(0)) return;

  // The hold includes bidding; released capital can be redeployed the following day.
  const periodDays = market.purchaseHoldFrames + 1;
  const startingValue = BigInt(invested.integerValue(BigNumber.ROUND_CEIL).toFixed(0));
  const apy = {
    min: calculateAnnualPercentageYield({
      startingValue,
      endingValue: BigInt(principal.integerValue(BigNumber.ROUND_FLOOR).toFixed(0)),
      periodDays,
    }),
    max: calculateAnnualPercentageYield({
      startingValue,
      endingValue: BigInt(principal.plus(reward).integerValue(BigNumber.ROUND_FLOOR).toFixed(0)),
      periodDays,
    }),
  };
  const capitalAtTarget = BigNumber(availableUsdc).times(prices.usdcUsdPrice).div(prices.argonUsdTargetPrice);

  return {
    apy,
    earnings: {
      min: BigInt(capitalAtTarget.times(apy.min).div(100).integerValue(BigNumber.ROUND_FLOOR).toFixed(0)),
      max: BigInt(capitalAtTarget.times(apy.max).div(100).integerValue(BigNumber.ROUND_FLOOR).toFixed(0)),
    },
  };
}

/** Purchase estimates include network fees and a zero-to-full reward range. */
export function projectStabilizerBuyQuote({
  quote,
  feeEstimateWei,
  periodDays,
  matchingRate,
  liquidRepaymentMicrogons = 0n,
  liquidRepaymentRewardPercent,
}: {
  quote: IStabilizerBuyEstimate;
  feeEstimateWei: bigint;
  periodDays: number;
  matchingRate: BigNumber;
  liquidRepaymentMicrogons?: bigint;
  liquidRepaymentRewardPercent?: BigNumber;
}) {
  const cost = calculateStabilizerBuyCost({ quote, feeEstimateWei });
  if (!cost) return;
  const { spent, investedCost } = cost;

  const discount = BigNumber(quote.quotedMicrogonsOut).minus(spent).decimalPlaces(0, BigNumber.ROUND_FLOOR);
  let maximumReward = 0n;
  let liquidRepaymentBonus = 0n;
  if (quote.qualifiesForRewards) {
    maximumReward = BigInt(
      BigNumber.maximum(0, discount).times(matchingRate).integerValue(BigNumber.ROUND_FLOOR).toFixed(0),
    );
    if (liquidRepaymentRewardPercent) {
      liquidRepaymentBonus = percentOf(liquidRepaymentMicrogons, liquidRepaymentRewardPercent.times(100).toNumber());
    }
  }

  const min = quote.quotedMicrogonsOut - investedCost;
  const max = min + maximumReward + liquidRepaymentBonus;
  const baseMaximumApy = calculateAnnualPercentageYield({
    startingValue: investedCost,
    endingValue: quote.quotedMicrogonsOut + maximumReward,
    periodDays,
  });
  let maximumApy = baseMaximumApy;
  if (liquidRepaymentBonus > 0n) {
    maximumApy = calculateAnnualPercentageYield({
      startingValue: investedCost,
      endingValue: quote.quotedMicrogonsOut + maximumReward + liquidRepaymentBonus,
      periodDays,
    });
  }

  return {
    discountPercent: BigNumber(1).minus(spent.div(quote.quotedMicrogonsOut)).times(100).toNumber(),
    earnings: { min, max },
    liquidRepaymentBonus,
    liquidRepaymentBonusApy: maximumApy - baseMaximumApy,
    apy: {
      min: calculateAnnualPercentageYield({
        startingValue: investedCost,
        endingValue: quote.quotedMicrogonsOut,
        periodDays,
      }),
      max: maximumApy,
    },
  };
}

/** Estimate purchase principal returned at target; repayment bonuses are separate. */
export function projectStabilizerBuyLiquidPaydown({
  microgons,
  priceIndex,
  repayment,
  liquid,
  lockExpirations = new Map<number, number>(),
  availableSatoshisByFission,
  availableLiquidityByFission,
}: {
  microgons: bigint;
  priceIndex: PriceIndex;
  repayment?: StabilizerBuy['liquidRepayments'][number];
  liquid?: BitcoinLiquid;
  lockExpirations?: ReadonlyMap<number, number>;
  availableSatoshisByFission?: ReadonlyMap<number, bigint>;
  availableLiquidityByFission?: ReadonlyMap<number, bigint>;
}) {
  let purchaseRValue: BigNumber;
  let highWaterRValue: BigNumber;
  let purchaseMicrogonsPerBtc: BigNumber;
  if (repayment) {
    if (!repayment.observedRValueHighWater) return;
    purchaseRValue = repayment.purchaseRValue;
    highWaterRValue = repayment.observedRValueHighWater;
    purchaseMicrogonsPerBtc = repayment.microgonsAtTargetPerBtc;
  } else {
    const { argonUsdTargetPrice, argonUsdPrice, btcUsdPrice } = priceIndex;
    if (!argonUsdTargetPrice?.gt(0)) return;
    if (!argonUsdPrice?.gt(0)) return;
    if (!btcUsdPrice?.gt(0)) return;

    purchaseRValue = priceIndex.rValue;
    highWaterRValue = purchaseRValue;
    purchaseMicrogonsPerBtc = btcUsdPrice
      .div(argonUsdTargetPrice)
      .times(1_000_000)
      .decimalPlaces(18, BigNumber.ROUND_DOWN);
  }
  if (!purchaseRValue.gt(0) || !purchaseMicrogonsPerBtc.gt(0)) return;

  const redemptionRate = BitcoinLock.calculateRedemptionRate(purchaseRValue).decimalPlaces(18, BigNumber.ROUND_DOWN);
  const highWaterRate = BitcoinLock.calculateRedemptionRate(highWaterRValue).decimalPlaces(18, BigNumber.ROUND_DOWN);
  const capturedDiscount = BigNumber.maximum(BigNumber(1).minus(redemptionRate), 0)
    .times(purchaseRValue)
    .decimalPlaces(18, BigNumber.ROUND_DOWN);
  // Preserve the purchase commitment that selects Bitcoin; only its burn follows the best quote.
  const purchasePremiumRate = BigNumber.maximum(redemptionRate.minus(1), 0);
  const commitmentRate = BigNumber(1).minus(capturedDiscount).plus(purchasePremiumRate);
  const burnRate = BigNumber.minimum(redemptionRate, highWaterRate);
  const targetBurnRate = BigNumber.minimum(burnRate, 1);

  if (!liquid) {
    const targetBurn = bigNumberToBigInt(BigNumber(microgons).times(targetBurnRate).div(commitmentRate));
    const burnedMicrogons = bigNumberToBigInt(BigNumber(microgons).times(burnRate).div(commitmentRate));
    return {
      returnedAtTarget: microgons - targetBurn,
      appliedMicrogons: microgons,
      burnedMicrogons,
      returnedMicrogons: microgons - burnedMicrogons,
    };
  }

  const fissions = liquid.fissions.filter(fission => fission.closedAtArgonBlock == null && fission.satoshis > 0n);
  if (fissions.some(fission => !lockExpirations.has(fission.lockId))) return;
  if (fissions.some(fission => fission.createdAtArgonBlock === undefined)) return;
  fissions.sort((left, right) => {
    const expiryOrder = lockExpirations.get(left.lockId)! - lockExpirations.get(right.lockId)!;
    if (expiryOrder !== 0) return expiryOrder;
    const creationOrder = left.createdAtArgonBlock! - right.createdAtArgonBlock!;
    if (creationOrder !== 0) return creationOrder;
    return left.fissionId - right.fissionId;
  });

  const totalSatoshis = fissions.reduce((sum, fission) => sum + fission.satoshis, 0n);
  const liabilityBefore = fissions.reduce(
    (sum, fission) => sum + (availableLiquidityByFission?.get(fission.fissionId) ?? fission.liquidityPromised),
    0n,
  );
  let remainingCommitment = microgons;
  let targetBurn = 0n;
  let burnedMicrogons = 0n;
  let repaidSatoshis = 0n;
  let liquidityRepaid = 0n;
  const repaidSatoshisByFission = new Map<number, bigint>();
  const repaidLiquidityByFission = new Map<number, bigint>();
  for (const fission of fissions) {
    const quoteRepayment = (satoshis: bigint) => {
      const purchaseBasis = purchaseMicrogonsPerBtc
        .times(satoshis)
        .div(SATOSHIS_PER_BITCOIN)
        .integerValue(BigNumber.ROUND_DOWN);
      const originalBasis = BigNumber(fission.microgonsAtTargetPerBtc)
        .times(satoshis)
        .div(SATOSHIS_PER_BITCOIN)
        .integerValue(BigNumber.ROUND_DOWN);
      const basis = BigNumber.minimum(purchaseBasis, originalBasis);
      return {
        committed: bigNumberToBigInt(basis.times(commitmentRate)),
        targetBurn: bigNumberToBigInt(basis.times(targetBurnRate)),
        burned: bigNumberToBigInt(basis.times(burnRate)),
      };
    };
    const availableSatoshis = availableSatoshisByFission?.get(fission.fissionId) ?? fission.satoshis;
    let satoshis = availableSatoshis;
    if (satoshis === 0n) continue;
    let repayment = quoteRepayment(satoshis);
    const partial = repayment.committed > remainingCommitment;
    if (partial) {
      let low = 0n;
      let high = satoshis - 1n;
      while (low < high) {
        const middle = high - (high - low) / 2n;
        if (quoteRepayment(middle).committed <= remainingCommitment) low = middle;
        else high = middle - 1n;
      }
      satoshis = low;
      repayment = quoteRepayment(satoshis);
    }
    if (satoshis === 0n) break;

    remainingCommitment -= repayment.committed;
    targetBurn += repayment.targetBurn;
    burnedMicrogons += repayment.burned;
    repaidSatoshis += satoshis;
    repaidSatoshisByFission.set(fission.fissionId, satoshis);
    const availableLiquidity = availableLiquidityByFission?.get(fission.fissionId) ?? fission.liquidityPromised;
    const repaidLiquidity = (availableLiquidity * satoshis) / availableSatoshis;
    liquidityRepaid += repaidLiquidity;
    repaidLiquidityByFission.set(fission.fissionId, repaidLiquidity);
    if (partial) break;
  }

  const paydownPercent = getPercent(repaidSatoshis, totalSatoshis);
  return {
    returnedAtTarget: microgons - targetBurn,
    burnedMicrogons,
    returnedMicrogons: microgons - burnedMicrogons,
    appliedMicrogons: microgons - remainingCommitment,
    paydownPercent,
    repaidSatoshisByFission,
    repaidSatoshis,
    repaidLiquidityByFission,
    liabilityBefore,
    liabilityAfter: liabilityBefore - liquidityRepaid,
    liquidityRepaid,
  };
}

/** Project the pending queue in payout order without counting the same Bitcoin twice. */
export function projectStabilizerBuyPendingPaydowns({
  positions,
  liquids,
  lockExpirations,
  priceIndex,
}: {
  positions: StabilizerBuys['snapshot']['positions'];
  liquids: readonly BitcoinLiquid[];
  lockExpirations: ReadonlyMap<number, number>;
  priceIndex: PriceIndex;
}) {
  const estimates = new Map<bigint, ReturnType<typeof projectStabilizerBuyLiquidPaydown>>();
  const availableSatoshis = new Map(
    liquids.flatMap(liquid => liquid.fissions.map(fission => [fission.fissionId, fission.satoshis] as const)),
  );
  const availableLiquidity = new Map(
    liquids.flatMap(liquid => liquid.fissions.map(fission => [fission.fissionId, fission.liquidityPromised] as const)),
  );
  const unavailableLiquids = new Set<number>();
  const repayments = positions
    .flatMap(position => position.liquidRepayments)
    .toSorted((left, right) => {
      if (left.gatewayActivityNonce < right.gatewayActivityNonce) return -1;
      if (left.gatewayActivityNonce > right.gatewayActivityNonce) return 1;
      return 0;
    });
  for (const repayment of repayments) {
    if (unavailableLiquids.has(repayment.liquidId)) continue;
    const liquid = liquids.find(liquid => liquid.liquidId === repayment.liquidId);
    if (!liquid) continue;
    const estimate = projectStabilizerBuyLiquidPaydown({
      microgons: repayment.microgons,
      repayment,
      priceIndex,
      liquid,
      lockExpirations,
      availableSatoshisByFission: availableSatoshis,
      availableLiquidityByFission: availableLiquidity,
    });
    if (!estimate) {
      unavailableLiquids.add(repayment.liquidId);
      continue;
    }
    estimates.set(repayment.gatewayActivityNonce, estimate);
    for (const [fissionId, repaid] of estimate.repaidSatoshisByFission ?? []) {
      availableSatoshis.set(fissionId, availableSatoshis.get(fissionId)! - repaid);
    }
    for (const [fissionId, repaid] of estimate.repaidLiquidityByFission ?? []) {
      availableLiquidity.set(fissionId, availableLiquidity.get(fissionId)! - repaid);
    }
  }
  return {
    byNonce: estimates,
    availableSatoshisByFission: availableSatoshis,
    unavailableLiquidIds: unavailableLiquids,
  };
}

/** Match the payout hook's Fission repayments, excluding later transactions in that block. */
export function getStabilizerBuyReturnedSatoshis(buy: IStabilizerBuyRecord, liquid: BitcoinLiquid) {
  const completed = buy.liquidRepaymentEvent;
  if (!completed) return;
  if (completed.microgonsBurned === 0n) return 0n;
  const repayments = liquid.fissions
    .flatMap(fission => fission.repayments)
    .filter(repayment => repayment.blockHash === completed.blockHash && repayment.eventIndex < completed.eventIndex);
  let burned = repayments.reduce((sum, repayment) => sum + repayment.redemptionAmount, 0n);
  let returned = repayments.reduce((sum, repayment) => sum + repayment.satoshis, 0n);
  for (const fission of liquid.fissions) {
    if (fission.closeReason !== 'closed' || fission.closedBlockHash !== completed.blockHash) continue;
    // Payout settles one Liquid per account in on_initialize. Signed closes occur later in the block.
    if (fission.closedExtrinsicIndex !== undefined) continue;
    if (fission.redemptionAmount === undefined) return;
    burned += fission.redemptionAmount;
    returned += fission.satoshis;
  }
  if (burned !== completed.microgonsBurned) return;
  return returned;
}

export function calculateStabilizerBuyCost({
  quote,
  feeEstimateWei,
}: {
  quote: IStabilizerBuyEstimate;
  feeEstimateWei: bigint;
}) {
  const prices = quote.prices;
  if (!prices?.ethereumUsdPrice) return;

  const spent = BigNumber(quote.request.maxUsdcIn).times(prices.usdcUsdPrice).div(prices.argonUsdTargetPrice);
  const fees = BigNumber(feeEstimateWei).times(prices.ethereumUsdPrice).div(prices.argonUsdTargetPrice).div(1e12);
  const investedCost = BigInt(spent.plus(fees).integerValue(BigNumber.ROUND_CEIL).toFixed(0));
  return { spent, investedCost };
}

export function projectStabilizerBuyBid({
  snapshot,
  admissionFrame,
  reward,
  bidFee,
  periodDays,
}: {
  snapshot: Pick<StabilizerBuys['snapshot'], 'buys' | 'frameRewards' | 'positions' | 'hasPendingHistoryGap'>;
  admissionFrame: number;
  reward: bigint;
  bidFee: bigint;
  periodDays: number;
}) {
  if (snapshot.hasPendingHistoryGap) return;

  const purchases = snapshot.buys.filter(buy => buy.admissionFrame === admissionFrame);
  const heldPrincipal = snapshot.positions.find(position => position.admissionFrame === admissionFrame)?.purchase
    .principal;
  const recordedPrincipal = purchases.reduce((sum, buy) => sum + (buy.principal ?? 0n), 0n);
  if (!purchases.length || recordedPrincipal !== heldPrincipal) return;

  const fees = snapshot.frameRewards.find(rewards => rewards.admissionFrame === admissionFrame)?.bidFees ?? [];
  if (fees.some(fee => fee.isAmbiguous)) return;

  let investedCost = bidFee + fees.reduce((sum, fee) => sum + fee.amount, 0n);
  for (const buy of purchases) {
    if (
      buy.spentMicrogons === undefined ||
      buy.ethereumFeeMicrogons === undefined ||
      buy.usdcApprovalFeeMicrogons === undefined
    )
      return;
    if (buy.argonFees.some(fee => fee.isAmbiguous)) return;

    investedCost += buy.spentMicrogons + buy.ethereumFeeMicrogons + buy.usdcApprovalFeeMicrogons;
    investedCost += buy.argonFees.reduce((sum, fee) => sum + fee.amount, 0n);
  }

  if (investedCost <= 0n) return;

  return {
    earnings: heldPrincipal + reward - investedCost,
    apy: calculateAnnualPercentageYield({
      startingValue: investedCost,
      endingValue: heldPrincipal + reward,
      periodDays,
    }),
  };
}
