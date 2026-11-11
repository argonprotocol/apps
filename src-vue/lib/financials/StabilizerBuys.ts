import BigNumber from 'bignumber.js';
import { calculateAnnualPercentageYield, type ICapitalFlow } from '@argonprotocol/apps-core';
import type IStabilizerBuyData from '../../../core/src/interfaces/IStabilizerBuyData.ts';
import type { StabilizerBuyPurchases } from '../StabilizerBuyPurchases.ts';
import { createFinancialPosition, type IStabilizerBuyFinancialPosition } from '../../interfaces/IFinancialPosition.ts';
import type { StabilizerBuys } from '../StabilizerBuys.ts';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyFrameRewards,
  type IStabilizerBuyQuote,
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

/** Historical entries model deployed capital, not a wallet's ability to capture every opportunity. */
export function projectHistoricalStabilizerBuys({
  history,
  fees,
  market,
  availableUsdc,
}: {
  history: IStabilizerBuyData;
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
}: {
  quote: IStabilizerBuyQuote;
  feeEstimateWei: bigint;
  periodDays: number;
  matchingRate: BigNumber;
}) {
  const cost = calculateStabilizerBuyCost({ quote, feeEstimateWei });
  if (!cost) return;
  const { spent, investedCost } = cost;

  const discount = BigNumber(quote.quotedMicrogonsOut).minus(spent).decimalPlaces(0, BigNumber.ROUND_FLOOR);
  let maximumReward = 0n;
  if (quote.qualifiesForRewards) {
    maximumReward = BigInt(
      BigNumber.maximum(0, discount).times(matchingRate).integerValue(BigNumber.ROUND_FLOOR).toFixed(0),
    );
  }

  const min = quote.quotedMicrogonsOut - investedCost;
  const max = min + maximumReward;

  return {
    discountPercent: BigNumber(1).minus(spent.div(quote.quotedMicrogonsOut)).times(100).toNumber(),
    earnings: { min, max },
    apy: {
      min: calculateAnnualPercentageYield({
        startingValue: investedCost,
        endingValue: quote.quotedMicrogonsOut,
        periodDays,
      }),
      max: calculateAnnualPercentageYield({
        startingValue: investedCost,
        endingValue: quote.quotedMicrogonsOut + maximumReward,
        periodDays,
      }),
    },
  };
}

export function calculateStabilizerBuyCost({
  quote,
  feeEstimateWei,
}: {
  quote: IStabilizerBuyQuote;
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
