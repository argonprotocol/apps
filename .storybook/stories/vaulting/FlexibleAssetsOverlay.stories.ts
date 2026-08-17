import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
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
    template: '<FlexibleAssetsOverlay />',
  }),
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

export const UpdatingAssets: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('progress'),
};

export const UpdateFailed: Story = {
  beforeEach: () => setupFlexibleAssetsScenario('progressError'),
};
