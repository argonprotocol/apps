import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { expect, within } from 'storybook/test';
import { setupWalletScenario } from '../../scenarios/setupWalletScenario.ts';
import ArgonTokens from '../../../src-vue/wallets/components/ArgonTokens.vue';
import { getCurrency } from '../../../src-vue/stores/currency.ts';

const meta = {
  title: 'Wallets/Internal App Wallet Tokens',
  component: ArgonTokens,
  render: () => ({
    components: { ArgonTokens },
    template: `
      <div class="w-xl bg-white p-6 text-xl text-slate-700">
        <ArgonTokens :microgons="998_000_000n" :micronots="500_000_000n" :satoshis="5_000n" showBitcoin />
      </div>
    `,
  }),
} satisfies Meta<typeof ArgonTokens>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithBitcoin: Story = {
  beforeEach: () => {
    setupWalletScenario('defaultArgon');
    const currency = getCurrency();
    currency.microgonsPer = {
      ...currency.microgonsPer,
      [UnitOfMeasurement.BTC]: 6_800_000_000n,
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('0.00005 BTC')).toBeVisible();
    await expect(canvas.getByText('₳0.34')).toBeVisible();
  },
};
