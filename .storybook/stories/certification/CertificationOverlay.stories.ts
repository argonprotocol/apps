import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { userEvent, within } from 'storybook/test';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
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
    await expectEventuallyVisible(detailHeading);
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
    await expectEventuallyVisible(canvas.findByText('Treasury Certification', { selector: 'h2[id]' }));
    await expectEventuallyVisible(canvas.findByText('Underway'));
    await expectEventuallyVisible(canvas.findByText('Acquire ₳500 of Treasury Bonds'));
  },
};

export const TreasuryOverviewComplete: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'complete' }),
  render: () => renderCertification(OperationalStepId.LiquidLock),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Liquid Lock ₳600 of Bitcoin' });
    await expectEventuallyVisible(detailHeading);
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
    await expectEventuallyVisible(canvas.findByText('Treasury Certification', { selector: 'h2[id]' }));
    await expectEventuallyVisible(canvas.findByText('Acquire ₳500 of Treasury Bonds'));
  },
};

export const OperationsOverviewInProgress: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'mixed' }),
  render: () => renderCertification(OperationalStepId.ActivateVault),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Create a ₳1,000 Vault' });
    await expectEventuallyVisible(detailHeading);
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
    await expectEventuallyVisible(canvas.findByText('Operations Certification', { selector: 'h2[id]' }));
    await expectEventuallyVisible(canvas.findByText('Underway'));
    await expectEventuallyVisible(canvas.findByText('Win 2 Mining Seats'));
  },
};

export const OperationsOverviewComplete: Story = {
  beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'complete' }),
  render: () => renderCertification(OperationalStepId.ActivateVault),
  play: async () => {
    const canvas = within(document.body);
    const detailHeading = await canvas.findByRole('heading', { name: 'Create a ₳1,000 Vault' });
    await expectEventuallyVisible(detailHeading);
    const backControl = detailHeading.parentElement?.closest('h2')?.querySelector(':scope > span');

    if (!backControl) throw new Error('Certification detail Back control is missing');

    await userEvent.click(backControl);
    await expectEventuallyVisible(canvas.findByText('Operations Certification', { selector: 'h2[id]' }));
    await expectEventuallyVisible(canvas.findByText('Win 2 Mining Seats'));
  },
};

const detailStories = {
  [OperationalStepId.BackupMnemonic]: {
    beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.BackupMnemonic),
    play: async () => {
      const canvas = within(document.body);

      await expectEventuallyVisible(canvas.findByRole('heading', { name: 'Create Your Mnemonic Backup' }));
      await expectEventuallyVisible(canvas.findByText('Step Completed'));
      await expectEventuallyVisible(canvas.findByText(/saving your 12-word recovery phrase/));
    },
  },
  [OperationalStepId.LiquidLock]: {
    beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.LiquidLock),
    play: async () => {
      const canvas = within(document.body);

      await expectEventuallyVisible(canvas.findByText('Not completed'));
      await expectEventuallyVisible(canvas.findByText(/mint Argons equal to the market value/));
    },
  },
  [OperationalStepId.TreasuryTransfer]: {
    beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.TreasuryTransfer),
    play: async () => {
      const canvas = within(document.body);

      await expectEventuallyVisible(canvas.findByRole('heading', { name: 'Transfer 1,000 ARGN from Uniswap' }));
      await expectEventuallyVisible(canvas.findByText('Step Completed'));
      await expectEventuallyVisible(canvas.findByText(/must originate from Uniswap on Ethereum/));
    },
  },
  [OperationalStepId.AcquireArgonBonds]: {
    beforeEach: () => setupCertificationScenario({ track: 'treasury', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.AcquireArgonBonds),
    play: async () => {
      const canvas = within(document.body);

      await expectEventuallyVisible(canvas.findByText('Underway'));
      await expectEventuallyVisible(canvas.findByText(/claim on future mining auction revenue/));
    },
  },
  [OperationalStepId.OperationalTransfer]: {
    beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.OperationalTransfer),
    play: async () => {
      const canvas = within(document.body);

      await expectEventuallyVisible(canvas.findByRole('heading', { name: 'Transfer 2,000 ARGN from Uniswap' }));
      await expectEventuallyVisible(canvas.findByText('Step Completed'));
      await expectEventuallyVisible(canvas.findByText(/must originate from Uniswap on Ethereum/));
    },
  },
  [OperationalStepId.ActivateVault]: {
    beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.ActivateVault),
    play: async () => {
      const canvas = within(document.body);

      await expectEventuallyVisible(canvas.findByText('Underway'));
      await expectEventuallyVisible(canvas.findByText(/commit your own Argons as security/));
    },
  },
  [OperationalStepId.FirstMiningSeat]: {
    beforeEach: () => setupCertificationScenario({ track: 'operations', state: 'mixed' }),
    render: () => renderCertification(OperationalStepId.FirstMiningSeat),
    play: async () => {
      const canvas = within(document.body);

      await expectEventuallyVisible(canvas.findByText('Not completed'));
      await expectEventuallyVisible(canvas.findByText(/allocated through a competitive bidding process/));
    },
  },
} satisfies Record<CurrentTrackStepId, Story>;

export const BackupMnemonic = detailStories[OperationalStepId.BackupMnemonic];
export const LiquidLock = detailStories[OperationalStepId.LiquidLock];
export const TreasuryTransfer = detailStories[OperationalStepId.TreasuryTransfer];
export const AcquireArgonBonds = detailStories[OperationalStepId.AcquireArgonBonds];
export const OperationalTransfer = detailStories[OperationalStepId.OperationalTransfer];
export const ActivateVault = detailStories[OperationalStepId.ActivateVault];
export const FirstMiningSeat = detailStories[OperationalStepId.FirstMiningSeat];
