import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { fn, userEvent, within } from 'storybook/test';
import { setupWalletScenario } from '../../scenarios/setupWalletScenario.ts';
import { createBitcoinUtxo } from '../../scenarios/setupBitcoinOverlayScenario.ts';
import basicEmitter, { type IWalletOverlayOptions } from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from '../../../src-vue/stores/bitcoin.ts';
import { getEthereumMoveTracker } from '../../../src-vue/stores/moveFromEthereum.ts';
import { BitcoinUtxoRole, BitcoinUtxoStatus } from '../../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import AppScreen from '../../components/AppScreen.vue';
import Home from '../../../src-vue/screens/Home.vue';

let request: IWalletOverlayOptions;
let isInteractive = false;
let finishFirstBitcoinReleaseInitiation: () => void;
let waitForSecondBitcoinReleaseInitiation: Promise<void>;

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
  scenario:
    | 'defaultArgon'
    | 'pendingBitcoinFunding'
    | 'pendingBitcoinRelease'
    | 'bitcoinSend'
    | 'bitcoinSendLocked'
    | 'bitcoinWalletDetails'
    | 'bitcoinWalletInsurancePending'
    | 'bitcoinWalletInsuranceUnavailable'
    | 'bitcoinWalletInsurancePriceIncrease'
    | 'bitcoinWalletInsuranceSubmitting'
    | 'bitcoinWalletInsuranceError'
    | 'privateKeyError' = 'defaultArgon',
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

function useLockedBitcoinSendScenario() {
  useScenario(WalletType.argon, 'send', 'bitcoinSendLocked', true);
}

function useBitcoinWalletDetailsScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletDetails', true);
}

function usePendingBitcoinDepositScenario() {
  useBitcoinWalletDetailsScenario();
  const lock = getBitcoinLocks().getAllLocks()[0];
  const fundingRecord = createBitcoinUtxo({
    id: 301,
    lockUtxoId: lock.utxoId!,
    role: BitcoinUtxoRole.Funding,
    status: BitcoinUtxoStatus.FundingUtxo,
    satoshis: lock.fundedSatoshis,
  });
  lock.fundingUtxo = fundingRecord;
  lock.utxos = [
    fundingRecord,
    createBitcoinUtxo({
      id: 302,
      lockUtxoId: lock.utxoId!,
      status: BitcoinUtxoStatus.SeenOnMempool,
      satoshis: 1_000_000n,
    }),
  ];
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

function useMultiChannelSendFailureScenario() {
  useBitcoinSendScenario();
  const bitcoinReleaseSubmit = getBitcoinTransactionOperations().bitcoinLockRelease.submit as ReturnType<typeof fn>;
  let markSecondBitcoinReleaseInitiation: () => void;
  waitForSecondBitcoinReleaseInitiation = new Promise(resolve => {
    markSecondBitcoinReleaseInitiation = resolve;
  });
  bitcoinReleaseSubmit.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishFirstBitcoinReleaseInitiation = () => resolve(undefined);
      }),
  );
  bitcoinReleaseSubmit.mockImplementationOnce(async () => {
    markSecondBitcoinReleaseInitiation();
    throw new Error('Synthetic second release initiation failure.');
  });
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

export const PendingBitcoinDeposit: Story = {
  render: () => ({
    components: { AppScreen, Home },
    template: '<AppScreen interactive><Home /></AppScreen>',
  }),
  beforeEach: usePendingBitcoinDepositScenario,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByTestId('LeftBar.bitcoinDepositAttention'));
    await within(canvasElement.ownerDocument.body).findByRole('tooltip');
  },
};

export const PendingBitcoinDepositWalletOverlay: Story = {
  beforeEach: usePendingBitcoinDepositScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Review unattached Bitcoin deposits' }));
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

export const SendBitcoinFromChannels: Story = {
  beforeEach: useBitcoinSendScenario,
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

export const SendBitcoinLockedInLiquid: Story = {
  beforeEach: useLockedBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await userEvent.click(canvas.getByRole('button', { name: 'Details' }));
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
      .find(channel => channel.utxoId === 101)!;
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

export const MultiChannelSendInitiationFailure: Story = {
  beforeEach: useMultiChannelSendFailureScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await userEvent.type(
      canvas.getByTestId('WalletTransferForm.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
    await userEvent.click(await canvas.findByRole('button', { name: /Send Bitcoin/ }));
    await waitForSecondBitcoinReleaseInitiation;
    finishFirstBitcoinReleaseInitiation();
    await canvas.findByText('Synthetic second release initiation failure.');
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
