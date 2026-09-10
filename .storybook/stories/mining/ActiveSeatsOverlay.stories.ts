import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { fn, userEvent, within } from 'storybook/test';
import { MotionGlobalConfig } from 'motion-v';
import AppScreen from '../../components/AppScreen.vue';
import { activeMiningCohorts, activeMiningSlots } from '../../scenarios/miningOverlayFixtures.ts';
import { setupMiningPortfolioScenario } from '../../scenarios/setupMiningPortfolioScenario.ts';
import ActiveSeatsOverlay from '../../../src-vue/overlays/mining/ActiveSeatsOverlay.vue';
import Mining from '../../../src-vue/screens/Mining.vue';
import { getMining } from '../../../src-vue/stores/mainchain.ts';
import { getMyMiningSeats } from '../../../src-vue/stores/myMiningSeats.ts';

const fetchCurrentMiningSeats = fn<ReturnType<typeof getMining>['fetchCurrentMiningSeats']>();

const meta = {
  title: 'Mining/Active seats',
  component: ActiveSeatsOverlay,
  beforeEach: () => {
    MotionGlobalConfig.skipAnimations = true;
    setupMiningPortfolioScenario();
    fetchCurrentMiningSeats.mockReset();
    fetchCurrentMiningSeats.mockResolvedValue(activeMiningSlots);
    Object.assign(getMining(), { fetchCurrentMiningSeats });
    Object.assign(getMyMiningSeats(), { miningCohorts: activeMiningCohorts });
  },
  render: args => ({
    components: { ActiveSeatsOverlay, AppScreen, Mining },
    setup() {
      const isOpen = Vue.ref(false);
      Vue.onMounted(() => {
        void Vue.nextTick().then(() => {
          isOpen.value = true;
        });
      });
      return { args, isOpen };
    },
    template: `
      <AppScreen :interactive="isOpen">
        <Mining />
        <ActiveSeatsOverlay v-bind="args" :isOpen="isOpen" @close="isOpen = false" />
      </AppScreen>
    `,
  }),
  args: {
    isOpen: true,
  },
} satisfies Meta<typeof ActiveSeatsOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentSeats: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.hover(await canvas.findByText('A1'));
  },
};
export const NoActiveSeats: Story = {
  beforeEach: () => {
    fetchCurrentMiningSeats.mockResolvedValue([]);
  },
};

export const PendingHistory: Story = {
  beforeEach: () => {
    Object.assign(getMyMiningSeats(), { miningCohorts: [] });
  },
};
