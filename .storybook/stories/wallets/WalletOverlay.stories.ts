import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { MoveToken } from '@argonprotocol/apps-core';
import { fn, mocked, userEvent, within } from 'storybook/test';
import { setupWalletScenario, type WalletScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter, { type IWalletOverlayOptions } from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';
import UpgradeToTreasuryOverlay from '../../../src-vue/overlays/UpgradeToTreasuryOverlay.vue';
import { useVaultingStats } from '../../../src-vue/stores/vaultingStats.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { getBitcoinLocks } from '../../../src-vue/stores/bitcoin.ts';
import { getEthereumMoveTracker } from '../../../src-vue/stores/moveFromEthereum.ts';
import { loadEthereumChainConfig } from '../../../src-vue/lib/EthereumClient.ts';

let request: IWalletOverlayOptions;
let showTreasuryUpgrade = false;
const isInteractive = Vue.ref(false);

const meta = {
  title: 'Wallets/Overview',
  render: () => ({
    components: { WalletOverlay, UpgradeToTreasuryOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openWalletOverlay', request));
      return { isInteractive, showTreasuryUpgrade };
    },
    template: `
      <div class="relative h-screen w-screen overflow-hidden">
        <WalletOverlay />
        <UpgradeToTreasuryOverlay v-if="showTreasuryUpgrade" />
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
  showTreasuryUpgrade = false;
  const wallets = useWallets();
  request = {
    wallet: walletType === WalletType.argon ? wallets.argonWallets.defaultArgonWallet : wallets.bitcoinWallet,
    view,
  };
  isInteractive.value = interactive;
}

async function openTokenMenu({
  moveToken,
  rightClick = false,
  rowFraction = 0.5,
}: {
  moveToken: MoveToken;
  rightClick?: boolean;
  rowFraction?: number;
}) {
  const row = await within(document.body).findByRole('button', { name: `${moveToken} actions` });
  const bounds = row.getBoundingClientRect();
  await userEvent.pointer({
    target: row,
    keys: rightClick ? '[MouseRight]' : '[MouseLeft]',
    coords: { clientX: bounds.left + bounds.width * rowFraction, clientY: bounds.top + bounds.height / 2 },
  });
}

function useTokenMenuScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinSend', true);
  mocked(loadEthereumChainConfig).mockResolvedValue({
    chainId: 1,
    gatewayAddress: '0x5555555555555555555555555555555555555555',
    argonTokenAddress: '0x6666666666666666666666666666666666666666',
    argonotTokenAddress: '0x7777777777777777777777777777777777777777',
  });
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

async function waitForWalletOverlay() {
  await within(document.body).findByTestId('WalletOverlay');
}

export const MainWallet: Story = {
  beforeEach: () => useScenario(WalletType.argon),
  play: waitForWalletOverlay,
};

export const BitcoinWalletDetails: Story = {
  beforeEach: useBitcoinWalletDetailsScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
  },
};

export const FundedBitcoinConnector: Story = {
  name: 'Funded Bitcoin connector receive',
  beforeEach: useBitcoinWalletDetailsScenario,
  play: async () => {
    const connector = document.querySelector<HTMLElement>('[data-wallet-connector-id="bitcoin"]');
    if (!connector) throw new Error('Bitcoin connector was not rendered');

    await userEvent.click(within(connector).getByText('Bitcoin', { exact: true }));
    isInteractive.value = false;
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
    await new Promise(resolve => setTimeout(resolve, 350));
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
    await within(insuranceOverlay).findByText('Unable to update Bitcoin insurance.');
  },
};

export const BitcoinConnector: Story = {
  beforeEach: () => useScenario(WalletType.argon, undefined, 'defaultArgon', true),
  play: async () => {
    await waitForWalletOverlay();
    await userEvent.click(await within(document.body).findByText('Create Channel', { exact: true }));
    isInteractive.value = false;
  },
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
    await canvas.findByText(/due in 10 days/);
  },
};

export const BitcoinPendingOutboundError: Story = {
  beforeEach: useBitcoinReleaseErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getByTestId('WalletViewMain.bitcoinSend'));
    await canvas.findByText('Unable to broadcast this Bitcoin transaction.');
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
  play: waitForWalletOverlay,
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
  play: waitForWalletOverlay,
};

export const ArgonTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    isInteractive.value = false;
  },
};

export const ArgonTokenMenuNearRowEnd: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.ARGN, rowFraction: 0.9 });
    isInteractive.value = false;
  },
};

export const ArgonotTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.ARGNOT });
    isInteractive.value = false;
  },
};

export const BitcoinTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.BTC });
    isInteractive.value = false;
  },
};

export const ArgonTokenMenuByRightClick: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.ARGN, rightClick: true, rowFraction: 0.1 });
    isInteractive.value = false;
  },
};

export const BitcoinTokenMenuByRightClick: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.BTC, rightClick: true, rowFraction: 0.9 });
    isInteractive.value = false;
  },
};

export const ArgonotTokenMenuByKeyboard: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const row = await within(document.body).findByRole('button', { name: 'ARGNOT actions' });
    row.focus();
    await userEvent.keyboard('{Enter}');
    isInteractive.value = false;
  },
};

export const ArgonTokenMenuAtZeroBalance: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    useWallets().defaultArgonWallet.availableMicrogons = 0n;
  },
  play: ArgonTokenMenu.play,
};

export const BitcoinTokenMenuAtZeroBalance: Story = {
  beforeEach: () => useScenario(WalletType.argon, undefined, 'defaultArgon', true),
  play: BitcoinTokenMenu.play,
};

export const ArgonotTokenMenuAtZeroBalance: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    useWallets().defaultArgonWallet.availableMicronots = 0n;
  },
  play: ArgonotTokenMenu.play,
};

export const TokenMenuLinksLoading: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    mocked(loadEthereumChainConfig).mockImplementation(() => new Promise(() => undefined));
  },
  play: ArgonTokenMenu.play,
};

export const TokenMenuLinksUnavailable: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    mocked(loadEthereumChainConfig).mockRejectedValue(new Error('Synthetic chain configuration failure'));
  },
  play: ArgonTokenMenu.play,
};

export const TokenMenuOnLocalEthereum: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    mocked(loadEthereumChainConfig).mockResolvedValue({
      chainId: 31337,
      gatewayAddress: '0x5555555555555555555555555555555555555555',
      argonTokenAddress: '0x6666666666666666666666666666666666666666',
      argonotTokenAddress: '0x7777777777777777777777777777777777777777',
    });
  },
  play: ArgonTokenMenu.play,
};

export const TokenMenuLinksRecovered: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    mocked(loadEthereumChainConfig).mockRejectedValueOnce(new Error('Synthetic chain configuration failure'));
  },
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    await canvas.findByText('Token links unavailable. Reopen this menu to retry.');
    await userEvent.keyboard('{Escape}');
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    isInteractive.value = false;
  },
};

export const SendArgonFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Send ARGN' }));
    isInteractive.value = false;
  },
};

export const SendArgonotFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGNOT });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Send ARGNOT' }));
    isInteractive.value = false;
  },
};

export const SendBitcoinFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.BTC });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Send BTC' }));
    isInteractive.value = false;
  },
};

export const ReceiveArgonFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Receive ARGN' }));
    isInteractive.value = false;
  },
};

export const ReceiveBitcoinFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.BTC });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Receive BTC' }));
    isInteractive.value = false;
  },
};

export const RequestTreasuryAccessFromBitcoinChannels: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    showTreasuryUpgrade = true;
    Object.assign(useVaultingStats(), { argonBondsAPR: 7.2, argonotStakingAPR: 4.6 });
  },
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.BTC });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Receive BTC' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Click to request access.' }));
    await canvas.findByText('Put Your Assets to Work');
    isInteractive.value = false;
  },
};

export const ReceiveArgonotFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGNOT });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Receive ARGNOT' }));
    isInteractive.value = false;
  },
};

export const SendEmptyWallet: Story = {
  beforeEach: () => {
    useScenario(WalletType.argon, 'send');
    Object.assign(useWallets().defaultArgonWallet, {
      availableMicrogons: 0n,
      reservedMicrogons: 0n,
      totalMicrogons: 0n,
      availableMicronots: 0n,
      totalMicronots: 0n,
    });
  },
  play: waitForWalletOverlay,
};

export const SendBitcoinOnlyWallet: Story = {
  beforeEach: () => {
    useBitcoinSendScenario();
    Object.assign(useWallets().defaultArgonWallet, {
      availableMicrogons: 0n,
      reservedMicrogons: 0n,
      totalMicrogons: 0n,
      availableMicronots: 0n,
      totalMicronots: 0n,
    });
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
  },
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
  },
};

export const ReceiveTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'receive', 'defaultArgon', true),
  play: waitForWalletOverlay,
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
  play: waitForWalletOverlay,
};
