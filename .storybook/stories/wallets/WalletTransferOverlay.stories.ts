import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { MoveFrom, MoveTo, MoveToken } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { fn, userEvent, within } from 'storybook/test';
import { setupWalletTransferScenario, type WalletTransferScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter, { type IWalletOverlayOptions } from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';
import type { ITransactionMoveMetadata } from '../../../src-vue/lib/txs/Balance.transfer.ts';
import type { TransactionInfo } from '../../../src-vue/lib/TransactionInfo.ts';
import { getMoveCapital, useWallets } from '../../../src-vue/stores/wallets.ts';

let request: IWalletOverlayOptions;

const meta = {
  title: 'Wallets/Cross-chain transfer',
  render: () => ({
    components: { WalletOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openWalletOverlay', request));
    },
    template: `
      <div class="relative h-screen w-screen overflow-hidden">
        <WalletOverlay />
      </div>
    `,
  }),
} satisfies Meta<typeof WalletOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

function useScenario(state: WalletTransferScenario, restoreArgonTransfer = false) {
  const scenario = setupWalletTransferScenario(state);
  if (restoreArgonTransfer) {
    getMoveCapital().data.pendingExternalTransfer = {
      tx: {
        id: 52,
        metadataJson: {
          moveFrom: MoveFrom.DefaultArgon,
          moveTo: MoveTo.External,
          externalAddress: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
          assetsToMove: { [MoveToken.ARGN]: 125_000_000n },
        },
      },
      getStatus: fn(() => ({ progressPct: 42, isFinalized: false, error: undefined })),
      subscribeToProgress: fn(callback => {
        void callback(
          {
            progressPct: 42,
            progressMessage: 'Waiting for 3rd Block...',
            confirmations: 1,
            expectedConfirmations: 4,
            isMaxed: false,
          },
          undefined,
        );
        return fn();
      }),
    } as unknown as TransactionInfo<ITransactionMoveMetadata>;
  }
  const isInbound = [
    'inboundForm',
    'inboundEmpty',
    'inboundArgonOnly',
    'existingInbound',
    'submittingInbound',
    'inboundEthereum',
    'inboundTransactionUnavailable',
    'inboundRelay',
    'inboundArgon',
    'completeInbound',
  ].includes(state);
  const ethereumWallet = useWallets().ethereumWallets.find(41);
  if (isInbound && !ethereumWallet) throw new Error('Ethereum Treasury story wallet is missing.');
  request = isInbound
    ? {
        wallet: ethereumWallet!,
        view: 'main',
      }
    : {
        wallet: useWallets().argonWallets.defaultArgonWallet,
        view: 'send',
      };
  return scenario.cleanup;
}

async function getInboundCanvas() {
  return within(document.body);
}

async function getOutboundCanvas() {
  return within(document.body);
}

async function submitTransfer(canvas: ReturnType<typeof within>) {
  await userEvent.click(await canvas.findByRole('button', { name: /Initiate Transfer/ }));
}

const stories = {
  inboundForm: {
    beforeEach: () => useScenario('inboundForm'),
  },

  inboundEmpty: {
    beforeEach: () => useScenario('inboundEmpty'),
  },

  inboundArgonOnly: {
    beforeEach: () => useScenario('inboundArgonOnly'),
    play: async () => {
      const canvas = await getInboundCanvas();

      await userEvent.click(canvas.getByTestId('ConnectorTransfer.token'));
    },
  },

  outboundForm: {
    beforeEach: () => useScenario('outboundForm'),
  },

  feeLoading: {
    beforeEach: () => useScenario('feeLoading'),
  },

  feeUnavailable: {
    beforeEach: () => useScenario('feeUnavailable'),
  },

  insufficientEth: {
    beforeEach: () => useScenario('insufficientEth'),
  },

  submittingInbound: {
    beforeEach: () => useScenario('submittingInbound'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await submitTransfer(canvas);
    },
  },

  inboundEthereum: {
    beforeEach: () => useScenario('inboundEthereum'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await submitTransfer(canvas);
    },
  },

  inboundTransactionUnavailable: {
    beforeEach: () => useScenario('inboundTransactionUnavailable'),
  },

  inboundRelay: {
    beforeEach: () => useScenario('inboundRelay'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await submitTransfer(canvas);
    },
  },

  inboundArgon: {
    beforeEach: () => useScenario('inboundArgon'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await submitTransfer(canvas);
    },
  },

  submittingOutbound: {
    beforeEach: () => useScenario('submittingOutbound'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await submitTransfer(canvas);
    },
  },

  outboundArgon: {
    beforeEach: () => useScenario('outboundArgon'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await submitTransfer(canvas);
    },
  },

  outboundAuthorization: {
    beforeEach: () => useScenario('outboundAuthorization'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await submitTransfer(canvas);
    },
  },

  outboundEthereum: {
    beforeEach: () => useScenario('outboundEthereum'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await submitTransfer(canvas);
    },
  },

  attentionError: {
    beforeEach: () => useScenario('attentionError'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await submitTransfer(canvas);
    },
  },

  completeInbound: {
    beforeEach: () => useScenario('completeInbound'),
    play: async () => {
      const canvas = await getInboundCanvas();
      await submitTransfer(canvas);
    },
  },

  completeOutbound: {
    beforeEach: () => useScenario('completeOutbound'),
    play: async () => {
      const canvas = await getOutboundCanvas();
      await submitTransfer(canvas);
    },
  },

  existingInbound: {
    beforeEach: () => useScenario('existingInbound'),
  },

  existingOutbound: {
    beforeEach: () => useScenario('existingOutbound'),
  },
} satisfies Partial<Record<WalletTransferScenario, Story>>;

export const InboundForm = stories.inboundForm;
export const InboundEmpty = stories.inboundEmpty;
export const InboundArgonOnly = stories.inboundArgonOnly;
export const OutboundForm = stories.outboundForm;
export const FeeLoading = stories.feeLoading;
export const FeeUnavailable = stories.feeUnavailable;
export const InsufficientEth = stories.insufficientEth;
export const SubmittingInbound = stories.submittingInbound;
export const InboundEthereum = stories.inboundEthereum;
export const InboundTransactionUnavailable = stories.inboundTransactionUnavailable;
export const InboundRelay = stories.inboundRelay;
export const InboundArgon = stories.inboundArgon;
export const SubmittingOutbound = stories.submittingOutbound;
export const OutboundArgon = stories.outboundArgon;
export const OutboundAuthorization = stories.outboundAuthorization;
export const OutboundEthereum = stories.outboundEthereum;
export const AttentionError = stories.attentionError;
export const CompleteInbound = stories.completeInbound;
export const CompleteOutbound = stories.completeOutbound;
export const ExistingInbound = stories.existingInbound;
export const ExistingOutbound = stories.existingOutbound;

export const ArgonAddress: Story = {
  beforeEach: () => useScenario('outboundForm'),
  play: async () => {
    const canvas = await getOutboundCanvas();
    const destination = within(canvas.getByTestId('WalletViewSend.destination'));

    await userEvent.click(destination.getByTestId('WalletViewSend.destinationMenu'));
    await userEvent.click(canvas.getByTestId('Another Argon Wallet'));
  },
};

export const ExistingArgonAddress: Story = {
  beforeEach: () => useScenario('outboundForm', true),
};

export const BitcoinAddress: Story = {
  beforeEach: () => useScenario('outboundBitcoin'),
  play: async () => {
    const canvas = await getOutboundCanvas();

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));

    const destination = within(canvas.getByTestId('WalletViewSend.destination'));
    await userEvent.click(destination.getByTestId('WalletViewSend.destinationMenu'));
  },
};
