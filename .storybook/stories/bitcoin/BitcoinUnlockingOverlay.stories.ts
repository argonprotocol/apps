import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';

import {
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import BitcoinUnlockingOverlay from '../../../src-vue/overlays/BitcoinUnlockingOverlay.vue';

let scenario: BitcoinOverlayScenario;

const meta = {
  title: 'Bitcoin/Send locked Bitcoin',
  component: BitcoinUnlockingOverlay,
  render: () => ({
    components: { BitcoinUnlockingOverlay },
    setup() {
      Vue.onMounted(() => {
        void Vue.nextTick(() => {
          document.querySelector('[data-testid="BitcoinUnlockingOverlay"]')?.setAttribute('inert', '');
        });
      });
      return { scenario };
    },
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
        Fixed state preview
      </div>
      <BitcoinUnlockingOverlay :personalLock="scenario.lock" />
    `,
  }),
} satisfies Meta<typeof BitcoinUnlockingOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    return () => scenario.cleanup();
  },
};
