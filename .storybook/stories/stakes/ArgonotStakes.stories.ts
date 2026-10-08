import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { fn, mocked, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setupBondPortfolioScenario, setupBondArchiveScenario } from '../../scenarios/setupBondPortfolioScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import ArgonotStakes from '../../../src-vue/screens/ArgonotStakes.vue';

const interactive = Vue.ref(false);

const meta = {
  title: 'Stakes/Overview',
  component: ArgonotStakes,
  beforeEach: () => {
    interactive.value = false;
  },
  render: () => ({
    components: { AppScreen, ArgonotStakes },
    setup() {
      return { interactive };
    },
    template: '<AppScreen :interactive="interactive"><ArgonotStakes /></AppScreen>',
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

export const HistorySyncFailed: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Argonot');
    getArgonBonds().data.historyError = 'Bond history stopped at block 100: archive unavailable';
  },
};

export const HistoryRetryRecovered: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Argonot');
    getArgonBonds().data.historyError = 'Bond history stopped at block 100: archive unavailable';
    interactive.value = true;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Retry History' }));
    interactive.value = false;
  },
};

export const IncompleteHistory: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Argonot', 0, false);
  },
};

export const CollapsedArchive: Story = {
  beforeEach: () => {
    setupBondArchiveScenario('Argonot');
  },
};

export const ExpandedArchive: Story = {
  beforeEach: () => {
    setupBondArchiveScenario('Argonot');
    interactive.value = true;
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByText(/been archived/));
    interactive.value = false;
  },
};

export const ArchivedOnly: Story = {
  beforeEach: () => {
    setupBondArchiveScenario('Argonot', true);
  },
};

export const ArchivedDetails: Story = {
  beforeEach: () => {
    setupBondArchiveScenario('Argonot', true);
    interactive.value = true;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText(/been archived/));
    await userEvent.click(canvas.getByTestId('Bond.stake-42'));
    interactive.value = false;
  },
};
