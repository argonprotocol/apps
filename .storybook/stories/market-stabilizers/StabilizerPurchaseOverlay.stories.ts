import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { within, mocked } from 'storybook/test';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { WalletForEthereum } from '../../../src-vue/lib/WalletForEthereum.ts';
import { StabilizerBuyStatus, type IStabilizerBuyRecord } from '../../../src-vue/interfaces/IStabilizerBuyPurchase.ts';
import { useMarketStabilizers } from '../../../src-vue/stores/marketStabilizers.ts';
import { getStabilizerBuyPurchases } from '../../../src-vue/stores/stabilizerBuys.ts';
import { buyOpportunity } from '../../../src-vue/__test__/helpers/stabilizerBuy.ts';
import AppScreen from '../../components/AppScreen.vue';
import { setupMarketStabilizers } from '../../scenarios/marketStabilizers.ts';
import Dashboard from '../../../src-vue/screens/market-stabilizers-screen/Dashboard.vue';
import StabilizerPurchaseOverlay from '../../../src-vue/overlays/StabilizerPurchaseOverlay.vue';

const meta = {
  title: 'Market Stabilizers/Purchase',
  component: StabilizerPurchaseOverlay,
  beforeEach: () => {
    const network = NetworkConfig.networkName!;
    const previous = NetworkConfig.get();
    NetworkConfig.setRuntimeOverride(network, { ...previous, tickMillis: 2_000, ticksBetweenFrames: 60 });

    const market = setupMarketStabilizers();
    market.config.stabilizerBuyAlert = { minimumApy: 12 };
    Object.assign(market, {
      opportunity: {
        ...buyOpportunity,
        quote: { ...buyOpportunity.quote, request: { ...buyOpportunity.quote.request, maxUsdcIn: 200_000_000n } },
      },
    });
    NetworkConfig.get().ethereumNetwork.stabilizerBuyQuoterAddress = buyOpportunity.quote.quoterAddress;
    Object.assign(market, {
      dates: {
        admission: {},
        opens: { 48: new Date('2026-01-13T12:00:00Z'), 49: new Date('2026-01-14T12:00:00Z') },
        closes: { 48: new Date('2026-01-14T12:00:00Z'), 49: new Date('2026-01-15T12:00:00Z') },
        releases: { 48: new Date('2026-02-11T12:00:00Z'), 49: new Date('2026-02-12T12:00:00Z') },
      },
    });
    return () => NetworkConfig.setRuntimeOverride(network, previous);
  },
  render: args => ({
    components: { AppScreen, Dashboard, StabilizerPurchaseOverlay },
    setup: () => ({ args }),
    template: '<AppScreen><Dashboard /><StabilizerPurchaseOverlay v-bind="args" inert /></AppScreen>',
  }),
} satisfies Meta<typeof StabilizerPurchaseOverlay>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Review: Story = {
  play: async () => {
    await within(document.body).findByRole('button', { name: /Finalize Purchase/ });
  },
};
export const ChooseWallet: Story = {
  ...Review,
  beforeEach: () => {
    useMarketStabilizers().wallets.push(new WalletForEthereum(`0x${'55'.repeat(20)}`));
  },
};

export const NeedsFunding: Story = {
  ...Review,
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.wallets[0].data.otherTokens = [];
    Object.assign(market, {
      availableUsdc: 0n,
      opportunity: {
        ...buyOpportunity,
        quote: { ...buyOpportunity.quote, request: { ...buyOpportunity.quote.request, maxUsdcIn: 25_123_456n } },
      },
    });
  },
};

export const BelowRewardMinimum: Story = {
  ...Review,
  name: 'Below Bonus Minimum',
  beforeEach: () => {
    Object.assign(useMarketStabilizers(), {
      opportunity: {
        ...buyOpportunity,
        quote: { ...buyOpportunity.quote, request: { ...buyOpportunity.quote.request, maxUsdcIn: 900_000n } },
      },
    });
    const purchases = mocked(getStabilizerBuyPurchases()!);
    purchases.previewPurchase.mockResolvedValue({
      feeEstimateWei: 1_000_000_000_000n,
      needsApproval: false,
    });
    purchases.quoteMaxProfit.mockImplementation(async request => {
      const quote = await purchases.quote({ ...request, maxUsdcIn: 900_000n });
      return { minimumQuote: quote, quote, preview: await purchases.previewPurchase({ ethereumQuote: quote }) };
    });
  },
};

