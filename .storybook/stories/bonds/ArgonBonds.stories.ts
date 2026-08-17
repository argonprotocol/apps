import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, fn, mocked, within } from 'storybook/test';
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

export const TreasuryBondGuide: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Vault');
    setCertificationGuide(OperationalStepId.AcquireArgonBonds);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('Buy Argon Bonds')).toBeVisible();
    await expect(canvas.getByText('Click Here')).toBeVisible();
  },
};
