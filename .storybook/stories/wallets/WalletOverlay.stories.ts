import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, fn, userEvent, within } from 'storybook/test';
import { setupWalletScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter, { type IWalletOverlayOptions } from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';
import { useWallets } from '../../../src-vue/stores/wallets.ts';

let request: IWalletOverlayOptions;
let isInteractive = false;
let ethereumBalanceRefreshes: ReturnType<typeof fn>[] = [];

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

function useFocusRefreshScenario() {
  useScenario(WalletType.argon, undefined, 'defaultArgon', true);
  ethereumBalanceRefreshes = useWallets().ethereumWallets.persistedWallets.map(wallet => {
    const refresh = fn(async () => undefined);
    wallet.refresh = refresh;
    return refresh;
  });
}

function usePendingBitcoinFundingScenario() {
  useScenario(WalletType.argon, undefined, 'pendingBitcoinFunding', true);
}

function usePendingBitcoinReleaseScenario() {
  useScenario(WalletType.argon, undefined, 'pendingBitcoinRelease', true);
}

export const MainWallet: Story = {
  beforeEach: () => useScenario(WalletType.argon),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Internal App Wallet')).resolves.toBeVisible();
    await expect(canvas.getByText('Ethereum Treasury')).toBeVisible();
    await expect(canvas.getByText('Ethereum Savings')).toBeVisible();
    await expect(
      canvas.getByTestId('WalletOverlay').querySelector('rect[width^="calc"], rect[height^="calc"]'),
    ).toBeNull();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};

export const RefreshEthereumBalancesOnFocus: Story = {
  beforeEach: useFocusRefreshScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Internal App Wallet')).resolves.toBeVisible();
    window.dispatchEvent(new Event('focus'));
    for (const refresh of ethereumBalanceRefreshes) await expect(refresh).toHaveBeenCalledOnce();

    ethereumBalanceRefreshes.forEach(refresh => refresh.mockClear());
    await userEvent.click(canvas.getByTestId('WalletOverlay.closeRight()'));
    window.dispatchEvent(new Event('focus'));
    for (const refresh of ethereumBalanceRefreshes) expect(refresh).not.toHaveBeenCalled();
  },
};

export const BitcoinConnector: Story = {
  beforeEach: () => useScenario(WalletType.bitcoin),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Create Bitcoin Channel')).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};

export const BitcoinChannelFundingPending: Story = {
  beforeEach: usePendingBitcoinFundingScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('button', { name: '1 Transfer Pending' })).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay').querySelector('.transfer-particle-right')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: '1 Transfer Pending' }));
    await expect(canvas.findByText('0.05 BTC from Bitcoin Network to Testing Channel')).resolves.toBeVisible();
    await expect(canvas.getByText(/Bitcoin confirmation 2 of 4/)).toBeVisible();
  },
};

export const BitcoinChannelReleasePending: Story = {
  beforeEach: usePendingBitcoinReleaseScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('button', { name: '1 Transfer Pending' })).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay').querySelector('.transfer-particle-left')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: '1 Transfer Pending' }));
    await expect(canvas.findByText(/0.05 BTC from Testing Channel to /)).resolves.toBeVisible();
    await expect(canvas.getByText(/Bitcoin confirmation 2 of 4/)).toBeVisible();
  },
};

export const SendTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Send From Internal' })).resolves.toBeVisible();
    await expect(canvas.findByTestId('WalletViewSend.destination')).resolves.toBeVisible();
    await expect(document.querySelectorAll('article.opacity-20')).toHaveLength(0);
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};

export const SendBitcoinFromChannels: Story = {
  beforeEach: useBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Send From Internal' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await expect(canvas.getByTestId('WalletViewSend.amount')).toHaveTextContent('0.03');
    await expect(canvas.findByText(/0.04 BTC is used by Liquids/)).resolves.toBeVisible();
    await expect(canvas.getByText('Bitcoin Network Speed')).toBeVisible();
    await expect(canvas.queryByText(/how much you're willing to pay/)).not.toBeInTheDocument();
    await expect(canvas.getByTestId('WalletViewSend.bitcoinFeeRate')).not.toHaveClass('h-auto', 'py-3');
    await userEvent.type(
      canvas.getByTestId('WalletTransferForm.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
    const costOfSend = within(canvas.getByTestId('WalletViewSend.cost'));
    await expect(costOfSend.findByText('Bitcoin Network')).resolves.toBeVisible();
    await expect(costOfSend.getByText('Argon Network')).toBeVisible();
    await expect(canvas.findByRole('button', { name: /Send Bitcoin/ })).resolves.toBeEnabled();
  },
};

export const SendBitcoinLockedInLiquid: Story = {
  beforeEach: useLockedBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await expect(canvas.getByTestId('WalletViewSend.maximum')).toHaveTextContent('0 BTC');
    await expect(
      canvas.getByText('No Bitcoin is available to send. Channels must have no active Liquids to send BTC.'),
    ).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Open Wallet' })).not.toBeInTheDocument();
    await expect(canvas.queryByTestId('WalletViewSend.destination')).not.toBeInTheDocument();
    await expect(canvas.queryByText('Bitcoin Network Speed')).not.toBeInTheDocument();
    await expect(canvas.queryByTestId('WalletViewSend.cost')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Details' }));
    await expect(
      canvas.getByText('Bitcoin used by active Liquids cannot be sent until those Liquids are closed.'),
    ).toBeVisible();
    await expect(canvas.getByText('Cosigner: Testing')).toBeVisible();
    await expect(canvas.queryByText(/does not have enough ARGN/)).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /Send Bitcoin/ })).toBeDisabled();
  },
};

export const CloseReturnsToMain: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Send From Internal' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletOverlay.closeRight()'));
    await expect(canvas.findByText('Internal App Wallet')).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay')).toBeVisible();
  },
};

export const BackClosesOpenSendMenu: Story = {
  beforeEach: useBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Send From Internal' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await userEvent.click(canvas.getByTestId('WalletViewSend.destinationMenu'));
    await expect(canvas.findByTestId('Bitcoin Network Address')).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletHeader.back()'));
    await expect(canvas.findByText('Internal App Wallet')).resolves.toBeVisible();
  },
};

export const ReceiveTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'receive', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Receive Into Internal' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletViewReceive.address.copyContent()'));
    await expect(navigator.clipboard.writeText).toHaveBeenCalledWith('5StorybookInternalArgonWallet');
    await userEvent.click(canvas.getByTestId('WalletViewReceive.openBitcoinConnector()'));
    await expect(canvas.findByText('Create Bitcoin Channel')).resolves.toBeVisible();
  },
};

export const PrivateKey: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'privateKey', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Private Key' })).resolves.toBeVisible();
    await expect(canvas.findByText('5StorybookInternalArgonWallet')).resolves.toBeVisible();
    await userEvent.click(await canvas.findByRole('button', { name: 'Show' }));
    await expect(canvas.getByText(`0x${'12'.repeat(32)}`)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Copy to Clipboard' }));
    await expect(canvas.findByRole('button', { name: 'Copied!' })).resolves.toBeVisible();
  },
};

export const PrivateKeyExportError: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'privateKey', 'privateKeyError'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Synthetic private-key export failure.')).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy to Clipboard' })).toBeDisabled();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};
