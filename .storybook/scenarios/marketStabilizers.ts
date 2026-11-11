import { reactive } from 'vue';
import { fn, mocked } from 'storybook/test';
import BigNumber from 'bignumber.js';
import { getAddress } from 'viem';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { useMarketStabilizers } from '../../src-vue/stores/marketStabilizers.ts';
import {
  getStabilizerBuys,
  getStabilizerBuyOperations,
  getStabilizerBuyPurchases,
} from '../../src-vue/stores/stabilizerBuys.ts';
import { getConfig } from '../../src-vue/stores/config.ts';
import type { StabilizerBuys } from '../../src-vue/lib/StabilizerBuys.ts';
import { StabilizerBuyPurchases } from '../../src-vue/lib/StabilizerBuyPurchases.ts';
import type { ICrosschainTransferProgress } from '../../src-vue/lib/CrosschainTransferProgress.ts';
import { WalletForEthereum } from '../../src-vue/lib/WalletForEthereum.ts';
import type { IStabilizerBuyQuote, IStabilizerBuyRecord } from '../../src-vue/interfaces/IStabilizerBuyPurchase.ts';
import { buyOpportunity } from '../../src-vue/__test__/helpers/stabilizerBuy.ts';
import { setupAppScenario } from './setupAppScenario.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { calculatePositionReturn } from '../../src-vue/lib/financials/index.ts';

