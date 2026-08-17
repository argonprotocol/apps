import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, within } from 'storybook/test';
import { setupWalletScenario } from '../../scenarios/setupWalletScenario.ts';
import WalletDialog from '../../../src-vue/wallets/WalletDialog.vue';

let scenario: ReturnType<typeof setupWalletScenario>;

const meta = {
  title: 'Wallets/Wallet',
  render: () => ({
    components: { WalletDialog },
    setup() {
      return { scenario };
    },
    template: `
      <WalletDialog
        :primaryWallet="scenario.primaryWallet"
        :transferIn="scenario.transferIn"
        :transferOut="scenario.transferOut"
        :walletSelections="scenario.walletSelections"
        :availableWallets="scenario.availableWallets"
        :zIndex="50"
      />
      <Teleport to="body">
        <div
          data-testid="WalletOverlay.fixedPreviewGuard"
          class="fixed inset-0 z-[60] cursor-not-allowed"
          aria-label="Wallet controls are disabled in this fixed preview"
          title="Wallet controls are disabled in this fixed preview"
        >
          <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
            Controls are disabled in this fixed preview.
          </span>
        </div>
      </Teleport>
    `,
  }),
} satisfies Meta<typeof WalletDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

function useScenario(state: Parameters<typeof setupWalletScenario>[0]) {
  scenario = setupWalletScenario(state);
}

export const DefaultArgon: Story = {
  beforeEach: () => useScenario('defaultArgon'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.getByText('Internal App Wallet')).toBeVisible();
    await expect(canvas.getByText('880 ARGN')).toBeVisible();
  },
};

export const MiningWallet: Story = {
  beforeEach: () => useScenario('mining'),
  play: async () => {
    await expect(within(document.body).getByText('Mining Wallet')).toBeVisible();
  },
};

export const EthereumWallet: Story = {
  beforeEach: () => useScenario('ethereum'),
  play: async () => {
    await expect(within(document.body).getByText('Ethereum Treasury Wallet')).toBeVisible();
  },
};

export const TransferInChooser: Story = {
  beforeEach: () => useScenario('transferInChooser'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.getByTestId('WalletOverlay.transferInPanel')).toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay.transferInPanel')).toHaveTextContent('TRANSFER IN');
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toHaveAttribute(
      'aria-label',
      'Wallet controls are disabled in this fixed preview',
    );
  },
};

export const TransferOutChooser: Story = {
  beforeEach: () => useScenario('transferOutChooser'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.getByTestId('WalletOverlay.transferOutPanel')).toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay.transferOutPanel')).toHaveTextContent('TRANSFER OUT');
  },
};

export const ArgonToMining: Story = {
  beforeEach: () => useScenario('argonToMining'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.getByText('Internal App Wallet')).toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay.transferOutPanel')).toHaveTextContent('Mining Wallet');
  },
};

export const EthereumInbound: Story = {
  beforeEach: () => useScenario('ethereumInbound'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.getByTestId('WalletOverlay.transferInPanel')).toHaveTextContent('Ethereum Treasury Wallet');
    await expect(canvas.getByText('Internal App Wallet')).toBeVisible();
  },
};

export const EthereumOutbound: Story = {
  beforeEach: () => useScenario('ethereumOutbound'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.getByTestId('WalletOverlay.transferOutPanel')).toHaveTextContent('Ethereum Treasury Wallet');
    await expect(canvas.getByText('Internal App Wallet')).toBeVisible();
  },
};

export const CustomArgonAddress: Story = {
  beforeEach: () => useScenario('customArgon'),
  play: async () => {
    await expect(within(document.body).getByLabelText('Address of Account')).toBeVisible();
  },
};
