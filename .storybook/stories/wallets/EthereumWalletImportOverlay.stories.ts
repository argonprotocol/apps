import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { userEvent, within } from 'storybook/test';
import { setupWalletScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';

const syntheticMnemonic = 'synthetic alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';

const meta = {
  title: 'Wallets/Ethereum import',
  render: () => ({
    components: { WalletOverlay },
    setup() {
      const disableDocsLinks = () => {
        document
          .querySelector('[data-testid="WalletOverlay"]')
          ?.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')
          .forEach(link => {
            link.setAttribute('aria-disabled', 'true');
            link.removeAttribute('href');
            link.tabIndex = -1;
            link.title = 'External documentation is disabled in this Storybook preview.';
          });
      };
      const blockDocsLink = (event: Event) => {
        const element = event.target instanceof Element ? event.target : undefined;
        const link = element?.closest('a[target="_blank"]');
        if (!link?.closest('[data-testid="WalletOverlay"]')) return;

        event.preventDefault();
        event.stopPropagation();
      };
      const docsObserver = new MutationObserver(disableDocsLinks);

      document.addEventListener('click', blockDocsLink, true);
      document.addEventListener('keydown', blockDocsLink, true);
      docsObserver.observe(document.body, { childList: true, subtree: true });
      Vue.onMounted(() => {
        basicEmitter.emit('openWalletOverlayAddConnector', 'external');
        void Vue.nextTick(disableDocsLinks);
      });
      Vue.onUnmounted(() => {
        docsObserver.disconnect();
        document.removeEventListener('click', blockDocsLink, true);
        document.removeEventListener('keydown', blockDocsLink, true);
      });
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

function useScenario(state: Parameters<typeof setupWalletScenario>[0]) {
  const scenario = setupWalletScenario(state);
  return scenario.cleanup;
}

async function openEthereumImport() {
  return within(document.body);
}

export const PrivateKeyEntry: Story = {
  beforeEach: () => useScenario('importReady'),
};

export const MnemonicEntry: Story = {
  beforeEach: () => useScenario('importReady'),
  play: async () => {
    const canvas = await openEthereumImport();

    // The production radio input switches the entry field and submit label together.
    await userEvent.click(canvas.getByRole('radio', { name: /Mnemonic/ }));
  },
};

export const InvalidMnemonic: Story = {
  beforeEach: () => useScenario('importReady'),
  play: async () => {
    const canvas = await openEthereumImport();

    // The 12/24-word rule is local component validation, so this synthetic input never reaches an import service.
    await userEvent.click(canvas.getByRole('radio', { name: /Mnemonic/ }));
    await userEvent.type(canvas.getByPlaceholderText('Paste mnemonic'), 'synthetic words are intentionally invalid');
    await userEvent.click(canvas.getByRole('button', { name: 'Load Wallets From Mnemonic' }));
  },
};

export const ScanningBalances: Story = {
  beforeEach: () => {
    return useScenario('importScanning');
  },
  play: async () => {
    const canvas = await openEthereumImport();

    // The story reaches the real scanning state after its normal mnemonic-preview transition.
    await userEvent.click(canvas.getByRole('radio', { name: /Mnemonic/ }));
    await userEvent.type(canvas.getByPlaceholderText('Paste mnemonic'), syntheticMnemonic);
    await userEvent.click(canvas.getByRole('button', { name: 'Load Wallets From Mnemonic' }));
  },
};

export const MnemonicAccounts: Story = {
  beforeEach: () => useScenario('importAccounts'),
  play: async () => {
    const canvas = await openEthereumImport();

    await userEvent.click(canvas.getByRole('radio', { name: /Mnemonic/ }));
    await userEvent.type(canvas.getByPlaceholderText('Paste mnemonic'), syntheticMnemonic);
    await userEvent.click(canvas.getByRole('button', { name: 'Load Wallets From Mnemonic' }));
    // Accounts are production buttons, indexed from their displayed account name.
    await userEvent.click(canvas.getByRole('button', { name: /Account 2/ }));
  },
};

export const UnavailableMnemonicAccount: Story = {
  beforeEach: () => useScenario('importUnavailable'),
  play: async () => {
    const canvas = await openEthereumImport();

    await userEvent.click(canvas.getByRole('radio', { name: /Mnemonic/ }));
    await userEvent.type(canvas.getByPlaceholderText('Paste mnemonic'), syntheticMnemonic);
    await userEvent.click(canvas.getByRole('button', { name: 'Load Wallets From Mnemonic' }));
  },
};

export const ImportFailure: Story = {
  beforeEach: () => useScenario('importFailure'),
  play: async () => {
    const canvas = await openEthereumImport();

    // This uses a conspicuously synthetic value; the mocked import boundary supplies the failure.
    await userEvent.type(canvas.getByPlaceholderText('Paste private key'), 'synthetic-not-a-private-key');
    await userEvent.type(canvas.getByPlaceholderText('Name this wallet'), 'Storybook wallet');
    await userEvent.click(canvas.getByRole('button', { name: 'Import Wallet' }));
  },
};
