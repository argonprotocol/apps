import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { userEvent, within } from 'storybook/test';
import { setupCertificationScenario } from '../../scenarios/setupCertificationScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import {
  OperationalStepId,
  operationsCertificationStepIds,
  treasuryCertificationStepIds,
  useCertificationController,
} from '../../../src-vue/stores/certificationController.ts';
import CertificationOverlay from '../../../src-vue/overlays/CertificationOverlay.vue';
import { setupBitcoinPortfolioScenario } from '../../scenarios/setupBitcoinPortfolioScenario.ts';
import { getBitcoinFissions } from '../../../src-vue/stores/bitcoin.ts';

const meta = {
  title: 'Certification/Workflow',
  component: CertificationOverlay,
} satisfies Meta<typeof CertificationOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;
type CurrentTrackStepId =
  | (typeof treasuryCertificationStepIds)[number]
  | (typeof operationsCertificationStepIds)[number];
const isInteractive = Vue.ref(false);

function renderCertification(stepId: OperationalStepId, showOverview = false) {
  isInteractive.value = showOverview;
  return {
    components: { CertificationOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openOperationalOverlay', stepId));
      Vue.onMounted(() => document.addEventListener('keydown', preventFixedPreviewKeyboard, true));
      Vue.onUnmounted(() => document.removeEventListener('keydown', preventFixedPreviewKeyboard, true));
      return { isInteractive };

      function preventFixedPreviewKeyboard(event: KeyboardEvent) {
        if (isInteractive.value) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    template: `
      <CertificationOverlay />
      <div
        v-if="!isInteractive"
        class="pointer-events-auto fixed inset-0 z-[9999] cursor-not-allowed"
        aria-label="Certification controls are disabled in this fixed preview"
      >
        <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
          Controls are disabled in this fixed preview.
        </span>
      </div>
    `,
  };
}

export const TreasuryOverviewInProgress: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
  render: () => renderCertification(OperationalStepId.LiquidLock, true),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Liquid Lock ₳600 of Bitcoin' });
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
    isInteractive.value = false;
  },
};

export const TreasuryOverviewComplete: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'complete' }),
  render: () => renderCertification(OperationalStepId.LiquidLock, true),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Liquid Lock ₳600 of Bitcoin' });
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
    isInteractive.value = false;
  },
};

export const OperationsOverviewInProgress: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'mixed' }),
  render: () => renderCertification(OperationalStepId.ActivateVault, true),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Create a ₳1,000 Vault' });
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
    isInteractive.value = false;
  },
};

export const OperationsOverviewComplete: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'complete' }),
  render: () => renderCertification(OperationalStepId.ActivateVault, true),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Create a ₳1,000 Vault' });
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
    isInteractive.value = false;
  },
};

const detailStories = {
  [OperationalStepId.BackupMnemonic]: {
    beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.BackupMnemonic),
  },
  [OperationalStepId.LiquidLock]: {
    beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.LiquidLock),
  },
  [OperationalStepId.TreasuryTransfer]: {
    beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.TreasuryTransfer),
  },
  [OperationalStepId.AcquireArgonBonds]: {
    beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.AcquireArgonBonds),
  },
  [OperationalStepId.OperationalTransfer]: {
    beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.OperationalTransfer),
  },
  [OperationalStepId.ActivateVault]: {
    beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.ActivateVault),
  },
  [OperationalStepId.FirstMiningSeat]: {
    beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.FirstMiningSeat),
  },
} satisfies Record<CurrentTrackStepId, Story>;

export const BackupMnemonic = detailStories[OperationalStepId.BackupMnemonic];
export const LiquidLock = detailStories[OperationalStepId.LiquidLock];
export const TreasuryTransfer = detailStories[OperationalStepId.TreasuryTransfer];
export const TreasuryTransferWithDifferentMinimum: Story = {
  beforeEach: () => {
    setupCertificationScenario({ track: 'treasury', state: 'mixed' });
    useCertificationController().rewardConfig.treasuryMinimumUniswapTransfer =
      375n * BigInt(MICROGONS_PER_ARGON) + BigInt(MICROGONS_PER_ARGON) / 2n;
  },
  render: () => renderCertification(OperationalStepId.TreasuryTransfer),
};

export const TreasuryFundingNotStarted: Story = {
  beforeEach: () => {
    setupCertificationScenario({ track: 'treasury', state: 'mixed' });
    const controller = useCertificationController();
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = null;
  },
  render: () => renderCertification(OperationalStepId.TreasuryTransfer),
};

export const TreasuryFundingUnderway: Story = {
  beforeEach: () => {
    setupCertificationScenario({ track: 'treasury', state: 'mixed' });
    const controller = useCertificationController();
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  },
  render: () => renderCertification(OperationalStepId.TreasuryTransfer),
};

export const BitcoinLockUnderway: Story = {
  beforeEach: () => {
    setupCertificationScenario({ track: 'treasury', state: 'mixed' });
    useCertificationController().activeGuideId = OperationalStepId.LiquidLock;
  },
  render: () => renderCertification(OperationalStepId.LiquidLock),
};

export const BitcoinLockedWithoutLiquid: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true });
    getBitcoinFissions().data.fissionsById = {};
    const controller = useCertificationController();
    controller.isLoaded = true;
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = true;
    controller.chainProgress.hasBitcoinLock = false;
    controller.activeGuideId = null;
  },
  render: () => renderCertification(OperationalStepId.LiquidLock),
};

export const BitcoinLockComplete: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'complete' }),
  render: () => renderCertification(OperationalStepId.LiquidLock),
};

export const AcquireArgonBonds = detailStories[OperationalStepId.AcquireArgonBonds];
export const OperationalTransfer = detailStories[OperationalStepId.OperationalTransfer];
export const ActivateVault = detailStories[OperationalStepId.ActivateVault];
export const FirstMiningSeat = detailStories[OperationalStepId.FirstMiningSeat];
