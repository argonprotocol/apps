import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { userEvent, within } from 'storybook/test';
import { setupWalletScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { OperationalStepId, useCertificationController } from '../../../src-vue/stores/certificationController.ts';

const syntheticMnemonic = 'synthetic alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
const isInteractive = Vue.ref(true);

const meta = {
  title: 'Wallets/Ethereum import',
  render: () => ({
    components: { WalletOverlay },
    setup() {
      const disableDocsLinks = () => {
        document.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]').forEach(link => {
          link.setAttribute('aria-disabled', 'true');
          link.removeAttribute('href');
          link.tabIndex = -1;
          link.title = 'External documentation is disabled in this Storybook preview.';
        });
      };
      const blockDocsLink = (event: Event) => {
        const element = event.target instanceof Element ? event.target : undefined;
        const link = element?.closest('a[target="_blank"]');
        if (!link) return;

        event.preventDefault();
      };
      const docsObserver = new MutationObserver(disableDocsLinks);

      document.addEventListener('click', blockDocsLink, true);
      document.addEventListener('keydown', blockDocsLink, true);
      docsObserver.observe(document.body, { childList: true, subtree: true });
      Vue.onMounted(() => {
        document.addEventListener('keydown', preventFixedPreviewKeyboard, true);
        basicEmitter.emit('openWalletOverlayAddConnector', 'external');
        void Vue.nextTick(disableDocsLinks);
      });
      Vue.onUnmounted(() => {
        docsObserver.disconnect();
        document.removeEventListener('click', blockDocsLink, true);
        document.removeEventListener('keydown', blockDocsLink, true);
        document.removeEventListener('keydown', preventFixedPreviewKeyboard, true);
      });
      return { isInteractive };

      function preventFixedPreviewKeyboard(event: KeyboardEvent) {
        if (isInteractive.value) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    template: `
      <div class="relative h-screen w-screen overflow-hidden">
        <WalletOverlay />
        <div v-if="!isInteractive" class="pointer-events-auto fixed inset-0 z-[9999] cursor-not-allowed" aria-label="Controls are disabled in this fixed preview">
          <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
            Fixed state preview
          </span>
        </div>
      </div>
    `,
  }),
} satisfies Meta<typeof WalletOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

function useScenario(state: Parameters<typeof setupWalletScenario>[0], guide = false) {
  const scenario = setupWalletScenario(state);
  isInteractive.value = true;
  if (guide) {
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  }
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

export const TreasuryImportOptionsGuide: Story = {
  beforeEach: () => {
    const cleanup = useScenario('importReady', true);
    isInteractive.value = false;
    return cleanup;
  },
};

export const TreasuryMnemonicEntryGuide: Story = {
  beforeEach: () => useScenario('importReady', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('radio', { name: /Mnemonic/ }));
    isInteractive.value = false;
  },
};

export const TreasuryPasteMnemonicGuide: Story = {
  beforeEach: () => useScenario('importReady', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('radio', { name: /Mnemonic/ }));
    await userEvent.click(canvas.getByText('How to export your mnemonic from Uniswap', { exact: false }));
    isInteractive.value = false;
  },
};

export const TreasuryMetaMaskHelpGuide: Story = {
  beforeEach: () => useScenario('importReady', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('radio', { name: /Private key/ }));
    isInteractive.value = false;
  },
};

export const TreasuryPastePrivateKeyGuide: Story = {
  beforeEach: () => useScenario('importReady', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByPlaceholderText('Paste private key'));
    isInteractive.value = false;
  },
};

export const TreasuryNamePrivateKeyWalletGuide: Story = {
  beforeEach: () => useScenario('importReady', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.type(await canvas.findByPlaceholderText('Paste private key'), 'synthetic-not-a-private-key');
    isInteractive.value = false;
  },
};

export const TreasuryPrivateKeyReady: Story = {
  beforeEach: () => useScenario('importReady', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.type(await canvas.findByPlaceholderText('Paste private key'), 'synthetic-not-a-private-key');
    await userEvent.type(canvas.getByPlaceholderText('Name this wallet'), 'Storybook wallet');
    isInteractive.value = false;
  },
};

export const TreasuryLoadMnemonicAccountsGuide: Story = {
  beforeEach: () => useScenario('importAccounts', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('radio', { name: /Mnemonic/ }));
    await userEvent.type(canvas.getByPlaceholderText('Paste mnemonic'), syntheticMnemonic);
    isInteractive.value = false;
  },
};

export const TreasuryChooseMnemonicAccountGuide: Story = {
  beforeEach: () => useScenario('importAccounts', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('radio', { name: /Mnemonic/ }));
    await userEvent.type(canvas.getByPlaceholderText('Paste mnemonic'), syntheticMnemonic);
    await userEvent.click(canvas.getByRole('button', { name: 'Load Wallets From Mnemonic' }));
    isInteractive.value = false;
  },
};

export const TreasuryImportMnemonicAccountGuide: Story = {
  beforeEach: () => useScenario('importAccounts', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('radio', { name: /Mnemonic/ }));
    await userEvent.type(canvas.getByPlaceholderText('Paste mnemonic'), syntheticMnemonic);
    await userEvent.click(canvas.getByRole('button', { name: 'Load Wallets From Mnemonic' }));
    await userEvent.click(await canvas.findByRole('button', { name: /Account 2/ }));
    await userEvent.type(canvas.getByPlaceholderText('Name this wallet'), 'Storybook wallet');
    isInteractive.value = false;
  },
};

export const TreasuryNameMnemonicWalletGuide: Story = {
  beforeEach: () => useScenario('importAccounts', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('radio', { name: /Mnemonic/ }));
    await userEvent.type(canvas.getByPlaceholderText('Paste mnemonic'), syntheticMnemonic);
    await userEvent.click(canvas.getByRole('button', { name: 'Load Wallets From Mnemonic' }));
    await userEvent.click(await canvas.findByRole('button', { name: /Account 2/ }));
    isInteractive.value = false;
  },
};

export const TreasuryMnemonicBalancesLoading: Story = {
  beforeEach: () => useScenario('importScanning', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('radio', { name: /Mnemonic/ }));
    await userEvent.type(canvas.getByPlaceholderText('Paste mnemonic'), syntheticMnemonic);
    await userEvent.click(canvas.getByRole('button', { name: 'Load Wallets From Mnemonic' }));
    isInteractive.value = false;
  },
};

export const TreasuryImportFailure: Story = {
  beforeEach: () => useScenario('importFailure', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.type(await canvas.findByPlaceholderText('Paste private key'), 'synthetic-not-a-private-key');
    await userEvent.type(canvas.getByPlaceholderText('Name this wallet'), 'Storybook wallet');
    await userEvent.click(canvas.getByRole('button', { name: 'Import Wallet' }));
    isInteractive.value = false;
  },
};
