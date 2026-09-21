import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupCertificationMenuScenario } from '../../scenarios/setupCertificationScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import UpgradeToOperationsOverlay from '../../../src-vue/overlays/UpgradeToOperationsOverlay.vue';
import Home from '../../../src-vue/screens/Home.vue';
import CertificationMenu from '../../../src-vue/navigation/CertificationMenu.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { useCertificationController } from '../../../src-vue/stores/certificationController.ts';

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
};

export const OperationalProgressLoading: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({
      selectedTab: TopTab.Home,
      config: {
        hasExtensionTreasury: true,
        hasExtensionOperations: true,
      },
    });
    controller.isLoaded = true;
    controller.hasLoadedInitialOperationalProgress = false;
  },
  render: () => renderCertificationOverview(false),
};

export const ConfigLoading: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Home,
      config: {
        isLoaded: false,
        hasExtensionTreasury: false,
        hasExtensionOperations: false,
      },
    });
  },
  render: () => renderCertificationOverview(false),
};

export const PersistedOperationsDuringLiveStateLoss: Story = {
  beforeEach: async () => {
    await setupCertificationMenuScenario('treasuryComplete');

    const config = getConfig();
    const controller = useCertificationController();
    config.hasExtensionOperations = true;
    controller.chainProgress = {
      ...controller.chainProgress,
      isUpgradedToOperations: false,
    };
  },
  render: () => renderCertificationOverview(false),
};

export const TreasuryChecklistComplete: Story = {
  name: 'Treasury complete',
  beforeEach: () => setupCertificationMenuScenario('treasuryComplete'),
  render: () => renderCertificationOverview(false),
};

export const OperationsChecklist: Story = {
  beforeEach: () => setupCertificationMenuScenario('operationsChecklist'),
  render: () => renderCertificationOverview(true),
};

export const StepCompletedNotice: Story = {
  beforeEach: () => setupCertificationMenuScenario('stepCompleted'),
  render: () => renderCertificationOverview(false),
};

export const StepCompletedNoticeAfterOperationsAccessLoads: Story = {
  beforeEach: async () => {
    await setupCertificationMenuScenario('stepCompleted');
    getConfig().hasExtensionOperations = false;
  },
  render: () => renderCertificationOverview(false),
  play: async () => {
    const canvas = within(document.body);
    await canvas.findByText('Step Completed');

    getConfig().hasExtensionOperations = true;
    await Vue.nextTick();
  },
};

export const UpgradeAvailableNotice: Story = {
  beforeEach: () => setupCertificationMenuScenario('upgradeAvailable'),
  render: () => renderCertificationOverview(false),
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
};

export const OperationsUpgradeRequested: Story = {
  beforeEach: () => setupCertificationMenuScenario('upgradeRequested'),
  render: () => renderCertificationOverview(false),
};

export const OperationsActivatedNotice: Story = {
  beforeEach: () => setupCertificationMenuScenario('operationsActivated'),
  render: () => renderCertificationOverview(false),
};
