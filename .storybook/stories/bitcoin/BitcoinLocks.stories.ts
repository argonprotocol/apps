import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import {
  setupBitcoinEmptyScenario,
  setupBitcoinPortfolioScenario,
} from '../../scenarios/setupBitcoinPortfolioScenario.ts';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import { OperationalStepId } from '../../../src-vue/stores/certificationController.ts';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
import BitcoinLocks from '../../../src-vue/screens/BitcoinLocks.vue';

const meta = {
  title: 'Bitcoin/Overview',
  component: BitcoinLocks,
  render: () => ({
    components: { AppScreen, BitcoinLocks },
    template: '<AppScreen><BitcoinLocks /></AppScreen>',
  }),
} satisfies Meta<typeof BitcoinLocks>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  beforeEach: () => setupBitcoinEmptyScenario({ loading: true }),
};

export const Start: Story = {
  beforeEach: () => setupBitcoinEmptyScenario(),
};

export const RestoringHistory: Story = {
  beforeEach: () => setupBitcoinEmptyScenario({ recovering: true }),
};

export const Portfolio: Story = {
  beforeEach: () => setupBitcoinPortfolioScenario(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getAllByText('Preparing the Bitcoin release.')).toHaveLength(1);
    await expect(canvas.getAllByText('Waiting for the vault to cosign the Bitcoin release.')).toHaveLength(1);
    await expect(canvas.getAllByText('The release request is processing on Argon.')).toHaveLength(1);
    await expect(canvas.getAllByText('The release is processing on the Bitcoin network.')).toHaveLength(1);
    await expect(canvas.getByText('2 bitcoin transactions have been archived')).toBeVisible();
    await expect(canvas.getByText(/^released \d+ days ago$/)).toBeVisible();
  },
};

export const PortfolioWithFeeWaiver: Story = {
  beforeEach: () => setupBitcoinPortfolioScenario({ feeWaiver: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/fee waiver from Atlas Operator has ₳27\.20 remaining/)).toBeVisible();
  },
};

export const LiquidLockGuide: Story = {
  beforeEach: () => {
    setupBitcoinEmptyScenario();
    Object.assign(useFinancials(), { savingsTotalReadyToUse: 1n });
    setCertificationGuide(OperationalStepId.LiquidLock);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('Liquid Lock Your First Bitcoin')).toBeVisible();
    await expect(canvas.getByText('Click Here')).toBeVisible();
  },
};
