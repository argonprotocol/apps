import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import { setupCertificationMenuScenario } from '../../scenarios/setupCertificationScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import UpgradeToOperationsOverlay from '../../../src-vue/overlays/UpgradeToOperationsOverlay.vue';
import Home from '../../../src-vue/screens/Home.vue';
import CertificationMenu from '../../../src-vue/navigation/CertificationMenu.vue';

const meta = {
  title: 'Certification/Top bar',
  component: CertificationMenu,
} satisfies Meta<typeof CertificationMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

function renderCertificationOverview(openMenu: boolean) {
  return {
    components: { AppScreen, Home },
    setup() {
      Vue.onMounted(() => {
        if (!openMenu) return;
        void Vue.nextTick().then(() => basicEmitter.emit('openCertificationMenu'));
      });
    },
    template: '<AppScreen><Home /></AppScreen>',
  };
}

export const TreasuryChecklist: Story = {
  beforeEach: () => setupCertificationMenuScenario('treasuryChecklist'),
  render: () => renderCertificationOverview(true),
  play: async () => {
    const canvas = within(document.body);

    await expectEventuallyVisible(canvas.findByText(/Complete the following steps to unlock/));
    await expectEventuallyVisible(canvas.findByText(/Liquid Lock/));
    await expectEventuallyVisible(canvas.findByText(/Acquire .*Argon Bonds/));
  },
};

export const TreasuryChecklistComplete: Story = {
  name: 'Treasury complete',
  beforeEach: () => setupCertificationMenuScenario('treasuryComplete'),
  render: () => renderCertificationOverview(true),
  play: async () => {
    const canvas = within(document.body);

    await expectEventuallyVisible(canvas.findByText('Upgrade to Operations'));
  },
};

export const OperationsChecklist: Story = {
  beforeEach: () => setupCertificationMenuScenario('operationsChecklist'),
  render: () => renderCertificationOverview(true),
  play: async () => {
    const canvas = within(document.body);

    await expectEventuallyVisible(canvas.findByText(/Complete the following operations steps/));
    await expectEventuallyVisible(canvas.findByText('Create a ₳1,000 Vault'));
    await expectEventuallyVisible(canvas.findByText('Win 2 Mining Seats'));
  },
};

export const StepCompletedNotice: Story = {
  beforeEach: () => setupCertificationMenuScenario('stepCompleted'),
  render: () => renderCertificationOverview(false),
  play: async () => {
    const canvas = within(document.body);

    await expectEventuallyVisible(canvas.findByText('Step Completed'));
    await expectEventuallyVisible(canvas.findByText('Transfer Argons from Uniswap'));
    await expectEventuallyVisible(canvas.findByText(/is now complete/));
  },
};

export const UpgradeAvailableNotice: Story = {
  beforeEach: () => setupCertificationMenuScenario('upgradeAvailable'),
  render: () => renderCertificationOverview(false),
  play: async () => {
    const canvas = within(document.body);

    await expectEventuallyVisible(canvas.findByText('Upgrade to Operations', { selector: '.text-xl' }));
    await expectEventuallyVisible(canvas.findByText(/Treasury certification is complete/));
    await expectEventuallyVisible(canvas.findByText('Atlas Operator'));
  },
};

export const RequestOperations: Story = {
  beforeEach: () => setupCertificationMenuScenario('upgradeAvailable'),
  render: () => ({
    components: { AppScreen, Home, UpgradeToOperationsOverlay },
    setup() {
      const observer = new MutationObserver(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return;

        dialog.setAttribute('inert', '');
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      Vue.onMounted(() => basicEmitter.emit('openUpgradeToOperationsOverlay'));
      Vue.onUnmounted(() => observer.disconnect());
    },
    template: `
      <AppScreen><Home /></AppScreen>
      <UpgradeToOperationsOverlay />
      <div class="fixed inset-0 z-[10000] cursor-default"></div>
      <div class="fixed top-2 right-3 z-[10001] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
        Fixed state preview
      </div>
    `,
  }),
  play: async () => {
    const canvas = within(document.body);

    await expectEventuallyVisible(canvas.findByRole('heading', { name: 'Upgrade to Operations' }));
    await expectEventuallyVisible(canvas.findByText('Request Operational Upgrade'));
    await expectEventuallyVisible(canvas.findByText('Atlas Operator', { selector: 'strong' }));
  },
};

export const OperationsUpgradeRequested: Story = {
  beforeEach: () => setupCertificationMenuScenario('upgradeRequested'),
  render: () => renderCertificationOverview(false),
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Operations Requested'));
  },
};

export const OperationsActivatedNotice: Story = {
  beforeEach: () => setupCertificationMenuScenario('operationsActivated'),
  render: () => renderCertificationOverview(false),
  play: async () => {
    const canvas = within(document.body);

    await expectEventuallyVisible(canvas.findByText('Operations Activated'));
    await expectEventuallyVisible(canvas.findByText(/Mining and Vaulting are now available/));
  },
};