export function setupMarketStabilizers() {
  setupAppScenario({ selectedTab: TopTab.MarketStabilizers });
  const wallet = new WalletForEthereum(`0x${'44'.repeat(20)}`);
  wallet.data.otherTokens = [
    {
      symbol: 'ETH',
      decimals: 18,
      address: null,
      chain: 'ethereum',
      unitOfMeasurement: UnitOfMeasurement.ETH,
      value: 10_000_000_000_000_000n,
    },
    {
      symbol: 'USDC',
      decimals: 6,
      address: null,
      chain: 'ethereum',
      unitOfMeasurement: UnitOfMeasurement.USDC,
      value: 1_000_000_000n,
    },
  ];
  wallet.data.balanceIsCached = false;
  wallet.data.balanceUpdatedAt = new Date('2026-11-01T12:00:00Z');
  const transactionProgressByHash = reactive({} as StabilizerBuyPurchases['data']['transactionProgressByHash']);
  const market = reactive({
    data: {
      buys: [],
      frameRewards: [],
      positions: [],
      auctionsByFrame: {},
      payableReward: 0n,
      nextPayoutFrame: null,
      currentFrameId: 49,
      currentTick: 10,
      blockNumber: 1234,
      isLoaded: true,
      isAvailable: true,
      financialRevision: 0,
      isRestoringHistory: false,
      error: undefined,
      historyError: undefined,
      market: {
        approvedPool: {
          chainId: 1n,
          poolId: buyOpportunity.quote.poolId,
          poolManager: buyOpportunity.quote.poolManager,
          usdcToken: buyOpportunity.quote.usdcToken,
          argonIsToken0: false,
        },
        prices: null,
        matchingRate: BigNumber(1),
        auctionInclusionPercent: BigNumber(0.9),
        frameId: 49,
        frameRewardTicksRemaining: 100,
        maxPriceAgeTicks: 10,
        maxPositiveBids: 4,
        purchaseHoldFrames: 30,
      },
    },
    history: {
      throughDate: '2026-10-31',
      ethereumBlockNumber: 100,
      argonTokenAddress: buyOpportunity.quote.poolKey.currency1,
      usdcTokenAddress: buyOpportunity.quote.usdcToken,
      pools: [],
      rewardFunding: { frameRange: [1, 10], argonBlockRange: [10, 100], frameCount: 10, averageArgonsPerFrame: '10' },
      days: [{ date: '2026-10-31', buyCount: 2, argonBought: '206', usdcSpent: '200', costInTargetArgons: '200' }],
    },
    config: getConfig(),
    summary: {
      state: 'ready',
      currentValue: 0n,
      positions: [],
      returnSummary: calculatePositionReturn([]),
    },
    returns: { byFrame: {}, byPurchase: {} },
    dates: { admission: {}, opens: {}, closes: {}, releases: {} },
    wallets: [wallet],
    hasAccess: true,
    canActivate: true,
    availableUsdc: 1_000_000_000n,
    get purchaseProgressById(): Record<string, ICrosschainTransferProgress> {
      return Object.fromEntries(
        market.data.buys.map(buy => [
          buy.id,
          StabilizerBuyPurchases.getProgress(
            buy as IStabilizerBuyRecord,
            transactionProgressByHash,
            market.data.ethereumGatewaySync,
          ),
        ]),
      );
    },
    get progressByPurchaseId(): Record<string, number> {
      return Object.fromEntries(
        Object.entries(market.purchaseProgressById).map(([id, progress]) => [id, progress.overallProgressPct]),
      );
    },
    biddingFrame: undefined,
    opportunity: undefined,
    buyDiscountPercent: undefined,
    alertError: undefined,
  } as unknown as ReturnType<typeof useMarketStabilizers>);
  mocked(useMarketStabilizers).mockReturnValue(market as ReturnType<typeof useMarketStabilizers>);
  mocked(getStabilizerBuys, { partial: true }).mockReturnValue({
    data: market.data as StabilizerBuys['data'],
    accountAddress: `0x${'33'.repeat(32)}`,
    get snapshot() {
      return {
        ...market.data,
        accountAddress: `0x${'33'.repeat(32)}`,
        hasPendingHistoryGap: false,
      } as StabilizerBuys['snapshot'];
    },
  });
  mocked(getStabilizerBuyOperations, { partial: true }).mockReturnValue({
    stabilizerBuyBid: {
      prepare: fn(async () => ({ txFeePlusTip: 10_000n, canAfford: true })),
      getPendingForFrame: fn(() => undefined),
    } as unknown as ReturnType<typeof getStabilizerBuyOperations>['stabilizerBuyBid'],
  });
  const quotePurchase = fn(async (request: Parameters<StabilizerBuyPurchases['quote']>[0]) => {
    const maxUsdcIn = request.maxUsdcIn ?? 1_000_000n;
    const principal = (10_300_000_000n * maxUsdcIn) / (10_000_000_000n + maxUsdcIn);
    return {
      ...buyOpportunity.quote,
      quoterAddress: request.quoterAddress,
      sourceAddress: getAddress(request.sourceAddress),
      request: {
        ...buyOpportunity.quote.request,
        maxUsdcIn,
        minMicrogonsOut: (principal * 98n) / 100n,
        deadline: request.deadline,
      },
      quotedMicrogonsOut: principal,
      prices: {
        tick: 10,
        usdcUsdPrice: BigNumber(1),
        argonUsdTargetPrice: BigNumber(1),
        ethereumUsdPrice: BigNumber(200),
      },
    } satisfies IStabilizerBuyQuote;
  });
  mocked(getStabilizerBuyPurchases, { partial: true }).mockReturnValue({
    data: { transactionProgressByHash },
    quote: quotePurchase,
    quoteMaxProfit: fn(async request => {
      const minimumQuote = await quotePurchase({ ...request, maxUsdcIn: 1_000_000n });
      let amount = request.maxUsdcIn;
      if (amount < 1_000_000n) amount = 1_000_000n;
      if (amount > 148_891_565n) amount = 148_891_565n;
      return {
        minimumQuote,
        quote: await quotePurchase({ ...request, maxUsdcIn: amount }),
        preview: { feeEstimateWei: 200_000_000_000_000n, needsApproval: true },
      };
    }),
    estimateHistoricalFees: fn(async () => ({
      ethereumFeeWei: 200_000_000_000_000n,
      bidFee: 10_000n,
      prices: {
        tick: 10,
        usdcUsdPrice: BigNumber(1),
        argonUsdTargetPrice: BigNumber(1),
        ethereumUsdPrice: BigNumber(200),
      },
    })),
    previewPurchase: fn(async () => ({ feeEstimateWei: 200_000_000_000_000n, needsApproval: true })),
  } as unknown as NonNullable<ReturnType<typeof getStabilizerBuyPurchases>>);
  return market;
}
