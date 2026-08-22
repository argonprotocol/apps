import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import { setupWalletTransferScenario, type WalletTransferScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter, { type IWalletOverlayRequest } from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletOverlayController from '../../../src-vue/wallets/WalletOverlayController.vue';

let request: IWalletOverlayRequest = {
  connectorType: WalletType.ethereum,
  ethereumWalletRecordId: 41,
};

const meta = {
  title: 'Wallets/Cross-chain transfer',
  render: () => ({
    components: { WalletOverlayController },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openWalletOverlay', request));
    },
    template: `
      <div class="relative h-screen w-screen overflow-hidden">
        <WalletOverlayController />
      </div>
    `,
  }),
} satisfies Meta<typeof WalletOverlayController>;

export default meta;
type Story = StoryObj<typeof meta>;

function useScenario(state: WalletTransferScenario) {
  const scenario = setupWalletTransferScenario(state);
  const isInbound = [
    'inboundForm',
    'submittingInbound',
    'inboundEthereum',
    'inboundRelay',
    'inboundArgon',
    'completeInbound',
  ].includes(state);
  request = isInbound
    ? {
        connectorType: WalletType.ethereum,
        ethereumWalletRecordId: 41,
        view: 'main',
      }
    : {
        connectorType: WalletType.argon,
        view: 'send',
      };
  return scenario.cleanup;
}

async function getInboundCanvas() {
  const canvas = within(document.body);
  await expectEventuallyVisible(canvas.findByRole('heading', { name: /Send(?:ing)? from Ethereum Treasury/ }));
  return canvas;
}

async function getOutboundCanvas() {
  const canvas = within(document.body);
  await expectEventuallyVisible(canvas.findByRole('heading', { name: /Send(?:ing)? From Internal/ }));
  return canvas;
}

async function expectProgress(canvas: ReturnType<typeof within>, expectedText: string[]) {
  for (const text of expectedText) await expectEventuallyVisible(canvas.findByText(text));
}

function getConnectorArticle(connectorId: string | number) {
  const connector = document.querySelector(`[data-wallet-connector-id="${connectorId}"]`);
  const article = connector?.closest('article');
  if (!article) throw new Error(`Wallet connector article is missing: ${connectorId}`);
  return article;
}

const stories = {
  inboundForm: {
    beforeEach: () => useScenario('inboundForm'),
    play: async () => {
      const canvas = await getInboundCanvas();

      await expect(canvas.getByTestId('ConnectorTransfer.destination')).toHaveTextContent('Internal App Wallet');
      await expectEventuallyVisible(canvas.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(canvas.getByRole('button', { name: /Initiate Transfer/ })).toBeEnabled());
      await expect(canvas.queryByRole('button', { name: 'Reverse transfer direction' })).not.toBeInTheDocument();
    },
  },

  outboundForm: {
    beforeEach: () => useScenario('outboundForm'),
    play: async () => {
      const canvas = await getOutboundCanvas();

      await expect(canvas.getByTestId('WalletViewSend.destination')).toHaveTextContent('Ethereum Treasury');
      await waitFor(() => expect(getConnectorArticle(41)).not.toHaveClass('opacity-20'));
      await waitFor(() => expect(getConnectorArticle(42)).toHaveClass('opacity-20'));
      await waitFor(() => expect(getConnectorArticle('bitcoin')).toHaveClass('opacity-20'));
      await waitFor(() => expect(canvas.getByRole('button', { name: /Initiate Transfer/ })).toBeEnabled());

      const destination = within(canvas.getByTestId('WalletViewSend.destination'));
      await userEvent.click(destination.getByTestId('input-menu-trigger'));
      await expect(canvas.queryByTestId('Bitcoin Network Address')).not.toBeInTheDocument();
      await userEvent.click(canvas.getByTestId('Ethereum Savings'));
      await waitFor(() => expect(getConnectorArticle(41)).toHaveClass('opacity-20'));
      await waitFor(() => expect(getConnectorArticle(42)).not.toHaveClass('opacity-20'));
    },
  },

  feeLoading: {
    beforeEach: () => useScenario('feeLoading'),
    play: async () => {
      const canvas = await getOutboundCanvas();

      await expect(canvas.getByRole('button', { name: /Initiate Transfer/ })).toBeDisabled();
    },
  },

  feeUnavailable: {
    beforeEach: () => useScenario('feeUnavailable'),
    play: async () => {
      const canvas = await getOutboundCanvas();

      await expectEventuallyVisible(canvas.findByText(/Unable to estimate network fees/));
      await expect(canvas.getByRole('button', { name: /Initiate Transfer/ })).toBeDisabled();
    },
  },

  insufficientEth: {
    beforeEach: () => useScenario('insufficientEth'),
    play: async () => {
      const canvas = await getOutboundCanvas();

      await expectEventuallyVisible(canvas.findByText(/Please try again with a higher gas price/));
      await expect(canvas.getByRole('button', { name: /Initiate Transfer/ })).toBeDisabled();
    },
  },

  submittingInbound: {
    beforeEach: () => useScenario('submittingInbound'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await expectProgress(canvas, ['Step 1 of 3: Finalizing on Ethereum', 'Preparing Ethereum transfer...']);
    },
  },

  inboundEthereum: {
    beforeEach: () => useScenario('inboundEthereum'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await expectProgress(canvas, ['Step 1 of 3: Finalizing on Ethereum', 'Ethereum confirmation 6 of 12']);
    },
  },

  inboundRelay: {
    beforeEach: () => useScenario('inboundRelay'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await expectProgress(canvas, ['Step 2 of 3: Proving to Argon', 'Waiting for Argon proof of 18 Ethereum blocks']);
    },
  },

  inboundArgon: {
    beforeEach: () => useScenario('inboundArgon'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await expectProgress(canvas, [
        'Step 3 of 3: Finalizing on Argon',
        'Argon confirmation 2 of 4',
        'Argon is finalizing this transfer now.',
      ]);
    },
  },

  submittingOutbound: {
    beforeEach: () => useScenario('submittingOutbound'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await expectProgress(canvas, ['Step 1 of 3: Finalizing on Argon', 'Submitting to Argon miners...']);
    },
  },

  outboundArgon: {
    beforeEach: () => useScenario('outboundArgon'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await expectProgress(canvas, ['Step 1 of 3: Finalizing on Argon', 'Argon confirmation 3 of 4']);
    },
  },

  outboundAuthorization: {
    beforeEach: () => useScenario('outboundAuthorization'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await expectProgress(canvas, ['Step 2 of 3: Waiting for Minting Authorization']);
      await expectEventuallyVisible(canvas.findByText(/45% authorized/));
    },
  },

  outboundEthereum: {
    beforeEach: () => useScenario('outboundEthereum'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await expectProgress(canvas, ['Step 3 of 3: Sending to Ethereum', 'Ethereum confirmation 9 of 12']);
    },
  },

  attentionError: {
    beforeEach: () => useScenario('attentionError'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await expectEventuallyVisible(
        canvas.findByText('Ethereum submission needs attention. The transfer remains recorded for recovery.'),
      );
      await expectEventuallyVisible(canvas.findByRole('button', { name: 'Create Another Transaction' }));
    },
  },

  completeInbound: {
    beforeEach: () => useScenario('completeInbound'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await expectProgress(canvas, ['Step 3 of 3: Finalizing on Argon', 'Confirmed on Argon.', '100.00%']);
    },
  },

  completeOutbound: {
    beforeEach: () => useScenario('completeOutbound'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await expectProgress(canvas, ['Step 3 of 3: Sending to Ethereum', 'Confirmed on Ethereum.', '100.00%']);
    },
  },
} satisfies Partial<Record<WalletTransferScenario, Story>>;

