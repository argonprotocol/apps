import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import {
  setupBitcoinEmptyScenario,
  setupBitcoinPortfolioScenario,
} from '../../scenarios/setupBitcoinPortfolioScenario.ts';
import Bitcoin from '../../../src-vue/screens/Bitcoin.vue';

const meta = {
  title: 'Bitcoin/Overview',
  component: Bitcoin,
  render: () => ({
    components: { AppScreen, Bitcoin },
    template: '<AppScreen><Bitcoin /></AppScreen>',
  }),
} satisfies Meta<typeof Bitcoin>;

export default meta;
type Story = StoryObj<typeof meta>;
let pendingLiquidCreate: ReturnType<typeof setupBitcoinPortfolioScenario>['bitcoinLiquidCreate'];

export const Loading: Story = {
  beforeEach: () => setupBitcoinEmptyScenario({ loading: true }),
};

export const Empty: Story = {
  beforeEach: () => setupBitcoinEmptyScenario(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Your First Liquid' }));

    const documentBody = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(documentBody.getByText('Create a Bitcoin Liquid')).toBeVisible());
    await waitFor(() =>
      expect(
        documentBody.getByText(
          "You don't have Bitcoin available in your wallet. Add Bitcoin before creating a Liquid.",
        ),
      ).toBeVisible(),
    );
    await expect(documentBody.getByRole('button', { name: 'Create Liquid' })).toBeDisabled();
    await expect(documentBody.queryByText('Choose How Much Bitcoin to Liquid Lock')).not.toBeInTheDocument();
  },
};

export const Liquids: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const leftBar = canvasElement.querySelector<HTMLElement>('.Navigation.LeftBar');
    if (!leftBar) throw new Error('Bitcoin navigation is missing');
    const navigationRow = within(leftBar).getByText('Bitcoin Liquid').closest('li');

    await expect(navigationRow).toHaveTextContent('₳85,680.00');
    const closeAmounts = canvas.getAllByText(/ to close$/);
    await expect(closeAmounts).toHaveLength(2);
    await expect(closeAmounts[0]).toBeVisible();
    await expect(closeAmounts[1]).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /Close Liquid/ })).not.toBeInTheDocument();
    await expect(canvas.queryByText(/ debt$/)).not.toBeInTheDocument();
    await expect(canvas.getByText('₳47,600.00 liquidity')).toBeVisible();
    await expect(canvas.getByText(/₳38,080.00 liquidity/)).toBeVisible();
    await expect(canvas.getByText('(₳9,900.80 pending mint)')).toBeVisible();
    await expect(canvas.getByText('₳5.10 fees')).toBeVisible();
    await expect(canvas.getByText('₳2.55 fees')).toBeVisible();
    await expect(canvas.getByText('13.4% return')).toBeVisible();
    await expect(canvas.getByText('8.25% return')).toBeVisible();
    await expect(canvas.queryByText(/ of BTC$/)).not.toBeInTheDocument();
  },
};

export const ClosedLiquidArchive: Story = {
  name: 'Archived Liquids',
  render: () => ({
    components: { AppScreen, Bitcoin },
    template: '<AppScreen interactive><Bitcoin /></AppScreen>',
  }),
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ closedLiquidArchive: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('1 Bitcoin Liquid has been archived')).toBeVisible();
    await expect(canvas.getAllByText(/BTC Liquid$/)).toHaveLength(3);
    await expect(canvas.getByText('₳1,652.40 profit')).toBeVisible();
    await expect(canvas.getByText('₳1.25 insurance fees')).toBeVisible();
    await expect(canvas.getByText('₳8.00 transaction fees')).toBeVisible();
    await expect(canvas.getByText('9.72% return')).toBeVisible();
    await userEvent.click(canvas.getAllByText(/BTC Liquid$/)[2]);

    const body = within(canvasElement.ownerDocument.body);
    const details = await body.findByRole('dialog', { name: 'Bitcoin Liquid Details' });
    await waitFor(() => expect(details).toBeVisible());
    const overlay = within(details);
    await expect(overlay.getByText('₳16,500.00 repaid')).toBeVisible();
    await expect(overlay.getByText('Aug 8, 2026')).toBeVisible();
    await expect(overlay.getByText('Total close cost was ₳16,504.00, including transaction fees.')).toBeVisible();
    await expect(overlay.getAllByText('₳4.00 fees')).toHaveLength(2);
    await expect(overlay.getByText('₳9.25')).toBeVisible();
    await expect(overlay.queryByRole('button', { name: 'Review Ratchet' })).not.toBeInTheDocument();
    await expect(overlay.queryByRole('button', { name: /Close Liquid/ })).not.toBeInTheDocument();

    await userEvent.click(overlay.getByTestId('OverlayBase.clickClose()'));
    await waitFor(() => expect(body.queryByRole('dialog', { name: 'Bitcoin Liquid Details' })).not.toBeInTheDocument());
    await userEvent.click(canvas.getAllByText(/BTC Liquid$/)[2]);
    const reopenedDetails = await body.findByRole('dialog', { name: 'Bitcoin Liquid Details' });
    await waitFor(() => expect(reopenedDetails).toBeVisible());
  },
};

