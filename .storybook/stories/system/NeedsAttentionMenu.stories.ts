import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { mocked, fn } from 'storybook/test';
import { StabilizerBuy } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import TopBar from '../../../src-vue/navigation/TopBar.vue';
import { useAttention } from '../../../src-vue/stores/attention.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
import { reduceFinancialPositions } from '../../../src-vue/lib/financials/index.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';

const opportunity = {
  type: 'buy',
  key: 'synthetic-buy-opportunity',
  expiresAt: 2_000_000_000_000,
  apy: 42,
  discountPercent: 8,
  observedAt: new Date('2026-11-01T12:00:00Z'),
  quote: {
    chainId: 31337,
    gatewayAddress: `0x${'11'.repeat(20)}`,
    adapterAddress: `0x${'22'.repeat(20)}`,
    quoterAddress: `0x${'33'.repeat(20)}`,
    sourceAddress: `0x${'44'.repeat(20)}`,
    poolId: `0x${'55'.repeat(32)}`,
    poolManager: `0x${'66'.repeat(20)}`,
    usdcToken: `0x${'77'.repeat(20)}`,
    poolKey: {
      currency0: `0x${'77'.repeat(20)}`,
      currency1: `0x${'88'.repeat(20)}`,
      fee: 8_388_608,
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
    sqrtPriceX96After: 79_228_162_514_264_337_593_543n,
    swapGasEstimate: 100_000n,
    minimumRewardPrincipal: 1_000_000n,
    qualifiesForRewards: true,
  },
} satisfies NonNullable<ReturnType<typeof useAttention>['stabilizerBuyOpportunity']>;

const position = new StabilizerBuy(
  48,
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
    totalMatchingBasis: 80_000_000n,
    budget: 36_000_000n,
    remainingBudget: 36_000_000n,
    remainingMatchingBasis: 1_000_000_000n,
    maturesAtFrame: 78,
  },
);
const stabilizerBid: NonNullable<ReturnType<typeof useAttention>['stabilizerBid']> = {
  type: 'bid',
  key: 'synthetic-bid-opportunity',
  position,
  bid: {
    ownerAccount: `0x${'aa'.repeat(32)}`,
    latestBid: 100,
    matchingBasis: 40_000_000n,
    requestedReward: 40_000_000n,
    fundingEstimate: 12_000_000n,
  },
};

const viewedAttention = { actionKeys: [], hasUnseenActions: false, markViewed: fn() };

const meta = {
  title: 'System/Needs attention',
  component: TopBar,
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.MarketStabilizers });
    controller.isLoaded = true;
    getCurrency().isLoaded = true;

    const financials = useFinancials();
    Object.assign(financials, {
      financialPositionAggregate: reduceFinancialPositions(
        financials.financialPositionAggregate.groups.map(group => ({
          ...group,
          state: 'ready',
          observation: { observedAt: opportunity.observedAt },
        })),
      ),
    });

    mocked(useAttention, { partial: true }).mockReturnValue({
      ...viewedAttention,
      count: 1,
      stabilizerBid,
      bitcoinAlertGroups: [],
      pendingOperationsUpgradeRequests: [],
    });
  },
  render: () => ({
    components: { TopBar },
    template: `<div class="h-screen bg-slate-100">
      <TopBar />
      <div class="p-6 text-slate-500">Fixed state preview</div>
    </div>`,
  }),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: /^Needs attention/ }));
    canvasElement.querySelector('.TopBar')!.setAttribute('inert', '');
  },
} satisfies Meta<typeof TopBar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RewardBid: Story = { name: 'Bonus Bid' };

export const FirstBid: Story = {
  beforeEach: () => {
    mocked(useAttention, { partial: true, deep: true }).mockReturnValue({
      ...viewedAttention,
      count: 1,
      stabilizerBid: {
        type: 'bid',
        key: 'synthetic-first-bid-opportunity',
        position: new StabilizerBuy(
          position.admissionFrame,
          { ...position.purchase, bidRate: BigNumber(0), positiveBidCount: 0 },
          position.auction,
        ),
      },
      bitcoinAlertGroups: [],
      pendingOperationsUpgradeRequests: [],
    });
  },
};

export const BuyingOpportunity: Story = {
  beforeEach: () => {
    mocked(useAttention, { partial: true, deep: true }).mockReturnValue({
      ...viewedAttention,
      count: 1,
      bitcoinAlertGroups: [],
      pendingOperationsUpgradeRequests: [],
      stabilizerBuyOpportunity: opportunity,
    });
  },
};

export const BuyAndBid: Story = {
  beforeEach: () => {
    mocked(useAttention, { partial: true, deep: true }).mockReturnValue({
      ...viewedAttention,
      count: 2,
      stabilizerBid,
      bitcoinAlertGroups: [],
      pendingOperationsUpgradeRequests: [],
      stabilizerBuyOpportunity: opportunity,
    });
  },
};

export const UnseenActions: Story = {
  beforeEach: () => {
    mocked(useAttention, { partial: true, deep: true }).mockReturnValue({
      ...viewedAttention,
      hasUnseenActions: true,
      count: 2,
      stabilizerBid,
      bitcoinAlertGroups: [],
      pendingOperationsUpgradeRequests: [],
      stabilizerBuyOpportunity: opportunity,
    });
  },
  play: ({ canvasElement }) => {
    canvasElement.tabIndex = -1;
    canvasElement.focus({ preventScroll: true });
    canvasElement.querySelector('.TopBar')!.setAttribute('inert', '');
  },
};
