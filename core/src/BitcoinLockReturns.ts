import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import type { IBitcoinPriceRecord } from './interfaces/index.js';
import { calculateAggregateReturn } from './FinancialReturns.js';

dayjs.extend(utc);

const SCENARIO_UNIT_SCALE = 1_000_000;

export function calculateBitcoinRatchetReturn({
  prices,
  flatFee,
  percentageFee,
  ratchetThreshold,
  couponFeesPaid = 0,
}: {
  prices: readonly IBitcoinPriceRecord[];
  flatFee: number;
  /** Percentage points charged by the vault. For example, 5 means 5%. */
  percentageFee: number;
  /** Ratio required to ratchet. For example, 0.1 means 10%. */
  ratchetThreshold: number;
  /** Vault-funded reimbursement in the same value unit as the prices. */
  couponFeesPaid?: number;
}) {
  if (!prices.length) {
    return {
      ...calculateAggregateReturn([]),
      finalLockPrice: 0,
      grossFees: 0n,
      couponFeesPaid: 0n,
      netFees: 0n,
      ratchetCount: 0,
    };
  }

  const startingPrice = prices[0].price;
  const startingDate = dayjs.utc(prices[0].date);
  const fullTermDays = Math.max(1, dayjs.utc(prices.at(-1)!.date).diff(startingDate, 'day'));
  let lockPrice = startingPrice;
  let argonsReceived = startingPrice;
  let grossFees = flatFee + startingPrice * (percentageFee / 100);
  let ratchetCount = 0;

  for (const priceRow of prices.slice(1)) {
    const priceDifference = priceRow.price - lockPrice;
    if (Math.abs(priceDifference / lockPrice) < ratchetThreshold) continue;

    grossFees += flatFee;
    if (priceDifference > 0) {
      const elapsedDays = dayjs.utc(priceRow.date).diff(startingDate, 'day');
      const remainingDays = Math.max(0, fullTermDays - elapsedDays);
      const amountToMint = BigInt(Math.floor(priceDifference * SCENARIO_UNIT_SCALE));
      const percentageFeeAmount = BigInt(Math.ceil(Number(amountToMint) * (percentageFee / 100)));

      // Mirrors BitcoinLock.calculateRatchetingCosts; scenario days stand in for Bitcoin blocks.
      const proratedFee = (percentageFeeAmount * BigInt(remainingDays)) / BigInt(fullTermDays);
      grossFees += Number(proratedFee) / SCENARIO_UNIT_SCALE;
      argonsReceived += priceDifference;
    }

    lockPrice = priceRow.price;
    ratchetCount += 1;
  }

  const grossFeesScaled = scaleScenarioValue(grossFees);
  const couponFeesPaidScaled = scaleScenarioValue(couponFeesPaid);
  const netFees = grossFeesScaled > couponFeesPaidScaled ? grossFeesScaled - couponFeesPaidScaled : 0n;
  const aggregateReturn = calculateAggregateReturn([
    {
      startingCapital: scaleScenarioValue(startingPrice) + netFees,
      endingCapital: scaleScenarioValue(argonsReceived),
    },
  ]);

  return {
    ...aggregateReturn,
    finalLockPrice: lockPrice,
    grossFees: grossFeesScaled,
    couponFeesPaid: couponFeesPaidScaled,
    netFees,
    ratchetCount,
  };
}

function scaleScenarioValue(value: number): bigint {
  return BigInt(Math.round(value * SCENARIO_UNIT_SCALE));
}
