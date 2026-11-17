import { expect, it } from 'vitest';
import { BitcoinFission, NetworkConfig, StabilizerBuy } from '@argonprotocol/apps-core';
import { PriceIndex } from '@argonprotocol/mainchain';
import { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';
import BigNumber from 'bignumber.js';
import {
  projectHistoricalStabilizerBuys,
  projectStabilizerBuyBid,
  projectStabilizerBuyQuote,
  projectStabilizerBuyLiquidPaydown,
  projectStabilizerBuyPendingPaydowns,
  getStabilizerBuyReturnedSatoshis,
} from '../lib/financials/StabilizerBuys.ts';
import { buyOpportunity } from './helpers/stabilizerBuy.ts';
import { StabilizerBuyStatus, type IStabilizerBuyRecord } from '../interfaces/IStabilizerBuyPurchase.ts';

it.each([
  { price: 0.5, budget: 135_060_000_000n, returned: 35_060_000_000n },
  { price: 0.95, budget: 95_250_000_000n, returned: 250_000_000n },
])('estimates returned principal separately from bonuses at price $price', ({ price, budget, returned }) => {
  const priceIndex = new PriceIndex();
  priceIndex.btcUsdPrice = BigNumber(100_000);
  priceIndex.argonUsdTargetPrice = BigNumber(1);
  priceIndex.argonUsdPrice = BigNumber(price);
  const liquid = BitcoinLiquid.create({
    liquidId: 10,
    fissions: [
      new BitcoinFission({
        ownerAccount: 'synthetic-owner',
        fissionId: 1,
        liquidId: 10,
        lockId: 1,
        satoshis: 100_000_000n,
        microgonsAtTargetPerBtc: 100_000_000_000n,
        liquidityPromised: 100_000_000_000n,
        createdAtArgonBlock: 100,
        ratchetNumber: 0,
        lastUpdatedArgonBlock: 100,
      }),
    ],
  });

  expect(projectStabilizerBuyLiquidPaydown({ microgons: budget, priceIndex })?.returnedAtTarget).toBe(returned);
  expect(
    projectStabilizerBuyLiquidPaydown({
      microgons: budget,
      priceIndex,
      liquid,
      lockExpirations: new Map([[1, 1_000]]),
    }),
  ).toMatchObject({ returnedAtTarget: returned, appliedMicrogons: budget, paydownPercent: 100 });
});

it('returns whole-satoshi leftovers and caps payment to the selected Liquid in lock-expiry order', () => {
  const priceIndex = new PriceIndex();
  priceIndex.btcUsdPrice = BigNumber(10_000);
  priceIndex.argonUsdTargetPrice = BigNumber(1);
  priceIndex.argonUsdPrice = BigNumber(1);
  const liquid = BitcoinLiquid.create({
    liquidId: 10,
    fissions: [5_000_000_000n, 10_000_000_000n].map(
      (price, index) =>
        new BitcoinFission({
          ownerAccount: 'synthetic-owner',
          fissionId: index + 1,
          liquidId: 10,
          lockId: index + 1,
          satoshis: 100n,
          microgonsAtTargetPerBtc: price,
          liquidityPromised: 10_000n,
          createdAtArgonBlock: 100 + index,
          ratchetNumber: 0,
          lastUpdatedArgonBlock: 101,
        }),
    ),
  });
  const lockExpirations = new Map([
    [1, 2_000],
    [2, 1_000],
  ]);

  // The earlier-expiring Lock costs 100 microgons per satoshi. Twelve fit; the remainder is returned.
  expect(projectStabilizerBuyLiquidPaydown({ microgons: 1_250n, priceIndex, liquid, lockExpirations })).toMatchObject({
    returnedAtTarget: 50n,
    appliedMicrogons: 1_200n,
    paydownPercent: 6,
  });
  expect(projectStabilizerBuyLiquidPaydown({ microgons: 20_000n, priceIndex, liquid, lockExpirations })).toMatchObject({
    returnedAtTarget: 5_000n,
    appliedMicrogons: 15_000n,
    paydownPercent: 100,
  });
  expect(projectStabilizerBuyLiquidPaydown({ microgons: 1_250n, priceIndex, liquid })).toBeUndefined();

  priceIndex.argonUsdPrice = BigNumber(0.5);
  expect(projectStabilizerBuyLiquidPaydown({ microgons: 3_376n, priceIndex, liquid, lockExpirations })).toMatchObject({
    returnedAtTarget: 876n,
    appliedMicrogons: 3_376n,
    paydownPercent: 12.5,
  });
});

it.each([
  { bestR: '0.95', burned: 950_000_000n, returned: 50_000_000n },
  { bestR: '0.949999999999999879', burned: 949_999_999n, returned: 50_000_001n },
])('refunds the cheapest quote for the same ten percent of Liquid at R=$bestR', ({ bestR, burned, returned }) => {
  const priceIndex = new PriceIndex();
  const liquid = BitcoinLiquid.create({
    liquidId: 10,
    fissions: [
      new BitcoinFission({
        ownerAccount: 'synthetic-owner',
        fissionId: 1,
        liquidId: 10,
        lockId: 1,
        satoshis: 100_000_000n,
        microgonsAtTargetPerBtc: 10_000_000_000n,
        liquidityPromised: 10_000_000_000n,
        createdAtArgonBlock: 100,
        ratchetNumber: 0,
        lastUpdatedArgonBlock: 100,
      }),
    ],
  });
  const repayment: StabilizerBuy['liquidRepayments'][number] = {
    liquidId: 10,
    admissionFrame: 12,
    gatewayActivityNonce: 1n,
    microgons: 1_000_000_000n,
    eligibleRewardPercent: BigNumber(0),
    purchaseTick: 100,
    microgonsAtTargetPerBtc: BigNumber(10_000_000_000),
    purchaseRValue: BigNumber(0.9),
    priceWindow: { nextFrame: null, nextTick: 100n, rValueHighWater: BigNumber(bestR) },
    observedRValueHighWater: BigNumber(bestR),
  };
  // The purchase covers 10% at R=0.90. At R=0.95 that same portion costs 950,
  // so return 50 without spending it on additional Liquid.
  expect(
    projectStabilizerBuyLiquidPaydown({
      microgons: repayment.microgons,
      priceIndex,
      repayment,
      liquid,
      lockExpirations: new Map([[1, 1_000]]),
    }),
  ).toMatchObject({
    appliedMicrogons: 1_000_000_000n,
    burnedMicrogons: burned,
    returnedMicrogons: returned,
    paydownPercent: 10,
    repaidSatoshisByFission: new Map([[1, 10_000_000n]]),
    liabilityBefore: 10_000_000_000n,
    liabilityAfter: 9_000_000_000n,
    liquidityRepaid: 1_000_000_000n,
  });
});

it('keeps pending Bitcoin fixed as recovery improves and shares its capacity with later purchases', () => {
  const priceIndex = new PriceIndex();
  priceIndex.btcUsdPrice = BigNumber(200_000);
  priceIndex.argonUsdTargetPrice = BigNumber(1);
  priceIndex.argonUsdPrice = BigNumber(0.2);
  const fission = new BitcoinFission({
    ownerAccount: 'synthetic-owner',
    fissionId: 1,
    liquidId: 10,
    lockId: 1,
    satoshis: 100_000_000n,
    microgonsAtTargetPerBtc: 100_000_000_000n,
    liquidityPromised: 100_000_000_000n,
    createdAtArgonBlock: 100,
    ratchetNumber: 0,
    lastUpdatedArgonBlock: 100,
  });
  const liquid = BitcoinLiquid.create({ liquidId: 10, fissions: [fission] });
  const repayment: StabilizerBuy['liquidRepayments'][number] = {
    liquidId: 10,
    admissionFrame: 12,
    gatewayActivityNonce: 1n,
    microgons: 135_060_000_000n,
    eligibleRewardPercent: BigNumber(0.05),
    purchaseTick: 100,
    microgonsAtTargetPerBtc: BigNumber(100_000_000_000),
    purchaseRValue: BigNumber(0.5),
    priceWindow: { nextFrame: 12n, nextTick: 100n, rValueHighWater: BigNumber(0) },
    observedRValueHighWater: BigNumber(0.5),
  };
  const lockExpirations = new Map([[1, 1_000]]);
  const before = projectStabilizerBuyLiquidPaydown({
    microgons: repayment.microgons,
    repayment,
    priceIndex,
    liquid,
    lockExpirations,
  })!;
  expect(before).toMatchObject({ burnedMicrogons: 135_060_000_000n, returnedMicrogons: 0n, paydownPercent: 100 });
  const recovered = { ...repayment, observedRValueHighWater: BigNumber(1) };
  const after = projectStabilizerBuyLiquidPaydown({
    microgons: repayment.microgons,
    repayment: recovered,
    priceIndex,
    liquid,
    lockExpirations,
  })!;
  expect(after).toMatchObject({
    burnedMicrogons: 100_000_000_000n,
    returnedMicrogons: 35_060_000_000n,
    paydownPercent: 100,
  });
  expect(after.repaidSatoshisByFission).toEqual(before.repaidSatoshisByFission);

  const position = new StabilizerBuy(
    12,
    {
      principal: 0n,
      capturedDiscount: 0n,
      bidRate: BigNumber(1),
      positiveBidCount: 1,
      pendingLiquidRepays: 2n,
      liquidRepaymentRewardRate: null,
    },
    {
      matchingRate: BigNumber(1),
      totalMatchingBasis: 0n,
      budget: 0n,
      remainingBudget: 0n,
      remainingMatchingBasis: 0n,
      maturesAtFrame: 42,
    },
    [{ ...recovered, gatewayActivityNonce: 2n }, recovered],
  );
  const queue = projectStabilizerBuyPendingPaydowns({
    positions: [position],
    liquids: [liquid],
    lockExpirations,
    priceIndex,
  });
  expect(queue.byNonce.get(1n)?.paydownPercent).toBe(100);
  expect(queue.byNonce.get(1n)).toMatchObject({
    liabilityBefore: 100_000_000_000n,
    liabilityAfter: 0n,
    liquidityRepaid: 100_000_000_000n,
  });
  expect(queue.byNonce.get(2n)).toMatchObject({
    burnedMicrogons: 0n,
    returnedMicrogons: repayment.microgons,
    paydownPercent: 0,
    liabilityBefore: 0n,
    liabilityAfter: 0n,
    liquidityRepaid: 0n,
  });
  const extra = projectStabilizerBuyLiquidPaydown({
    microgons: 1_000_000n,
    priceIndex,
    liquid,
    lockExpirations,
    availableSatoshisByFission: queue.availableSatoshisByFission,
  })!;
  expect(extra).toMatchObject({
    appliedMicrogons: 0n,
    burnedMicrogons: 0n,
    returnedMicrogons: 1_000_000n,
    paydownPercent: 0,
  });
  expect(fission.satoshis).toBe(100_000_000n);

  delete repayment.observedRValueHighWater;
  const unknown = new StabilizerBuy(12, position.purchase, position.auction, [repayment]);
  expect(
    projectStabilizerBuyPendingPaydowns({
      positions: [unknown],
      liquids: [liquid],
      lockExpirations,
      priceIndex,
    }).unavailableLiquidIds.has(10),
  ).toBe(true);

  const buy: IStabilizerBuyRecord = {
    id: 'synthetic-repayment',
    ownerAccount: 'synthetic-owner',
    status: StabilizerBuyStatus.Complete,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    argonFees: [],
    liquidRepaymentEvent: {
      gatewayActivityNonce: 1n,
      liquidId: 10,
      microgonsBurned: 100_000_000_000n,
      blockNumber: 200,
      blockHash: 'synthetic-block',
      blockTime: 2000,
      eventIndex: 3,
    },
  };
  expect(getStabilizerBuyReturnedSatoshis(buy, liquid)).toBeUndefined();
  fission.repayments.push({
    blockNumber: 200,
    blockHash: 'synthetic-block',
    blockTime: new Date(2000),
    tick: 200,
    eventIndex: 1,
    satoshis: 100_000_000n,
    liquidityRepaid: 100_000_000_000n,
    redemptionAmount: 100_000_000_000n,
  });
  fission.repayments.push({ ...fission.repayments[0], eventIndex: 4, satoshis: 1n, redemptionAmount: 1n });
  expect(getStabilizerBuyReturnedSatoshis(buy, liquid)).toBe(100_000_000n);
});

it('carries indivisible liquidity through successive pending paydowns', () => {
  const liquid = BitcoinLiquid.create({
    liquidId: 10,
    fissions: [
      new BitcoinFission({
        ownerAccount: 'synthetic-owner',
        fissionId: 1,
        liquidId: 10,
        lockId: 1,
        satoshis: 3n,
        liquidityPromised: 4n,
        microgonsAtTargetPerBtc: 100_000_000n,
        createdAtArgonBlock: 100,
        ratchetNumber: 0,
        lastUpdatedArgonBlock: 100,
      }),
    ],
  });
  const position = new StabilizerBuy(
    12,
    {
      principal: 0n,
      capturedDiscount: 0n,
      bidRate: BigNumber(0),
      positiveBidCount: 0,
      pendingLiquidRepays: 3n,
      liquidRepaymentRewardRate: null,
    },
    {
      matchingRate: BigNumber(1),
      totalMatchingBasis: 0n,
      budget: 0n,
      remainingBudget: 0n,
      remainingMatchingBasis: 0n,
      maturesAtFrame: 42,
    },
    [1n, 2n, 3n].map(gatewayActivityNonce => ({
      liquidId: 10,
      admissionFrame: 12,
      gatewayActivityNonce,
      microgons: 1n,
      eligibleRewardPercent: BigNumber(0),
      purchaseTick: 100,
      microgonsAtTargetPerBtc: BigNumber(100_000_000),
      purchaseRValue: BigNumber(1),
      observedRValueHighWater: BigNumber(1),
      priceWindow: { nextFrame: null, nextTick: 100n, rValueHighWater: BigNumber(1) },
    })),
  );
  const queue = projectStabilizerBuyPendingPaydowns({
    positions: [position],
    liquids: [liquid],
    lockExpirations: new Map([[1, 1_000]]),
    priceIndex: new PriceIndex(),
  });
  // Four units back three satoshis: the first two take one each; the final one takes the two left over.
  expect(queue.byNonce.get(1n)).toMatchObject({ liabilityBefore: 4n, liquidityRepaid: 1n, liabilityAfter: 3n });
  expect(queue.byNonce.get(2n)).toMatchObject({ liabilityBefore: 3n, liquidityRepaid: 1n, liabilityAfter: 2n });
  expect(queue.byNonce.get(3n)).toMatchObject({ liabilityBefore: 2n, liquidityRepaid: 2n, liabilityAfter: 0n });
  expect(liquid.liquidityPromised).toBe(4n);
});

it('counts fully closed paydown Bitcoin without including later signed closes or Lock-driven closures', () => {
  const fissions = [
    { satoshis: 55n, redemptionAmount: 52n, closeReason: 'closed' as const },
    { satoshis: 10n, redemptionAmount: 9n, closeReason: 'closed' as const, closedExtrinsicIndex: 2 },
    { satoshis: 20n, redemptionAmount: 18n, closeReason: 'lock-spent' as const },
  ].map(
    (closure, index) =>
      new BitcoinFission({
        ownerAccount: 'synthetic-owner',
        fissionId: index + 1,
        liquidId: 10,
        lockId: 1,
        microgonsAtTargetPerBtc: 100_000_000n,
        liquidityPromised: closure.satoshis,
        ratchetNumber: 0,
        closedAtArgonBlock: 200,
        closedBlockHash: 'synthetic-block',
        ...closure,
      }),
  );
  const survivor = new BitcoinFission({
    ownerAccount: 'synthetic-owner',
    fissionId: 4,
    liquidId: 10,
    lockId: 1,
    satoshis: 45n,
    initialSatoshis: 50n,
    microgonsAtTargetPerBtc: 100_000_000n,
    liquidityPromised: 45n,
    ratchetNumber: 0,
  });
  survivor.repayments.push({
    blockNumber: 200,
    blockHash: 'synthetic-block',
    blockTime: new Date(2000),
    tick: 200,
    eventIndex: 1,
    satoshis: 5n,
    liquidityRepaid: 5n,
    redemptionAmount: 4n,
  });
  const buy: IStabilizerBuyRecord = {
    id: 'synthetic-full-fission-paydown',
    ownerAccount: 'synthetic-owner',
    status: StabilizerBuyStatus.Complete,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    argonFees: [],
    liquidRepaymentEvent: {
      gatewayActivityNonce: 1n,
      liquidId: 10,
      microgonsBurned: 56n,
      blockNumber: 200,
      blockHash: 'synthetic-block',
      blockTime: 2000,
      eventIndex: 3,
    },
  };
  const liquid = BitcoinLiquid.create({ liquidId: 10, fissions: [...fissions, survivor] });
  expect(getStabilizerBuyReturnedSatoshis(buy, liquid)).toBe(60n);
  fissions[0].redemptionAmount = undefined;
  expect(getStabilizerBuyReturnedSatoshis(buy, liquid)).toBeUndefined();
});

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

  const belowMinimum = projectStabilizerBuyQuote({
    ...input,
    liquidRepaymentMicrogons: 1_000_019n,
    liquidRepaymentRewardPercent: BigNumber(0.05),
  })!;
  expect(belowMinimum.earnings).toEqual({ min: 99_999n, max: 99_999n });
  expect(belowMinimum.liquidRepaymentBonus).toBe(0n);
  expect(belowMinimum.apy.min).toBeGreaterThan(0);
  expect(belowMinimum.apy.max).toBe(belowMinimum.apy.min);

  const atMinimum = projectStabilizerBuyQuote({
    ...input,
    quote: { ...quote, quotedMicrogonsOut: 1_000_000n, qualifiesForRewards: true },
  })!;
  expect(atMinimum.earnings).toEqual({ min: 100_000n, max: 200_000n });

  const withLiquid = projectStabilizerBuyQuote({
    ...input,
    quote: { ...quote, quotedMicrogonsOut: 1_000_000n, qualifiesForRewards: true },
    liquidRepaymentMicrogons: 1_000_019n,
    liquidRepaymentRewardPercent: BigNumber(0.05),
  })!;
  expect(withLiquid.liquidRepaymentBonus).toBe(50_000n);
  expect(withLiquid.earnings.min).toBe(atMinimum.earnings.min);
  expect(withLiquid.earnings.max).toBe(atMinimum.earnings.max + 50_000n);
  expect(withLiquid.apy.max).toBeCloseTo((Math.pow(1_150_000 / 900_000, 365 / 30) - 1) * 100);
  expect(withLiquid.liquidRepaymentBonusApy).toBeCloseTo(withLiquid.apy.max - atMinimum.apy.max);
  expect(atMinimum.liquidRepaymentBonusApy).toBe(0);
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
