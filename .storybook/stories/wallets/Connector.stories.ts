import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, within } from 'storybook/test';
import { setupBitcoinOverlayScenario } from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import Connector from '../../../src-vue/wallets/components/Connector.vue';

const meta = {
  title: 'Wallets/Bitcoin connector',
  component: Connector,
  args: {
    direction: 'left',
    open: false,
  },
  render: () => ({
    components: { Connector },
    setup() {
      return { wallet: useWallets().bitcoinWallet };
    },
    template: `
      <div class="flex h-screen w-screen items-center justify-center bg-slate-800">
        <Connector :wallet="wallet" direction="left" :open="false" />
      </div>
    `,
  }),
} satisfies Meta<typeof Connector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FundedChannels: Story = {
  beforeEach: () => {
    const scenario = setupBitcoinOverlayScenario();
    Object.assign(scenario.financials, { bitcoinWalletTotalSatoshis: 5_000n });
    return () => scenario.cleanup();
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('₳0.34')).toBeVisible();
  },
};