export const InboundForm = stories.inboundForm;
export const OutboundForm = stories.outboundForm;
export const FeeLoading = stories.feeLoading;
export const FeeUnavailable = stories.feeUnavailable;
export const InsufficientEth = stories.insufficientEth;
export const SubmittingInbound = stories.submittingInbound;
export const InboundEthereum = stories.inboundEthereum;
export const InboundRelay = stories.inboundRelay;
export const InboundArgon = stories.inboundArgon;
export const SubmittingOutbound = stories.submittingOutbound;
export const OutboundArgon = stories.outboundArgon;
export const OutboundAuthorization = stories.outboundAuthorization;
export const OutboundEthereum = stories.outboundEthereum;
export const AttentionError = stories.attentionError;
export const CompleteInbound = stories.completeInbound;
export const CompleteOutbound = stories.completeOutbound;

export const ArgonAddress: Story = {
  beforeEach: () => useScenario('outboundForm'),
  play: async () => {
    const canvas = await getOutboundCanvas();
    const destination = within(canvas.getByTestId('WalletViewSend.destination'));

    await userEvent.click(destination.getByTestId('input-menu-trigger'));
    await userEvent.click(canvas.getByTestId('Argon Network Address'));
    await expect(canvas.findByPlaceholderText('Enter Argon network address')).resolves.toBeVisible();
    await waitFor(() => expect(getConnectorArticle(41)).toHaveClass('opacity-20'));
    await waitFor(() => expect(getConnectorArticle(42)).toHaveClass('opacity-20'));
    await expect(canvas.queryByRole('button', { name: /Initiate Transfer/ })).not.toBeInTheDocument();
  },
};

export const BitcoinAddress: Story = {
  beforeEach: () => useScenario('outboundForm'),
  play: async () => {
    const canvas = await getOutboundCanvas();

    await userEvent.click(canvas.getAllByTestId('input-menu-trigger')[0]);
    await userEvent.click(canvas.getByTestId('BTC'));

    const destination = within(canvas.getByTestId('WalletViewSend.destination'));
    await expect(destination.findByText('Bitcoin Network Address')).resolves.toBeVisible();
    await expect(canvas.findByPlaceholderText('Enter Bitcoin network address')).resolves.toBeVisible();
    await userEvent.click(destination.getByTestId('input-menu-trigger'));
    await expect(canvas.getByTestId('Bitcoin Network Address')).toBeVisible();
    await expect(canvas.queryByTestId('Ethereum Treasury')).not.toBeInTheDocument();
    await expect(canvas.queryByTestId('Argon Network Address')).not.toBeInTheDocument();
    await waitFor(() => expect(getConnectorArticle('bitcoin')).not.toHaveClass('opacity-20'));
    await waitFor(() => expect(getConnectorArticle(41)).toHaveClass('opacity-20'));
    await waitFor(() => expect(getConnectorArticle(42)).toHaveClass('opacity-20'));
    await expect(canvas.queryByRole('button', { name: /Initiate Transfer/ })).not.toBeInTheDocument();
  },
};
