import type { Meta, StoryObj } from '@storybook/vue3-vite';
import AppScreen from '../../components/AppScreen.vue';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyRecord,
  type IStabilizerBuyPurchaseRecord,
} from '../../../src-vue/interfaces/IStabilizerBuyPurchase.ts';
import { buyOpportunity } from '../../../src-vue/__test__/helpers/stabilizerBuy.ts';
import Dashboard from '../../../src-vue/screens/market-stabilizers-screen/Dashboard.vue';

import { setupMarketStabilizers } from '../../scenarios/marketStabilizers.ts';
import { useMarketStabilizers } from '../../../src-vue/stores/marketStabilizers.ts';
import { useStabilizerBuyNavigation } from '../../../src-vue/stores/stabilizerBuys.ts';

const meta = {
  title: 'Market Stabilizers/Overview',
  component: Dashboard,
  beforeEach: () => {
    setupMarketStabilizers();
  },
  render: () => ({
    components: { AppScreen, Dashboard },
    setup: () => ({ market: useMarketStabilizers() }),
    template: `<AppScreen :hasStabilizerOpportunity="!!market.opportunity && market.config.stabilizerBuyAlert !== undefined && market.opportunity.apy >= market.config.stabilizerBuyAlert.minimumApy"><Dashboard /></AppScreen>`,
  }),
} satisfies Meta<typeof Dashboard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FirstVisit: Story = {
  beforeEach: () => {
    Object.assign(useMarketStabilizers(), { hasAccess: false });
  },
};
const noPurchasesSummary: Pick<ReturnType<typeof useMarketStabilizers>['summary'], 'currentValue' | 'returnSummary'> = {
  currentValue: 0n,
  returnSummary: {
    availability: 'available',
    investedCost: 0n,
    paidIncome: 0n,
    settledPrincipalValue: 0n,
    returnAmount: 0n,
    percent: 0,
    apr: 0,
    apy: 0,
    eligiblePositionCount: 0,
    investmentPositionCount: 0,
  },
};
export const Watching: Story = {
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.config.stabilizerBuyAlert = { minimumApy: 12 };
    Object.assign(market, { buyDiscountPercent: 10.4 });
  },
};
export const ExpiredOpportunity: Story = {
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.config.stabilizerBuyAlert = { minimumApy: 12 };
    Object.assign(market, { availableUsdc: 0n });
    useStabilizerBuyNavigation().noticeError = 'This buying opportunity has expired. Watching for the next one.';
  },
};
export const Opportunity: Story = {
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.config.stabilizerBuyAlert = { minimumApy: 12 };
    Object.assign(market, {
      buyDiscountPercent: 3.7,
      opportunity: {
        ...buyOpportunity,
        apy: 44,
        discountPercent: 3.7,
        quote: { ...buyOpportunity.quote, quotedMicrogonsOut: 5_000_000_000n },
      },
    });
  },
};

export const UnfundedOpportunity: Story = {
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.wallets[0].data.otherTokens = [];
    Object.assign(market, { availableUsdc: 0n, buyDiscountPercent: 10.4, opportunity: buyOpportunity });
  },
};

const purchase: IStabilizerBuyRecord = {
  id: 'synthetic-buy-1',
  ownerAccount: 'synthetic-owner',
  createdAt: new Date(Date.now() - 2 * 86_400_000),
  updatedAt: new Date(),
  argonFees: [],
  principal: 240_000_000n,
  admissionFrame: 48,
  status: StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon,
};
const pendingPurchase: IStabilizerBuyPurchaseRecord = {
  id: 'synthetic-buy-3',
  ownerAccount: 'synthetic-owner',
  createdAt: new Date(),
  updatedAt: new Date(),
  argonFees: [],
  status: StabilizerBuyStatus.ConfirmingPurchaseOnEthereum,
  ethereumMaxFeeWei: 1_000_000_000_000_000n,
  ethereumTxHash: `0x${'aa'.repeat(32)}`,
  ethereumSubmittedAt: new Date(),
  ethereumQuote: {
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
      argonAccountId: `0x${'11'.repeat(32)}`,
      maxUsdcIn: 200_000_000n,
      minMicrogonsOut: 201_478_000n,
      deadline: 2_000_000_000n,
    },
    quotedMicrogonsOut: 205_590_000n,
    sqrtPriceX96After: 1n << 96n,
    swapGasEstimate: 100_000n,
    minimumRewardPrincipal: 1_000_000n,
    qualifiesForRewards: true,
  },
};

