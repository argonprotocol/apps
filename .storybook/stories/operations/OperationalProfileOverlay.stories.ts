import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { setupOperationalProfileScenario } from '../../scenarios/setupOnboardingOverlayScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import OperationalProfileOverlay from '../../../src-vue/overlays/OperationalProfileOverlay.vue';

const meta = {
  title: 'Operations/Profile',
  component: OperationalProfileOverlay,
  render: () => ({
    components: { OperationalProfileOverlay },
    setup() {
      Vue.onMounted(() =>
        basicEmitter.emit('openOperationalProfileOverlay', {
          draftName: 'AtlasOperator',
          onSelect: () => undefined,
        }),
      );
    },
    template: '<OperationalProfileOverlay />',
  }),
} satisfies Meta<typeof OperationalProfileOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DraftName: Story = {
  beforeEach: () => setupOperationalProfileScenario('draft'),
};

export const VaultRequired: Story = {
  beforeEach: () => setupOperationalProfileScenario('vaultRequired'),
};

export const LoadFailed: Story = {
  beforeEach: () => setupOperationalProfileScenario('loadError'),
};
