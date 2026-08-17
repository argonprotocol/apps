import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import { setupWalletTransferScenario, type WalletTransferScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletDialogs from '../../../src-vue/wallets/WalletDialogs.vue';

const meta = {
  title: 'Wallets/Cross-chain transfer',
  render: () => ({
    components: { WalletDialogs },
    setup() {
      Vue.onMounted(() => {
        basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
      });
    },
    template: `
      <div class="relative h-screen w-screen overflow-hidden">
        <WalletDialogs />
      </div>
    `,
  }),
} satisfies Meta<typeof WalletDialogs>;

export default meta;
type Story = StoryObj<typeof meta>;

function useScenario(state: WalletTransferScenario) {
  const scenario = setupWalletTransferScenario(state);
  return scenario.cleanup;
}

async function getWalletCanvas(direction: 'in' | 'out') {
  const canvas = within(document.body);
  const panelTestId = direction === 'in' ? 'WalletOverlay.transferInPanel' : 'WalletOverlay.transferOutPanel';
  const toggleTestId = direction === 'in' ? 'WalletOverlay.toggleTransferIn()' : 'WalletOverlay.toggleTransferOut()';
  const moveTestId =
    direction === 'in' ? 'EthereumTop.startMoveFromEthereum(ARGN)' : 'ArgonTop.startMoveToEthereum(ARGN)';

  await expectEventuallyVisible(canvas.findByText('Internal App Wallet'));
  await userEvent.click(canvas.getByTestId(toggleTestId));

  const chooser = await canvas.findByTestId(panelTestId);
  const ethereumWalletLabel = within(chooser).getByText('Ethereum Treasury Wallet');
  const ethereumWalletButton = ethereumWalletLabel.closest('button');
  if (!ethereumWalletButton) throw new Error('Ethereum wallet chooser button is missing');

  await userEvent.click(ethereumWalletButton);
  await expectEventuallyVisible(canvas.findByTestId(panelTestId));
  await expect(canvas.getByTestId(panelTestId)).toHaveTextContent('Ethereum Treasury Wallet');

  const moveButton = canvas.getByTestId(moveTestId);
  await waitFor(() => expect(moveButton).toBeEnabled());
  await userEvent.click(moveButton);
  return canvas;
}

const stories = {
  inboundForm: {
    beforeEach: () => useScenario('inboundForm'),
    play: async () => {
      const canvas = await getWalletCanvas('in');

      await expectEventuallyVisible(canvas.findByRole('heading', { name: 'Move From Ethereum' }));
      await expectEventuallyVisible(canvas.findByText('Max you can move: 175 ARGN'));
      await expectEventuallyVisible(canvas.findByText(/Estimated network fee:/));
      await expectEventuallyVisible(canvas.findByRole('button', { name: 'Cancel' }));
      await expect(canvas.getByRole('button', { name: 'Submit' })).toBeEnabled();
    },
  },

  outboundForm: {
    beforeEach: () => useScenario('outboundForm'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(canvas.findByRole('heading', { name: 'Move To Ethereum' }));
      await expectEventuallyVisible(canvas.findByText(/Max you can move: 875 ARGN/));
      await expectEventuallyVisible(canvas.findByText(/Estimated Ethereum fee range:/));
      await expect(canvas.getByRole('button', { name: 'Submit' })).toBeEnabled();
    },
  },

  feeLoading: {
    beforeEach: () => useScenario('feeLoading'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(canvas.findByText('Estimating final Ethereum network fee...'));
      await expect(canvas.getByRole('button', { name: 'Submit' })).toBeEnabled();
    },
  },

  feeUnavailable: {
    beforeEach: () => useScenario('feeUnavailable'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(canvas.findByText('Unable to estimate the final Ethereum fee right now.'));
      await expect(canvas.getByRole('button', { name: 'Submit' })).toBeEnabled();
    },
  },

  insufficientEth: {
    beforeEach: () => useScenario('insufficientEth'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(canvas.findByText(/Your Ethereum wallet has/));
      await expectEventuallyVisible(canvas.findByText(/but this transfer likely needs between/));
    },
  },

  routeUnavailable: {
    beforeEach: () => useScenario('routeUnavailable'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(
        canvas.getByText(
          'Ethereum state is still syncing. Transfers out will be available once finalized Ethereum state is available on Argon.',
        ),
      );
      await expect(canvas.getByRole('button', { name: 'Submit' })).toBeDisabled();
    },
  },

  submittingInbound: {
    beforeEach: () => useScenario('submittingInbound'),
    play: async () => {
      const canvas = await getWalletCanvas('in');

      await expectEventuallyVisible(canvas.findByText('Step 1 of 3: Finalizing on Ethereum'));
      await expectEventuallyVisible(canvas.findByText('Preparing Ethereum transfer...'));
      await expect(canvas.queryByTestId('WalletTransferOverlay.close()')).not.toBeInTheDocument();
    },
  },

  inboundEthereum: {
    beforeEach: () => useScenario('inboundEthereum'),
    play: async () => {
      const canvas = await getWalletCanvas('in');

      await expectEventuallyVisible(canvas.findByText('Step 1 of 3: Finalizing on Ethereum'));
      await expectEventuallyVisible(canvas.findByText('Ethereum confirmation 6 of 12'));
    },
  },

  inboundRelay: {
    beforeEach: () => useScenario('inboundRelay'),
    play: async () => {
      const canvas = await getWalletCanvas('in');

      await expectEventuallyVisible(canvas.findByText('Step 2 of 3: Proving to Argon'));
      await expectEventuallyVisible(canvas.findByText('Waiting for Argon proof of 18 Ethereum blocks'));
    },
  },

  inboundArgon: {
    beforeEach: () => useScenario('inboundArgon'),
    play: async () => {
      const canvas = await getWalletCanvas('in');

      await expectEventuallyVisible(canvas.findByText('Step 3 of 3: Finalizing on Argon'));
      await expectEventuallyVisible(canvas.findByText('Argon confirmation 2 of 4'));
      await expectEventuallyVisible(canvas.findByText('Argon is finalizing this transfer now.'));
    },
  },

  submittingOutbound: {
    beforeEach: () => useScenario('submittingOutbound'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(canvas.findByText('Step 1 of 3: Finalizing on Argon'));
      await expectEventuallyVisible(canvas.findByText('Submitting to Argon miners...'));
      await expect(canvas.queryByTestId('WalletTransferOverlay.close()')).not.toBeInTheDocument();
    },
  },

  outboundArgon: {
    beforeEach: () => useScenario('outboundArgon'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(canvas.findByText('Step 1 of 3: Finalizing on Argon'));
      await expectEventuallyVisible(canvas.findByText('Argon confirmation 3 of 4'));
    },
  },

  outboundAuthorization: {
    beforeEach: () => useScenario('outboundAuthorization'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(canvas.findByText('Step 2 of 3: Waiting for Minting Authorization'));
      await expectEventuallyVisible(canvas.findByText(/45% authorized/));
      await expectEventuallyVisible(canvas.findByText(/115\.00 ARGN remaining/));
    },
  },

  outboundEthereum: {
    beforeEach: () => useScenario('outboundEthereum'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(canvas.findByText('Step 3 of 3: Sending to Ethereum'));
      await expectEventuallyVisible(canvas.findByText('Ethereum confirmation 9 of 12'));
    },
  },

  attentionError: {
    beforeEach: () => useScenario('attentionError'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(
        canvas.getByText('Ethereum submission needs attention. The transfer remains recorded for recovery.'),
      );
      await expectEventuallyVisible(canvas.findByRole('button', { name: 'Dismiss' }));
    },
  },

  completeInbound: {
    beforeEach: () => useScenario('completeInbound'),
    play: async () => {
      const canvas = await getWalletCanvas('in');

      await expectEventuallyVisible(canvas.findByText('Step 3 of 3: Finalizing on Argon'));
      await expectEventuallyVisible(canvas.findByText('Confirmed on Argon.'));
      await expectEventuallyVisible(canvas.findByText('100.00%'));
      await expectEventuallyVisible(canvas.findByRole('button', { name: 'Done' }));
    },
  },

  completeOutbound: {
    beforeEach: () => useScenario('completeOutbound'),
    play: async () => {
      const canvas = await getWalletCanvas('out');

      await expectEventuallyVisible(canvas.findByText('Step 3 of 3: Sending to Ethereum'));
      await expectEventuallyVisible(canvas.findByText('Confirmed on Ethereum.'));
      await expectEventuallyVisible(canvas.findByText('100.00%'));
      await expectEventuallyVisible(canvas.findByRole('button', { name: 'Done' }));
    },
  },
} satisfies Record<WalletTransferScenario, Story>;

export const InboundForm = stories.inboundForm;
export const OutboundForm = stories.outboundForm;
export const FeeLoading = stories.feeLoading;
export const FeeUnavailable = stories.feeUnavailable;
export const InsufficientEth = stories.insufficientEth;
export const RouteUnavailable = stories.routeUnavailable;
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