export const Purchases: Story = {
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.config.stabilizerBuyAlert = { minimumApy: 12 };
    Object.assign(market, {
      biddingFrame: 48,
    });

    Object.assign(market.summary, {
      currentValue: 440_000_000n,
      returnSummary: {
        availability: 'available',
        investedCost: 600_210_000n,
        paidIncome: 5_000_000n,
        settledPrincipalValue: 240_000_000n,
        returnAmount: 84_790_000n,
        percent: 23.25,
        apr: 60,
        apy: 80,
        eligiblePositionCount: 2,
        investmentPositionCount: 2,
      },
    });

    Object.assign(market.data, {
      buys: [
        purchase,
        {
          ...purchase,
          id: 'synthetic-buy-4',
          principal: 200_000_000n,
          createdAt: new Date(Date.now() - 86_400_000),
        },
        {
          ...purchase,
          id: 'synthetic-buy-2',
          admissionFrame: 17,
          createdAt: new Date(Date.now() - 33 * 86_400_000),
          status: StabilizerBuyStatus.Complete,
        },
        {
          ...pendingPurchase,
          status: StabilizerBuyStatus.WaitingForArgonRecognition,
          purchaseEthereumBlockNumber: 5_000,
          ethereumFeeWei: 21_000_000_000_000n,
          usdcApprovalFeeWei: 11_000_000_000_000n,
          ethereumGatewayActivity: {
            token: pendingPurchase.ethereumQuote.poolKey.currency0,
            amount: 203_000_000n,
            purchase: {
              repayLiquidId: 0n,
              repaySignature: '0x' as const,
              buyer: pendingPurchase.ethereumQuote.sourceAddress,
              argonAccountId: pendingPurchase.ethereumQuote.request.argonAccountId,
              timestamp: 1_767_225_600n,
              usdcToken: pendingPurchase.ethereumQuote.usdcToken,
              usdcSpent: 198_000_000n,
              poolManager: pendingPurchase.ethereumQuote.poolManager,
              poolId: pendingPurchase.ethereumQuote.poolId,
              sqrtPriceBeforeX96: pendingPurchase.ethereumQuote.sqrtPriceX96After - 1n,
              sqrtPriceAfterX96: pendingPurchase.ethereumQuote.sqrtPriceX96After,
            },
            gatewayState: {
              gatewayActivityNonce: 2n,
              argonApprovalsNonce: 1n,
              argonCirculation: 0n,
              argonotCirculation: 0n,
            },
          },
        },
      ],
      ethereumGatewaySync: {
        ethereumBlockNumber: 1_000n,
        finalizedGatewayActivityNonce: 1n,
        bestGatewayActivityNonce: 1n,
      },
      frameRewards: [
        {
          ownerAccount: 'synthetic-owner',
          admissionFrame: 48,
          bidCount: 1,
          latestBid: 20,
          requestedReward: 8_000_000n,
          paidReward: 0n,
          lastUpdatedArgonBlock: 1234,
          bidFees: [],
          createdAt: new Date('2026-01-12T12:00:00Z'),
          updatedAt: new Date('2026-01-12T12:00:00Z'),
        },
        {
          ownerAccount: 'synthetic-owner',
          admissionFrame: 17,
          bidCount: 1,
          latestBid: 20,
          requestedReward: 5_000_000n,
          awardedReward: 5_000_000n,
          paidReward: 5_000_000n,
          lastUpdatedArgonBlock: 1234,
          bidFees: [],
          createdAt: new Date(Date.now() - 33 * 86_400_000),
          updatedAt: new Date(Date.now() - 86_400_000),
          payout: {
            blockNumber: 1000,
            blockHash: `0x${'dd'.repeat(32)}`,
            blockTime: Date.now() - 86_400_000,
            eventIndex: 2,
          },
        },
      ],
    });

    Object.assign(market.dates, {
      closes: { 48: new Date(Date.now() + (12 * 60 + 27) * 60_000) },
      releases: {
        48: new Date(Date.now() + 30 * 86_400_000 + (12 * 60 + 27) * 60_000),
        17: new Date(Date.now() - 86_400_000),
      },
      admission: {
        48: new Date(Date.now() + (12 * 60 + 27) * 60_000 - 2 * 86_400_000),
        17: new Date(Date.now() - 33 * 86_400_000),
      },
    });

    Object.assign(market.returns, {
      byFrame: {
        48: { ...noPurchasesSummary.returnSummary, investedCost: 400_210_000n, returnAmount: 39_790_000n, apy: 194.8 },
        17: { ...noPurchasesSummary.returnSummary, investedCost: 200_000_000n, returnAmount: 45_000_000n, apy: 80 },
      },
    });
  },
};

export const NeedsAttention: Story = {
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.config.stabilizerBuyAlert = { minimumApy: 12 };
    Object.assign(market.summary, {
      currentValue: 0n,
      returnSummary: {
        ...noPurchasesSummary.returnSummary,
        investedCost: 210_000n,
        returnAmount: -210_000n,
        percent: -100,
        apy: -100,
        apr: -100,
      },
    });

    Object.assign(market.data, {
      buys: [
        {
          ...pendingPurchase,
          status: StabilizerBuyStatus.Failed,
          ethereumFeeWei: 210_000_000_000_000n,
          statusError: 'The Ethereum purchase reverted. Review your wallet before trying again.',
        },
      ],
    });

    Object.assign(market.returns, {
      byPurchase: {
        'synthetic-buy-3': {
          ...noPurchasesSummary.returnSummary,
          investedCost: 210_000n,
          returnAmount: -210_000n,
          apy: -100,
          eligiblePositionCount: 1,
          investmentPositionCount: 1,
        },
      },
    });
  },
};
