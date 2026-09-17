import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, fn, userEvent, within } from 'storybook/test';
import { setupWalletScenario, type WalletScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter, { type IWalletOverlayOptions } from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { getBitcoinLocks } from '../../../src-vue/stores/bitcoin.ts';
import { getEthereumMoveTracker } from '../../../src-vue/stores/moveFromEthereum.ts';

let request: IWalletOverlayOptions;
let isInteractive = false;

const meta = {
  title: 'Wallets/Overview',
  render: () => ({
    components: { WalletOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openWalletOverlay', request));
      return { isInteractive };
    },
    template: `
      <div class="relative h-screen w-screen overflow-hidden">
        <WalletOverlay />
        <div
          v-if="!isInteractive"
          data-testid="WalletOverlay.fixedPreviewGuard"
          class="fixed inset-0 z-[999] cursor-not-allowed"
          aria-label="Wallet controls are disabled in this fixed preview"
          title="Wallet controls are disabled in this fixed preview"
        >
          <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
            Controls are disabled in this fixed preview.
          </span>
        </div>
      </div>
    `,
  }),
} satisfies Meta<typeof WalletOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

function useScenario(
  walletType: WalletType.argon | WalletType.bitcoin,
  view?: IWalletOverlayOptions['view'],
  scenario: WalletScenario = 'defaultArgon',
  interactive = false,
) {
  setupWalletScenario(scenario);
  const wallets = useWallets();
  request = {
    wallet: walletType === WalletType.argon ? wallets.argonWallets.defaultArgonWallet : wallets.bitcoinWallet,
    view,
  };
  isInteractive = interactive;
}

function useBitcoinSendScenario() {
  useScenario(WalletType.argon, 'send', 'bitcoinSend', true);
}

function useBitcoinWalletDetailsScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletDetails', true);
}

function useBitcoinWalletInsurancePendingScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsurancePending', true);
}

function useBitcoinWalletInsuranceUnavailableScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsuranceUnavailable', true);
}

function useBitcoinWalletInsurancePriceIncreaseScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsurancePriceIncrease', true);
}

function useBitcoinWalletInsuranceSubmittingScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsuranceSubmitting', true);
}

function useBitcoinWalletInsuranceErrorScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsuranceError', true);
}

function useBitcoinFeeErrorScenario() {
  useBitcoinSendScenario();
  const calculateBitcoinNetworkFee = getBitcoinLocks().calculateBitcoinNetworkFee as ReturnType<typeof fn>;
  calculateBitcoinNetworkFee.mockRejectedValueOnce(new Error('Unable to estimate network fees.'));
}

function usePendingBitcoinFundingScenario() {
  useScenario(WalletType.argon, undefined, 'pendingBitcoinFunding', true);
}

function usePendingTransferLoadErrorScenario() {
  usePendingBitcoinFundingScenario();
  const loadInboundTransfers = getEthereumMoveTracker().load as ReturnType<typeof fn>;
  loadInboundTransfers.mockRejectedValueOnce(new Error('Synthetic inbound transfer load failure.'));
}

function usePendingBitcoinReleaseScenario() {
  useScenario(WalletType.argon, undefined, 'pendingBitcoinRelease', true);
}

function useBitcoinReleaseWaitingScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletReleaseWaiting', true);
}

function useBitcoinReleaseErrorScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletReleaseError', true);
}

function useBitcoinReleaseFailedScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletReleaseFailed', true);
}

function useBitcoinUnattachedDepositScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinUnattachedDeposit', true);
}

export const MainWallet: Story = {
  beforeEach: () => useScenario(WalletType.argon),
};

export const BitcoinWalletDetails: Story = {
  beforeEach: useBitcoinWalletDetailsScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
  },
};

export const FundedBitcoinConnector: Story = {
  beforeEach: useBitcoinWalletDetailsScenario,
  play: async () => {
    const connector = document.querySelector<HTMLElement>('[data-wallet-connector-id="bitcoin"]');
    if (!connector) throw new Error('Bitcoin connector was not rendered');

    await userEvent.click(within(connector).getByRole('button'));
  },
};

export const UpdateInsurancePending: Story = {
  beforeEach: useBitcoinWalletInsurancePendingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    const channelRow = canvas.getAllByRole('button', { name: /Channel/ })[0];
    await userEvent.click(channelRow);
  },
};

export const UpdateInsuranceWithoutCosignerCapacity: Story = {
  beforeEach: useBitcoinWalletInsuranceUnavailableScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
  },
};

