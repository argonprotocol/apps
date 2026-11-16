import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { fn, userEvent, within } from 'storybook/test';
import { NetworkConfig, StabilizerBuy } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import AppScreen from '../../components/AppScreen.vue';
import MarketStabilizers from '../../../src-vue/screens/MarketStabilizers.vue';
import Bitcoin from '../../../src-vue/screens/Bitcoin.vue';
import { useCertificationController } from '../../../src-vue/stores/certificationController.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { setupMarketStabilizers } from '../../scenarios/marketStabilizers.ts';
import { setupBitcoinPortfolioScenario } from '../../scenarios/setupBitcoinPortfolioScenario.ts';
import { buyOpportunity } from '../../../src-vue/__test__/helpers/stabilizerBuy.ts';
import {
  getBitcoinFissions,
  getBitcoinLocks,
  getBitcoinTransactionOperations,
} from '../../../src-vue/stores/bitcoin.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getWalletKeys } from '../../../src-vue/stores/wallets.ts';
import {
  getStabilizerBuys,
  getStabilizerBuyOperations,
  getStabilizerBuyPurchases,
  useStabilizerBuyNavigation,
} from '../../../src-vue/stores/stabilizerBuys.ts';
import { useMarketStabilizers } from '../../../src-vue/stores/marketStabilizers.ts';
import { StabilizerBuyStatus, type IStabilizerBuyRecord } from '../../../src-vue/interfaces/IStabilizerBuyPurchase.ts';
import {
  calculateStabilizerBuyReturn,
  createStabilizerBuyFinancialPositions,
  getStabilizerBuyReturnedSatoshis,
  projectStabilizerBuyPendingPaydowns,
} from '../../../src-vue/lib/financials/StabilizerBuys.ts';
import { calculatePositionReturn } from '../../../src-vue/lib/financials/index.ts';

const meta = {
  id: 'market-stabilizers-liquid-buyback',
  title: 'Market Stabilizers/Liquid Paydown',
  component: MarketStabilizers,
  parameters: {
    docs: {
      description: {
        component: 'App Vue screens driven by synthetic Storybook data. Transactions are disabled.',
      },
    },
  },
  beforeEach: () => {
    const network = NetworkConfig.networkName!;
    const previous = NetworkConfig.get();
    NetworkConfig.setRuntimeOverride(network, {
      ...previous,
      ticksBetweenFrames: 1440,
      tickMillis: 60_000,
      ethereumNetwork: { ...previous.ethereumNetwork, stabilizerBuyQuoterAddress: buyOpportunity.quote.quoterAddress },
    });
    const market = setupMarketStabilizers();
    setupBitcoinPortfolioScenario({ settledLiquid: true, currentArgonPriceUsd: 0.5 });
    Object.assign(market, {
      config: getConfig(),
      opportunity: buyOpportunity,
      buyDiscountPercent: 8,
      liquids: getBitcoinFissions()
        .getLiquids()
        .filter(liquid => !liquid.isClosed),
      availableLiquids: getBitcoinFissions()
        .getLiquids()
        .filter(liquid => !liquid.isClosed),
      liquidRepaymentWindows: new Map([
        [2_401, true],
        [2_468, false],
      ]),
    });
    useCertificationController().setTab(TopTab.MarketStabilizers);
    const navigation = useStabilizerBuyNavigation();
    navigation.buyId = undefined;
    navigation.admissionFrame = undefined;
    navigation.reviewBuy = false;
    navigation.cancelPendingNotice();
    market.config.stabilizerBuyAlert = { minimumApy: 12 };
    market.config.saveStabilizerBuyAlert = fn(async settings => {
      market.config.stabilizerBuyAlert = settings;
    });
    Object.assign(getWalletKeys(), { canSign: false });

    const unavailable = fn(async () => {
      throw new Error('Transactions are disabled in this design preview.');
    });
    getStabilizerBuyPurchases()!.purchase = unavailable;
    getStabilizerBuyOperations().stabilizerBuyBid.submit = unavailable;
    const bitcoin = getBitcoinTransactionOperations();
    bitcoin.bitcoinLiquidClose.submit = unavailable;
    bitcoin.bitcoinLiquidRatchet.submit = unavailable;

    Object.assign(market, {
      dates: {
        admission: { 48: new Date('2026-11-10T12:00:00Z') },
        opens: { 48: new Date('2026-11-11T12:00:00Z') },
        closes: { 48: new Date('2026-11-12T12:00:00Z') },
        releases: { 48: new Date('2026-12-10T12:00:00Z') },
      },
    });
    return () => NetworkConfig.setRuntimeOverride(network, previous);
  },
  render: () => ({
    components: { AppScreen, MarketStabilizers, Bitcoin },
    setup: () => ({ controller: useCertificationController(), TopTab }),
    template: `<AppScreen interactive scenarioLabel="Interactive paydown preview · transactions disabled">
      <Bitcoin v-if="controller.selectedTab === TopTab.BitcoinLocks" />
      <MarketStabilizers v-else />
    </AppScreen>`,
  }),
} satisfies Meta<typeof MarketStabilizers>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Introduction: Story = {
  beforeEach: () => {
    Object.assign(useMarketStabilizers(), { hasAccess: false });
  },
};

