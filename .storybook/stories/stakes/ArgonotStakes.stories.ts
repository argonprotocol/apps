import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { fn, mocked } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setupBondPortfolioScenario } from '../../scenarios/setupBondPortfolioScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import ArgonotStakes from '../../../src-vue/screens/ArgonotStakes.vue';

const meta = {
  title: 'Stakes/Overview',
  component: ArgonotStakes,
  render: () => ({
    components: { AppScreen, ArgonotStakes },
    template: '<AppScreen><ArgonotStakes /></AppScreen>',
  }),
} satisfies Meta<typeof ArgonotStakes>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.ArgonotStaking });
    mocked(getArgonBonds).mockReturnValue({
      data: Vue.reactive({ isLoaded: false, bondLots: [] }),
      load: fn(() => new Promise<void>(() => undefined)),
    } as unknown as ReturnType<typeof getArgonBonds>);
  },
};

export const LoadFailed: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.ArgonotStaking });
    mocked(getArgonBonds).mockReturnValue({
      data: Vue.reactive({ isLoaded: false, bondLots: [] }),
      load: fn(async () => {
        throw new Error('Mining auction stake availability could not be loaded.');
      }),
    } as unknown as ReturnType<typeof getArgonBonds>);
  },
};

export const Start: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.ArgonotStaking });
    mocked(getArgonBonds).mockReturnValue({
      data: Vue.reactive({ isLoaded: true, bondLots: [] }),
      load: fn(async () => undefined),
    } as unknown as ReturnType<typeof getArgonBonds>);
  },
};

export const Portfolio: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Argonot');
  },
};