export const UpdateInsuranceAfterBitcoinPriceIncrease: Story = {
  beforeEach: useBitcoinWalletInsurancePriceIncreaseScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
  },
};

export const UpdatingInsurance: Story = {
  beforeEach: useBitcoinWalletInsuranceSubmittingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
    const insuranceOverlay = await canvas.findByTestId('ConnectorChannel');
    const amount = within(insuranceOverlay).getByTestId('input-number');
    await userEvent.click(amount);
    await userEvent.keyboard('{Control>}a{/Control}600');
    await userEvent.click(within(insuranceOverlay).getByRole('button', { name: 'Update Insurance' }));
  },
};

export const UpdateInsuranceError: Story = {
  beforeEach: useBitcoinWalletInsuranceErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
    const insuranceOverlay = await canvas.findByTestId('ConnectorChannel');
    const amount = within(insuranceOverlay).getByTestId('input-number');
    await userEvent.click(amount);
    await userEvent.keyboard('{Control>}a{/Control}600');
    await userEvent.click(within(insuranceOverlay).getByRole('button', { name: 'Update Insurance' }));
  },
};

export const BitcoinConnector: Story = {
  beforeEach: () => useScenario(WalletType.bitcoin),
};

export const BitcoinChannelFundingPending: Story = {
  beforeEach: usePendingBitcoinFundingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: '1 Transfer Pending' }));
  },
};

export const BitcoinChannelReleasePending: Story = {
  beforeEach: usePendingBitcoinReleaseScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: '1 Transfer Pending' }));
  },
};

export const BitcoinPendingOutbound: Story = {
  beforeEach: useBitcoinReleaseWaitingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
  },
};

export const BitcoinPendingOutboundProgress: Story = {
  beforeEach: useBitcoinReleaseWaitingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getByTestId('WalletViewMain.bitcoinSend'));
    await expect(await canvas.findByText(/due in 10 days/)).toBeVisible();
  },
};

export const BitcoinPendingOutboundError: Story = {
  beforeEach: useBitcoinReleaseErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getByTestId('WalletViewMain.bitcoinSend'));
    await expect(await canvas.findByText('Unable to broadcast this Bitcoin transaction.')).toBeVisible();
  },
};

export const BitcoinFailedOutbound: Story = {
  beforeEach: useBitcoinReleaseFailedScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getByTestId('WalletViewMain.bitcoinSend'));
  },
};

export const BitcoinFailedOutboundInTransfers: Story = {
  beforeEach: useBitcoinReleaseFailedScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: '1 Transfer Needs Attention' }));
  },
};

export const BitcoinUnattachedDeposit: Story = {
  beforeEach: useBitcoinUnattachedDepositScenario,
};

export const BitcoinUnattachedDepositReturn: Story = {
  beforeEach: useBitcoinUnattachedDepositScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByTestId('WalletViewMain.unattachedBitcoinDeposit'));
  },
};

export const PendingTransferLoadFailureKeepsAvailableRows: Story = {
  beforeEach: usePendingTransferLoadErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: '1 Transfer Pending' }));
  },
};

export const SendTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send'),
};

export const SendTokensFromWallet: Story = {
  beforeEach: () => useScenario(WalletType.argon, undefined, 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(canvas.getByTestId('WalletViewMain.openSend()'));
  },
};

export const SendBitcoinFromChannels: Story = {
  beforeEach: useBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    const amount = within(canvas.getByTestId('WalletViewSend.amount')).getByTestId('input-number');
    await userEvent.clear(amount);
    await userEvent.type(amount, '0.025');
    await userEvent.type(
      canvas.getByTestId('WalletTransferForm.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
  },
};

export const SendBitcoinFeeError: Story = {
  beforeEach: useBitcoinFeeErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await userEvent.type(
      canvas.getByTestId('WalletTransferForm.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
  },
};

export const SendBitcoinReactsToLiquidAllocation: Story = {
  beforeEach: useBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));

    const newlyAllocatedChannel = getBitcoinLocks()
      .getAllLocks()
      .find(channel => channel.lockId === 101)!;
    newlyAllocatedChannel.fissionedSatoshis = newlyAllocatedChannel.fundedSatoshis;
    await Vue.nextTick();
  },
};

export const SendBitcoinAtZeroBalance: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
  },
};

export const ReceiveTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'receive', 'defaultArgon', true),
};

export const PrivateKey: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'privateKey', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show' }));
  },
};

export const PrivateKeyExportError: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'privateKey', 'privateKeyError'),
};
