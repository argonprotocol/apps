import { expect, it } from 'vitest';
import { NetworkConfig, StabilizerBuy } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import {
  projectHistoricalStabilizerBuys,
  projectStabilizerBuyBid,
  projectStabilizerBuyQuote,
} from '../lib/financials/StabilizerBuys.ts';
import { buyOpportunity } from './helpers/stabilizerBuy.ts';
import { StabilizerBuyStatus, type IStabilizerBuyRecord } from '../interfaces/IStabilizerBuyPurchase.ts';

it('excludes matching rewards below the chain minimum while preserving the purchase discount', () => {
  const quote = {
    ...buyOpportunity.quote,
    request: { ...buyOpportunity.quote.request, maxUsdcIn: 900_000n },
    quotedMicrogonsOut: 999_999n,
    minimumRewardPrincipal: 1_000_000n,
    qualifiesForRewards: false,
    prices: {
      tick: 10,
      usdcUsdPrice: BigNumber(1),
      argonUsdTargetPrice: BigNumber(1),
      ethereumUsdPrice: BigNumber(2000),
    },
  };
  const input = { quote, feeEstimateWei: 0n, periodDays: 30, matchingRate: BigNumber(1) };

  const belowMinimum = projectStabilizerBuyQuote(input)!;
  expect(belowMinimum.earnings).toEqual({ min: 99_999n, max: 99_999n });
  expect(belowMinimum.apy.min).toBeGreaterThan(0);
  expect(belowMinimum.apy.max).toBe(belowMinimum.apy.min);

  const atMinimum = projectStabilizerBuyQuote({
    ...input,
    quote: { ...quote, quotedMicrogonsOut: 1_000_000n, qualifiesForRewards: true },
  })!;
  expect(atMinimum.earnings).toEqual({ min: 100_000n, max: 200_000n });
});

it('includes actual purchase fees and the proposed bid fee, withholding estimates for missing purchase history', () => {
  const buy: IStabilizerBuyRecord = {
    id: 'synthetic-buy',
    ownerAccount: `0x${'11'.repeat(32)}`,
    admissionFrame: 12,
    status: StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    principal: 55_000_000n,
    spentMicrogons: 50_000_000n,
    ethereumFeeMicrogons: 21_000n,
    usdcApprovalFeeMicrogons: 1_000n,
    argonFees: [],
  };
  const position = new StabilizerBuy(
    12,
    {
      pendingLiquidRepays: 0n,
      liquidRepaymentRewardRate: null,
      principal: 55_000_000n,
      capturedDiscount: 5_000_000n,
      bidRate: BigNumber(0.5),
      positiveBidCount: 1,
    },
    {
      matchingRate: BigNumber(1),
      totalMatchingBasis: 5_000_000n,
      budget: 5_000_000n,
      remainingBudget: 5_000_000n,
      remainingMatchingBasis: 1_000_000_000n,
      maturesAtFrame: 42,
    },
  );
  const input: Parameters<typeof projectStabilizerBuyBid>[0] = {
    snapshot: { buys: [buy], frameRewards: [], positions: [position], hasPendingHistoryGap: false },
    admissionFrame: 12,
    reward: 2_000_000n,
    bidFee: 5_000n,
    periodDays: 30,
  };
  expect(projectStabilizerBuyBid(input)?.earnings).toBe(6_973_000n);

  delete buy.usdcApprovalFeeMicrogons;
  expect(projectStabilizerBuyBid(input)).toBeUndefined();
  buy.usdcApprovalFeeMicrogons = 1_000n;
  buy.principal = 54_000_000n;
  expect(projectStabilizerBuyBid(input)).toBeUndefined();
  buy.principal = 55_000_000n;
  expect(
    projectStabilizerBuyBid({ ...input, snapshot: { ...input.snapshot, hasPendingHistoryGap: true } }),
  ).toBeUndefined();
});

it.each(['mainnet', 'localnet'] as const)(
  'models deployed capital and capped funding carried over empty days (%s)',
  network => {
    NetworkConfig.setNetwork(network);
    const input: Parameters<typeof projectHistoricalStabilizerBuys>[0] = {
      history: {
        throughDate: '2026-01-03',
        ethereumBlockNumber: 100,
        argonTokenAddress: 'synthetic-argon',
        usdcTokenAddress: 'synthetic-usdc',
        pools: [],
        rewardFunding: { frameRange: [1, 2], argonBlockRange: [10, 20], frameCount: 2, averageArgonsPerFrame: '5' },
        days: [
          { date: '2026-01-01', buyCount: 2, argonBought: '120', usdcSpent: '100', costInTargetArgons: '100' },
          { date: '2026-01-02', buyCount: 0, argonBought: '0', usdcSpent: '0', costInTargetArgons: '0' },
          { date: '2026-01-03', buyCount: 1, argonBought: '110', usdcSpent: '100', costInTargetArgons: '100' },
        ],
      },
      fees: {
        ethereumFeeWei: 1_000_000_000_000_000_000n,
        bidFee: 1_000_000n,
        prices: {
          tick: 10,
          usdcUsdPrice: BigNumber(0.8),
          argonUsdTargetPrice: BigNumber(1),
          ethereumUsdPrice: BigNumber(2),
        },
      },
      market: {
        matchingRate: BigNumber(1),
        auctionInclusionPercent: BigNumber(0.5),
        purchaseHoldFrames: 30,
      },
      availableUsdc: 100_000_000n,
    };
    const result = projectHistoricalStabilizerBuys(input)!;
    // 200 spent + 3 purchases * (2 ETH-cost ARGN + 1 bid-fee ARGN) = 209 deployed.
    // Reserve/budget: 5/5 on day1; 5 carried on day2; 10/5 on day3. Total reward10.
    const minApy = (Math.pow(230 / 209, 365 / 31) - 1) * 100;
    const maxApy = (Math.pow(240 / 209, 365 / 31) - 1) * 100;
    expect(result.apy.min).toBeCloseTo(minApy, 8);
    expect(result.apy.max).toBeCloseTo(maxApy, 8);
    // 100USDC at $0.80 is 80 target ARGN; do not assume USDC=$1.
    expect(result.earnings.min).toBe(BigInt(Math.floor((80_000_000 * minApy) / 100)));
    expect(result.earnings.max).toBe(BigInt(Math.floor((80_000_000 * maxApy) / 100)));

    const constrained = projectHistoricalStabilizerBuys({
      ...input,
      market: { ...input.market, matchingRate: BigNumber(0.1) },
    })!;
    // Matching basis is2+1; the50% inclusion cap yields1.5 total.
    expect(constrained.apy.max).toBeCloseTo((Math.pow(231.5 / 209, 365 / 31) - 1) * 100, 8);

    const expensive = projectHistoricalStabilizerBuys({ ...input, fees: { ...input.fees, bidFee: 100_000_000n } })!;
    expect(expensive.apy.max).toBeLessThan(0);
    expect(expensive.earnings.max).toBeLessThan(0n);
    expect(
      projectHistoricalStabilizerBuys({ ...input, history: { ...input.history, rewardFunding: undefined } }),
    ).toBeUndefined();
  },
);