const purchase: IStabilizerBuyRecord = {
  id: 'synthetic-buy-1',
  ownerAccount: 'synthetic-owner',
  createdAt: new Date('2026-01-12T12:00:00Z'),
  updatedAt: new Date('2026-01-12T12:00:00Z'),
  argonFees: [],
  usdcApprovalFeeWei: 21_000_000_000_000n,
  ethereumConfirmedAt: new Date('2026-01-12T12:01:00Z'),
  status: StabilizerBuyStatus.WaitingForArgonRecognition,
};

const heldPurchase: IStabilizerBuyRecord = {
  ...purchase,
  principal: 240_000_000n,
  admissionFrame: 48,
  argonPurchaseEvent: {
    sourceChain: { type: 'Ethereum' },
    transfer: {
      gatewayActivityNonce: 1n,
      from: buyOpportunity.quote.sourceAddress,
      asset: { type: 'Argon' },
      to: purchase.ownerAccount,
      amount: 240_000_000n,
    },
    purchaseTick: 1,
    purchase: {
      repayLiquidId: null,
      repaySignature: new Uint8Array(),
      usdcToken: buyOpportunity.quote.usdcToken,
      usdcSpent: 200_000_000n,
      argonBought: 240n * 10n ** 18n,
      poolManager: buyOpportunity.quote.poolManager,
      poolId: buyOpportunity.quote.poolId,
      sqrtPriceBeforeX96: 1n,
      sqrtPriceAfterX96: 2n,
    },
  },
  purchaseArgonRecognitionBlockNumber: 1234,
  purchaseArgonRecognitionBlockHash: `0x${'66'.repeat(32)}`,
  purchaseArgonRecognitionBlockTime: new Date('2026-01-12T12:02:00Z'),
  purchaseArgonRecognitionEventIndex: 1,
  status: StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon,
};
export const WaitingForArgon: Story = {
  args: { buyId: purchase.id },
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.data.buys = [{ ...purchase, purchaseEthereumBlockNumber: 5_000 }];
    market.data.ethereumGatewaySync = {
      ethereumBlockNumber: 1_000n,
      finalizedGatewayActivityNonce: 1n,
      bestGatewayActivityNonce: 1n,
    };
  },
};

export const ConfirmingOnEthereum: Story = {
  args: { buyId: purchase.id },
  beforeEach: () => {
    const hash = `0x${'aa'.repeat(32)}` as const;
    const expected = NetworkConfig.get().ethereumNetwork.finalityBlocks;
    const confirmations = Math.floor(expected / 2);
    useMarketStabilizers().data.buys = [
      {
        ...purchase,
        status: StabilizerBuyStatus.ConfirmingPurchaseOnEthereum,
        ethereumTxHash: hash,
      },
    ];
    getStabilizerBuyPurchases()!.data.transactionProgressByHash[hash] = {
      blockNumber: 42,
      confirmations,
      expectedConfirmations: expected,
      progressPct: (confirmations / expected) * 100,
      isFinalized: false,
    };
  },
};

export const HeldForRewards: Story = {
  name: 'Held for Bonus',
  args: { buyId: heldPurchase.id },
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.data.buys = [heldPurchase];
    Object.assign(market, { biddingFrame: heldPurchase.admissionFrame });
  },
};
export const Complete: Story = {
  args: { buyId: heldPurchase.id },
  beforeEach: () => {
    const market = useMarketStabilizers();
    market.data.buys = [
      {
        ...heldPurchase,
        purchaseArgonReleaseBlockNumber: 1300,
        purchaseArgonReleaseBlockHash: `0x${'77'.repeat(32)}`,
        purchaseArgonReleaseBlockTime: new Date('2026-02-11T12:02:00Z'),
        purchaseArgonReleaseEventIndex: 0,
        status: StabilizerBuyStatus.Complete,
      },
    ];
  },
};
export const Failed: Story = {
  args: { buyId: purchase.id },
  beforeEach: () => {
    useMarketStabilizers().data.buys = [
      {
        ...purchase,
        status: StabilizerBuyStatus.Failed,
        statusError: 'The Ethereum purchase reverted. Review your wallet before requesting another quote.',
      },
    ];
  },
};
