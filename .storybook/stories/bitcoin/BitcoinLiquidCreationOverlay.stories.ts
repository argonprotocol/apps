import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, within } from 'storybook/test';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import type { IBitcoinLiquidSource } from '../../../src-vue/interfaces/IBitcoinLiquidSource.ts';
import BitcoinLiquidCreationOverlay from '../../../src-vue/overlays/BitcoinLiquidCreationOverlay.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';

const insuredSources: IBitcoinLiquidSource[] = [
  {
    key: 'atlas',
    cosigner: 'Atlas Operator',
    unallocatedSatoshis: 30_000_000n,
    maximumLiquidSatoshis: 30_000_000n,
    selectedSatoshis: 30_000_000n,
  },
  {
    key: 'my-vault',
    cosigner: 'My Vault',
    unallocatedSatoshis: 20_000_000n,
    maximumLiquidSatoshis: 20_000_000n,
    selectedSatoshis: 20_000_000n,
  },
];

const meta = {
  title: 'Bitcoin/Create Liquid',
  component: BitcoinLiquidCreationOverlay,
  args: {
    sources: insuredSources,
    feeMicrogons: 12_500_000n,
    liquidityMicrogons: 34_000_000_000n,
    projectedEarningsMicrogons: 13_736_000_000n,
    isSubmitting: false,
    progressPct: 0,
    confirmations: -1,
    expectedConfirmations: 4,
    availableWalletMicrogons: 100_000_000n,
    isTreasuryCertified: false,
    treasuryCertificationRequiredSatoshis: 20_000_000n,
    microgonsAtTargetPerBtc: 68_000_000_000n,
  },
  render: args => ({
    components: { BitcoinLiquidCreationOverlay },
    setup() {
      const storyKey = Vue.computed(() => {
        return (args as unknown as { sources: IBitcoinLiquidSource[] }).sources
          .map(
            source =>
              `${source.key}:${source.unallocatedSatoshis}:${source.selectedSatoshis}:${source.maximumLiquidSatoshis}`,
          )
          .join('|');
      });

      return { args, storyKey };
    },
    template: `
      <BitcoinLiquidCreationOverlay :key="storyKey" v-bind="args" />
      <div class="fixed inset-0 z-[10000] cursor-not-allowed" aria-label="Liquid controls are disabled in this fixed preview">
        <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
          Fixed state preview
        </span>
      </div>
    `,
  }),
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.BitcoinLocks });
  },
} satisfies Meta<typeof BitcoinLiquidCreationOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {};

export const VaultCapacityCapped: Story = {
  args: {
    sources: [
      insuredSources[0]!,
      {
        ...insuredSources[1],
        unallocatedSatoshis: 30_000_000n,
        maximumLiquidSatoshis: 12_000_000n,
        selectedSatoshis: 12_000_000n,
      },
    ],
    feeMicrogons: 27_500_000n,
    couponCreditMicrogons: 75_000_000n,
    feeGiftProvider: 'Atlas Operator',
    liquidityMicrogons: 40_800_000_000n,
    projectedEarningsMicrogons: 16_483_200_000n,
  },
};

export const InsufficientWalletFunds: Story = {
  args: {
    availableWalletMicrogons: 5_000_000n,
  },
};

export const NoBitcoinAvailable: Story = {
  args: {
    sources: insuredSources.map(source => ({
      ...source,
      unallocatedSatoshis: 0n,
      maximumLiquidSatoshis: 0n,
      selectedSatoshis: 0n,
    })),
  },
  play: async () => {
    const body = within(document.body);
    await expect(
      body.getByText("You don't have Bitcoin available in your wallet.", { exact: false }),
    ).toBeInTheDocument();
    await expect(body.getByRole('button', { name: 'Create Liquid', hidden: true })).toBeDisabled();
  },
};

export const BelowTreasuryCertificationRequirement: Story = {
  args: {
    treasuryCertificationRequiredSatoshis: 60_000_000n,
  },
};

export const CreatingOnArgon: Story = {
  args: {
    isSubmitting: true,
    progressPct: 48,
    confirmations: 1,
  },
};

export const BatchFailed: Story = {
  args: {
    errorMessage: 'The cosigner no longer has enough securitization available for this amount.',
  },
};
