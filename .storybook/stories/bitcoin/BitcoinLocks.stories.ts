import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
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
let portfolioScenario: ReturnType<typeof setupBitcoinPortfolioScenario>;

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
  beforeEach: () => {
    portfolioScenario = setupBitcoinPortfolioScenario();
  },
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
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/fee waiver from Atlas Operator has ₳27\.20 remaining/)).toBeVisible();
  },
};

export const AtParRatchet: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ atParRatchet: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Price Is at Par' }));
    await waitFor(() => expect(within(document.body).getByText(/Ratchet Your/)).toBeVisible());
  },
};

export const PendingRatchet: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ pendingRatchet: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ratchetButton = canvas.getByRole('button', { name: 'Ratcheting...' });
    const spinner = ratchetButton.querySelector('[data-testid="Spinner"]');
    const unlockButton = ratchetButton.parentElement?.querySelector('[PrimaryButton]');

    await expect(ratchetButton).toBeVisible();
    await expect(spinner).toBeVisible();
    await expect(ratchetButton.getBoundingClientRect().height).toBe(unlockButton?.getBoundingClientRect().height);

    await userEvent.click(ratchetButton);
    await waitFor(() =>
      expect(within(document.body).getByRole('button', { name: 'Ratchet pending...' })).toBeVisible(),
    );
  },
};

export const RatchetStartsWhileMounted: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    await expect(canvas.queryByRole('button', { name: 'Ratcheting...' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Ratchet +4.75%' }));
    await userEvent.click(await body.findByRole('button', { name: 'Finish Ratchet' }));

    const ratchetButton = canvas.getByText('Ratcheting...').closest('button')!;
    await expect(ratchetButton.querySelector('[data-testid="Spinner"]')).toBeVisible();
  },
};

export const RatchetPreparationCancelled: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);

    await userEvent.click(canvas.getByRole('button', { name: 'Ratchet +4.75%' }));
    await userEvent.click(await body.findByRole('button', { name: 'Finish Ratchet' }));
    await expect(canvas.getByText('Ratcheting...')).toBeVisible();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(canvas.queryByText('Ratcheting...')).not.toBeInTheDocument());
  },
};

export const RatchetCompletion: Story = {
  beforeEach: () => {
    portfolioScenario = setupBitcoinPortfolioScenario({ pendingRatchet: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Ratcheting...')).toBeVisible();

    portfolioScenario.completePendingRatchet();

    await waitFor(() => expect(canvas.queryByText('Ratcheting...')).not.toBeInTheDocument());
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