export const ChoosePurchaseUse: Story = {
  name: 'Purchase',
  beforeEach: () => {
    useStabilizerBuyNavigation().reviewBuy = true;
  },
};

export const ChooseLiquid: Story = {
  beforeEach: () => {
    useStabilizerBuyNavigation().reviewBuy = true;
  },
  play: async () => {
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Attach a Liquid' }));
  },
};

export const ReviewBuyback: Story = {
  name: 'Liquid Selected',
  beforeEach: () => {
    useStabilizerBuyNavigation().reviewBuy = true;
  },
  play: async () => {
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Attach a Liquid' }));
    await userEvent.click(await within(document.body).findByRole('button', { name: '0.7 BTC Liquid' }));
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Change Attached Liquid' }));
  },
};

export const ScheduledBuyback: Story = {
  name: 'Scheduled Paydown',
  beforeEach: () => setupPurchaseRecords(false),
};

export const SharedRewardBid: Story = {
  name: 'Shared Bonus Bid',
  beforeEach: () => {
    setupPurchaseRecords(false);
    useStabilizerBuyNavigation().admissionFrame = 48;
  },
};

export const BiddingComplete: Story = {
  name: 'Bidding Complete · Expected Liquid Benefits',
  beforeEach: () => {
    setupPurchaseRecords(false, true);
    useStabilizerBuyNavigation().admissionFrame = 48;
  },
};

export const CompletedBuyback: Story = {
  name: 'Completed Paydown',
  beforeEach: () => {
    setupPurchaseRecords(true);
    useStabilizerBuyNavigation().admissionFrame = 48;
  },
};

export const FromLiquidDetails: Story = {
  beforeEach: () => {
    useCertificationController().setTab(TopTab.BitcoinLocks);
  },
  play: async () => {
    await userEvent.click(await within(document.body).findByTestId('BitcoinLiquid.active-2401'));
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Pay Down at a Discount' }));
  },
};

export const ScheduledFromLiquidDetails: Story = {
  beforeEach: () => {
    setupPurchaseRecords(false);
    Object.assign(useMarketStabilizers(), { buyDiscountPercent: 8, opportunity: buyOpportunity });
    getBitcoinFissions().data.pendingRepaymentLiquidIds.add(2_401);
    useCertificationController().setTab(TopTab.BitcoinLocks);
  },
  play: async () => {
    await userEvent.click(await within(document.body).findByTestId('BitcoinLiquid.active-2401'));
  },
};

export const LiquidFromBuyDetails: Story = {
  beforeEach: () => {
    setupPurchaseRecords(true);
    useStabilizerBuyNavigation().admissionFrame = 48;
  },
  play: async () => {
    await userEvent.click(await within(document.body).findByRole('button', { name: /BTC Liquid/ }));
  },
};

