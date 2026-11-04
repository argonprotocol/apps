import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { fn, mocked } from 'storybook/test';
import * as Vue from 'vue';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import Network from '../../../src-vue/screens/Network.vue';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { useMiningStats } from '../../../src-vue/stores/miningStats.ts';
import { useVaultingStats } from '../../../src-vue/stores/vaultingStats.ts';

const meta = {
  title: 'Network/Economics',
  component: Network,
  render: () => ({
    components: { AppScreen, Network },
    template: '<AppScreen><Network /></AppScreen>',
  }),
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Network });
    getCurrency().isLoaded = true;
    mocked(useMiningStats, { partial: true }).mockReturnValue(
      Vue.reactive({
        hasCurrentStats: true,
        isUpdating: false,
        error: '',
        cohortProgress: { completed: 2, total: 2 },
        provisionalReturns: undefined,
        averageAPR: 0,
        averageAPY: 0,
        activeMiningSeatCount: 20,
        activeBidCosts: 0n,
        activeBlockRewards: 0n,
        update: fn(async () => undefined),
      }),
    );
    Object.assign(useVaultingStats(), {
      isLoaded: true,
      vaultCount: 1,
      bitcoinLocked: 0,
      microgonValueInVaults: 0n,
      argonBurnCapacity: 0,
      averageAPR: 0,
      argonBondsAPR: 0,
      argonotStakingAPR: 0,
    });
  },
} satisfies Meta<typeof Network>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LoadedZeros: Story = {};

export const Loading: Story = {
  beforeEach: () => {
    Object.assign(useMiningStats(), {
      hasCurrentStats: false,
      isUpdating: true,
      averageAPR: undefined,
      averageAPY: undefined,
      cohortProgress: { completed: 0, total: 10 },
    });
    useVaultingStats().isLoaded = false;
  },
};

export const Provisional: Story = {
  beforeEach: () => {
    Object.assign(useMiningStats(), {
      isUpdating: true,
      averageAPR: undefined,
      averageAPY: undefined,
      provisionalReturns: { apr: 13, apy: 13.9, microgonRevenue: 123_450_000n },
      cohortProgress: { completed: 3, total: 10 },
    });
  },
};

export const Refreshing: Story = {
  beforeEach: () => {
    Object.assign(useMiningStats(), {
      isUpdating: true,
      averageAPR: 20,
      averageAPY: 22.1,
      activeBlockRewards: 500_000_000n,
      provisionalReturns: { apr: 13, apy: 13.9, microgonRevenue: 123_450_000n },
      cohortProgress: { completed: 3, total: 10 },
    });
  },
};

export const Interrupted: Story = {
  beforeEach: () => {
    Object.assign(useMiningStats(), {
      averageAPR: undefined,
      averageAPY: undefined,
      provisionalReturns: { apr: 13, apy: 13.9, microgonRevenue: 123_450_000n },
      cohortProgress: { completed: 3, total: 10 },
      error: 'Unable to finish calculating mining returns.',
    });
  },
};
