import { StabilizerBuy } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import type { IStabilizerBuyOpportunity } from '../../interfaces/IStabilizerBuyPurchase.ts';

export const buyOpportunity: Extract<IStabilizerBuyOpportunity, { type: 'buy' }> = {
  type: 'buy',
  key: 'synthetic-buy-opportunity',
  apy: 42,
  discountPercent: 8,
  observedAt: new Date('2026-11-01T12:00:00Z'),
  expiresAt: 2_000_000_000_000,
  quote: {
    chainId: 31337,
    gatewayAddress: `0x${'11'.repeat(20)}`,
    adapterAddress: `0x${'22'.repeat(20)}`,
    quoterAddress: `0x${'33'.repeat(20)}`,
    sourceAddress: `0x${'44'.repeat(20)}`,
    poolManager: `0x${'55'.repeat(20)}`,
    poolId: `0x${'66'.repeat(32)}`,
    usdcToken: `0x${'77'.repeat(20)}`,
    poolKey: {
      currency0: `0x${'88'.repeat(20)}`,
      currency1: `0x${'77'.repeat(20)}`,
      fee: 3000,
      tickSpacing: 60,
      hooks: `0x${'99'.repeat(20)}`,
    },
    request: {
      repayLiquidId: 0n,
      repaySignature: '0x' as const,
      argonAccountId: `0x${'aa'.repeat(32)}`,
      maxUsdcIn: 100_000_000n,
      minMicrogonsOut: 109_000_000n,
      deadline: 2_000_000_000n,
    },
    quotedMicrogonsOut: 110_000_000n,
    minimumRewardPrincipal: 1_000_000n,
    qualifiesForRewards: true,
    sqrtPriceX96After: 1n << 96n,
    swapGasEstimate: 100_000n,
  },
};

export const bidOpportunity: Extract<IStabilizerBuyOpportunity, { type: 'bid' }> = {
  type: 'bid',
  key: 'synthetic-bid-opportunity',
  position: new StabilizerBuy(
    12,
    {
      pendingLiquidRepays: 0n,
      liquidRepaymentRewardRate: null,
      principal: 400_000_000n,
      capturedDiscount: 40_000_000n,
      bidRate: BigNumber(1),
      positiveBidCount: 1,
    },
    {
      matchingRate: BigNumber(1),
      totalMatchingBasis: 40_000_000n,
      budget: 12_000_000n,
      remainingBudget: 12_000_000n,
      remainingMatchingBasis: 1_000_000_000n,
      maturesAtFrame: 42,
    },
  ),
  bid: {
    ownerAccount: `0x${'aa'.repeat(32)}`,
    latestBid: 100,
    matchingBasis: 40_000_000n,
    requestedReward: 40_000_000n,
    fundingEstimate: 12_000_000n,
  },
};
