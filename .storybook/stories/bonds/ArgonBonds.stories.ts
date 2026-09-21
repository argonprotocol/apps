import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { fn, mocked } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setupBondPortfolioScenario } from '../../scenarios/setupBondPortfolioScenario.ts';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import { OperationalStepId } from '../../../src-vue/stores/certificationController.ts';
import ArgonBonds from '../../../src-vue/screens/ArgonBonds.vue';

const meta = {
  title: 'Bonds/Overview',
  component: ArgonBonds,
  render: () => ({
    components: { AppScreen, ArgonBonds },
    template: '<AppScreen><ArgonBonds /></AppScreen>',
  }),
} satisfies Meta<typeof ArgonBonds>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.ArgonBonds });
    mocked(getArgonBonds).mockReturnValue({
      data: Vue.reactive({ isLoaded: false, bondLots: [] }),
      load: fn(() => new Promise<void>(() => undefined)),
    } as unknown as ReturnType<typeof getArgonBonds>);
  },
};

export const LoadFailed: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.ArgonBonds });
    mocked(getArgonBonds).mockReturnValue({
      data: Vue.reactive({ isLoaded: false, bondLots: [] }),
      load: fn(async () => {
        throw new Error('The treasury bond index is temporarily unavailable.');
      }),
    } as unknown as ReturnType<typeof getArgonBonds>);
  },
};

export const Start: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.ArgonBonds });
    mocked(getArgonBonds).mockReturnValue({
      data: Vue.reactive({ isLoaded: true, bondLots: [] }),
      load: fn(async () => undefined),
    } as unknown as ReturnType<typeof getArgonBonds>);
  },
};

export const Portfolio: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Vault');
  },
};

export const HistorySyncFailed: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Vault');
    getArgonBonds().data.historyError = 'Bond history stopped at block 100: archive unavailable';
  },
};

export const IncompleteHistory: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Vault', 0, false);
  },
};

export const TreasuryBondGuide: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Vault');
    setCertificationGuide(OperationalStepId.AcquireArgonBonds);
  },
};