function setupPurchaseRecords(settled: boolean, biddingClosed = false) {
  const market = useMarketStabilizers();
  const ownerAccount = getStabilizerBuys().accountAddress;
  const purchasedAt = new Date('2026-11-10T12:00:00Z');
  const settledAt = new Date('2026-12-10T12:00:00Z');
  const block = { blockNumber: 2000, blockHash: `0x${'77'.repeat(32)}`, blockTime: settledAt.getTime(), eventIndex: 1 };
  const buys: IStabilizerBuyRecord[] = [
    { principal: 1_000_000_000n, spentMicrogons: 900_000_000n, repayLiquidId: 2_401 },
    { principal: 400_000_000n, spentMicrogons: 360_000_000n },
  ].map((purchase, index) => ({
    ...purchase,
    id: `synthetic-buyback-purchase-${index}`,
    ownerAccount,
    gatewayTransferId: `Ethereum:${index + 1}`,
    admissionFrame: 48,
    createdAt: purchasedAt,
    updatedAt: purchasedAt,
    purchasedAt,
    argonFees: [],
    ethereumFeeMicrogons: 100_000n,
    usdcApprovalFeeMicrogons: 0n,
    status: StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon,
    argonPurchaseEvent: {
      sourceChain: { type: 'Ethereum' },
      transfer: {
        gatewayActivityNonce: BigInt(index + 1),
        from: buyOpportunity.quote.sourceAddress,
        asset: { type: 'Argon' },
        to: ownerAccount,
        amount: purchase.principal,
      },
      purchaseTick: 1000,
      purchase: {
        repayLiquidId: purchase.repayLiquidId ?? null,
        repaySignature: new Uint8Array(),
        usdcToken: buyOpportunity.quote.usdcToken,
        usdcSpent: purchase.spentMicrogons,
        argonBought: purchase.principal * 10n ** 12n,
        poolManager: buyOpportunity.quote.poolManager,
        poolId: buyOpportunity.quote.poolId,
        sqrtPriceBeforeX96: 1n,
        sqrtPriceAfterX96: 2n,
      },
    },
  }));
  const auction = {
    matchingRate: BigNumber(1),
    totalMatchingBasis: 200_000_000n,
    budget: 180_000_000n,
    remainingBudget: 180_000_000n,
    remainingMatchingBasis: 180_000_000n,
    maturesAtFrame: 78,
  };
  market.data.buys = buys;
  market.data.positions = [
    new StabilizerBuy(
      48,
      {
        principal: 400_000_000n,
        pendingLiquidRepays: 1n,
        liquidRepaymentRewardRate: null,
        capturedDiscount: 140_000_000n,
        bidRate: BigNumber(0.8),
        positiveBidCount: 1,
      },
      auction,
      [
        {
          liquidId: 2_401,
          gatewayActivityNonce: 1n,
          admissionFrame: 48,
          microgons: 1_000_000_000n,
          eligibleRewardPercent: BigNumber(0.05),
          purchaseTick: 1000,
          microgonsAtTargetPerBtc: BigNumber(68_000_000_000),
          purchaseRValue: BigNumber(0.5),
          observedRValueHighWater: BigNumber(0.6),
          priceWindow: { nextFrame: 49n, nextTick: 1100n, rValueHighWater: BigNumber(0) },
        },
      ],
    ),
  ];
  market.data.frameRewards = [
    {
      ownerAccount,
      admissionFrame: 48,
      bidCount: 1,
      latestBid: 80,
      lastUpdatedArgonBlock: 1234,
      paidReward: 0n,
      bidFees: [],
      createdAt: purchasedAt,
      updatedAt: purchasedAt,
    },
  ];
  market.data.auctionsByFrame[48] = {
    auction,
    observedAtFrame: 49,
    bids: [
      { ownerAccount: `0x${'11'.repeat(32)}`, latestBid: 40, matchingBasis: 20_000_000n },
      { ownerAccount, latestBid: 80, matchingBasis: 140_000_000n },
      { ownerAccount: `0x${'22'.repeat(32)}`, latestBid: 0, matchingBasis: 40_000_000n },
    ],
  };
  Object.assign(market, { biddingFrame: 48, opportunity: undefined });
  if (biddingClosed) {
    market.data.currentFrameId = 50;
    market.data.auctionsByFrame[48].observedAtFrame = 50;
    const bid = StabilizerBuy.allocateBids(market.data.auctionsByFrame[48].bids, auction, BigNumber(0.9)).find(
      bid => bid.ownerAccount === ownerAccount,
    )!;
    market.closedAuctionBids.set(48, bid);
    Object.assign(market, { biddingFrame: undefined });
  }

  if (settled) {
    const fission = getBitcoinFissions()
      .getAll()
      .find(fission => fission.fissionId === 2_401)!;
    fission.initialSatoshis = fission.satoshis;
    fission.satoshis -= 1_088_840n;
    fission.liquidityPromised -= 740_411_200n;
    fission.repayments.push({
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      blockTime: settledAt,
      tick: 1300,
      eventIndex: 0,
      satoshis: 1_088_840n,
      liquidityRepaid: 740_411_200n,
      redemptionAmount: 900_000_000n,
    });
    market.data.currentFrameId = 78;
    market.data.positions = [];
    Object.assign(market, { biddingFrame: undefined });
    Object.assign(market.data.buys[0], {
      liquidRepaymentEvent: { ...block, gatewayActivityNonce: 1n, liquidId: 2_401, microgonsBurned: 900_000_000n },
      releasedPrincipal: 100_000_000n,
    });
    market.data.buys[1].releasedPrincipal = 400_000_000n;
    for (const buy of market.data.buys) {
      buy.status = StabilizerBuyStatus.Complete;
      buy.purchaseArgonReleaseBlockNumber = block.blockNumber;
      buy.purchaseArgonReleaseBlockHash = block.blockHash;
      buy.purchaseArgonReleaseBlockTime = settledAt;
      buy.purchaseArgonReleaseEventIndex = 3;
    }
    Object.assign(market.data.frameRewards[0], {
      awardedReward: 112_000_000n,
      paidReward: 112_000_000n,
      requestedReward: 112_000_000n,
      maturesAtFrame: 78,
      repaymentRewards: [{ ...block, admissionFrame: 48, amount: 36_000_000n, eventIndex: 2 }],
      payout: { ...block, eventIndex: 3 },
    });
  }

  const positions = createStabilizerBuyFinancialPositions(getStabilizerBuys().snapshot);
  const returns = calculatePositionReturn(positions);
  Object.assign(market.summary, {
    positions,
    currentValue: positions.reduce((sum, position) => sum + (position.currentValue ?? 0n), 0n),
    returnSummary: returns,
  });

  const liquid = market.liquids.find(liquid => liquid.liquidId === 2_401)!;
  const lockExpirations = new Map<number, number>();
  for (const fission of liquid.fissions) {
    const lock = getBitcoinLocks().getLockById(fission.lockId)?.scriptDetails;
    if (lock) lockExpirations.set(fission.lockId, lock.vaultClaimHeight);
  }
  const forecasts = projectStabilizerBuyPendingPaydowns({
    positions: market.data.positions,
    liquids: market.liquids,
    lockExpirations,
    priceIndex: getCurrency().priceIndex,
  });
  const estimate = forecasts.byNonce.get(1n);
  const rate = market.closedAuctionBids.get(48)?.liquidRepaymentRewardRate;
  let potentialBonus = 0n;
  if (estimate && rate) {
    potentialBonus = BigInt(
      BigNumber(estimate.burnedMicrogons).times('0.05').times(rate).integerValue(BigNumber.ROUND_DOWN).toFixed(0),
    );
  }
  Object.assign(market, {
    liquidPaydowns: [
      {
        buy: buys[0],
        liquid,
        estimate,
        potentialBonus,
        returnedSatoshis: getStabilizerBuyReturnedSatoshis(buys[0], liquid),
        repaymentState: settled ? liquid.getRepaymentState(block.blockNumber) : estimate,
      },
    ],
  });
  market.returns.byFrame[48] = calculateStabilizerBuyReturn({
    position: positions[0],
    group: market.summary,
    periodDays: 30,
    expectedReward: market.closedAuctionBids.get(48)?.fundingEstimate,
    potentialLiquidBonus: potentialBonus,
  });
}
