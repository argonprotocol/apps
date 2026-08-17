import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { setupOperationalRewardsScenario } from '../../scenarios/setupOnboardingOverlayScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import OperationalRewardsOverlay from '../../../src-vue/overlays/OperationalRewardsOverlay.vue';

const meta = {
  title: 'Certification/Rewards',
  component: OperationalRewardsOverlay,
} satisfies Meta<typeof OperationalRewardsOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

function renderRewards(screen: 'activate' | 'congratulations' | 'claim') {
  return {
    components: { OperationalRewardsOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openOperationalRewardsOverlay', { screen }));
    },
    template: '<OperationalRewardsOverlay />',
  };
}

export const ActivationReady: Story = {
  beforeEach: () => setupOperationalRewardsScenario('activationReady'),
  render: () => renderRewards('activate'),
};

export const CertificationComplete: Story = {
  beforeEach: () => setupOperationalRewardsScenario('congratulations'),
  render: () => renderRewards('congratulations'),
};

export const RewardsAvailable: Story = {
  beforeEach: () => setupOperationalRewardsScenario('claim'),
  render: () => renderRewards('claim'),
};

export const TreasuryLimited: Story = {
  beforeEach: () => setupOperationalRewardsScenario('treasuryLimited'),
  render: () => renderRewards('claim'),
};

export const RuntimeUnavailable: Story = {
  beforeEach: () => setupOperationalRewardsScenario('runtimeUnavailable'),
  render: () => renderRewards('claim'),
};
