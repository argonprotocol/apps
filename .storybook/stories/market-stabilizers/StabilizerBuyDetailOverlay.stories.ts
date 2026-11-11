import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import { StabilizerBuy } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { buyOpportunity } from '../../../src-vue/__test__/helpers/stabilizerBuy.ts';
import { StabilizerBuyStatus } from '../../../src-vue/interfaces/IStabilizerBuyPurchase.ts';
import { useMarketStabilizers } from '../../../src-vue/stores/marketStabilizers.ts';
import AppScreen from '../../components/AppScreen.vue';
import { setupMarketStabilizers } from '../../scenarios/marketStabilizers.ts';
import Dashboard from '../../../src-vue/screens/market-stabilizers-screen/Dashboard.vue';
import StabilizerBuyDetailOverlay from '../../../src-vue/overlays/StabilizerBuyDetailOverlay.vue';

const meta = {
  title: 'Market Stabilizers/Buy Details',
  component: StabilizerBuyDetailOverlay,
  beforeEach: () => {
    const market = setupMarketStabilizers();
    const ownerAccount = `0x${'33'.repeat(32)}`;
    const auction = {
      matchingRate: BigNumber(1),
      totalMatchingBasis: 440_000_000n,
      budget: 396_000_000n,
      remainingBudget: 396_000_000n,
      remainingMatchingBasis: 396_000_000n,
      maturesAtFrame: 78,
    };
    const position = new StabilizerBuy(
      48,
      {
        pendingLiquidRepays: 0n,
        liquidRepaymentRewardRate: null,
        principal: 440_000_000n,
        capturedDiscount: 40_000_000n,
        bidRate: BigNumber(0.8),
        positiveBidCount: 1,
      },
      auction,
    );
    market.data.positions = [position];
    market.data.frameRewards = [
      {
        ownerAccount,
        admissionFrame: 48,
        bidCount: 1,
        latestBid: 80,
        requestedReward: 32_000_000n,
        paidReward: 0n,
        lastUpdatedArgonBlock: 1234,
        bidFees: [],
        createdAt: new Date('2026-01-12T12:00:00Z'),
        updatedAt: new Date('2026-01-12T12:00:00Z'),
      },
    ];
    market.data.auctionsByFrame[48] = {
      auction,
      observedAtFrame: 49,
      bids: [
        { ownerAccount: `0x${'11'.repeat(32)}`, latestBid: 40, matchingBasis: 350_000_000n },
        { ownerAccount: `0x${'22'.repeat(32)}`, latestBid: 70, matchingBasis: 50_000_000n },
        { ownerAccount, latestBid: 80, matchingBasis: 40_000_000n },
      ],
    };
    market.data.buys = [
      { principal: 240_000_000n, usdcSpent: 220_000_000n, hour: 12 },
      { principal: 200_000_000n, usdcSpent: 180_000_000n, hour: 13 },
    ].map(({ principal, usdcSpent, hour }, index) => ({
      id: `synthetic-buy-${index}`,
      ownerAccount,
      createdAt: new Date(`2026-01-12T${hour}:00:00Z`),
      updatedAt: new Date('2026-01-12T13:02:00Z'),
      argonFees: [],
      admissionFrame: 48,
      principal,
      spentMicrogons: usdcSpent,
      ethereumFeeMicrogons: 100_000n,
      usdcApprovalFeeMicrogons: 0n,
      argonPurchaseEvent: {
        sourceChain: { type: 'Ethereum' },
        transfer: {
          gatewayActivityNonce: BigInt(index + 1),
          from: buyOpportunity.quote.sourceAddress,
          asset: { type: 'Argon' },
          to: ownerAccount,
          amount: principal,
        },
        purchaseTick: 1,
        purchase: {
          repayLiquidId: null,
          repaySignature: new Uint8Array(),
          usdcToken: buyOpportunity.quote.usdcToken,
          usdcSpent,
          argonBought: principal * 10n ** 12n,
          poolManager: buyOpportunity.quote.poolManager,
          poolId: buyOpportunity.quote.poolId,
          sqrtPriceBeforeX96: 1n,
          sqrtPriceAfterX96: 2n,
        },
      },
      status: StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon,
    }));
    market.returns.byFrame[48] = {
      availability: 'available',
      investedCost: 400_200_000n,
      returnAmount: 39_800_000n,
      settledPrincipalValue: 0n,
      percent: 9.95,
      apy: 217,
      eligiblePositionCount: 1,
      investmentPositionCount: 1,
    };
    Object.assign(market.summary, {
      currentValue: 440_000_000n,
      returnSummary: market.returns.byFrame[48],
    });
    Object.assign(market, { biddingFrame: 48 });
    setPurchaseDates(new Date(Date.now() + (12 * 60 + 27) * 60_000));
  },
  render: args => ({
    components: { AppScreen, Dashboard, StabilizerBuyDetailOverlay },
    setup: () => ({ args }),
    template: '<AppScreen><Dashboard /><StabilizerBuyDetailOverlay v-bind="args" inert /></AppScreen>',
  }),
  args: { admissionFrame: 48 },
} satisfies Meta<typeof StabilizerBuyDetailOverlay>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BiddingOpen: Story = {};
export const WindowClosed: Story = {
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.data.currentFrameId = 50;
    Object.assign(market, { biddingFrame: undefined });
    setPurchaseDates(new Date(Date.now() - 60_000));
  },
};
export const RewardAwarded: Story = {
  name: 'Bonus Earned',
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.data.currentFrameId = 50;
    market.data.frameRewards[0].awardedReward = 7_000_000n;
    market.data.frameRewards[0].maturesAtFrame = 78;
    setPurchaseDates(new Date(Date.now() - 86_400_000));
    market.returns.byFrame[48].returnAmount = 46_800_000n;
    market.returns.byFrame[48].apy = 284;
    Object.assign(market, { biddingFrame: undefined });
  },
};
export const PaymentQueued: Story = {
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.data.currentFrameId = 78;
    market.data.positions = [];
    market.data.auctionsByFrame = {};
    market.data.frameRewards[0].awardedReward = 7_000_000n;
    market.data.frameRewards[0].maturesAtFrame = 78;
    setPurchaseDates(new Date(Date.now() - 28 * 86_400_000 - 10 * 60_000));
    for (const buy of market.data.buys) {
      buy.purchaseArgonReleaseBlockTime = market.dates.releases[48];
      buy.releasedPrincipal = buy.principal;
    }
    market.returns.byFrame[48].returnAmount = 46_800_000n;
    market.returns.byFrame[48].apy = 284;
    Object.assign(market, { biddingFrame: undefined });
  },
};
export const Paid: Story = {
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.data.currentFrameId = 79;
    market.data.positions = [];
    market.data.auctionsByFrame = {};
    setPurchaseDates(new Date(Date.now() - 29 * 86_400_000));
    const rewards = market.data.frameRewards[0];
    rewards.awardedReward = 7_000_000n;
    rewards.paidReward = 7_000_000n;
    rewards.payout = {
      blockNumber: 1300,
      blockHash: `0x${'dd'.repeat(32)}`,
      blockTime: market.dates.releases[48].getTime() + 2 * 60_000,
      eventIndex: 2,
    };
    for (const buy of market.data.buys) {
      buy.status = StabilizerBuyStatus.Complete;
      buy.purchaseArgonReleaseBlockTime = market.dates.releases[48];
      buy.releasedPrincipal = buy.principal;
    }
    market.returns.byFrame[48].returnAmount = 46_800_000n;
    market.returns.byFrame[48].apy = 284;
    Object.assign(market, { biddingFrame: undefined });
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement.ownerDocument.body).getByText('Bidding for a Bonus'));
  },
};

export const PurchaseDetails: Story = {
  ...RewardAwarded,
  name: 'Purchase Details',
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement.ownerDocument.body).getByTitle('Show purchase details'));
  },
};

function setPurchaseDates(biddingClosesAt: Date) {
  const market = useMarketStabilizers();
  const admission = new Date(biddingClosesAt.getTime() - 2 * 86_400_000);
  market.dates.admission[48] = admission;
  market.dates.opens[48] = new Date(biddingClosesAt.getTime() - 86_400_000);
  market.dates.closes[48] = biddingClosesAt;
  market.dates.releases[48] = new Date(admission.getTime() + 30 * 86_400_000);

  for (const [index, purchase] of market.data.buys.entries()) {
    purchase.createdAt = new Date(admission.getTime() + index * 60 * 60_000);
    purchase.updatedAt = purchase.createdAt;
    purchase.purchasedAt = purchase.createdAt;
  }
}
