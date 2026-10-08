import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { within } from 'storybook/test';
import { setupFlexibleAssetsScenario } from '../../scenarios/setupOnboardingOverlayScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import FlexibleAssetsOverlay from '../../../src-vue/overlays/FlexibleAssetsOverlay.vue';

const meta = {
  title: 'Vaulting/Flexible assets',
  component: FlexibleAssetsOverlay,
  render: () => ({
    components: { FlexibleAssetsOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openFlexibleAssetsOverlay'));
    },
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">Fixed state preview</div>
      <FlexibleAssetsOverlay inert />
    `,
  }),
  play: async () => {
    await within(document.body).findByRole('heading', { name: 'Manage Flexible Assets' });
  },
} satisfies Meta<typeof FlexibleAssetsOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoEligibleAssets: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('empty'),
};

export const LoadingAssets: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('loading'),
};

export const EligibleAssets: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('eligible'),
};

export const PartiallyDisplacedAssets: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('partiallyDisplaced'),
};

export const FullyDisplacedAssets: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('fullyDisplaced'),
};

export const DisplacementUnavailable: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('displacementUnavailable'),
};

export const UpdatingAssets: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('progress'),
};

export const UpdateFailed: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('progressError'),
};
