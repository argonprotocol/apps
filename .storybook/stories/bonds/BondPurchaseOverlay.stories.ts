import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { setupBondPurchaseScenario } from '../../scenarios/setupPurchaseOverlayScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import BondPurchaseOverlay from '../../../src-vue/overlays/BondPurchaseOverlay.vue';

const meta = {
  title: 'Bonds/Purchase',
  component: BondPurchaseOverlay,
  render: () => ({
    components: { BondPurchaseOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openBondPurchaseOverlay'));
    },
    template: '<BondPurchaseOverlay />',
  }),
} satisfies Meta<typeof BondPurchaseOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LoadingVaults: Story = {
  beforeEach: () => setupBondPurchaseScenario('loading'),
};

export const VaultLoadFailed: Story = {
  beforeEach: () => setupBondPurchaseScenario('loadError'),
};

export const NoActiveVaults: Story = {
  beforeEach: () => setupBondPurchaseScenario('ready'),
};
