import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { fn, mocked, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setupBondPortfolioScenario, setupBondArchiveScenario } from '../../scenarios/setupBondPortfolioScenario.ts';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
import { OperationalStepId } from '../../../src-vue/stores/certificationController.ts';
import ArgonBonds from '../../../src-vue/screens/ArgonBonds.vue';

const interactive = Vue.ref(false);

const meta = {
  title: 'Bonds/Overview',
  component: ArgonBonds,
  beforeEach: () => {
    interactive.value = false;
  },
  render: () => ({
    components: { AppScreen, ArgonBonds },
    setup() {
      return { interactive };
    },
    template: '<AppScreen :interactive="interactive"><ArgonBonds /></AppScreen>',
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

export const SmallDistributedIncome: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Vault');
    useFinancials().bondSummariesByAsset.ARGN.returnSummary.paidIncome = 4_321n;
  },
};

export const HistorySyncFailed: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Vault');
    getArgonBonds().data.historyError = 'Bond history stopped at block 100: archive unavailable';
  },
};

export const HistoryRetryRecovered: Story = {
  beforeEach: () => {
    setupBondPortfolioScenario('Vault');
    getArgonBonds().data.historyError = 'Bond history stopped at block 100: archive unavailable';
    interactive.value = true;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Retry History' }));
    await Vue.nextTick();
    interactive.value = false;
  },
};

export const IncompleteHistory: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Known bond earnings include flexible earnings. Returns remain unavailable while historical attribution is incomplete.',
      },
    },
  },
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

export const CollapsedArchive: Story = {
  beforeEach: () => {
    setupBondArchiveScenario('Vault');
  },
};

export const ExpandedArchive: Story = {
  beforeEach: () => {
    setupBondArchiveScenario('Vault');
    interactive.value = true;
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByText(/been archived/));
    interactive.value = false;
  },
};

export const ArchivedOnly: Story = {
  beforeEach: () => {
    setupBondArchiveScenario('Vault', true);
  },
};

export const ArchivedDetails: Story = {
  beforeEach: () => {
    setupBondArchiveScenario('Vault', true);
    interactive.value = true;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText(/been archived/));
    await userEvent.click(canvas.getByTestId('Bond.bond-42'));
    interactive.value = false;
  },
};
