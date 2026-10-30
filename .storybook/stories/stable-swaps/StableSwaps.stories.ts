import { userEvent, within } from 'storybook/test';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import StableSwaps from '../../../src-vue/screens/StableSwaps.vue';

const meta = {
  title: 'Stable Swaps/Overview',
  component: StableSwaps,
  render: () => ({
    components: { AppScreen, StableSwaps },
    template: '<AppScreen><StableSwaps /></AppScreen>',
  }),
} satisfies Meta<typeof StableSwaps>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BlankSlate: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.StableSwaps });
  },
};

export const CreateStabilizer: Story = {
  render: () => ({
    components: { AppScreen, StableSwaps },
    template: '<AppScreen interactive><StableSwaps /></AppScreen>',
  }),
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.StableSwaps });
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Activate Your First Stabilizer' }));
  },
};
