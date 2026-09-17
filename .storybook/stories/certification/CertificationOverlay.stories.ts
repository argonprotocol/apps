import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { userEvent, within } from 'storybook/test';
import { setupCertificationScenario } from '../../scenarios/setupCertificationScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import {
  OperationalStepId,
  operationsCertificationStepIds,
  treasuryCertificationStepIds,
} from '../../../src-vue/stores/certificationController.ts';
import CertificationOverlay from '../../../src-vue/overlays/CertificationOverlay.vue';

const meta = {
  title: 'Certification/Workflow',
  component: CertificationOverlay,
} satisfies Meta<typeof CertificationOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;
type CurrentTrackStepId =
  | (typeof treasuryCertificationStepIds)[number]
  | (typeof operationsCertificationStepIds)[number];

function renderCertification(stepId: OperationalStepId) {
  return {
    components: { CertificationOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openOperationalOverlay', stepId));
    },
    template: '<CertificationOverlay />',
  };
}

export const TreasuryOverviewInProgress: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
  render: () => renderCertification(OperationalStepId.LiquidLock),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Liquid Lock ₳600 of Bitcoin' });
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
  },
};

export const TreasuryOverviewComplete: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'complete' }),
  render: () => renderCertification(OperationalStepId.LiquidLock),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Liquid Lock ₳600 of Bitcoin' });
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
  },
};

export const OperationsOverviewInProgress: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'mixed' }),
  render: () => renderCertification(OperationalStepId.ActivateVault),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Create a ₳1,000 Vault' });
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
  },
};

export const OperationsOverviewComplete: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'complete' }),
  render: () => renderCertification(OperationalStepId.ActivateVault),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Create a ₳1,000 Vault' });
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
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
export const AcquireArgonBonds = detailStories[OperationalStepId.AcquireArgonBonds];
export const OperationalTransfer = detailStories[OperationalStepId.OperationalTransfer];
export const ActivateVault = detailStories[OperationalStepId.ActivateVault];
export const FirstMiningSeat = detailStories[OperationalStepId.FirstMiningSeat];
