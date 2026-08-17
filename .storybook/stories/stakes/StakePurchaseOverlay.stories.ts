import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { setupStakePurchaseScenario } from '../../scenarios/setupPurchaseOverlayScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import StakePurchaseOverlay from '../../../src-vue/overlays/StakePurchaseOverlay.vue';

const meta = {
  title: 'Stakes/Purchase',
  component: StakePurchaseOverlay,
  render: () => ({
    components: { StakePurchaseOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openStakePurchaseOverlay'));
    },
    template: '<StakePurchaseOverlay />',
  }),
} satisfies Meta<typeof StakePurchaseOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AvailabilityFailed: Story = {
  beforeEach: () => setupStakePurchaseScenario('loadError'),
};

export const ChooseAmount: Story = {
  beforeEach: () => setupStakePurchaseScenario('ready'),
};

export const WalletFundingRequired: Story = {
  beforeEach: () => setupStakePurchaseScenario('fundingRequired'),
};

export const Purchasing: Story = {
  beforeEach: () => setupStakePurchaseScenario('progress'),
};

export const PurchaseFailed: Story = {
  beforeEach: () => setupStakePurchaseScenario('progressError'),
};

export const PurchaseComplete: Story = {
  beforeEach: () => setupStakePurchaseScenario('complete'),
};