export const RatchetOpportunity: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ currentBitcoinPriceUsd: 72_000 });
  },
  play: async ({ canvasElement }) => {
    const opportunities = within(canvasElement).getAllByText('Ratchet +5.88% available');
    await expect(opportunities).toHaveLength(2);
    await expect(opportunities[0]).toBeVisible();
  },
};

export const LiquidDetails: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ currentBitcoinPriceUsd: 72_000 });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByText(/BTC Liquid$/)[0]);
    const body = within(canvasElement.ownerDocument.body);
    const details = await body.findByRole('dialog', { name: 'Bitcoin Liquid Details' });
    await waitFor(() => expect(details).toBeVisible());
    const overlay = within(details);
    await expect(overlay.getByText('TOTAL FEES')).toBeVisible();
    await expect(overlay.getByText(/insurance · .* transactions/)).toBeVisible();
    await expect(overlay.getByText(/Would unlock/)).toBeVisible();
    await expect(overlay.queryByText(/Cannot read properties/)).not.toBeInTheDocument();
  },
};

export const LiquidsWithFeeWaiver: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true });
  },
};

export const LiquidFinancialHistoryUnavailable: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ financialHistoryUnavailable: true });
  },
};

export const CreateLiquidForm: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(/Create Liquid ·/));
    await waitFor(() => within(canvasElement.ownerDocument.body).getByText('Create a Bitcoin Liquid'));
  },
};

export const CreateLiquidWithoutBitcoin: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ noAvailableBitcoin: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(/Create Liquid · 0 BTC Available/));
    const documentBody = within(canvasElement.ownerDocument.body);
    await expect(
      documentBody.findByText("You don't have Bitcoin available in your wallet. Add Bitcoin before creating a Liquid."),
    ).resolves.toBeTruthy();
    await expect(documentBody.getByRole('button', { name: 'Create Liquid' })).toBeDisabled();
  },
};

export const CreateLiquidWhileFeeWaiversUnavailable: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true, feeWaiverRefreshPending: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(/Create Liquid ·/));
    await waitFor(() => within(canvasElement.ownerDocument.body).getByText('Create a Bitcoin Liquid'));
  },
};

export const CreateLiquidWhileQuoteLoads: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ createLiquidPreviewPending: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(/Create Liquid ·/));
    await waitFor(() =>
      expect(within(canvasElement.ownerDocument.body).getByText('Create a Bitcoin Liquid')).toBeVisible(),
    );
  },
};

export const CreateLiquidQuoteUnavailable: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ createLiquidError: 'Network Bitcoin pricing is currently unavailable.' });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(/Create Liquid ·/));
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).getByText('Network Bitcoin pricing is currently unavailable.'),
      ).toBeVisible(),
    );
  },
};

export const CloseWhileCreatingLiquid: Story = {
  beforeEach: () => {
    pendingLiquidCreate = setupBitcoinPortfolioScenario({ pendingLiquidCreation: true }).bitcoinLiquidCreate;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(/Create Liquid ·/));
    const documentBody = within(canvasElement.ownerDocument.body);
    await userEvent.click(await documentBody.findByRole('button', { name: 'Create Liquid' }));
    await waitFor(() => expect(pendingLiquidCreate.submit).toHaveBeenCalled());
    await documentBody.findByText('Creating Liquid...');
    const close = canvasElement.ownerDocument.body.querySelector<HTMLElement>(
      '[data-testid="OverlayBase.clickClose()"]',
    );
    if (!close) throw new Error('The Liquid creation overlay close action was not rendered.');
    await userEvent.click(close);
    await waitFor(() => expect(documentBody.queryByText('Create a Bitcoin Liquid')).not.toBeInTheDocument());
    const pendingRow = await canvas.findByTestId('PendingBitcoinLiquid-2700');
    await expect(within(pendingRow).getByText(/BTC Liquid Is Being Created$/)).toBeVisible();
    await expect(within(pendingRow).getByRole('button', { name: 'View Progress' })).toBeVisible();
    await expect(within(pendingRow).getAllByText('42.0%')).toHaveLength(2);
    await expect(canvas.getByText(/Create Liquid · 0 BTC Available/)).toBeVisible();

    await userEvent.click(within(pendingRow).getByRole('button', { name: 'View Progress' }));
    const reopenedDialog = await documentBody.findByRole('dialog');
    await waitFor(() => expect(reopenedDialog).toBeVisible());
    await expect(within(reopenedDialog).getByText('Creating Liquid...')).toBeVisible();

    const reopenedClose = reopenedDialog.querySelector<HTMLElement>('[data-testid="OverlayBase.clickClose()"]');
    if (!reopenedClose) throw new Error('The reopened Liquid creation overlay close action was not rendered.');
    await userEvent.click(reopenedClose);
    await waitFor(() => expect(documentBody.queryByRole('dialog')).not.toBeInTheDocument());
  },
};
