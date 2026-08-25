import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, userEvent, within } from 'storybook/test';
import { setupWalletScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter, { type IWalletOverlayOptions } from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';
import { useWallets } from '../../../src-vue/stores/wallets.ts';

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
  scenario: 'defaultArgon' | 'privateKeyError' = 'defaultArgon',
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

export const MainWallet: Story = {
  beforeEach: () => useScenario(WalletType.argon),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Internal App Wallet')).resolves.toBeVisible();
    await expect(canvas.getByText('Ethereum Treasury')).toBeVisible();
    await expect(canvas.getByText('Ethereum Savings')).toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};

export const BitcoinConnector: Story = {
  beforeEach: () => useScenario(WalletType.bitcoin),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Bitcoin Channel')).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};

export const SendTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Send From Internal' })).resolves.toBeVisible();
    await expect(canvas.findByTestId('WalletViewSend.destination')).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
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

export const ReceiveTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'receive'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Receiving to')).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
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
    await expect(canvas.getByRole('button', { name: 'Copied!' })).toBeVisible();
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
